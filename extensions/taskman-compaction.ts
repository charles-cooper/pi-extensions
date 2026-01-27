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
 *   pi --extension extensions/taskman-compaction.ts
 *
 * Or add to ~/.pi/settings.jsonl:
 *   {"extensions": ["~/pi-extensions/extensions/taskman-compaction.ts"]}
 *
 * Recommended settings for earlier compaction (~70% instead of ~92%):
 *   {"compaction": {"reserveTokens": 60000}}
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { complete } from "@mariozechner/pi-ai";
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
	// After compaction, inject continue guidance
	pi.on("session_compact", async (event, ctx) => {
		if (!event.fromExtension) return;

		pi.sendMessage(
			{
				customType: "compaction_continue",
				content: `Context was compacted. Use the /continue skill approach:
1. Read the compaction summary above
2. Expand breadcrumbs selectively (only what's needed for next step)
3. Continue where you left off`,
				display: false,
			},
			{ triggerTurn: false },
		);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, signal } = event;
		const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary } = preparation;

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

		let messages: Message[] = [
			...llmMessages,
			{
				role: "user" as const,
				content: [{ type: "text" as const, text: HANDOFF_REQUEST + previousContext }],
				timestamp: Date.now(),
			},
		];

		const maxTurns = 10;
		let summary = "";

		try {
			// Agent loop
			for (let turn = 0; turn < maxTurns; turn++) {
				if (signal.aborted) throw new Error("Compaction cancelled");

				const response = await complete(
					model,
					{ messages, tools: toolDefs },
					{ apiKey, maxTokens: 8192, signal },
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

				// Execute all tool calls (batched)
				const toolResults = await Promise.all(toolCalls.map(async (tc) => {
					const tool = toolMap.get(tc.name);
					if (!tool) {
						return {
							role: "toolResult" as const,
							toolCallId: tc.toolCallId,
							content: [{ type: "text" as const, text: `Error: Unknown tool ${tc.name}` }],
							timestamp: Date.now(),
						};
					}
					const result = await tool.execute(tc.toolCallId, tc.arguments, signal);
					return {
						role: "toolResult" as const,
						toolCallId: tc.toolCallId,
						content: result.content,
						timestamp: Date.now(),
					};
				}));

				// Add assistant response and tool results to messages
				messages = [
					...messages,
					{ role: "assistant" as const, content: response.content, timestamp: Date.now() } as Message,
					...toolResults,
				];
			}

			if (!summary.trim()) {
				ctx.ui.notify("Compaction summary was empty, using default", "warning");
				return;
			}

			return {
				compaction: {
					summary,
					firstKeptEntryId,
					tokensBefore,
				},
			};
		} catch (error) {
			if (signal.aborted) return;
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Taskman compaction failed: ${message}, using default`, "error");
			return;
		}
	});
}
