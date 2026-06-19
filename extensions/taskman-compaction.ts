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
import { completeSimple } from "@earendil-works/pi-ai";
import type { Tool, Message, ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, createReadTool, createWriteTool, createEditTool, createBashTool, getAgentDir, serializeConversation } from "@earendil-works/pi-coding-agent";

const AGENT_DIR = getAgentDir();
const HANDOFF_SKILL_PATH = path.join(AGENT_DIR, "skills/taskman/handoff.md");

const REMEMBER_SKILL_PATH = path.join(AGENT_DIR, "skills/taskman/remember.md");

const HANDOFF_REQUEST = `Context is getting long. Your task:

1. Read the /remember skill from ${REMEMBER_SKILL_PATH} and persist any reusable knowledge (learnings, patterns, decisions) to topics/memory files.
2. Read the /handoff skill from ${HANDOFF_SKILL_PATH} and follow its instructions to save current state.
3. Produce a final summary (text only, no tool calls) that will become the initial prompt for the next session. Preserve all user intent from this and previous sessions — goals, preferences, constraints, corrections — and use judgment as to how to frame it. Make sure to phrase it in a way which is preserved across automated handoffs.

IMPORTANT: Do NOT take any action besides updating memory/handoff files. Do NOT modify source code or project files. Only run commands required by the taskman skills, such as taskman sync and git rev-parse for the handoff commit.

You can batch multiple tool calls.`;

function checkTaskmanAvailable(): boolean {
	return fs.existsSync(HANDOFF_SKILL_PATH);
}

type TaskmanCompactionSettings = {
	compactionEnabled: boolean;
	reserveTokens: number;
};

const DEFAULT_TASKMAN_COMPACTION_SETTINGS: TaskmanCompactionSettings = {
	compactionEnabled: true,
	reserveTokens: 16384,
};

function readSettingsFile(filePath: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch {
		return undefined;
	}
}

function numberSetting(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function applyTaskmanCompactionSettings(settings: TaskmanCompactionSettings, raw: unknown): TaskmanCompactionSettings {
	if (!raw || typeof raw !== "object") return settings;
	const root = raw as Record<string, unknown>;
	const compaction = root.compaction && typeof root.compaction === "object"
		? root.compaction as Record<string, unknown>
		: undefined;
	return {
		compactionEnabled: typeof compaction?.enabled === "boolean" ? compaction.enabled : settings.compactionEnabled,
		reserveTokens: numberSetting(compaction?.reserveTokens) ?? settings.reserveTokens,
	};
}

function getTaskmanCompactionSettings(cwd: string): TaskmanCompactionSettings {
	let settings = { ...DEFAULT_TASKMAN_COMPACTION_SETTINGS };
	settings = applyTaskmanCompactionSettings(settings, readSettingsFile(path.join(AGENT_DIR, "settings.json")));
	settings = applyTaskmanCompactionSettings(settings, readSettingsFile(path.join(cwd, ".pi/settings.json")));
	return settings;
}

function estimateContentTokens(content: unknown): number {
	if (typeof content === "string") return Math.ceil(content.length / 4);
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const value = block as Record<string, unknown>;
		if (value.type === "text" && typeof value.text === "string") chars += value.text.length;
		if (value.type === "thinking" && typeof value.thinking === "string") chars += value.thinking.length;
	}
	return Math.ceil(chars / 4);
}

function assistantOutputTokens(message: unknown): number {
	if (!message || typeof message !== "object") return 0;
	return estimateContentTokens((message as Record<string, unknown>).content);
}

