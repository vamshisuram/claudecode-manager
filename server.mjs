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
  const candidates = [
    { scope: 'project', path: path.join(process.cwd(), 'CLAUDE.md') },
    { scope: 'user', path: path.join(CLAUDE_DIR, 'CLAUDE.md') }
  ];
  const sources = candidates.map(c => ({
    ...c,
    exists: exists(c.path),
    content: readText(c.path)
  }));
  return { sources };
}

function loadSettings() {
  const userPath = path.join(CLAUDE_DIR, 'settings.json');
  const projectPath = path.join(process.cwd(), '.claude', 'settings.json');
  const projectLocalPath = path.join(process.cwd(), '.claude', 'settings.local.json');
  return {
    sources: [
      { scope: 'user', path: userPath, exists: exists(userPath), content: readJSON(userPath) },
      { scope: 'project', path: projectPath, exists: exists(projectPath), content: readJSON(projectPath) },
      { scope: 'project-local', path: projectLocalPath, exists: exists(projectLocalPath), content: readJSON(projectLocalPath) }
    ],
    user: readJSON(userPath) || {},
    project: readJSON(projectPath) || null,
    projectLocal: readJSON(projectLocalPath) || null
  };
}

// ---------- Ring 1 + Ring 2 additions ----------

function loadMarketplaces(installedPlugins) {
  const installedKeys = new Set(installedPlugins.map(p => p.id));
  const root = path.join(CLAUDE_DIR, 'plugins', 'marketplaces');
  const out = [];
  for (const name of listDir(root)) {
    const manifest =
      readJSON(path.join(root, name, '.claude-plugin', 'marketplace.json')) ||
      readJSON(path.join(root, name, 'marketplace.json'));
    if (!manifest) continue;
    const plugins = (manifest.plugins || []).map(pl => ({
      name: pl.name,
      description: pl.description || '',
      author: pl.author?.name || manifest.owner?.name || '',
      category: pl.category || '',
      source: pl.source?.url || pl.source?.source || '',
      homepage: pl.homepage || '',
      installed: installedKeys.has(`${pl.name}@${name}`)
    }));
    out.push({
      name,
      description: manifest.description || '',
      owner: manifest.owner?.name || '',
      pluginCount: plugins.length,
      installedCount: plugins.filter(p => p.installed).length,
      plugins
    });
  }
  return out;
}

function loadSessions() {
  const root = path.join(CLAUDE_DIR, 'projects');
  const projects = [];
  let totalSessions = 0;
  let totalMessages = 0;
  const recent = [];
  for (const dir of listDir(root)) {
    const idx = readJSON(path.join(root, dir, 'sessions-index.json'));
    if (!idx?.entries) continue;
    const entries = idx.entries;
    const messages = entries.reduce((s, e) => s + (e.messageCount || 0), 0);
    const lastModified = entries.reduce((m, e) => Math.max(m, e.fileMtime || 0), 0);
    projects.push({
      key: dir,
      projectPath: idx.originalPath || dir,
      sessionCount: entries.length,
      messageCount: messages,
      lastModified
    });
    totalSessions += entries.length;
    totalMessages += messages;
    for (const e of entries) {
      recent.push({
        sessionId: e.sessionId,
        projectPath: idx.originalPath || dir,
        summary: e.summary || e.firstPrompt || '(no summary)',
        messageCount: e.messageCount || 0,
        modified: e.modified || (e.fileMtime ? new Date(e.fileMtime).toISOString() : null),
        gitBranch: e.gitBranch || ''
      });
    }
  }
  recent.sort((a, b) => (b.modified || '').localeCompare(a.modified || ''));
  projects.sort((a, b) => b.lastModified - a.lastModified);
  return {
    totalSessions,
    totalMessages,
    projectCount: projects.length,
    projects: projects.slice(0, 50),
    recent: recent.slice(0, 25)
  };
}

