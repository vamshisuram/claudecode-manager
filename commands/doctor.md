---
description: Print a terminal-only health summary of the Claude Code setup
---

Give the user a quick read on their Claude Code setup without opening the browser.

If the server is already running on `http://localhost:4178`, fetch state from it:

```bash
curl -s http://localhost:4178/api/state
```

If it's not running, spin one up briefly:

```bash
NO_OPEN=1 node "${CLAUDE_PLUGIN_ROOT}/server.mjs" &
SVR=$!
sleep 1
STATE=$(curl -s http://localhost:4178/api/state)
kill $SVR 2>/dev/null
```

Then summarize in compact terminal-friendly form:

- `<N>` plugins, top 3 by command count
- `<N>` slash commands, `<N>` subagents, `<N>` skills
- `<N>` hooks total — call out any with `health: "broken"` (with their event and script path)
- `<N>` MCP servers — list disconnected ones
- All `conflicts[]` entries (title + detail)
- Sessions: total, total messages, top 3 most-active projects

End with: "Open the full UI with `/cc-manager:open`."

Keep the output dense and scannable. No prose paragraphs.
