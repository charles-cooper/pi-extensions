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
import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme, getLanguageFromPath, highlightCode } from "@mariozechner/pi-coding-agent";
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
	/** Partial message during streaming (contains in-progress tool calls) */
	partialMessage?: Message;
	usage: UsageStats;
	stopReason?: string;
	errorMessage?: string;
}

interface SubagentDetails {
	mode: "single" | "parallel";
	results: SubagentResult[];
	availableModels?: string[];
}

/** Check if a subagent result is an error (used consistently throughout) */
function isResultError(r: SubagentResult): boolean {
	return r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
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

interface ToolCallWithResult {
	type: "toolCall";
	id: string;
	name: string;
	args: Record<string, unknown>;
	result?: {
		content: Array<{ type: string; text?: string }>;
		isError: boolean;
	};
}

type DisplayItem = 
	| { type: "text"; text: string }
	| ToolCallWithResult;

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	// First pass: collect tool calls
	const toolCalls = new Map<string, ToolCallWithResult>();
	
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") {
					items.push({ type: "text", text: part.text });
				} else if (part.type === "toolCall") {
					const tc: ToolCallWithResult = {
						type: "toolCall",
						id: part.id,
						name: part.name,
						args: part.arguments
					};
					toolCalls.set(part.id, tc);
					items.push(tc);
				}
			}
		} else if (msg.role === "toolResult") {
			// Match result to its call
			const tc = toolCalls.get(msg.toolCallId);
			if (tc) {
				tc.result = {
					content: msg.content as Array<{ type: string; text?: string }>,
					isError: msg.isError
				};
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

/** Get messages for display, including partial streaming message if present */
function getDisplayMessages(r: SubagentResult): Message[] {
	return r.partialMessage ? [r.partialMessage, ...r.messages] : r.messages;
}

function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function formatToolCall(name: string, args: Record<string, unknown>, themeFg: (color: string, text: string) => string): string {
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

/** Render a tool call with full details (for expanded view) */
function renderToolCallExpanded(
	name: string,
	args: Record<string, unknown>,
	result: { content: Array<{ type: string; text?: string }>; isError: boolean } | undefined,
	theme: { fg: (color: string, text: string) => string; bold: (text: string) => string }
): Container {
	const container = new Container();
	const lowerName = name.toLowerCase();

	// Helper to get text from result
	const getResultText = (): string => {
		if (!result) return "";
		return result.content
			.filter(c => c.type === "text" && c.text)
			.map(c => c.text!)
			.join("\n");
	};

	switch (lowerName) {
		case "bash": {
			const cmd = (args.command as string) || "...";
			const timeout = args.timeout as number | undefined;
			let header = theme.fg("muted", "$ ") + theme.fg("toolOutput", cmd);
			if (timeout) header += theme.fg("dim", ` (timeout ${timeout}s)`);
			container.addChild(new Text(header, 0, 0));
			// Show bash output
			const output = getResultText();
			if (output) {
				const lines = output.split("\n");
				const maxLines = 10;
				const displayLines = lines.slice(0, maxLines);
				const remaining = lines.length - maxLines;
				container.addChild(new Text(theme.fg("dim", displayLines.join("\n")), 0, 0));
				if (remaining > 0) {
					container.addChild(new Text(theme.fg("muted", `... (${remaining} more lines)`), 0, 0));
				}
			}
			break;
		}
		case "read": {
			const rawPath = (args.path || args.file_path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let pathDisplay = theme.fg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				pathDisplay += theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			container.addChild(new Text(theme.fg("muted", "read ") + pathDisplay, 0, 0));
			// Show file content from result
			const content = getResultText();
			if (content) {
				const lang = getLanguageFromPath(rawPath);
				const lines = content.split("\n");
				const maxLines = 15;
				const displayLines = lines.slice(0, maxLines);
				const remaining = lines.length - maxLines;
				try {
					if (lang) {
						const highlighted = highlightCode(displayLines.join("\n"), lang);
						container.addChild(new Text(highlighted.join("\n"), 0, 0));
					} else {
						container.addChild(new Text(theme.fg("toolOutput", displayLines.join("\n")), 0, 0));
					}
				} catch {
					container.addChild(new Text(theme.fg("toolOutput", displayLines.join("\n")), 0, 0));
				}
				if (remaining > 0) {
					container.addChild(new Text(theme.fg("muted", `... (${remaining} more lines)`), 0, 0));
				}
			}
			break;
		}
		case "write": {
			const rawPath = (args.path || args.file_path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content as string) || "";
			container.addChild(new Text(theme.fg("muted", "write ") + theme.fg("accent", filePath), 0, 0));
			if (content) {
				const lines = content.split("\n");
				const maxLines = 15;
				const displayLines = lines.slice(0, maxLines);
				const remaining = lines.length - maxLines;
				
				// Try syntax highlighting, fall back to plain
				const lang = getLanguageFromPath(rawPath);
				try {
					if (lang) {
						const highlighted = highlightCode(displayLines.join("\n"), lang);
						container.addChild(new Text(highlighted.join("\n"), 0, 0));
					} else {
						container.addChild(new Text(theme.fg("toolOutput", displayLines.join("\n")), 0, 0));
					}
				} catch {
					container.addChild(new Text(theme.fg("toolOutput", displayLines.join("\n")), 0, 0));
				}
				if (remaining > 0) {
					container.addChild(new Text(theme.fg("muted", `... (${remaining} more lines)`), 0, 0));
				}
			}
			break;
		}
		case "edit": {
			const rawPath = (args.path || args.file_path || "...") as string;
			const filePath = shortenPath(rawPath);
			const oldText = (args.oldText as string) || "";
			const newText = (args.newText as string) || "";
			container.addChild(new Text(theme.fg("muted", "edit ") + theme.fg("accent", filePath), 0, 0));
			
			// Show old/new text as simple diff-like display
			if (oldText || newText) {
				const allOldLines = oldText.split("\n");
				const allNewLines = newText.split("\n");
				const oldLines = allOldLines.slice(0, 10);
				const newLines = allNewLines.slice(0, 10);
				const oldRemaining = allOldLines.length - oldLines.length;
				const newRemaining = allNewLines.length - newLines.length;
				
				if (oldText) {
					container.addChild(new Text(oldLines.map(l => theme.fg("error", "- " + l)).join("\n"), 0, 0));
					if (oldRemaining > 0) {
						container.addChild(new Text(theme.fg("muted", `  ... (${oldRemaining} more lines)`), 0, 0));
					}
				}
				if (newText) {
					container.addChild(new Text(newLines.map(l => theme.fg("success", "+ " + l)).join("\n"), 0, 0));
					if (newRemaining > 0) {
						container.addChild(new Text(theme.fg("muted", `  ... (${newRemaining} more lines)`), 0, 0));
					}
				}
			}
			break;
		}
		default: {
			// For unknown tools, show name and formatted JSON args
			container.addChild(new Text(theme.fg("accent", theme.bold(name)), 0, 0));
			const argsStr = JSON.stringify(args, null, 2);
			const lines = argsStr.split("\n").slice(0, 20);
			const remaining = argsStr.split("\n").length - lines.length;
			container.addChild(new Text(theme.fg("dim", lines.join("\n")), 0, 0));
			if (remaining > 0) {
				container.addChild(new Text(theme.fg("muted", `... (${remaining} more lines)`), 0, 0));
			}
			break;
		}
	}

	return container;
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
		// Tool names are case-sensitive (lowercase)
		args.push("--tools", tools.map(t => t.toLowerCase()).join(","));
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
		exitCode: -1, // -1 = still running
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
				// Clear partial - it's now in messages
				result.partialMessage = undefined;
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

			// Capture tool calls as they complete (for intermediate traces)
			if (event.type === "message_update" && event.assistantMessageEvent?.type === "toolcall_end") {
				// Update the partial message in-place for intermediate display
				result.partialMessage = event.message as Message;
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

		let hasExited = false;
		let killTimeout: ReturnType<typeof setTimeout> | undefined;
		
		const abortHandler = () => {
			wasAborted = true;
			proc.kill("SIGTERM");
			killTimeout = setTimeout(() => {
				if (!hasExited) proc.kill("SIGKILL");
			}, 3000);
		};

		proc.on("close", (code, sig) => {
			hasExited = true;
			if (killTimeout) clearTimeout(killTimeout);
			if (signal) signal.removeEventListener("abort", abortHandler);
			
			if (buffer.trim()) processLine(buffer);
			
			// Handle signal kills (code is null when killed by signal)
			if (sig) {
				if (!result.errorMessage) result.errorMessage = `Killed by ${sig}`;
				resolve(1);
			} else if (code !== 0 && !result.errorMessage) {
				result.errorMessage = stderr.trim() || `Exit code ${code}`;
				resolve(code ?? 1);
			} else {
				resolve(code ?? 0);
			}
		});

		proc.on("error", (err) => {
			result.errorMessage = err.message;
			resolve(1);
		});

		if (signal) {
			if (signal.aborted) abortHandler();
			else signal.addEventListener("abort", abortHandler, { once: true });
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

				const successCount = allResults.filter((r) => !isResultError(r)).length;
				const fullOutputs = allResults.map((r, i) => {
					const status = isResultError(r) ? "✗" : "✓";
					const header = `[${i + 1}/${allResults.length}] ${status} ${r.model}`;
					const body = r.output || r.errorMessage || "(no output)";
					return `${header}\n${body}`;
				});

				return {
					content: [{ type: "text", text: `${successCount}/${allResults.length} succeeded\n\n${fullOutputs.join("\n\n---\n\n")}` }],
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

			return {
				content: [{ type: "text", text: result.output || result.errorMessage || "(no output)" }],
				details: { mode: "single", results: [result], availableModels } as SubagentDetails,
				isError: isResultError(result),
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

			let text = theme.fg("toolTitle", theme.bold("subagent "));
			text += theme.fg("accent", model);
			if (args.tools?.length) {
				text += theme.fg("muted", ` [${args.tools.join(", ")}]`);
			}
			text += "\n" + theme.fg("dim", task);
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

			const renderSingleResult = (r: SubagentResult, showHeader: boolean, showExpanded: boolean) => {
				const isError = r.exitCode !== -1 && isResultError(r);
				const icon = r.exitCode === -1
					? theme.fg("warning", "⏳")
					: isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(getDisplayMessages(r));
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
						if (showExpanded) {
							container.addChild(new Spacer(1));
							container.addChild(renderToolCallExpanded(item.name, item.args, item.result, theme));
						} else {
							container.addChild(new Text(
								theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
								0, 0
							));
						}
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
				const isRunning = r.exitCode === -1;
				const isError = !isRunning && isResultError(r);
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: isError ? theme.fg("error", "✗") : theme.fg("success", "✓");

				if (expanded) {
					const container = new Container();
					const displayItems = getDisplayItems(getDisplayMessages(r));
					const finalOutput = getFinalOutput(r.messages);
					const toolCalls = displayItems.filter((i) => i.type === "toolCall");

					// Just show status icon + error if any (model/task already in renderCall)
					if (isError) {
						let statusLine = icon;
						if (r.stopReason) statusLine += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
						if (r.errorMessage) statusLine += ` ${theme.fg("error", r.errorMessage)}`;
						container.addChild(new Text(statusLine, 0, 0));
					}

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
								container.addChild(new Spacer(1));
								container.addChild(renderToolCallExpanded(item.name, item.args, item.result, theme));
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
			const done = details.results.filter((r) => r.exitCode !== -1);
			const successCount = done.filter((r) => !isResultError(r)).length;
			const failCount = done.filter((r) => isResultError(r)).length;
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
					container.addChild(renderSingleResult(r, true, true));
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
					: isResultError(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
				let preview: string;
				if (r.output) {
					preview = (r.output.length > 60 ? r.output.slice(0, 60) + "..." : r.output).split("\n")[0];
				} else if (r.exitCode === -1) {
					// Show tool call activity while running
					const toolCalls = getDisplayItems(getDisplayMessages(r)).filter(i => i.type === "toolCall");
					if (toolCalls.length > 0) {
						const last = toolCalls[toolCalls.length - 1];
						if (last.type === "toolCall") {
							const name = last.name.toLowerCase();
							if (name === "bash") {
								const cmd = (last.args.command as string) || "";
								preview = `$ ${cmd.slice(0, 40)}${cmd.length > 40 ? "..." : ""}`;
							} else if (name === "read" || name === "write" || name === "edit") {
								const p = shortenPath((last.args.path || last.args.file_path || "") as string);
								preview = `${name} ${p}`;
							} else {
								preview = `${name}...`;
							}
						} else {
							preview = "(running...)";
						}
					} else {
						preview = "(starting...)";
					}
				} else {
					preview = "(no output)";
				}
				text += `\n${rIcon} ${theme.fg("accent", r.model)} ${theme.fg("dim", preview)}`;
			}
			if (!isRunning) {
				const totalUsage = aggregateUsage(details.results);
				text += `\n${theme.fg("dim", `Total: ${formatUsage(totalUsage, "")}`)}`;
			}
			if (!expanded) {
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
