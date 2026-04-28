#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const CLAUDE_JSON = path.join(HOME, '.claude.json');

const PORT = Number(process.env.PORT || 4178);

const COLORS = ['purple', 'teal', 'info', 'pink', 'success', 'warning'];
const colorFor = (s) => {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
};
const initialFor = (name) => {
  const parts = name.split(/[-_:@/.]/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
};

const readJSON = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
};
const readText = (p) => {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
};
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const listDir = (p) => { try { return fs.readdirSync(p); } catch { return []; } };

// Parse YAML-ish frontmatter from a markdown file
function parseFrontmatter(text) {
  if (!text || !text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end === -1) return {};
  const block = text.slice(3, end).trim();
  const out = {};
  for (const line of block.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function countMarkdownIn(dir) {
  return listDir(dir).filter(f => f.endsWith('.md')).length;
}

function pluginContents(installPath) {
  if (!installPath || !exists(installPath)) {
    return { commands: 0, agents: 0, hooks: 0, mcp: 0 };
  }
  const manifest =
    readJSON(path.join(installPath, 'plugin.json')) ||
    readJSON(path.join(installPath, '.claude-plugin', 'plugin.json')) ||
    {};
  const commandsDir =
    (manifest.commands && path.join(installPath, manifest.commands)) ||
    path.join(installPath, 'commands');
  const agentsDir =
    (manifest.agents && path.join(installPath, manifest.agents)) ||
    path.join(installPath, 'agents');
  const skillsDir = path.join(installPath, 'skills');

  // commands: count .md in commands dir (recursive 1 level)
  let commands = countMarkdownIn(commandsDir);
  for (const d of listDir(commandsDir)) {
    const sub = path.join(commandsDir, d);
    try {
      if (fs.statSync(sub).isDirectory()) commands += countMarkdownIn(sub);
    } catch {}
  }
  const agents = countMarkdownIn(agentsDir);

  // hooks
  let hooks = 0;
  const hooksJson =
    readJSON(path.join(installPath, 'hooks', 'hooks.json')) ||
    readJSON(path.join(installPath, '.claude-plugin', 'hooks.json'));
  if (hooksJson && typeof hooksJson === 'object') {
    for (const arr of Object.values(hooksJson)) if (Array.isArray(arr)) hooks += arr.length;
  }

  // mcp
  let mcp = 0;
  const mcpJson =
    readJSON(path.join(installPath, '.mcp.json')) ||
    readJSON(path.join(installPath, 'mcp.json'));
  if (mcpJson?.mcpServers) mcp = Object.keys(mcpJson.mcpServers).length;

  // skills
  const skills = listDir(skillsDir).filter(s => exists(path.join(skillsDir, s, 'SKILL.md'))).length;

  return { commands, agents, hooks, mcp, skills, manifest };
}

function loadPlugins() {
  const installed = readJSON(path.join(CLAUDE_DIR, 'plugins', 'installed_plugins.json'));
  if (!installed?.plugins) return [];
  const out = [];
  for (const [key, entries] of Object.entries(installed.plugins)) {
    for (const e of (Array.isArray(entries) ? entries : [entries])) {
      const [pluginName, marketplace] = key.split('@');
      const contents = pluginContents(e.installPath);
      const desc = contents.manifest?.description || `${marketplace ? marketplace + ' / ' : ''}${pluginName}`;
      out.push({
        id: key,
        name: pluginName,
        source: marketplace || 'local',
        desc,
        version: e.version,
        scope: e.scope,
        installPath: e.installPath,
        enabled: true,
        commands: contents.commands,
        agents: contents.agents,
        hooks: contents.hooks,
        mcp: contents.mcp,
        skills: contents.skills,
        color: colorFor(pluginName),
        initial: initialFor(pluginName)
      });
    }
  }
  return out;
}

function loadCommands(plugins) {
  const out = [];
  // user-level commands
  const userCmdDir = path.join(CLAUDE_DIR, 'commands');
  for (const f of listDir(userCmdDir)) {
    if (!f.endsWith('.md')) continue;
    const fm = parseFrontmatter(readText(path.join(userCmdDir, f)) || '');
    out.push({
      name: '/' + f.replace(/\.md$/, ''),
      plugin: 'user',
      desc: fm.description || '(no description)',
      invokes: 'built-in',
      source: path.join(userCmdDir, f)
    });
  }
  // plugin commands
  for (const p of plugins) {
    const dir = path.join(p.installPath || '', 'commands');
    for (const f of listDir(dir)) {
      const full = path.join(dir, f);
      let stat; try { stat = fs.statSync(full); } catch { continue; }
      if (stat.isDirectory()) {
        for (const f2 of listDir(full)) {
          if (!f2.endsWith('.md')) continue;
          const fm = parseFrontmatter(readText(path.join(full, f2)) || '');
          out.push({
            name: `/${p.name}:${f}:${f2.replace(/\.md$/, '')}`,
            plugin: p.name,
            desc: fm.description || '(no description)',
            invokes: 'agent',
            source: path.join(full, f2)
          });
        }
      } else if (f.endsWith('.md')) {
        const fm = parseFrontmatter(readText(full) || '');
        out.push({
          name: `/${p.name}:${f.replace(/\.md$/, '')}`,
          plugin: p.name,
          desc: fm.description || '(no description)',
          invokes: 'agent',
          source: full
        });
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function loadAgents(plugins) {
  const out = [];
  const collect = (dir, pluginName) => {
    for (const f of listDir(dir)) {
      if (!f.endsWith('.md')) continue;
      const fm = parseFrontmatter(readText(path.join(dir, f)) || '');
      const tools = (fm.tools || '').split(',').map(s => s.trim()).filter(Boolean);
      out.push({
        name: f.replace(/\.md$/, ''),
        plugin: pluginName,
        desc: fm.description || '(no description)',
        model: fm.model || 'sonnet',
        tools,
        denied: []
      });
    }
  };
  collect(path.join(CLAUDE_DIR, 'agents'), 'user');
  for (const p of plugins) {
    collect(path.join(p.installPath || '', 'agents'), p.name);
  }
  return out;
}

function loadSkills(plugins) {
  const out = [];
  const collect = (dir, pluginName) => {
    for (const name of listDir(dir)) {
      const skillFile = path.join(dir, name, 'SKILL.md');
      if (!exists(skillFile)) continue;
      const fm = parseFrontmatter(readText(skillFile) || '');
      out.push({
        name,
        plugin: pluginName,
        desc: fm.description || '(no description)',
        autoInvoke: true
      });
    }
  };
  collect(path.join(CLAUDE_DIR, 'skills'), 'user');
  for (const p of plugins) {
    collect(path.join(p.installPath || '', 'skills'), p.name);
  }
  return out;
}

function flattenHooks(hooksObj, sourceLabel) {
  const out = [];
  if (!hooksObj) return out;
  for (const [event, groups] of Object.entries(hooksObj)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      const matcher = g.matcher || '*';
      for (const h of (g.hooks || [])) {
        out.push({
          event,
          matcher,
          type: h.type || 'command',
          cmd: h.command || h.prompt || '',
          source: sourceLabel,
          desc: h.description || ''
        });
      }
    }
  }
  return out;
}

function loadHooks(plugins) {
  const out = [];
  const settings = readJSON(path.join(CLAUDE_DIR, 'settings.json'));
  out.push(...flattenHooks(settings?.hooks, 'user settings.json'));
  for (const p of plugins) {
    const j =
      readJSON(path.join(p.installPath || '', 'hooks', 'hooks.json')) ||
      readJSON(path.join(p.installPath || '', '.claude-plugin', 'hooks.json'));
    out.push(...flattenHooks(j, `${p.name} plugin`));
  }
  return out;
}

function loadMcp() {
  const cfg = readJSON(CLAUDE_JSON);
  const out = [];
  const seen = new Set();
  const consume = (servers, scope) => {
    if (!servers || typeof servers !== 'object') return;
    for (const [name, s] of Object.entries(servers)) {
      const key = scope + ':' + name;
      if (seen.has(key)) continue;
      seen.add(key);
      const transport = s.type || (s.url ? 'http' : 'stdio');
      const url = s.url || s.command || transport;
      out.push({
        name,
        url: typeof url === 'string' ? url : JSON.stringify(url),
        scope,
        transport,
        tools: 0,
        status: 'configured',
        desc: s.description || ''
      });
    }
  };
  consume(cfg?.mcpServers, 'user');
  if (cfg?.projects) {
    for (const [proj, p] of Object.entries(cfg.projects)) {
      consume(p.mcpServers, `project:${path.basename(proj)}`);
    }
  }
  return out;
}

function loadPermissions() {
  const settings = readJSON(path.join(CLAUDE_DIR, 'settings.json'));
  const p = settings?.permissions || {};
  return { allow: p.allow || [], deny: p.deny || [], ask: p.ask || [] };
}

function loadMemory() {
  return (
    readText(path.join(process.cwd(), 'CLAUDE.md')) ||
    readText(path.join(CLAUDE_DIR, 'CLAUDE.md')) ||
    'No CLAUDE.md found in current directory or ~/.claude/.'
  );
}

function loadSettings() {
  const userSettings = readJSON(path.join(CLAUDE_DIR, 'settings.json')) || {};
  return {
    user: userSettings,
    project: readJSON(path.join(process.cwd(), '.claude', 'settings.json')) || null,
    projectLocal: readJSON(path.join(process.cwd(), '.claude', 'settings.local.json')) || null
  };
}

function lifecycleFromHooks(hooks) {
  const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'SubagentStop', 'Stop'];
  return events.map(name => ({
    name,
    desc: name,
    count: hooks.filter(h => h.event === name).length
  }));
}

function buildState() {
  const plugins = loadPlugins();
  const hooks = loadHooks(plugins);
  return {
    plugins,
    commands: loadCommands(plugins),
    agents: loadAgents(plugins),
    skills: loadSkills(plugins),
    hooks,
    mcp: loadMcp(),
    permissions: loadPermissions(),
    memory: loadMemory(),
    settings: loadSettings(),
    lifecycleEvents: lifecycleFromHooks(hooks),
    meta: {
      generatedAt: new Date().toISOString(),
      claudeDir: CLAUDE_DIR,
      cwd: process.cwd()
    }
  };
}

const HTML_PATH = path.join(__dirname, 'claudecode-manager.html');

const server = http.createServer((req, res) => {
  if (req.url === '/api/state') {
    try {
      const state = buildState();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(HTML_PATH));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`claudecode-manager running at ${url}`);
  if (!process.env.NO_OPEN) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    import('node:child_process').then(({ spawn }) => spawn(opener, [url], { detached: true, stdio: 'ignore' }).unref());
  }
});
