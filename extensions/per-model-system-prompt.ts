/**
 * Per-Model System Prompt Extension
 *
 * Allows different system prompts for different model families.
 * Create files like SYSTEM.claude.md, SYSTEM.gpt.md, etc.
 *
 * SYSTEM.md resolution (first match wins, replaces base):
 * 1. .pi/SYSTEM.<family>.md (project, model-specific)
 * 2. .pi/SYSTEM.md (project, base)
 * 3. ~/.pi/agent/SYSTEM.<family>.md (global, model-specific)
 * 4. ~/.pi/agent/SYSTEM.md (global, base)
 * 5. Built-in default (no modification)
 *
 * APPEND_SYSTEM.md resolution (additive, all matches concatenated):
 * 1. .pi/APPEND_SYSTEM.md (project base, if exists)
 * 2. .pi/APPEND_SYSTEM.<family>.md (project, model-specific)
 * 3. ~/.pi/agent/APPEND_SYSTEM.md (global base, if exists)
 * 4. ~/.pi/agent/APPEND_SYSTEM.<family>.md (global, model-specific)
 *
 * Model family is detected by substring match in the model ID.
 * Families are discovered from existing SYSTEM.*.md and APPEND_SYSTEM.*.md files.
 * Longest matching family name wins.
 *
 * Examples:
 *   SYSTEM.claude.md        - replaces base for claude-sonnet-4, claude-opus-4, etc.
 *   SYSTEM.gpt.md           - replaces base for gpt-4o, gpt-4-turbo, etc.
 *   APPEND_SYSTEM.claude.md - appends to system prompt for Claude models
 *
 * Usage:
 *   1. Copy to ~/.pi/agent/extensions/ or .pi/extensions/
 *   2. Create SYSTEM.<family>.md and/or APPEND_SYSTEM.<family>.md files
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

interface SystemPromptMatch {
	family: string;
	path: string;
	content: string;
}

interface DiscoveredPrompts {
	/** Map of family name -> file path for SYSTEM.*.md */
	projectFamilies: Map<string, string>;
	globalFamilies: Map<string, string>;
	/** Base SYSTEM.md paths */
	projectBase: string | undefined;
	globalBase: string | undefined;
	/** Map of family name -> file path for APPEND_SYSTEM.*.md */
	projectAppendFamilies: Map<string, string>;
	globalAppendFamilies: Map<string, string>;
	/** Base APPEND_SYSTEM.md paths */
	projectAppendBase: string | undefined;
	globalAppendBase: string | undefined;
}

interface DirectoryDiscovery {
	families: Map<string, string>;
	base: string | undefined;
	appendFamilies: Map<string, string>;
	appendBase: string | undefined;
}

/**
 * Scan a directory for SYSTEM.*.md and APPEND_SYSTEM.*.md files.
 * Returns maps of family -> full path for both types.
 */
function discoverPromptFiles(dir: string): DirectoryDiscovery {
	const families = new Map<string, string>();
	const appendFamilies = new Map<string, string>();
	let base: string | undefined;
	let appendBase: string | undefined;

	if (!fs.existsSync(dir)) {
		return { families, base, appendFamilies, appendBase };
	}

	try {
		const entries = fs.readdirSync(dir);

		for (const entry of entries) {
			if (!entry.endsWith(".md")) continue;

			const fullPath = path.join(dir, entry);

			// Check if it's a file
			try {
				const stat = fs.statSync(fullPath);
				if (!stat.isFile()) continue;
			} catch {
				continue;
			}

			if (entry.startsWith("SYSTEM.")) {
				if (entry === "SYSTEM.md") {
					base = fullPath;
				} else {
					// Extract family: SYSTEM.claude.md -> claude
					const family = entry.slice(7, -3); // Remove "SYSTEM." and ".md"
					if (family.length > 0) {
						families.set(family.toLowerCase(), fullPath);
					}
				}
			} else if (entry.startsWith("APPEND_SYSTEM.")) {
				if (entry === "APPEND_SYSTEM.md") {
					appendBase = fullPath;
				} else {
					// Extract family: APPEND_SYSTEM.claude.md -> claude
					const family = entry.slice(14, -3); // Remove "APPEND_SYSTEM." and ".md"
					if (family.length > 0) {
						appendFamilies.set(family.toLowerCase(), fullPath);
					}
				}
			}
		}
	} catch {
		// Directory read failed, return empty
	}

	return { families, base, appendFamilies, appendBase };
}

