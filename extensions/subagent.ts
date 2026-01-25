/**
 * Simple Subagent Tool
 *
 * Spawn a subagent with isolated context. The parent LLM provides:
 * - model: which model to use (from scoped models)
 * - task: the instruction
 * - context: optional XML-structured context
 * - tools: optional tool restriction
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Message } from "@mariozechner/pi-ai";
import { Container, Markdown, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

interface SubagentResult {
	model: string;
	task: string;
	context?: string;
	exitCode: number;
	output: string;
	usage: UsageStats;
	stopReason?: string;
	errorMessage?: string;
	availableModels?: string[];
}

function formatTokens(n: number): string {
	if (n < 1000) return n.toString();
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	return `${Math.round(n / 1000)}k`;
}

function formatUsage(u: UsageStats, model: string): string {
	const parts: string[] = [];
	if (u.turns) parts.push(`${u.turns} turn${u.turns > 1 ? "s" : ""}`);
	if (u.input) parts.push(`↑${formatTokens(u.input)}`);
	if (u.output) parts.push(`↓${formatTokens(u.output)}`);
	if (u.cacheRead) parts.push(`R${formatTokens(u.cacheRead)}`);
	if (u.cacheWrite) parts.push(`W${formatTokens(u.cacheWrite)}`);
	if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
	parts.push(model);
	return parts.join(" ");
}

// Read enabledModels from settings.json directly since scoped models
// aren't exposed in the extension API
function readEnabledModels(): string[] {
	try {
		const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
		const content = fs.readFileSync(settingsPath, "utf-8");
		const settings = JSON.parse(content);
		return settings.enabledModels ?? [];
	} catch {
		return [];
	}
}

function getAvailableModels(ctx: ExtensionContext): Map<string, { provider: string; id: string }> {
	const models = new Map<string, { provider: string; id: string }>();
	const enabledModels = readEnabledModels();
	// Normalize to lowercase set for exact matching
	const enabledSet = new Set(enabledModels.map((m) => m.toLowerCase()));

	for (const model of ctx.modelRegistry.getAvailable()) {

		const fullSpec = `${model.provider}/${model.id}`.toLowerCase();

		// If enabledModels is set, only include exact matches
		if (enabledSet.size > 0 && !enabledSet.has(fullSpec)) {
			continue;
		}

		// Key by full spec (provider/id) for unambiguous lookup
		models.set(fullSpec, { provider: model.provider, id: model.id });
	}

	return models;
}

async function runSubagent(
	cwd: string,
	model: string,
	task: string,
	context: string | undefined,
	tools: string[] | undefined,
	signal: AbortSignal | undefined,
	onUpdate: ((result: SubagentResult) => void) | undefined,
): Promise<SubagentResult> {
	const args = ["--mode", "json", "-p", "--no-session", "--model", model];

	if (tools && tools.length > 0) {
		args.push("--tools", tools.join(","));
	}

	// Build the prompt
	let prompt = "";
	if (context) {
		prompt += `<context>\n${context}\n</context>\n\n`;
	}
	prompt += `Task: ${task}`;
	args.push(prompt);

	const result: SubagentResult = {
		model,
		task,
		context,
		exitCode: 0,
		output: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
	};

	const emitUpdate = () => onUpdate?.(result);

	let wasAborted = false;

	const exitCode = await new Promise<number>((resolve) => {
		const proc = spawn("pi", args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let buffer = "";
		let stderr = "";

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}

			if (event.type === "message_end" && event.message) {
				const msg = event.message as Message;
				if (msg.role === "assistant") {
					result.usage.turns++;
					// Extract final text
					for (const part of msg.content) {
						if (part.type === "text") {
							result.output = part.text;
						}
					}
					const usage = msg.usage;
					if (usage) {
						result.usage.input += usage.input || 0;
						result.usage.output += usage.output || 0;
						result.usage.cacheRead += usage.cacheRead || 0;
						result.usage.cacheWrite += usage.cacheWrite || 0;
						result.usage.cost += usage.cost?.total || 0;
					}
					if (msg.stopReason) result.stopReason = msg.stopReason;
					if (msg.errorMessage) result.errorMessage = msg.errorMessage;
					emitUpdate();
				}
			}
		};

		proc.stdout.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});

		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});

		proc.on("close", (code) => {
			if (buffer.trim()) processLine(buffer);
			if (code !== 0 && !result.errorMessage) {
				result.errorMessage = stderr.trim() || `Exit code ${code}`;
			}
			resolve(code ?? 0);
		});

		proc.on("error", (err) => {
			result.errorMessage = err.message;
			resolve(1);
		});

		if (signal) {
			const kill = () => {
				wasAborted = true;
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 3000);
			};
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}
	});

	result.exitCode = exitCode;
	if (wasAborted) {
		result.stopReason = "aborted";
		result.errorMessage = "Aborted by user";
	}

	return result;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Spawn a subagent with isolated context. Params: model (full model ID from available models), task (instruction), context (optional, XML-structured context), tools (optional array).",
		parameters: Type.Object({
			model: Type.String({ description: "Full model ID from available models list" }),
			task: Type.String({ description: "The task instruction for the subagent" }),
			context: Type.Optional(Type.String({ description: "Optional XML-structured context to pass" })),
			tools: Type.Optional(Type.Array(Type.String(), { description: "Tool names to enable (default: all)" })),
		}),

		async execute(_id, params, onUpdate, ctx, signal) {
			const models = getAvailableModels(ctx);
			const resolved = models.get(params.model.toLowerCase());

			if (!resolved) {
				const available = [...models.keys()].join(", ");
				return {
					content: [{ type: "text", text: `Unknown model "${params.model}". Available: ${available}` }],
					isError: true,
				};
			}

			const modelSpec = `${resolved.provider}/${resolved.id}`;

			const result = await runSubagent(
				ctx.cwd,
				modelSpec,
				params.task,
				params.context,
				params.tools,
				signal,
				onUpdate
					? (r) =>
							onUpdate({
								content: [{ type: "text", text: r.output || "(running...)" }],
								details: r,
							})
					: undefined,
			);

			const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
			result.availableModels = [...models.keys()];

			return {
				content: [{ type: "text", text: result.output || result.errorMessage || "(no output)" }],
				details: result,
				isError,
			};
		},

		renderCall(args, theme) {
			const model = args.model || "?";
			const task = args.task || "...";
			const preview = task.length > 60 ? task.slice(0, 60) + "..." : task;

			let text = theme.fg("toolTitle", theme.bold("subagent "));
			text += theme.fg("accent", model);
			if (args.tools?.length) {
				text += theme.fg("muted", ` [${args.tools.join(", ")}]`);
			}
			text += "\n" + theme.fg("dim", preview);
			if (args.context) {
				const lines = args.context.split("\n").length;
				text += "\n" + theme.fg("muted", `(+${lines} lines context)`);
			}

			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as SubagentResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const isError = details.exitCode !== 0 || details.stopReason === "error" || details.stopReason === "aborted";
			const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");

			if (expanded) {
				const container = new Container();

				// Header
				let header = `${icon} ${theme.fg("toolTitle", theme.bold("subagent "))}`;
				header += theme.fg("accent", details.model);
				if (isError && details.stopReason) {
					header += ` ${theme.fg("error", `[${details.stopReason}]`)}`;
				}
				container.addChild(new Text(header, 0, 0));

				// Error
				if (details.errorMessage) {
					container.addChild(new Text(theme.fg("error", details.errorMessage), 0, 0));
				}

				// Task
				container.addChild(new Text("\n" + theme.fg("muted", "─── Task ───"), 0, 0));
				container.addChild(new Text(theme.fg("dim", details.task), 0, 0));

				// Context
				if (details.context) {
					container.addChild(new Text("\n" + theme.fg("muted", "─── Context ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", details.context), 0, 0));
				}

				// Output
				container.addChild(new Text("\n" + theme.fg("muted", "─── Output ───"), 0, 0));
				if (details.output) {
					container.addChild(new Markdown(details.output, 0, 0));
				} else {
					container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
				}

				// Usage
				const usage = formatUsage(details.usage, details.model);
				container.addChild(new Text("\n" + theme.fg("dim", usage), 0, 0));

				return container;
			}

			// Collapsed
			let text = `${icon} ${theme.fg("accent", details.model)}`;
			if (isError && details.errorMessage) {
				text += ` ${theme.fg("error", details.errorMessage)}`;
			} else if (details.output) {
				const preview = details.output.split("\n").slice(0, 5).join("\n");
				const truncated = details.output.split("\n").length > 5;
				text += "\n" + theme.fg("toolOutput", preview);
				if (truncated) text += "\n" + theme.fg("muted", "... (Ctrl+O to expand)");
			} else {
				text += " " + theme.fg("muted", "(no output)");
			}
			text += "\n" + theme.fg("dim", formatUsage(details.usage, details.model));

			return new Text(text, 0, 0);
		},
	});

	// Command: /subagent <model> <task>
	pi.registerCommand("subagent", {
		description: "Delegate to a subagent: /subagent <model> <task>",
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				const models = getAvailableModels(ctx);
				ctx.ui.notify(`Usage: /subagent <model> <task>\nModels: ${[...models.keys()].join(", ")}`, "info");
				return;
			}

			const parts = args.trim().split(/\s+/);
			const model = parts[0];
			const task = parts.slice(1).join(" ");

			if (!task) {
				ctx.ui.notify("Usage: /subagent <model> <task>", "error");
				return;
			}

			// Send as user message to trigger the LLM to use the tool
			pi.sendUserMessage(`Use a ${model} subagent to: ${task}`);
		},
	});
}
