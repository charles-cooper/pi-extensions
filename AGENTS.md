# AGENTS.md

## Repository Layout

Extensions live in `extensions/`. The `install.sh` script copies them to `~/.pi/agent/extensions/`.

**CRITICAL: Always edit files in THIS REPO (`extensions/*.ts`), never in `~/.pi/agent/extensions/` directly.** After editing, copy to the installed location:

```bash
cp extensions/subagent.ts ~/.pi/agent/extensions/subagent.ts
```

Or run `./install.sh` to copy all.
