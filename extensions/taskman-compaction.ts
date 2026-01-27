/**
 * Taskman Compaction Extension
 *
 * Replaces the default compaction prompt with the taskman /handoff skill.
 * Instead of serializing the conversation to text, sends the actual messages
 * plus a user message asking for a handoff summary - so the LLM sees the
 * conversation in native format with full context.
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

import { complete, getModel } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { convertToLlm } from "@mariozechner/pi-coding-agent";

const HANDOFF_REQUEST = `Context is getting long. Write a /handoff summary now to checkpoint our progress.

Use the /handoff skill format:
- Current focus and state
- Breadcrumbs (file:line, commands, topic refs) instead of copying content
- Next steps and blockers

This summary will replace the conversation history, so include everything needed to continue.

Output the handoff summary directly.`;

export default function (pi: ExtensionAPI) {
	// After compaction, inject a continue prompt so the agent re-orients
	pi.on("session_compact", async (event, ctx) => {
		// Only inject if this was our compaction (fromExtension means an extension handled it)
		if (!event.fromExtension) return;

		// Send a message to help agent re-orient after compaction
		pi.sendMessage(
			{
				customType: "compaction_continue",
				content: `Context was compacted. Use the /continue skill approach:
1. Read the compaction summary above
2. Expand breadcrumbs selectively (only what's needed for next step)
3. Continue where you left off`,
				display: false, // Don't render in UI, just send to LLM
			},
			{ triggerTurn: false }, // Don't auto-trigger a turn, wait for user
		);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, signal } = event;
		const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary } = preparation;

		const model = ctx.model ?? getModel("anthropic", "claude-sonnet-4-20250514");
		if (!model) {
			ctx.ui.notify("No model available for compaction", "warning");
			return;
		}

		const apiKey = await ctx.modelRegistry.getApiKey(model);
		if (!apiKey) {
			ctx.ui.notify(`No API key for ${model.provider}, using default compaction`, "warning");
			return;
		}

		// Combine all messages and convert to LLM format
		const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
		const llmMessages = convertToLlm(allMessages);

		ctx.ui.notify(
			`Taskman compaction: ${allMessages.length} messages, asking for /handoff summary...`,
			"info",
		);

		// Add handoff request as final user message
		const previousContext = previousSummary
			? `\n\nPrevious checkpoint for reference:\n${previousSummary}`
			: "";

		const messagesWithRequest = [
			...llmMessages,
			{
				role: "user" as const,
				content: [{ type: "text" as const, text: HANDOFF_REQUEST + previousContext }],
				timestamp: Date.now(),
			},
		];

		// Debug: show what we're sending
		console.log("\n=== TASKMAN COMPACTION ===");
		console.log(`Messages: ${llmMessages.length} + handoff request`);
		console.log("Request:", HANDOFF_REQUEST + previousContext);
		console.log("=== END ===\n");

		try {
			const response = await complete(
				model,
				{ messages: messagesWithRequest },
				{ apiKey, maxTokens: 8192, signal },
			);

			const summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			if (!summary.trim()) {
				if (!signal.aborted) {
					ctx.ui.notify("Compaction summary was empty, using default compaction", "warning");
				}
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
			ctx.ui.notify(`Taskman compaction failed: ${message}`, "error");
			return;
		}
	});
}
