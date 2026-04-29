---
description: Start the claudecode-manager local web UI
---

Start the claudecode-manager server in the background and open it in the user's browser.

The plugin's server lives at `${CLAUDE_PLUGIN_ROOT}/server.mjs`. Run it from the user's project directory so project-scoped settings resolve correctly:

```bash
cd "${CLAUDE_PROJECT_DIR:-$PWD}"
nohup node "${CLAUDE_PLUGIN_ROOT}/server.mjs" > /tmp/claudecode-manager.log 2>&1 &
```

The server writes its PID to `/tmp/claudecode-manager.pid` and auto-opens `http://localhost:4178` in the user's default browser.

After running, briefly confirm the server responded (`curl -s http://localhost:4178/api/state | head -c 50`) and tell the user the URL plus how to stop it (`/manager:close`).

If port 4178 is taken, retry with `PORT=4179 ...` before failing.
