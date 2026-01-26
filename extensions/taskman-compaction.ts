/**
 * Taskman Compaction Extension
 *
 * Replaces the default compaction prompt with the taskman /handoff skill.
 * This ensures compaction summaries follow the same format as manual handoffs,
 * with breadcrumbs and progressive disclosure.
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
import { complete, getModel } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";

// Skill file location
const HANDOFF_SKILL_PATH = path.join(os.homedir(), ".pi/agent/skills/taskman/handoff.md");

// System prompt for compaction
const SYSTEM_PROMPT = `You are a context summarization assistant creating a handoff document. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured handoff following the skill instructions.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the handoff document.`;

function readSkillFile(): string | undefined {
	try {
		if (fs.existsSync(HANDOFF_SKILL_PATH)) {
			return fs.readFileSync(HANDOFF_SKILL_PATH, "utf-8");
		}
	} catch {
		// ignore
	}
	return undefined;
}

function readTaskmanContext(cwd: string): string {
	const parts: string[] = [];

	// Try to read STATUS.md for current focus
	const statusPath = path.join(cwd, ".agent-files/STATUS.md");
	try {
		if (fs.existsSync(statusPath)) {
			const status = fs.readFileSync(statusPath, "utf-8");
			parts.push(`<current-status>\n${status}\n</current-status>`);
		}
	} catch {
		// ignore
	}

	// Try to read MEDIUMTERM_MEM.md for context
	const memPath = path.join(cwd, ".agent-files/MEDIUMTERM_MEM.md");
	try {
		if (fs.existsSync(memPath)) {
			const mem = fs.readFileSync(memPath, "utf-8");
			parts.push(`<memory-index>\n${mem}\n</memory-index>`);
		}
	} catch {
		// ignore
	}

	return parts.join("\n\n");
}

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, signal } = event;
		const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary } = preparation;

		// Read the handoff skill
		const skillContent = readSkillFile();
		if (!skillContent) {
			ctx.ui.notify("Handoff skill not found, using default compaction", "warning");
			return;
		}

		// Use the same model as the conversation (or fall back to a fast model)
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

		// Combine all messages
		const allMessages = [...messagesToSummarize, ...turnPrefixMessages];

		ctx.ui.notify(
			`Taskman compaction: summarizing ${allMessages.length} messages with handoff format...`,
			"info",
		);

		// Serialize conversation
		const conversationText = serializeConversation(convertToLlm(allMessages));

		// Get taskman context
		const taskmanContext = readTaskmanContext(ctx.cwd);

		// Build prompt using the skill
		const previousContext = previousSummary
			? `\n\n<previous-summary>\n${previousSummary}\n</previous-summary>`
			: "";

		const promptText = `You are creating a compaction summary (automatic context checkpoint) for a coding session.

Use the handoff skill format below to create the summary. The goal is to preserve context efficiently using breadcrumbs (pointers to recoverable information) rather than copying content verbatim.

<handoff-skill>
${skillContent}
</handoff-skill>

${taskmanContext ? `\n${taskmanContext}\n` : ""}
${previousContext}

<conversation>
${conversationText}
</conversation>

Create a handoff-style summary. Key points:
- Use breadcrumbs (file:line, commands to run) instead of copying content
- Focus on WHAT was being done and WHY, not full details
- Preserve exact file paths, function names, error messages as references
- Include next steps and any blockers
- Keep it concise - this replaces the conversation history

Output the summary directly, no preamble.`;

		const summaryMessages = [
			{
				role: "user" as const,
				content: [{ type: "text" as const, text: promptText }],
				timestamp: Date.now(),
			},
		];

		try {
			const response = await complete(
				model,
				{ systemPrompt: SYSTEM_PROMPT, messages: summaryMessages },
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