/**
 * Find the best matching family for a model ID.
 * Longest match wins (e.g., "claude-sonnet" beats "claude").
 */
function findMatchingFamily(modelId: string, families: Map<string, string>): string | undefined {
	const lower = modelId.toLowerCase();

	// Filter to families that match, sort by length descending
	const matches = Array.from(families.keys())
		.filter((family) => lower.includes(family))
		.sort((a, b) => b.length - a.length);

	return matches[0];
}

/**
 * Read file content, return undefined on error.
 */
function readFile(filePath: string): string | undefined {
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return undefined;
	}
}

/**
 * Resolve the system prompt for a given model.
 * Returns the content and source path, or undefined to use default.
 */
function resolveSystemPrompt(
	modelId: string,
	discovered: DiscoveredPrompts
): SystemPromptMatch | undefined {
	// 1. Project model-specific
	const projectFamily = findMatchingFamily(modelId, discovered.projectFamilies);
	if (projectFamily) {
		const filePath = discovered.projectFamilies.get(projectFamily)!;
		const content = readFile(filePath);
		if (content !== undefined) {
			return { family: projectFamily, path: filePath, content };
		}
	}

	// 2. Project base
	if (discovered.projectBase) {
		const content = readFile(discovered.projectBase);
		if (content !== undefined) {
			return { family: "(base)", path: discovered.projectBase, content };
		}
	}

	// 3. Global model-specific
	const globalFamily = findMatchingFamily(modelId, discovered.globalFamilies);
	if (globalFamily) {
		const filePath = discovered.globalFamilies.get(globalFamily)!;
		const content = readFile(filePath);
		if (content !== undefined) {
			return { family: globalFamily, path: filePath, content };
		}
	}

	// 4. Global base
	if (discovered.globalBase) {
		const content = readFile(discovered.globalBase);
		if (content !== undefined) {
			return { family: "(base)", path: discovered.globalBase, content };
		}
	}

	// 5. No custom system prompt found, use built-in
	return undefined;
}

/**
 * Resolve append content for a given model.
 * Returns concatenated content from all matching APPEND_SYSTEM files.
 * Order: project base, project family, global base, global family.
 */
function resolveAppendContent(
	modelId: string,
	discovered: DiscoveredPrompts
): { content: string; sources: string[] } | undefined {
	const parts: string[] = [];
	const sources: string[] = [];

	// 1. Project base append
	if (discovered.projectAppendBase) {
		const content = readFile(discovered.projectAppendBase);
		if (content) {
			parts.push(content);
			sources.push(discovered.projectAppendBase);
		}
	}

	// 2. Project model-specific append
	const projectFamily = findMatchingFamily(modelId, discovered.projectAppendFamilies);
	if (projectFamily) {
		const filePath = discovered.projectAppendFamilies.get(projectFamily)!;
		const content = readFile(filePath);
		if (content) {
			parts.push(content);
			sources.push(filePath);
		}
	}

	// 3. Global base append
	if (discovered.globalAppendBase) {
		const content = readFile(discovered.globalAppendBase);
		if (content) {
			parts.push(content);
			sources.push(discovered.globalAppendBase);
		}
	}

	// 4. Global model-specific append
	const globalFamily = findMatchingFamily(modelId, discovered.globalAppendFamilies);
	if (globalFamily) {
		const filePath = discovered.globalAppendFamilies.get(globalFamily)!;
		const content = readFile(filePath);
		if (content) {
			parts.push(content);
			sources.push(filePath);
		}
	}

	if (parts.length === 0) {
		return undefined;
	}

	return { content: parts.join("\n\n"), sources };
}