function checkHookHealth(hooks) {
  return hooks.map(h => {
    const cmd = h.cmd || '';
    // Try to extract a referenced file path from common patterns
    let scriptPath = null;
    let kind = 'inline';
    const m =
      cmd.match(/(?:node|bash|sh|python3?|deno|ruby)\s+["']?([^"'\s]+)["']?/) ||
      cmd.match(/^["']?(\/[^"'\s]+\.(?:sh|js|mjs|ts|py|rb))/);
    if (m) {
      scriptPath = m[1];
      kind = 'script';
    }
    let scriptExists = null;
    let executable = null;
    if (scriptPath) {
      scriptExists = exists(scriptPath);
      if (scriptExists) {
        try {
          const st = fs.statSync(scriptPath);
          executable = !!(st.mode & 0o111);
        } catch { executable = null; }
      }
    }
    let status = 'ok';
    if (scriptPath && !scriptExists) status = 'broken';
    return { ...h, scriptPath, scriptKind: kind, scriptExists, executable, health: status };
  });
}

function detectConflicts(state) {
  const conflicts = [];

  // Duplicate slash command names
  const cmdByName = {};
  for (const c of state.commands) {
    (cmdByName[c.name] = cmdByName[c.name] || []).push(c.plugin);
  }
  for (const [name, owners] of Object.entries(cmdByName)) {
    if (owners.length > 1) {
      conflicts.push({
        kind: 'duplicate-command',
        severity: 'warning',
        title: `Slash command \`${name}\` is defined in ${owners.length} places`,
        detail: `Defined by: ${owners.join(', ')}`
      });
    }
  }

  // Duplicate agent names
  const agentByName = {};
  for (const a of state.agents) {
    (agentByName[a.name] = agentByName[a.name] || []).push(a.plugin);
  }
  for (const [name, owners] of Object.entries(agentByName)) {
    if (owners.length > 1) {
      conflicts.push({
        kind: 'duplicate-agent',
        severity: 'warning',
        title: `Subagent \`${name}\` is defined in ${owners.length} places`,
        detail: `Defined by: ${owners.join(', ')}`
      });
    }
  }

  // Broken hooks
  const broken = state.hooks.filter(h => h.health === 'broken');
  for (const h of broken) {
    conflicts.push({
      kind: 'broken-hook',
      severity: 'error',
      title: `Hook references missing file`,
      detail: `${h.event} hook can't find ${h.scriptPath} (${h.source})`
    });
  }

  // Disconnected MCP
  for (const m of state.mcp) {
    if (m.status === 'disconnected') {
      conflicts.push({
        kind: 'mcp-disconnected',
        severity: 'warning',
        title: `MCP server \`${m.name}\` not connected`,
        detail: m.url
      });
    }
  }

  return conflicts;
}

function buildCommandAgentLinks(commands, agents) {
  const agentNames = new Set(agents.map(a => a.name));
  for (const c of commands) {
    if (!c.source || !exists(c.source)) { c.invokesAgents = []; continue; }
    const text = readText(c.source) || '';
    const mentioned = [];
    for (const name of agentNames) {
      if (text.includes(name)) mentioned.push(name);
    }
    c.invokesAgents = mentioned;
  }
}

function readScriptPreview(scriptPath, maxBytes = 4000) {
  if (!scriptPath || !exists(scriptPath)) return null;
  try {
    const buf = fs.readFileSync(scriptPath, 'utf8');
    if (buf.length <= maxBytes) return buf;
    return buf.slice(0, maxBytes) + `\n\n... (truncated, ${buf.length - maxBytes} more bytes)`;
  } catch { return null; }
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
  const rawHooks = loadHooks(plugins);
  const hooks = checkHookHealth(rawHooks);
  const commands = loadCommands(plugins);
  const agents = loadAgents(plugins);
  buildCommandAgentLinks(commands, agents);
  const mcp = loadMcp();
  const state = {
    plugins,
    commands,
    agents,
    skills: loadSkills(plugins),
    hooks,
    mcp,
    permissions: loadPermissions(),
    memory: loadMemory(),
    settings: loadSettings(),
    marketplaces: loadMarketplaces(plugins),
    sessions: loadSessions(),
    lifecycleEvents: lifecycleFromHooks(hooks),
    meta: {
      generatedAt: new Date().toISOString(),
      claudeDir: CLAUDE_DIR,
      cwd: process.cwd()
    }
  };
  state.conflicts = detectConflicts(state);
  return state;
}

const HTML_PATH = path.join(__dirname, 'claudecode-manager.html');

// Allow file reads only inside these roots (safety boundary for /api/script)
const ALLOWED_ROOTS = [CLAUDE_DIR, process.cwd()];
function isPathSafe(p) {
  const abs = path.resolve(p);
  return ALLOWED_ROOTS.some(r => abs === r || abs.startsWith(r + path.sep));
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/api/state') {
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
  if (u.pathname === '/api/script') {
    const p = u.searchParams.get('path');
    if (!p || !isPathSafe(p)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'path missing or outside allowed roots' }));
      return;
    }
    const content = readScriptPreview(p, 16000);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ path: p, exists: exists(p), content }));
    return;
  }
  if (u.pathname === '/api/open') {
    const p = u.searchParams.get('path');
    const action = u.searchParams.get('action') || 'open'; // 'open' | 'reveal'
    if (!p || !isPathSafe(p) || !exists(p)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'path missing, outside allowed roots, or does not exist' }));
      return;
    }
    import('node:child_process').then(({ spawn }) => {
      let cmd, args;
      if (process.platform === 'darwin') {
        cmd = 'open';
        args = action === 'reveal' ? ['-R', p] : [p];
      } else if (process.platform === 'win32') {
        cmd = 'explorer';
        args = action === 'reveal' ? ['/select,', p] : [p];
      } else {
        cmd = 'xdg-open';
        args = [action === 'reveal' ? path.dirname(p) : p];
      }
      try {
        spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }
  if (u.pathname === '/' || u.pathname === '/index.html') {
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
