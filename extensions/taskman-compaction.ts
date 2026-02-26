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

const HANDOFF_REQUEST = `Context is getting long. Your task:

1. Read the /remember skill from ${REMEMBER_SKILL_PATH} and persist any reusable knowledge (learnings, patterns, decisions) to topics/memory files.
2. Read the /handoff skill from ${HANDOFF_SKILL_PATH} and follow its instructions to save current state.
3. Produce a final summary (text only, no tool calls) that will become the initial prompt for the next session. Preserve all user intent from this and previous sessions — goals, preferences, constraints, corrections — and use judgment as to how to frame it. Make sure to phrase it in a way which is preserved across automated handoffs.

IMPORTANT: Do NOT take any action besides updating memory/handoff files. Do NOT modify source code, run commands, or make any changes to the project itself.

You can batch multiple tool calls.`;

function checkTaskmanAvailable(): boolean {
	return fs.existsSync(HANDOFF_SKILL_PATH);
}

export default function (pi: ExtensionAPI) {
	// =========================================================================
	// Mid-turn compaction check
	// =========================================================================
	// Framework only checks shouldCompact at agent_end (after entire turn).
	// During long tool-use turns (100+ tool calls), context grows past threshold
	// unchecked. This handler checks at each turn_end (after each LLM call +
	// tool batch) and triggers compaction early via ctx.compact(), which
	// internally aborts the agent loop then runs our session_before_compact.
	let midTurnCompactPending = false;
	const settingsPath = path.join(os.homedir(), ".pi/agent/settings.json");
	function isCompactionEnabled(): boolean {
		try {
			const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
			return settings?.compaction?.enabled !== false;
		} catch { return true; } // default: enabled
	}

	pi.on("turn_end", (event, ctx) => {
		if (midTurnCompactPending) return;
		if (!isCompactionEnabled()) return;
		if (ctx.isIdle()) return;

		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null) return;

		// Hard token threshold rather than percentage — works across context window sizes
		// (200K and 1M Opus variants). Framework's shouldCompact uses reserveTokens from
		// settings (not exposed to extensions). 160K matches 200K window with 40K reserve.
		// Future: could be per-model or read from settings if needed.
		const MID_TURN_COMPACT_THRESHOLD = 160_000;
		if (usage.tokens > MID_TURN_COMPACT_THRESHOLD) {
			midTurnCompactPending = true;
			ctx.ui.notify(
				`Context at ${Math.round(usage.tokens / 1000)}K tokens mid-turn, triggering compaction`,
				"info"
			);
			ctx.compact({
				onComplete: () => { midTurnCompactPending = false; },
				onError: () => { midTurnCompactPending = false; },
			});
		}
	});

	// =========================================================================
	// Post-compaction continue message
	// =========================================================================
	// Track if we've already sent the continue message for this compaction
	// After compaction, auto-continue so the agent acts on the summary.
	// For overflow: framework also calls agent.continue() at 100ms — ours wins (starts first),
	// framework's continue() throws "already processing" and is silently swallowed. Fine.
	// For queued messages: skip — framework's continue() handles delivery.
	let continueMessageSent = false;
	pi.on("session_compact", async (event, ctx) => {
		midTurnCompactPending = false; // Reset guard after any compaction
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

		// Combine messages and convert to LLM format.
		// Framework bug workaround: findCutPoint with keepRecentTokens:0 produces empty
		// messagesToSummarize when the last entry is a toolResult (not a valid cut point).
		// Since we set firstKeptEntryId:null (keep nothing), we need ALL messages after
		// the last compaction. Extract from branchEntries as fallback.
		let allMessages = [...messagesToSummarize, ...turnPrefixMessages];
		if (allMessages.length === 0) {
			const { branchEntries } = event;
			const lastCompactIdx = branchEntries.findLastIndex((e: any) => e.type === "compaction");
			const startIdx = lastCompactIdx >= 0 ? lastCompactIdx + 1 : 0;
			for (let i = startIdx; i < branchEntries.length; i++) {
				const entry = branchEntries[i] as any;
				if (entry.type === "message") {
					allMessages.push(entry.message);
				} else if (entry.type === "custom_message") {
					allMessages.push({
						role: "custom",
						content: entry.content,
						timestamp: entry.timestamp ?? Date.now(),
					});
				}
			}
		}
		const llmMessages = convertToLlm(allMessages);

		// If still no messages (e.g., immediate re-compaction with <3 entries),
		// return previous summary with clean context instead of falling through to default
		if (llmMessages.length === 0) {
			return {
				compaction: {
					summary: previousSummary || "/taskman continue",
					firstKeptEntryId: null as any,
					tokensBefore,
					details: {},
				},
			};
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
		const systemPrompt = `You are a handoff agent. Run /remember and /handoff skills using tools, then produce a summary as your final response (text only, no tool calls).

Your summary becomes the initial prompt for the next session. If that session compacts, your summary is all that survives.

Preserve all user intent from this and previous sessions — goals, preferences, constraints, corrections — and use judgment as to how to frame it. Make sure to phrase it in a way which is preserved across automated handoffs.

Also include:
- What technical progress was made and what remains
- Where to load context from (skill files, handoff files, topic files)
- Breadcrumbs (file paths, commands) to reconstruct state`;

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

				const maxTokens = 32768;

				const response = await completeSimple(
					model,
					{ systemPrompt, messages, tools: toolDefs },
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
					firstKeptEntryId: null as any, // Keep ZERO old messages — clean slate after compaction
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
					firstKeptEntryId: null as any, // Keep ZERO old messages — clean slate after compaction
					tokensBefore,
					details: {},
				},
			};
		}
	});
}
