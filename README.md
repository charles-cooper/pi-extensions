# pi-extensions

Personal extensions for [pi coding agent](https://github.com/mariozechner/pi-mono).

## Extensions

### extensions/subagent.ts

Spawn subagents with isolated context. The LLM can delegate tasks to other models.

Features:
- Uses scoped models from `~/.pi/agent/settings.json`
- Supports tool restrictions per subagent
- Streams progress and tracks usage/cost

## Install

```bash
./install.sh
```

Copies all `extensions/*.ts` to `~/.pi/agent/extensions/`.
