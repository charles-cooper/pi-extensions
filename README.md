# pi-extensions

Personal extensions for [pi coding agent](https://github.com/badlogic/pi-mono).

## Install

```bash
./install.sh
```

Copies all `extensions/*.ts` to `~/.pi/agent/extensions/`.

---

## extensions/subagent.ts

Spawn subagents with isolated context. The LLM can delegate tasks to other models.

- Single or parallel execution (up to 8 tasks, 4 concurrent)
- Uses scoped models from `~/.pi/agent/settings.json`
- Supports tool restrictions per subagent
- Streams progress and tracks usage/cost
- Model skills annotations help pick the right model

### Model Skills

Define model capabilities in `~/.pi/agent/model-skills/*.md`:

```markdown
# ~/.pi/agent/model-skills/claude-sonnet.md
---
model: claude-sonnet
for: tool use, coding, fast execution
weaknesses: complex abstract reasoning
abstract: 6
detailed: 7
tool-use: 9
instruction: 8
creativity: 6
speed: 8
cost: 7
context: 7
---
```

**Fields:**
- `model`: substring to match (longest match wins)
- `for`: short description of strengths
- `weaknesses`: optional limitations
- Ratings (1-10, higher is better):
  - `abstract`: big-picture thinking, architectural reasoning
  - `detailed`: step-by-step logic, edge cases, debugging
  - `tool-use`: reliable multi-step file/code operations
  - `instruction`: follows instructions precisely
  - `creativity`: novel approaches, writing quality
  - `speed`: response time
  - `cost`: cost efficiency (higher = cheaper)
  - `context`: context window size

The tool description shows an XML schema with all axes defined, helping the orchestrating agent pick the right model for each task.

### Usage

**Via LLM tool call:**
```
Single: { model: "anthropic/claude-sonnet-4-5", task: "..." }
Parallel: { tasks: [{ model: "...", task: "..." }, ...] }
```

**Via slash command:**
```
/subagent claude-sonnet review this PR
```

### Rendering

- Collapsed view shows output preview (5 lines)
- Expanded view (Ctrl+O) shows task, tool calls, full output
- Status icons: ✓ success, ✗ error, ⏳ running, ◐ partial

---

## extensions/per-model-system-prompt.ts

Per-model system prompts. Different models get different instructions.

### Why?

Different models need different prompting:
- Claude works well with XML tags and `<thinking>` blocks
- GPT models may need more explicit guardrails
- Some models have bad habits that need specific "NEVER do X" rules

### Usage

Create files in `.pi/` (project) or `~/.pi/agent/` (global):

```
~/.pi/agent/
├── SYSTEM.claude.md         # Replaces base prompt for Claude
├── SYSTEM.gpt.md            # Replaces base prompt for GPT
├── APPEND_SYSTEM.claude.md  # Appends to prompt for Claude
└── APPEND_SYSTEM.gpt.md     # Appends to prompt for GPT
```

### Example files

**SYSTEM.claude.md** (replaces entire base prompt):
```markdown
You are an expert coding assistant optimized for Claude.

Use XML tags for structured output.
Think step-by-step in <thinking> blocks before complex operations.

NEVER use `git add -A` or `git add .` - always add specific files.
```

**APPEND_SYSTEM.gpt.md** (adds to existing prompt):
```markdown
## GPT-specific Guidelines

NEVER use `git add -A` or `git add .` - always add specific files.
NEVER run destructive commands without confirmation.
Always read files before editing.
```

### How it works

**Model family detection:**
- Substring match in model ID
- `claude-sonnet-4-20250514` → matches `claude`
- `openrouter/openai/gpt-4o` → matches `gpt`
- Longest match wins: `claude-sonnet` beats `claude`

**SYSTEM.md resolution** (first match wins, replaces base):
1. `.pi/SYSTEM.<family>.md`
2. `.pi/SYSTEM.md`
3. `~/.pi/agent/SYSTEM.<family>.md`
4. `~/.pi/agent/SYSTEM.md`
5. Built-in default

**APPEND_SYSTEM.md resolution** (additive, all concatenated):
1. `.pi/APPEND_SYSTEM.md` (if exists)
2. `.pi/APPEND_SYSTEM.<family>.md` (if exists)
3. `~/.pi/agent/APPEND_SYSTEM.md` (if exists)
4. `~/.pi/agent/APPEND_SYSTEM.<family>.md` (if exists)

### Status bar

Shows which prompt file is active: `📝 SYSTEM.claude.md +1 append`

---

## extensions/taskman-compaction.ts

Replaces auto-compaction with taskman handoff format.

### Why?

Default compaction uses a rigid structured format. This extension:
- Uses the `/handoff` skill for compaction summaries
- Produces breadcrumbs (pointers) instead of copying content
- Integrates with taskman context (STATUS.md, MEDIUMTERM_MEM.md)
- Keeps summaries lean with progressive disclosure

### Usage

Add to `~/.pi/settings.jsonl`:
```json
{"extensions": ["~/pi-extensions/extensions/taskman-compaction.ts"]}
```

### Earlier compaction

Default compaction triggers at ~92% context. To trigger earlier (~70%):
```json
{"compaction": {"reserveTokens": 60000}}
```

### Requirements

Requires the taskman skill at `~/.pi/agent/skills/taskman/handoff.md`.