export default function (pi: ExtensionAPI) {
	let compactAfterCurrentAgent = false;
	let compactionScheduled = false;

	function contextOverThreshold(ctx: { cwd: string; getContextUsage(): { tokens: number | null; contextWindow: number } | undefined }, extraTokens = 0): boolean {
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null || usage.contextWindow <= 0) return false;
		const settings = getTaskmanCompactionSettings(ctx.cwd);
		if (!settings.compactionEnabled) return false;
		return usage.tokens + extraTokens > usage.contextWindow - settings.reserveTokens;
	}

	function requestCompactionAfterAgent(ctx: { ui: { notify(message: string, level: "info" | "warning" | "error"): void }; abort(): void }, reason: string): void {
		if (compactAfterCurrentAgent) return;
		compactAfterCurrentAgent = true;
		pi.events.emit("taskman-compaction:abort-suppression-start", { reason, timestamp: Date.now() });
		ctx.ui.notify(`${reason}; will compact after current turn boundary`, "info");
		ctx.abort();
	}

	function scheduleCompaction(ctx: { isIdle(): boolean; compact(options?: { onComplete?: () => void; onError?: (error: Error) => void }): void; ui: { notify(message: string, level: "info" | "warning" | "error"): void } }, attempt = 0): void {
		if (compactionScheduled && attempt === 0) return;
		compactionScheduled = true;
		setTimeout(() => {
			if (!ctx.isIdle() && attempt < 50) {
				scheduleCompaction(ctx, attempt + 1);
				return;
			}
			if (!ctx.isIdle()) {
				compactionScheduled = false;
				pi.events.emit("taskman-compaction:abort-suppression-end", { reason: "agent-did-not-become-idle", timestamp: Date.now() });
				ctx.ui.notify("Skipped deferred compaction because agent did not become idle", "warning");
				return;
			}
			ctx.compact({
				onComplete: () => {
					compactionScheduled = false;
					pi.events.emit("taskman-compaction:abort-suppression-end", { reason: "compaction-complete", timestamp: Date.now() });
				},
				onError: (error) => {
					compactionScheduled = false;
					pi.events.emit("taskman-compaction:abort-suppression-end", { reason: "compaction-error", timestamp: Date.now() });
					ctx.ui.notify(`Deferred compaction failed: ${error.message}`, "warning");
				},
			});
		}, 100);
	}

	pi.on("message_update", (event, ctx) => {
		const outputTokens = assistantOutputTokens((event as any).message);
		if (!contextOverThreshold(ctx, outputTokens)) return;
		requestCompactionAfterAgent(ctx, `Assistant output crossed context safety threshold`);
	});

	pi.on("turn_end", (_event, ctx) => {
		if (!contextOverThreshold(ctx)) return;
		requestCompactionAfterAgent(ctx, "Context is near limit at turn boundary");
	});

	pi.on("agent_end", (_event, ctx) => {
		if (!compactAfterCurrentAgent) return;
		compactAfterCurrentAgent = false;
		scheduleCompaction(ctx);
	});

	let continueMessageSent = false;
	let continueMessageTimer: ReturnType<typeof setTimeout> | undefined;

	function clearContinueMessageTimer(): void {
		if (!continueMessageTimer) return;
		clearTimeout(continueMessageTimer);
		continueMessageTimer = undefined;
	}

	function sendContinueMessage(deliverAs?: "followUp"): void {
		pi.sendMessage(
			{
				customType: "compaction_continue",
				content: "Load /taskman skill and /continue the task specified in the handoff.",
				display: false,
			},
			{ triggerTurn: true, ...(deliverAs ? { deliverAs } : {}) },
		);
	}

	function scheduleContinueAfterCompaction(ctx: { isIdle(): boolean; sessionManager: { getLeafId(): string | null } }, compactionEntryId: string): void {
		if (continueMessageSent) return;
		continueMessageSent = true;
		clearContinueMessageTimer();
		continueMessageTimer = setTimeout(() => {
			continueMessageTimer = undefined;
			try {
				const userTurnStarted = ctx.sessionManager.getLeafId() !== compactionEntryId;
				if (!ctx.isIdle()) {
					sendContinueMessage("followUp");
					return;
				}
				sendContinueMessage(userTurnStarted ? "followUp" : undefined);
			} catch {
				// Context may be stale if the user reloaded/switched sessions during compaction.
			}
		}, 1000);
	}

	pi.on("session_compact", (event, ctx) => {
		scheduleContinueAfterCompaction(ctx, event.compactionEntry.id);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		continueMessageSent = false;
		clearContinueMessageTimer();
		const { preparation, signal, customInstructions } = event;
		const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary, fileOps, settings } = preparation;

		// Warn if reserveTokens is too low for multi-turn agent loop
		if (settings.reserveTokens < 25000) {
			ctx.ui.notify(
				`reserveTokens is ${settings.reserveTokens} (recommend ≥25000 for taskman compaction). Add {"compaction":{"reserveTokens":25000}} to settings.json`,
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
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			ctx.ui.notify(`No API key for ${model.provider}/${model.id}, using default compaction`, "warning");
			return;
		}
		const apiKey = auth.apiKey;
		const headers = auth.headers;

		// Combine messages and convert to LLM format.
		// Framework bug workaround: custom compaction can receive an empty summarized
		// span when the computed cut point cannot summarize a complete/split turn.
		// In that case, summarize messages after the last compaction as fallback while
		// still preserving Pi's prepared firstKeptEntryId boundary.
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
		const conversationText = serializeConversation(llmMessages);

		// If still no messages (e.g., immediate re-compaction with <3 entries),
		// return previous summary while retaining Pi's safe recent-message boundary.
		if (!conversationText.trim()) {
			return {
				compaction: {
					summary: previousSummary || "/taskman continue",
					firstKeptEntryId,
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
			? `\n\nUser instructions for next session:\n${customInstructions}`
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
			{
				role: "user" as const,
				content: [{
					type: "text" as const,
					text: `<conversation_to_handoff>\n${conversationText}\n</conversation_to_handoff>\n\n${HANDOFF_REQUEST}${previousContext}${customContext}`,
				}],
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
					{ apiKey, headers, maxTokens, signal, reasoning: "high" },
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
						if (signal.aborted) throw new Error("Compaction cancelled");
						return {
							role: "toolResult" as const,
							toolCallId: tc.id,
							toolName: tc.name,
							content: result.content,
							isError: false,
							timestamp: Date.now(),
						};
					} catch (err) {
						if (signal.aborted) throw err;
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

				if (signal.aborted) throw new Error("Compaction cancelled");

				// Add assistant response and tool results to messages.
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
			if (signal.aborted) return { cancel: true };
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