export default function perModelSystemPromptExtension(pi: ExtensionAPI) {
	let discovered: DiscoveredPrompts = {
		projectFamilies: new Map(),
		globalFamilies: new Map(),
		projectBase: undefined,
		globalBase: undefined,
		projectAppendFamilies: new Map(),
		globalAppendFamilies: new Map(),
		projectAppendBase: undefined,
		globalAppendBase: undefined,
	};

	let currentModelId: string | undefined;
	let resolvedPrompt: SystemPromptMatch | undefined;
	let resolvedAppend: { content: string; sources: string[] } | undefined;

	/**
	 * Scan for SYSTEM.*.md and APPEND_SYSTEM.*.md files.
	 */
	function scanForSystemPrompts(cwd: string): void {
		const projectDir = path.join(cwd, ".pi");
		const globalDir = getAgentDir();

		const project = discoverPromptFiles(projectDir);
		const global = discoverPromptFiles(globalDir);

		discovered = {
			projectFamilies: project.families,
			globalFamilies: global.families,
			projectBase: project.base,
			globalBase: global.base,
			projectAppendFamilies: project.appendFamilies,
			globalAppendFamilies: global.appendFamilies,
			projectAppendBase: project.appendBase,
			globalAppendBase: global.appendBase,
		};

		// Log discovered families
		const allFamilies = new Set([
			...discovered.projectFamilies.keys(),
			...discovered.globalFamilies.keys(),
			...discovered.projectAppendFamilies.keys(),
			...discovered.globalAppendFamilies.keys(),
		]);

		if (allFamilies.size > 0) {
			console.log(`[per-model-prompt] Found families: ${Array.from(allFamilies).join(", ")}`);
		}
	}

	/**
	 * Update resolved prompts based on current model.
	 */
	function updateResolvedPrompt(ctx: ExtensionContext): void {
		if (!currentModelId) {
			resolvedPrompt = undefined;
			resolvedAppend = undefined;
			return;
		}

		resolvedPrompt = resolveSystemPrompt(currentModelId, discovered);
		resolvedAppend = resolveAppendContent(currentModelId, discovered);

		// Update status bar
		if (resolvedPrompt || resolvedAppend) {
			const parts: string[] = [];
			if (resolvedPrompt) {
				parts.push(
					resolvedPrompt.family === "(base)" ? "SYSTEM.md" : `SYSTEM.${resolvedPrompt.family}.md`
				);
			}
			if (resolvedAppend) {
				parts.push(`+${resolvedAppend.sources.length} append`);
			}
			ctx.ui.setStatus("system-prompt", `📝 ${parts.join(" ")}`);
		} else {
			ctx.ui.setStatus("system-prompt", undefined);
		}

		// Log what we're using
		if (resolvedPrompt) {
			const relativePath = resolvedPrompt.path.replace(process.env.HOME || "~", "~");
			console.log(
				`[per-model-prompt] Using ${relativePath} for ${currentModelId} (family: ${resolvedPrompt.family})`
			);
		}
		if (resolvedAppend) {
			for (const source of resolvedAppend.sources) {
				const relativePath = source.replace(process.env.HOME || "~", "~");
				console.log(`[per-model-prompt] Appending ${relativePath}`);
			}
		}
	}

	// Scan on session start
	pi.on("session_start", async (_event, ctx) => {
		scanForSystemPrompts(ctx.cwd);

		// Get current model if available
		if (ctx.model) {
			currentModelId = ctx.model.id;
			updateResolvedPrompt(ctx);
		}
	});

	// Track model changes
	pi.on("model_select", async (event, ctx) => {
		currentModelId = event.model.id;
		updateResolvedPrompt(ctx);
	});

	// Modify system prompt if we have matches
	pi.on("before_agent_start", async (event, _ctx) => {
		if (!resolvedPrompt && !resolvedAppend) {
			// No custom prompt, use built-in
			return;
		}

		let systemPrompt = event.systemPrompt;

		// Replace base if we have a custom SYSTEM.*.md
		if (resolvedPrompt) {
			systemPrompt = resolvedPrompt.content;
		}

		// Append model-specific content
		if (resolvedAppend) {
			systemPrompt = systemPrompt + "\n\n" + resolvedAppend.content;
		}

		return { systemPrompt };
	});
}
