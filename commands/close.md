---
description: Stop the cc-manager server
---

Stop the cc-manager server.

Try the pidfile first, fall back to a process match:

```bash
if [ -f /tmp/cc-manager.pid ]; then
  PID=$(cat /tmp/cc-manager.pid)
  kill "$PID" 2>/dev/null && rm /tmp/cc-manager.pid && echo "Stopped (pid $PID)" || echo "Process not running"
else
  pkill -f "cc-manager.*server.mjs" && echo "Stopped via pkill" || echo "Not running"
fi
```

Confirm the result to the user concisely.
