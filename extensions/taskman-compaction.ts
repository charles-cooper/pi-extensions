/**
 * Taskman Compaction Extension
 *
 * Replaces the default compaction with a taskman /handoff turn.
 * Flow:
 * - Abort the active agent run at a safe threshold
 * - Send a visible handoff prompt into the normal conversation context
 * - After the handoff turn completes, drop prior chat context
 * - Send a visible continue prompt so the next turn resumes from taskman
 *
 * Requires taskman; never falls back to built-in compaction.
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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const AGENT_DIR = getAgentDir();
const HANDOFF_SKILL_PATH = path.join(AGENT_DIR, "skills/taskman/handoff.md");

const REMEMBER_SKILL_PATH = path.join(AGENT_DIR, "skills/taskman/remember.md");

const HANDOFF_REQUEST = `Context is getting long. This is automated taskman compaction.

Treat this exactly like the user pressed Esc, then asked you to run a taskman handoff before starting a fresh session.

Your task:
1. Read the /remember skill from ${REMEMBER_SKILL_PATH} and persist any reusable knowledge (learnings, patterns, decisions) to topics/memory files.
2. Read the /handoff skill from ${HANDOFF_SKILL_PATH} and follow its instructions to save current state.
3. If the previous assistant message was empty/aborted, treat the interrupted work as unfinished unless the current conversation already contains explicit evidence it was completed or persisted.
4. Final response: briefly state that the taskman handoff is complete. Do not continue feature work; after this turn, the extension will compact away chat context and continue from taskman.

IMPORTANT: Do NOT take any action besides updating memory/handoff files. Do NOT modify source code or project files. Only run commands required by the taskman skills, such as taskman sync and git rev-parse for the handoff commit.

You can batch multiple tool calls.`;

function checkTaskmanAvailable(): boolean {
	return fs.existsSync(HANDOFF_SKILL_PATH);
}

type TaskmanCompactionSettings = {
	compactionEnabled: boolean;
	reserveTokens: number;
};

type CompactionPhase = "idle" | "awaiting_handoff_idle" | "handoff_turn" | "awaiting_drop_compaction";

type CompactionInterrupt = {
	reason: string;
	phase: "message_update" | "turn_end";
	timestamp: number;
};

const DEFAULT_TASKMAN_COMPACTION_SETTINGS: TaskmanCompactionSettings = {
	compactionEnabled: true,
	reserveTokens: 16384,
};

// Intentional: taskman compaction writes durable state to .agent-files and returns
// a breadcrumb summary. Keeping Pi's recent-message tail defeats the purpose and
// leaves tens of thousands of tokens after compaction. Pi currently treats an
// unmatched firstKeptEntryId as "keep no prior messages". Do not "fix" this to
// preparation.firstKeptEntryId unless you intentionally want post-compaction bloat.
const DROP_ALL_PRIOR_CONTEXT_AFTER_TASKMAN_HANDOFF = null as unknown as string;

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

function firstBranchEntryId(branchEntries: readonly unknown[]): string | undefined {
	for (const entry of branchEntries) {
		if (!entry || typeof entry !== "object") continue;
		const id = (entry as Record<string, unknown>).id;
		if (typeof id === "string") return id;
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	let phase: CompactionPhase = "idle";
	let scheduledAction = false;
	let pendingInterrupt: CompactionInterrupt | undefined;
	let completedHandoffInterrupt: CompactionInterrupt | undefined;
	let queuedHandoffInstructions = "";
	let continueMessageSent = false;
	let continueMessageTimer: ReturnType<typeof setTimeout> | undefined;

	function contextOverThreshold(ctx: { cwd: string; getContextUsage(): { tokens: number | null; contextWindow: number } | undefined }, extraTokens = 0): boolean {
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null || usage.contextWindow <= 0) return false;
		const settings = getTaskmanCompactionSettings(ctx.cwd);
		if (!settings.compactionEnabled) return false;
		return usage.tokens + extraTokens > usage.contextWindow - settings.reserveTokens;
	}

	function requestHandoffAfterAgent(ctx: { ui: { notify(message: string, level: "info" | "warning" | "error"): void }; abort(): void }, reason: string, interruptPhase: CompactionInterrupt["phase"]): void {
		if (phase !== "idle") return;
		const timestamp = Date.now();
		pendingInterrupt = { reason, phase: interruptPhase, timestamp };
		phase = "awaiting_handoff_idle";
		pi.events.emit("taskman-compaction:abort-suppression-start", { reason, phase: interruptPhase, timestamp });
		ctx.ui.notify(`${reason}; will run taskman handoff after current turn boundary`, "info");
		ctx.abort();
	}

	function scheduleWhenIdle(ctx: { isIdle(): boolean; ui: { notify(message: string, level: "info" | "warning" | "error"): void } }, action: () => void, skippedReason: string, attempt = 0): void {
		if (scheduledAction && attempt === 0) return;
		scheduledAction = true;
		setTimeout(() => {
			if (!ctx.isIdle() && attempt < 50) {
				scheduleWhenIdle(ctx, action, skippedReason, attempt + 1);
				return;
			}
			if (!ctx.isIdle()) {
				scheduledAction = false;
				phase = "idle";
				pi.events.emit("taskman-compaction:abort-suppression-end", { reason: skippedReason, timestamp: Date.now() });
				ctx.ui.notify("Skipped deferred taskman compaction because agent did not become idle", "warning");
				return;
			}
			scheduledAction = false;
			action();
		}, 100);
	}

	function sendHandoffMessage(extraInstructions = ""): void {
		const interrupt = pendingInterrupt;
		const interruptText = interrupt
			? `\n\nCompaction interrupted the active agent run. Reason: ${interrupt.reason}. Interrupt phase: ${interrupt.phase}. Timestamp: ${new Date(interrupt.timestamp).toISOString()}.`
			: "";
		const instructionText = extraInstructions.trim()
			? `\n\nUser compact instructions: ${extraInstructions.trim()}`
			: "";
		phase = "handoff_turn";
		pi.sendMessage(
			{
				customType: "taskman_compaction_handoff",
				content: `${HANDOFF_REQUEST}${interruptText}${instructionText}`,
				display: true,
			},
			{ triggerTurn: true },
		);
	}

	function scheduleHandoff(ctx: { isIdle(): boolean; ui: { notify(message: string, level: "info" | "warning" | "error"): void } }): void {
		scheduleWhenIdle(ctx, () => {
			if (!checkTaskmanAvailable()) {
				ctx.ui.notify("taskman not available. Install: pipx install taskmanager-exe && taskman install-skills", "error");
				phase = "idle";
				return;
			}
			sendHandoffMessage();
		}, "agent-did-not-become-idle");
	}

	function scheduleDropCompaction(ctx: { isIdle(): boolean; compact(options?: { customInstructions?: string; onComplete?: () => void; onError?: (error: Error) => void }): void; ui: { notify(message: string, level: "info" | "warning" | "error"): void } }): void {
		scheduleWhenIdle(ctx, () => {
			ctx.compact({
				customInstructions: "Taskman handoff just completed in the normal conversation context. Do not summarize chat. Drop prior context and continue from taskman.",
				onComplete: () => {
					pi.events.emit("taskman-compaction:abort-suppression-end", { reason: "compaction-complete", timestamp: Date.now() });
				},
				onError: (error) => {
					phase = "idle";
					pi.events.emit("taskman-compaction:abort-suppression-end", { reason: "compaction-error", timestamp: Date.now() });
					ctx.ui.notify(`Deferred taskman compaction failed: ${error.message}`, "warning");
				},
			});
		}, "handoff-agent-did-not-become-idle");
	}

	pi.registerCommand("compact", {
		description: "Run taskman handoff compaction",
		handler: async (args, ctx) => {
			if (!checkTaskmanAvailable()) {
				ctx.ui.notify("taskman not available. Install: pipx install taskmanager-exe && taskman install-skills", "error");
				return;
			}
			if (phase !== "idle") {
				ctx.ui.notify("Taskman compaction is already in progress", "warning");
				return;
			}
			pendingInterrupt = undefined;
			sendHandoffMessage(args);
		},
	});

	pi.on("input", (event, ctx) => {
		if (event.source === "extension") return;
		const text = event.text.trim();
		if (text !== "/compact" && !text.startsWith("/compact ")) return;
		if (!checkTaskmanAvailable()) {
			ctx.ui.notify("taskman not available. Install: pipx install taskmanager-exe && taskman install-skills", "error");
			return { action: "handled" as const };
		}
		if (phase !== "idle") {
			ctx.ui.notify("Taskman compaction is already in progress", "warning");
			return { action: "handled" as const };
		}
		pendingInterrupt = undefined;
		sendHandoffMessage(text.slice("/compact".length));
		return { action: "handled" as const };
	});

	pi.on("message_update", (event, ctx) => {
		if (phase !== "idle") return;
		const outputTokens = assistantOutputTokens((event as any).message);
		if (!contextOverThreshold(ctx, outputTokens)) return;
		requestHandoffAfterAgent(ctx, "Assistant output crossed context safety threshold", "message_update");
	});

	pi.on("turn_end", (_event, ctx) => {
		if (phase !== "idle") return;
		if (!contextOverThreshold(ctx)) return;
		requestHandoffAfterAgent(ctx, "Context is near limit at turn boundary", "turn_end");
	});

	pi.on("agent_end", (_event, ctx) => {
		if (phase === "awaiting_handoff_idle") {
			scheduleHandoff(ctx);
			return;
		}
		if (phase === "handoff_turn") {
			completedHandoffInterrupt = pendingInterrupt;
			pendingInterrupt = undefined;
			phase = "awaiting_drop_compaction";
			scheduleDropCompaction(ctx);
		}
	});

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
				display: true,
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
		const details = event.compactionEntry.details as { mode?: string } | undefined;
		if (details?.mode === "taskman-handoff-queued") {
			sendHandoffMessage(queuedHandoffInstructions);
			queuedHandoffInstructions = "";
			return;
		}
		scheduleContinueAfterCompaction(ctx, event.compactionEntry.id);
	});

	pi.on("session_before_compact", (event, ctx) => {
		continueMessageSent = false;
		clearContinueMessageTimer();
		const { preparation } = event;
		const { tokensBefore, fileOps, settings } = preparation;

		if (settings.reserveTokens < 25000) {
			ctx.ui.notify(
				`reserveTokens is ${settings.reserveTokens} (recommend ≥25000 for taskman compaction). Add {"compaction":{"reserveTokens":25000}} to settings.json`,
				"warning",
			);
		}

		if (!checkTaskmanAvailable()) {
			ctx.ui.notify("taskman not available. Install: pipx install taskmanager-exe && taskman install-skills", "error");
			return { cancel: true };
		}

		if (phase !== "awaiting_drop_compaction") {
			if (phase !== "idle") {
				return {
					compaction: {
						summary: "Taskman compaction is already in progress.",
						firstKeptEntryId: firstBranchEntryId(event.branchEntries) ?? preparation.firstKeptEntryId,
						tokensBefore,
						details: { mode: "taskman-handoff-already-running" },
					},
				};
			}
			queuedHandoffInstructions = event.customInstructions ?? "";
			return {
				compaction: {
					summary: "Taskman handoff queued. Prior context is still available until that handoff completes.",
					firstKeptEntryId: firstBranchEntryId(event.branchEntries) ?? preparation.firstKeptEntryId,
					tokensBefore,
					details: { mode: "taskman-handoff-queued" },
				},
			};
		}

		phase = "idle";
		ctx.ui.notify("Taskman handoff completed; dropping prior chat context", "info");

		const modified = new Set([...fileOps.edited, ...fileOps.written]);
		const readFiles = [...fileOps.read].filter(f => !modified.has(f)).sort();
		const modifiedFiles = [...modified].sort();
		const interrupt = completedHandoffInterrupt;
		completedHandoffInterrupt = undefined;

		return {
			compaction: {
				summary: "Taskman handoff completed. Load /taskman skill and /continue from the handoff.",
				firstKeptEntryId: DROP_ALL_PRIOR_CONTEXT_AFTER_TASKMAN_HANDOFF,
				tokensBefore,
				details: {
					mode: "taskman-handoff-drop",
					readFiles,
					modifiedFiles,
					interrupt,
				},
			},
		};
	});
}
