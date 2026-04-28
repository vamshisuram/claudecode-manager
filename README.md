# claudecode-manager

A local web UI to inspect your Claude Code setup — plugins, slash commands, subagents, skills, hooks, MCP servers, permissions, and merged settings — all in one place.

Read-only in v0. Mutations (enable/disable, delete, install) are intentionally out of scope until the read surface is stable.

## Run

```bash
node server.mjs
```

Opens `http://localhost:4178` in your browser.

Set `PORT=...` to use a different port. Set `NO_OPEN=1` to skip auto-opening the browser.

## What it reads

| Tab | Source |
| --- | --- |
| Plugins | `~/.claude/plugins/installed_plugins.json` + each plugin's `plugin.json` |
| Slash commands | `~/.claude/commands/*.md` + each plugin's `commands/` |
| Subagents | `~/.claude/agents/*.md` + each plugin's `agents/` |
| Skills | `~/.claude/skills/*/SKILL.md` + each plugin's `skills/` |
| Hooks | `~/.claude/settings.json` `hooks` + each plugin's `hooks/hooks.json` |
| MCP servers | `~/.claude.json` `mcpServers` (user + per-project) |
| Permissions | `~/.claude/settings.json` `permissions` |
| CLAUDE.md | `./CLAUDE.md` or `~/.claude/CLAUDE.md` |
| Settings | merged dump of user + project + project-local `settings.json` |

Everything is read straight from disk. No network calls, no tracking.

## Status

v0 — read-only inspector. See [DISCUSSION.md](#) once it lands for the full roadmap.
