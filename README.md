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

- Uses scoped models from `~/.pi/agent/settings.json`
- Supports tool restrictions per subagent
- Streams progress and tracks usage/cost

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
