---
description: Stop the claudecode-manager server
---

Stop the claudecode-manager server.

Try the pidfile first, fall back to a process match:

```bash
if [ -f /tmp/claudecode-manager.pid ]; then
  PID=$(cat /tmp/claudecode-manager.pid)
  kill "$PID" 2>/dev/null && rm /tmp/claudecode-manager.pid && echo "Stopped (pid $PID)" || echo "Process not running"
else
  pkill -f "claudecode-manager.*server.mjs" && echo "Stopped via pkill" || echo "Not running"
fi
```

Confirm the result to the user concisely.
