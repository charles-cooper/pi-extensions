/**
 * Taskman Compaction Extension
 *
 * Replaces the default compaction with taskman /handoff skill.
 * Runs an agent loop with read/write/edit tools so it can:
 * - Read the handoff skill
 * - Write to .agent-files/ (STATUS.md, handoff files, etc.)
 * - Produce a summary using breadcrumbs
 *
 * Falls back to default compaction if taskman not installed.
 *
 * Usage:
 *   pi --extension ~/pi-extensions/extensions/taskman-compaction.ts
 *
 * Or install to ~/.pi/agent/extensions/ (loaded automatically):
 *   cd ~/pi-extensions && bash install.sh
 *
 * Recommended settings (triggers compaction earlier, required for context budget):
 *   {"compaction": {"reserveTokens": 50000}}
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { completeSimple } from "@mariozechner/pi-ai";
import type { Tool, Message, ToolCall } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { convertToLlm, createReadTool, createWriteTool, createEditTool, createBashTool } from "@mariozechner/pi-coding-agent";

const HANDOFF_SKILL_PATH = path.join(os.homedir(), ".pi/agent/skills/taskman/handoff.md");

const REMEMBER_SKILL_PATH = path.join(os.homedir(), ".pi/agent/skills/taskman/remember.md");

const HANDOFF_REQUEST = `Context is getting long. First /remember, then /handoff to checkpoint our progress.

1. Read the /remember skill from ${REMEMBER_SKILL_PATH} and persist any reusable knowledge (learnings, patterns, decisions) to topics/memory files.
2. Read the /handoff skill from ${HANDOFF_SKILL_PATH} and follow its instructions to save current state.

You can batch multiple tool calls. The summary you produce will replace the conversation history, so include everything needed to continue.`;

function checkTaskmanAvailable(): boolean {
	return fs.existsSync(HANDOFF_SKILL_PATH);
}

export default function (pi: ExtensionAPI) {
	// Track if we've already sent the continue message for this compaction
	// After compaction, auto-continue so the agent acts on the summary.
	// For overflow: framework also calls agent.continue() at 100ms — ours wins (starts first),
	// framework's continue() throws "already processing" and is silently swallowed. Fine.
	// For queued messages: skip — framework's continue() handles delivery.
	let continueMessageSent = false;
	pi.on("session_compact", async (event, ctx) => {
		if (continueMessageSent) return;
		continueMessageSent = true;
		pi.sendMessage(
			{
				customType: "compaction_continue",
				content: "Load /taskman skill and /continue the task specified in the handoff.",
				display: false,
			},
			{ triggerTurn: true },
		);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		continueMessageSent = false; // Reset for next compaction
		const { preparation, signal, customInstructions } = event;
		const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary, fileOps, settings } = preparation;

		// Warn if reserveTokens is too low for multi-turn agent loop
		if (settings.reserveTokens < 25000) {
			ctx.ui.notify(
				`reserveTokens is ${settings.reserveTokens} (recommend ≥25000 for taskman compaction). Add {"compaction":{"reserveTokens":25000}} to settings.jsonl`,
				"warning"
			);
		}

		// Check if taskman is available
		if (!checkTaskmanAvailable()) {
			ctx.ui.notify(
				"taskman not available, using default compaction. Install: pipx install taskmanager-exe && taskman install-skills",
				"warning"
			);
			return; // Fall back to default
		}

		const model = ctx.model;
		if (!model) {
			ctx.ui.notify("No model available for compaction, using default", "warning");
			return;
		}
		const apiKey = await ctx.modelRegistry.getApiKey(model);
		if (!apiKey) {
			ctx.ui.notify(`No API key for ${model.provider}/${model.id}, using default compaction`, "warning");
			return;
		}

		// Combine messages and convert to LLM format
		const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
		const llmMessages = convertToLlm(allMessages);

		// If there are no messages to summarize, fall back to default compaction
		if (llmMessages.length === 0) {
			ctx.ui.notify("No messages to summarize, using default compaction", "info");
			return;
		}

		ctx.ui.notify(`Taskman compaction: ${allMessages.length} messages...`, "info");

		// Create tools - reuse pi's implementations
		const agentTools = [
			createReadTool(ctx.cwd),
			createWriteTool(ctx.cwd),
			createEditTool(ctx.cwd),
			createBashTool(ctx.cwd),
		];
		const toolDefs: Tool[] = agentTools.map(t => ({
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		}));
		const toolMap = new Map(agentTools.map(t => [t.name, t]));

		// Build initial messages with handoff request
		const previousContext = previousSummary
			? `\n\nPrevious checkpoint for reference:\n${previousSummary}`
			: "";

		const customContext = customInstructions
			? `\n\nUser instructions for this compaction:\n${customInstructions}`
			: "";

		// System prompt for the compaction agent
		const systemPrompt = `You are a handoff agent. Read the skills you're given, follow their instructions using the provided tools, then output a final summary. The summary replaces the conversation history — it must contain everything needed to continue.`;

		let messages: Message[] = [
			...llmMessages,
			{
				role: "user" as const,
				content: [{ type: "text" as const, text: HANDOFF_REQUEST + previousContext + customContext }],
				timestamp: Date.now(),
			},
		];

		// Generous limit — /remember + /handoff involve many file reads/writes,
		// especially when there are multiple topics to persist. Each LLM turn is
		// the real cost; tool execution is cheap.
		const maxTurns = 30;
		let summary = "";

		try {
			// Agent loop
			for (let turn = 0; turn < maxTurns; turn++) {
				if (signal.aborted) throw new Error("Compaction cancelled");
				ctx.ui.setStatus("compaction", `✎ handoff turn ${turn + 1}/${maxTurns}…`);

				// 16384 base — thinking + output share this budget on Opus.
				// With reasoning:high, thinking can consume 4-8K, so we need headroom
				// for the final summary (~3K tokens).
				const maxTokens = Math.max(16384, Math.floor(settings.reserveTokens * 0.5));

				// Last 3 turns: remove tools to force text-only summary output.
				// Without this, the model keeps finding "one more thing" to do.
				const turnsLeft = maxTurns - turn;
				const turnTools = turnsLeft <= 3 ? [] : toolDefs;

				const response = await completeSimple(
					model,
					{ systemPrompt, messages, tools: turnTools },
					{ apiKey, maxTokens, signal, reasoning: "high" },
				);

				// Bail on errored/aborted responses before executing any tool calls
				if (response.stopReason === "error" || response.stopReason === "aborted") {
					throw new Error(response.errorMessage ?? `Compaction LLM failed (${response.stopReason})`);
				}

				// Check for tool calls
				const toolCalls = response.content.filter(
					(c): c is ToolCall => c.type === "toolCall"
				);

				if (toolCalls.length === 0) {
					// No tool calls - extract final summary
					summary = response.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n");
					// Truncated output → fall back to default compaction rather than lose context
					if (response.stopReason === "length") {
						ctx.ui.notify("Compaction summary was truncated, using default", "warning");
						return;
					}
					break;
				}

				// Execute all tool calls (batched, per-tool error isolation)
				const toolResults = await Promise.all(toolCalls.map(async (tc) => {
					const tool = toolMap.get(tc.name);
					if (!tool) {
						ctx.ui.notify(`⚠ compaction: unknown tool ${tc.name}`, "warning");
						return {
							role: "toolResult" as const,
							toolCallId: tc.id,
							toolName: tc.name,
							content: [{ type: "text" as const, text: `Error: Unknown tool ${tc.name}` }],
							isError: true,
							timestamp: Date.now(),
						};
					}
					// Surface file operations to the user
					const filePath = tc.arguments?.path as string | undefined;
					const cmd = tc.arguments?.command as string | undefined;
					const label = filePath ? `${tc.name} ${filePath}` : cmd ? `bash: ${cmd}` : tc.name;
					ctx.ui.setStatus("compaction", `✎ ${label}`);
					ctx.ui.notify(`✎ ${label}`, "info");
					try {
						const result = await tool.execute(tc.id, tc.arguments, signal);
						return {
							role: "toolResult" as const,
							toolCallId: tc.id,
							toolName: tc.name,
							content: result.content,
							isError: false,
							timestamp: Date.now(),
						};
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						ctx.ui.notify(`⚠ compaction ${label}: ${errMsg}`, "warning");
						return {
							role: "toolResult" as const,
							toolCallId: tc.id,
							toolName: tc.name,
							content: [{ type: "text" as const, text: `Error: ${errMsg}` }],
							isError: true,
							timestamp: Date.now(),
						};
					}
				}));

				// Add assistant response and tool results to messages
				// Keep thinking blocks — completeSimple's transform pipeline handles them:
				// transformMessages() preserves thinking for same-model, converts to text for
				// cross-model. convertMessages() handles signature validation. No need to strip.
				// Spread response to preserve metadata (model, provider, api) for isSameModel checks.
				messages = [
					...messages,
					{ ...response } as Message,
					...toolResults,
				];
			}

			ctx.ui.setStatus("compaction", undefined);

			if (!summary.trim()) {
				ctx.ui.notify("Compaction agent produced empty summary", "warning");
				summary = "/taskman continue";
			}

			// Compute file lists from preparation's fileOps for continuity with default compaction
			const modified = new Set([...fileOps.edited, ...fileOps.written]);
			const readFiles = [...fileOps.read].filter(f => !modified.has(f)).sort();
			const modifiedFiles = [...modified].sort();

			return {
				compaction: {
					summary,
					firstKeptEntryId,
					tokensBefore,
					details: { readFiles, modifiedFiles },
				},
			};
		} catch (error) {
			ctx.ui.setStatus("compaction", undefined);
			if (signal.aborted) return;
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Taskman compaction failed: ${message}`, "error");

			// Never fall back to default — return minimal summary to keep context clean
			return {
				compaction: {
					summary: "/taskman continue",
					firstKeptEntryId,
					tokensBefore,
					details: {},
				},
			};
		}
	});
}
