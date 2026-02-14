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
import { convertToLlm, createReadTool, createWriteTool, createEditTool } from "@mariozechner/pi-coding-agent";

const HANDOFF_SKILL_PATH = path.join(os.homedir(), ".pi/agent/skills/taskman/handoff.md");

const HANDOFF_REQUEST = `Context is getting long. Run /handoff to checkpoint our progress.

Use the read tool to load the /handoff skill from ~/.pi/agent/skills/taskman/handoff.md, then follow its instructions. You can batch multiple tool calls.

The summary you produce will replace the conversation history, so include everything needed to continue.`;

function checkTaskmanAvailable(): boolean {
	return fs.existsSync(HANDOFF_SKILL_PATH);
}

export default function (pi: ExtensionAPI) {
	// Track if we've already sent the continue message for this compaction
	let continueMessageSent = false;

	// After compaction, auto-continue so the agent re-orients with the summary.
	// For overflow: framework also calls agent.continue() at 100ms — ours wins (starts first),
	// framework's continue() throws "already processing" and is silently swallowed. Fine.
	// For queued messages: skip — framework's continue() handles delivery.
	pi.on("session_compact", async (event, ctx) => {
		if (!event.fromExtension) return;
		if (continueMessageSent) return;
		continueMessageSent = true;

		if (ctx.hasPendingMessages()) return; // Let framework handle queued messages

		pi.sendMessage(
			{
				customType: "compaction_continue",
				content: `Context was compacted. Use the /continue skill approach:
1. Read the compaction summary above
2. Expand breadcrumbs selectively (only what's needed for next step)
3. Continue where you left off`,
				display: false,
			},
			{ triggerTurn: true },
		);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		continueMessageSent = false; // Reset for next compaction
		const { preparation, signal } = event;
		const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary, fileOps, settings } = preparation;

		// Warn if reserveTokens is too low for multi-turn agent loop
		if (settings.reserveTokens < 50000) {
			ctx.ui.notify(
				`reserveTokens is ${settings.reserveTokens} (recommend ≥50000 for taskman compaction). Add {"compaction":{"reserveTokens":50000}} to settings.jsonl`,
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

		const model = ctx.model!;
		const apiKey = (await ctx.modelRegistry.getApiKey(model))!;

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

		// System prompt for the compaction agent
		const systemPrompt = `You are a context summarizer. Your job is to create concise summaries of conversations that preserve all important context for continuation.

When summarizing:
- Include key decisions, learnings, and current state
- Use breadcrumbs (file:line references) for code context
- Preserve critical details needed to continue work
- Keep the summary focused and actionable`;

		let messages: Message[] = [
			...llmMessages,
			{
				role: "user" as const,
				content: [{ type: "text" as const, text: HANDOFF_REQUEST + previousContext }],
				timestamp: Date.now(),
			},
		];

		// 10 turns: handoff skill is multi-step (read skill, read status, read mem,
		// write handoff, write status, produce summary). 6 was too tight.
		const maxTurns = 10;
		let summary = "";

		try {
			// Agent loop
			for (let turn = 0; turn < maxTurns; turn++) {
				if (signal.aborted) throw new Error("Compaction cancelled");

				// Cap output tokens — summarization doesn't need full model budget
				// Floor at 4096 in case reserveTokens is very small
				const maxTokens = Math.max(4096, Math.min(8192, Math.floor(settings.reserveTokens * 0.5)));
				// reasoning:high — compaction must identify what matters across a long
				// conversation, synthesize breadcrumbs, and make good discard decisions.
				// This is a high-stakes single-shot; cost/latency is acceptable.
				const response = await completeSimple(
					model,
					{ systemPrompt, messages, tools: toolDefs },
					{ apiKey, maxTokens, signal, reasoning: "high" },
				);

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
					break;
				}

				// Execute all tool calls (batched, per-tool error isolation)
				const toolResults = await Promise.all(toolCalls.map(async (tc) => {
					const tool = toolMap.get(tc.name);
					if (!tool) {
						return {
							role: "toolResult" as const,
							toolCallId: tc.id,
							toolName: tc.name,
							content: [{ type: "text" as const, text: `Error: Unknown tool ${tc.name}` }],
							isError: true,
							timestamp: Date.now(),
						};
					}
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
				// Strip thinking blocks (API rejects them in non-final assistant turns)
				// Use blocklist so future content types aren't silently dropped
				const assistantContent = response.content.filter(
					(c) => c.type !== "thinking"
				);
				// Spread full response to preserve metadata (model, provider, usage, etc.)
				messages = [
					...messages,
					{ ...response, content: assistantContent } as Message,
					...toolResults,
				];
			}

			if (!summary.trim()) {
				ctx.ui.notify("Compaction summary was empty, using default", "warning");
				return;
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
			if (signal.aborted) return;
			const message = error instanceof Error ? error.message : String(error);
			// Include model info in error for debugging 422 errors
			const modelInfo = `${model.provider}/${model.id}`;
			ctx.ui.notify(`Taskman compaction failed (${modelInfo}): ${message}`, "error");
			console.error("[taskman-compaction] Error details:", {
				model: modelInfo,
				error: message,
				messagesCount: messages.length,
				lastMessageRole: messages[messages.length - 1]?.role,
			});
			return;
		}
	});
}
