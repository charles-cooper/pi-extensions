/**
 * Subagent Tool
 *
 * Spawn subagents with isolated context. Supports:
 * - Single mode: model + task
 * - Parallel mode: tasks array for concurrent execution
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import type { Message } from "@mariozechner/pi-ai";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const MAX_PARALLEL = 8;
const MAX_CONCURRENCY = 4;

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
	messages: Message[];
	usage: UsageStats;
	stopReason?: string;
	errorMessage?: string;
}

interface SubagentDetails {
	mode: "single" | "parallel";
	results: SubagentResult[];
	availableModels?: string[];
}

async function mapWithConcurrency<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let nextIndex = 0;
	const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
		while (nextIndex < items.length) {
			const index = nextIndex++;
			results[index] = await fn(items[index], index);
		}
	});
	await Promise.all(workers);
	return results;
}

type DisplayItem = 
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, unknown> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function formatToolCall(name: string, args: Record<string, unknown>, themeFg: (color: string, text: string) => string): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (name.toLowerCase()) {
		case "bash": {
			const cmd = (args.command as string) || "...";
			const preview = cmd.length > 60 ? `${cmd.slice(0, 60)}...` : cmd;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const filePath = shortenPath((args.path || args.file_path || "...") as string);
			return themeFg("muted", "read ") + themeFg("accent", filePath);
		}
		case "write": {
			const filePath = shortenPath((args.path || args.file_path || "...") as string);
			return themeFg("muted", "write ") + themeFg("accent", filePath);
		}
		case "edit": {
			const filePath = shortenPath((args.path || args.file_path || "...") as string);
			return themeFg("muted", "edit ") + themeFg("accent", filePath);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", name) + themeFg("dim", ` ${preview}`);
		}
	}
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

// Model skills: prefix -> description + ratings (1-10 scale)
interface ModelSkill {
	prefix: string;      // e.g. "openrouter/openai" or "anthropic/claude-sonnet-4-5"
	for: string;         // short description of strengths
	weaknesses?: string; // optional weaknesses
	// Ratings (1-10 scale, higher is better)
	abstract?: number;     // big-picture thinking, architectural reasoning
	detailed?: number;     // step-by-step logic, edge cases, debugging
	toolUse?: number;      // reliable multi-step file/code operations
	instruction?: number;  // follows instructions precisely
	creativity?: number;   // novel approaches, writing quality
	speed?: number;        // response time
	cost?: number;         // cost efficiency (higher = cheaper)
	context?: number;      // context window size
}

function parseSimpleFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) return { frontmatter: {}, body: content };
	
	const frontmatter: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const colonIdx = line.indexOf(":");
		if (colonIdx > 0) {
			const key = line.slice(0, colonIdx).trim();
			const value = line.slice(colonIdx + 1).trim();
			frontmatter[key] = value;
		}
	}
	return { frontmatter, body: match[2] };
}

function loadModelSkills(): ModelSkill[] {
	const skills: ModelSkill[] = [];
	const skillsDir = path.join(os.homedir(), ".pi", "agent", "model-skills");
	
	if (!fs.existsSync(skillsDir)) return skills;
	
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(skillsDir, { withFileTypes: true });
	} catch {
		return skills;
	}
	
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile()) continue;
		
		const filePath = path.join(skillsDir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		
		const { frontmatter } = parseSimpleFrontmatter(content);
		if (frontmatter.model && frontmatter.for) {
			const parseNum = (v: string | undefined): number | undefined => {
				if (!v) return undefined;
				const n = parseInt(v, 10);
				return isNaN(n) ? undefined : n;
			};
			skills.push({
				prefix: frontmatter.model.toLowerCase(),
				for: frontmatter.for,
				weaknesses: frontmatter.weaknesses,
				abstract: parseNum(frontmatter.abstract),
				detailed: parseNum(frontmatter.detailed),
				toolUse: parseNum(frontmatter["tool-use"]),
				instruction: parseNum(frontmatter.instruction),
				creativity: parseNum(frontmatter.creativity),
				speed: parseNum(frontmatter.speed),
				cost: parseNum(frontmatter.cost),
				context: parseNum(frontmatter.context),
			});
		}
	}
	
	// Sort by prefix length descending (more specific matches first)
	skills.sort((a, b) => b.prefix.length - a.prefix.length);
	return skills;
}

function getModelSkill(skills: ModelSkill[], modelId: string): ModelSkill | undefined {
	const id = modelId.toLowerCase();
	// Substring match, longest match wins (skills already sorted by length desc)
	return skills.find(s => id.includes(s.prefix));
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
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
	};

	const emitUpdate = () => onUpdate?.(result);

	let wasAborted = false;

	const exitCode = await new Promise<number>((resolve) => {
		const proc = spawn("pi", args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
		});
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
				result.messages.push(msg);
				if (msg.role === "assistant") {
					result.usage.turns++;
					// Update output to latest text
					result.output = getFinalOutput(result.messages);
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
				}
				emitUpdate();
			}

			// Also capture tool results
			if (event.type === "tool_result_end" && event.message) {
				result.messages.push(event.message as Message);
				emitUpdate();
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
	// Load model skills and enabled models
	const skills = loadModelSkills();
	const enabledModels = readEnabledModels();
	
	// Build model list with skills annotations as XML
	const axesLegend = `  <axes description="ratings 1-10, higher is better">
    <axis name="abstract" description="big-picture thinking, architectural reasoning, conceptual leaps" />
    <axis name="detailed" description="step-by-step logic, edge cases, debugging, attention to detail" />
    <axis name="tool-use" description="reliable multi-step file/code operations" />
    <axis name="instruction" description="follows instructions precisely, format compliance" />
    <axis name="creativity" description="novel approaches, writing quality, thinking outside the box" />
    <axis name="speed" description="response time" />
    <axis name="cost" description="cost efficiency (higher = cheaper)" />
    <axis name="context" description="context window size" />
  </axes>`;

	const formatModelXml = (modelId: string): string => {
		const skill = getModelSkill(skills, modelId);
		if (skill) {
			const attrs: string[] = [`id="${modelId}"`, `for="${skill.for}"`];
			if (skill.weaknesses) attrs.push(`weaknesses="${skill.weaknesses}"`);
			if (skill.abstract !== undefined) attrs.push(`abstract="${skill.abstract}"`);
			if (skill.detailed !== undefined) attrs.push(`detailed="${skill.detailed}"`);
			if (skill.toolUse !== undefined) attrs.push(`tool-use="${skill.toolUse}"`);
			if (skill.instruction !== undefined) attrs.push(`instruction="${skill.instruction}"`);
			if (skill.creativity !== undefined) attrs.push(`creativity="${skill.creativity}"`);
			if (skill.speed !== undefined) attrs.push(`speed="${skill.speed}"`);
			if (skill.cost !== undefined) attrs.push(`cost="${skill.cost}"`);
			if (skill.context !== undefined) attrs.push(`context="${skill.context}"`);
			return `  <model ${attrs.join(" ")} />`;
		}
		return `  <model id="${modelId}" />`;
	};
	
	const modelListXml = enabledModels.length > 0
		? `<available-models>\n${axesLegend}\n${enabledModels.map(formatModelXml).join("\n")}\n</available-models>`
		: "(all models with API keys)";
	
	const modelListShort = enabledModels.join(", ") || "(all models with API keys)";

	const TaskItem = Type.Object({
		model: Type.String({ description: "Model ID" }),
		task: Type.String({ description: "Task instruction" }),
		context: Type.Optional(Type.String({ description: "Optional XML context" })),
		tools: Type.Optional(Type.Array(Type.String(), { description: "Tool names to enable" })),
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			`Spawn a subagent with isolated context. Params: model, task, context (optional), tools (optional array).\n\n${modelListXml}`,
		parameters: Type.Object({
			// Single mode
			model: Type.Optional(Type.String({ description: `Model ID. Available: ${modelListShort}` })),
			task: Type.Optional(Type.String({ description: "The task instruction for the subagent" })),
			context: Type.Optional(Type.String({ description: "Optional XML-structured context to pass" })),
			tools: Type.Optional(Type.Array(Type.String(), { description: "Tool names to enable (default: all)" })),
			// Parallel mode
			tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of tasks for parallel execution (max 8)" })),
		}),

		async execute(_id, params, onUpdate, ctx, signal) {
			const models = getAvailableModels(ctx);
			const availableModels = [...models.keys()];

			const resolveModel = (model: string) => {
				const resolved = models.get(model.toLowerCase());
				if (!resolved) return null;
				return `${resolved.provider}/${resolved.id}`;
			};

			const hasSingle = params.model && params.task;
			const hasParallel = params.tasks && params.tasks.length > 0;

			if (hasSingle === hasParallel) {
				return {
					content: [{ type: "text", text: `Provide either (model + task) or tasks array, not both/neither.\nAvailable models: ${availableModels.join(", ")}` }],
					isError: true,
				};
			}

			// Parallel mode
			if (hasParallel) {
				if (params.tasks!.length > MAX_PARALLEL) {
					return {
						content: [{ type: "text", text: `Too many tasks (${params.tasks!.length}). Max is ${MAX_PARALLEL}.` }],
						isError: true,
					};
				}

				// Validate all models upfront
				for (const t of params.tasks!) {
					if (!resolveModel(t.model)) {
						return {
							content: [{ type: "text", text: `Unknown model "${t.model}". Available: ${availableModels.join(", ")}` }],
							isError: true,
						};
					}
				}

				// Track results for streaming
				const allResults: SubagentResult[] = params.tasks!.map((t) => ({
					model: resolveModel(t.model)!,
					task: t.task,
					context: t.context,
					exitCode: -1, // -1 = running
					output: "",
					messages: [],
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
				}));

				const emitUpdate = () => {
					if (onUpdate) {
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						const running = allResults.length - done;
						onUpdate({
							content: [{ type: "text", text: `${done}/${allResults.length} done, ${running} running...` }],
							details: { mode: "parallel", results: [...allResults], availableModels } as SubagentDetails,
						});
					}
				};

				emitUpdate();

				await mapWithConcurrency(params.tasks!, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSubagent(
						ctx.cwd,
						resolveModel(t.model)!,
						t.task,
						t.context,
						t.tools,
						signal,
						(r) => {
							allResults[index] = r;
							emitUpdate();
						},
					);
					allResults[index] = result;
					emitUpdate();
					return result;
				});

				const successCount = allResults.filter((r) => r.exitCode === 0).length;
				const summaries = allResults.map((r) => {
					const preview = r.output.slice(0, 100) + (r.output.length > 100 ? "..." : "");
					return `[${r.model}] ${r.exitCode === 0 ? "✓" : "✗"}: ${preview || r.errorMessage || "(no output)"}`;
				});

				return {
					content: [{ type: "text", text: `${successCount}/${allResults.length} succeeded\n\n${summaries.join("\n\n")}` }],
					details: { mode: "parallel", results: allResults, availableModels } as SubagentDetails,
					isError: successCount < allResults.length,
				};
			}

			// Single mode
			const modelSpec = resolveModel(params.model!);
			if (!modelSpec) {
				return {
					content: [{ type: "text", text: `Unknown model "${params.model}". Available: ${availableModels.join(", ")}` }],
					isError: true,
				};
			}

			const result = await runSubagent(
				ctx.cwd,
				modelSpec,
				params.task!,
				params.context,
				params.tools,
				signal,
				onUpdate
					? (r) =>
							onUpdate({
								content: [{ type: "text", text: r.output || "(running...)" }],
								details: { mode: "single", results: [r], availableModels } as SubagentDetails,
							})
					: undefined,
			);

			const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";

			return {
				content: [{ type: "text", text: result.output || result.errorMessage || "(no output)" }],
				details: { mode: "single", results: [result], availableModels } as SubagentDetails,
				isError,
			};
		},

		renderCall(args, theme) {
			// Parallel mode
			if (args.tasks && args.tasks.length > 0) {
				let text = theme.fg("toolTitle", theme.bold("subagent "));
				text += theme.fg("accent", `parallel (${args.tasks.length} tasks)`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? t.task.slice(0, 40) + "..." : t.task;
					text += `\n  ${theme.fg("accent", t.model)} ${theme.fg("dim", preview)}`;
				}
				if (args.tasks.length > 3) {
					text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				}
				return new Text(text, 0, 0);
			}

			// Single mode
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
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const aggregateUsage = (results: SubagentResult[]): UsageStats => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			const renderSingleResult = (r: SubagentResult, showHeader: boolean) => {
				const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
				const icon = r.exitCode === -1
					? theme.fg("warning", "⏳")
					: isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);
				const toolCalls = displayItems.filter((i) => i.type === "toolCall");

				const container = new Container();

				if (showHeader) {
					let header = `${icon} ${theme.fg("accent", r.model)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
				}

				if (r.errorMessage) {
					container.addChild(new Text(theme.fg("error", r.errorMessage), 0, 0));
				}

				// Task
				container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

				// Tool calls
				for (const item of toolCalls) {
					if (item.type === "toolCall") {
						container.addChild(new Text(
							theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
							0, 0
						));
					}
				}

				// Output
				if (finalOutput) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
				} else if (r.exitCode === -1) {
					container.addChild(new Text(theme.fg("muted", "(running...)"), 0, 0));
				}

				// Usage
				if (r.exitCode !== -1) {
					container.addChild(new Text(theme.fg("dim", formatUsage(r.usage, r.model)), 0, 0));
				}

				return container;
			};

			// Single mode
			if (details.mode === "single") {
				const r = details.results[0];
				const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");

				if (expanded) {
					const container = new Container();
					const displayItems = getDisplayItems(r.messages);
					const finalOutput = getFinalOutput(r.messages);
					const toolCalls = displayItems.filter((i) => i.type === "toolCall");

					// Header
					let header = `${icon} ${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", r.model)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));

					if (r.errorMessage) {
						container.addChild(new Text(theme.fg("error", r.errorMessage), 0, 0));
					}

					// Task
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));

					// Context
					if (r.context) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("muted", "─── Context ───"), 0, 0));
						container.addChild(new Text(theme.fg("dim", r.context), 0, 0));
					}

					// Tool calls
					if (toolCalls.length > 0) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("muted", "─── Tool Calls ───"), 0, 0));
						for (const item of toolCalls) {
							if (item.type === "toolCall") {
								container.addChild(new Text(
									theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
									0, 0
								));
							}
						}
					}

					// Output
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					const finalOut = getFinalOutput(r.messages);
					if (finalOut) {
						container.addChild(new Markdown(finalOut.trim(), 0, 0, mdTheme));
					} else {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					}

					// Usage
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", formatUsage(r.usage, r.model)), 0, 0));

					return container;
				}

				// Collapsed single
				let text = `${icon} ${theme.fg("accent", r.model)}`;
				if (isError && r.errorMessage) {
					text += ` ${theme.fg("error", r.errorMessage)}`;
				} else if (r.output) {
					const preview = r.output.split("\n").slice(0, 5).join("\n");
					const truncated = r.output.split("\n").length > 5;
					text += "\n" + theme.fg("toolOutput", preview);
					if (truncated) text += "\n" + theme.fg("muted", "... (Ctrl+O to expand)");
				} else {
					text += " " + theme.fg("muted", "(no output)");
				}
				text += "\n" + theme.fg("dim", formatUsage(r.usage, r.model));
				return new Text(text, 0, 0);
			}

			// Parallel mode
			const running = details.results.filter((r) => r.exitCode === -1).length;
			const successCount = details.results.filter((r) => r.exitCode === 0).length;
			const failCount = details.results.filter((r) => r.exitCode > 0).length;
			const isRunning = running > 0;
			const icon = isRunning
				? theme.fg("warning", "⏳")
				: failCount > 0
					? theme.fg("warning", "◐")
					: theme.fg("success", "✓");
			const status = isRunning
				? `${successCount + failCount}/${details.results.length} done, ${running} running`
				: `${successCount}/${details.results.length} succeeded`;

			if (expanded && !isRunning) {
				const container = new Container();
				container.addChild(new Text(
					`${icon} ${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", `parallel ${status}`)}`,
					0, 0
				));

				for (const r of details.results) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "────────────────────"), 0, 0));
					container.addChild(renderSingleResult(r, true));
				}

				const totalUsage = aggregateUsage(details.results);
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", `Total: ${formatUsage(totalUsage, "")}`), 0, 0));

				return container;
			}

			// Collapsed parallel
			let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
			for (const r of details.results) {
				const rIcon = r.exitCode === -1
					? theme.fg("warning", "⏳")
					: r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
				const preview = r.output
					? (r.output.length > 60 ? r.output.slice(0, 60) + "..." : r.output).split("\n")[0]
					: r.exitCode === -1 ? "(running...)" : "(no output)";
				text += `\n${rIcon} ${theme.fg("accent", r.model)} ${theme.fg("dim", preview)}`;
			}
			if (!isRunning) {
				const totalUsage = aggregateUsage(details.results);
				text += `\n${theme.fg("dim", `Total: ${formatUsage(totalUsage, "")}`)}`;
			}
			if (!expanded && !isRunning) {
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
			}
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

			// Let the LLM figure out model vs task
			pi.sendUserMessage(`Use a subagent: ${args.trim()}`);
		},
	});
}
