// Claude Code token monitor: reads local Claude Code transcripts and serves a live dashboard.
// Usage: node server.js            -> http://127.0.0.1:4317
//        node server.js --daily-json  (prints per-day aggregates and exits; used by export_excel.py)
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

// ---------- configuration (all optional) ----------
const CONFIG = {
  root: process.env.TOKEN_MONITOR_ROOT || path.join(os.homedir(), '.claude', 'projects'),
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 4317),
  dataDir: process.env.TOKEN_MONITOR_DATA || path.join(os.homedir(), '.claude', 'token-monitor-data'),
  outDir: process.env.TOKEN_MONITOR_OUT || path.join(process.cwd(), 'out'),
  pollMs: Number(process.env.TOKEN_MONITOR_POLL_MS || 1500),
  extraHosts: (process.env.TOKEN_MONITOR_ALLOWED_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
};
const PRICING = JSON.parse(fs.readFileSync(path.join(__dirname, 'pricing.json'), 'utf8'));

// ---------- helpers ----------
function family(model) {
  const m = /^claude-([a-z]+)/.exec(model || '');
  return m ? m[1][0].toUpperCase() + m[1].slice(1) : 'Other';
}

function projectName(cwd) {
  if (!cwd) return 'Unknown';
  if (/scratch-workspaces/i.test(cwd)) return 'No folder';
  return path.win32.basename(cwd.replace(/[\\/]+$/, '')) || 'Unknown';
}

function costOf(e, fam = e.family) {
  const p = PRICING.models[fam];
  if (!p) return 0;
  const prompt = e.inp + e.cw + e.cr;
  const mul = p.tierThreshold && prompt > p.tierThreshold ? p.tierMultiplier : 1;
  const cw5m = Math.max(0, e.cw - e.cw1h);
  const w = PRICING.cacheWriteMultiplier;
  return mul * (e.inp * p.input + cw5m * p.input * w['5m'] + e.cw1h * p.input * w['1h'] + e.cr * p.cacheRead + e.out * p.output) / 1e6;
}

function blank() { return { inp: 0, out: 0, cw: 0, cr: 0, calls: 0, cost: 0, maxPrompt: 0, overTier: 0 }; }
function add(a, e) {
  a.inp += e.inp; a.out += e.out; a.cw += e.cw; a.cr += e.cr; a.calls++; a.cost += e.cost;
  const prompt = e.inp + e.cw + e.cr;
  a.maxPrompt = Math.max(a.maxPrompt, prompt);
  const p = PRICING.models[e.family];
  if (p && p.tierThreshold && prompt > p.tierThreshold) a.overTier++;
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------- the monitor (state + aggregation), independent of HTTP so it can be tested ----------
function createMonitor(root = CONFIG.root, dataDir = CONFIG.dataDir) {
  const files = new Map();
  const seen = new Set();
  const events = [];
  const titles = new Map();
  let version = 0;

  function describe(file) {
    const rel = path.relative(root, file).split(path.sep);
    const session = rel.length >= 2 ? rel[1].replace(/\.jsonl$/, '') : rel[0];
    let agent = 'main';
    if (rel.includes('subagents')) {
      agent = 'other subagent';
      try {
        const meta = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
        if (typeof meta.agentType === 'string' && meta.agentType) agent = meta.agentType.slice(0, 64);
      } catch { /* no meta file */ }
    }
    return { session, agent, projectDir: rel[0], project: null, offset: 0, rest: '' };
  }

  function title(projectDir, session) {
    const k = projectDir + '/' + session;
    if (titles.has(k)) return titles.get(k);
    let t = null;
    try { t = JSON.parse(fs.readFileSync(path.join(root, projectDir, session, 'custom-title.json'), 'utf8')).customTitle || null; } catch {}
    if (t) titles.set(k, String(t).slice(0, 120));
    return t;
  }

  function ingest(line, info) {
    if (!line.includes('"usage"')) {
      if (!info.project && line.includes('"cwd"')) {
        try { const o = JSON.parse(line); if (o.cwd) info.project = projectName(o.cwd); } catch {}
      }
      return false;
    }
    let o;
    try { o = JSON.parse(line); } catch { return false; }
    if (o.cwd && !info.project) info.project = projectName(o.cwd);
    const msg = o.message;
    if (!msg || !msg.usage || !msg.model || msg.model === '<synthetic>') return false;
    const id = msg.id || o.uuid;
    if (id) { if (seen.has(id)) return false; seen.add(id); } // resumed/forked sessions copy messages
    const ts = Date.parse(o.timestamp);
    if (!Number.isFinite(ts)) return false;
    const u = msg.usage;
    const e = {
      ts, family: family(msg.model), agent: info.agent, session: info.session, projectDir: info.projectDir, info,
      inp: u.input_tokens || 0, out: u.output_tokens || 0,
      cw: u.cache_creation_input_tokens || 0, cr: u.cache_read_input_tokens || 0,
      cw1h: (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0,
    };
    e.cost = costOf(e);
    events.push(e);
    return true;
  }

  function list(dir, out = []) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const ent of ents) {
      if (ent.isSymbolicLink()) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (ent.name !== 'memory' && ent.name !== 'tool-results') list(p, out); }
      else if (ent.name.endsWith('.jsonl')) out.push(p);
    }
    return out;
  }

  function readNew(file) {
    let st;
    try { st = fs.statSync(file); } catch { return false; }
    let info = files.get(file);
    if (!info) { info = describe(file); files.set(file, info); }
    if (st.size < info.offset) { info.offset = 0; info.rest = ''; }
    if (st.size === info.offset) return false;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(st.size - info.offset);
    fs.readSync(fd, buf, 0, buf.length, info.offset);
    fs.closeSync(fd);
    info.offset = st.size;
    const lines = (info.rest + buf.toString('utf8')).split('\n');
    info.rest = lines.pop(); // half-written line: finished on the next poll
    let changed = false;
    for (const l of lines) if (l && ingest(l, info)) changed = true;
    return changed;
  }

  function poll() {
    // Oldest files first, so a message copied into a resumed session counts in its original one.
    const birth = f => { try { return fs.statSync(f).birthtimeMs; } catch { return 0; } };
    let changed = false;
    for (const f of list(root).sort((a, b) => birth(a) - birth(b))) if (readNew(f)) changed = true;
    if (changed) version++;
    return changed;
  }

  // --- calibration: % of a plan limit per equivalent dollar, from what the Claude app shows ---
  const calFile = path.join(dataDir, 'calibration.json');
  function loadCal() { try { return JSON.parse(fs.readFileSync(calFile, 'utf8')); } catch { return null; } }
  function spent(from, to) { let s = 0; for (const e of events) if (e.ts >= from && e.ts <= to) s += e.cost; return s; }
  function calibrate(input) {
    const now = Date.now();
    const cal = loadCal() || {};
    for (const [key, hours] of [['h5', 5], ['week', 168]]) {
      const pct = Number(input[key + 'Pct']);
      const reset = Date.parse(input[key + 'Reset']);
      if (!(pct > 0 && pct <= 100) || !Number.isFinite(reset)) continue;
      const start = reset - hours * 3600e3;
      const s = spent(start, now);
      if (s <= 0) continue;
      cal[key] = { pctPerDollar: pct / s, pct, reset: new Date(reset).toISOString() };
    }
    cal.calibratedAt = new Date(now).toISOString();
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(calFile, JSON.stringify(cal, null, 2));
    version++;
    return cal;
  }

  function startOf(range) {
    const n = new Date();
    if (range === 'today') return new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
    if (range === '7d') return new Date(n.getFullYear(), n.getMonth(), n.getDate() - 6).getTime();
    return 0;
  }

  function stats(range) {
    const from = startOf(range);
    const hourly = range === 'today';
    const total = blank(), byFamily = {}, byAgent = {}, bySession = {}, buckets = new Map();
    let last = 0;
    for (const e of events) {
      if (e.ts < from) continue;
      add(total, e);
      add(byFamily[e.family] ||= blank(), e);
      const a = byAgent[e.agent] ||= { ...blank(), models: {} };
      add(a, e); a.models[e.family] = true;
      const s = bySession[e.projectDir + '/' + e.session] ||= { ...blank(), project: null, title: null, lastTs: 0, agents: {} };
      add(s, e); s.lastTs = Math.max(s.lastTs, e.ts); s.agents[e.agent] = true;
      s.project = e.info.project || 'Unknown'; s.title = title(e.projectDir, e.session);
      const d = new Date(e.ts);
      const bk = hourly ? new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime()
                        : new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      const b = buckets.get(bk) || {};
      b[e.family] = (b[e.family] || 0) + e.inp + e.out + e.cw;
      buckets.set(bk, b);
      last = Math.max(last, e.ts);
    }
    for (const a of Object.values(byAgent)) a.models = Object.keys(a.models);
    const sessions = Object.entries(bySession)
      .map(([k, v]) => ({ id: k.split('/')[1].slice(0, 8), ...v, agents: Object.keys(v.agents) }))
      .sort((a, b) => b.lastTs - a.lastTs).slice(0, 25);
    const series = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, ...v }));
    const cal = loadCal();
    let window5h = null;
    if (cal && cal.h5 && Date.now() < Date.parse(cal.h5.reset)) {
      const reset = Date.parse(cal.h5.reset);
      window5h = { reset, spent: spent(reset - 5 * 3600e3, Date.now()) };
    }
    return { range, hourly, total, byFamily, byAgent, sessions, series, lastTs: last, version, cal, window5h, pricingVerifiedAt: PRICING.verifiedAt };
  }

  function daily() {
    const rows = new Map();
    for (const e of events) {
      const day = dayKey(e.ts);
      const k = day + '|' + e.agent + '|' + e.family;
      const r = rows.get(k) || { day, agent: e.agent, family: e.family, ...blank(), asOpus: 0 };
      add(r, e);
      r.asOpus += e.family === 'Opus' ? e.cost : costOf(e, 'Opus');
      rows.set(k, r);
    }
    return [...rows.values()].sort((a, b) => a.day.localeCompare(b.day) || a.agent.localeCompare(b.agent) || a.family.localeCompare(b.family));
  }

  return { poll, stats, daily, calibrate, loadCal, get version() { return version; }, events };
}

// ---------- HTTP ----------
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
};
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

// Only answer requests addressed to localhost (blocks DNS-rebinding attacks from web pages).
function hostAllowed(hostHeader) {
  if (!hostHeader) return false;
  const name = hostHeader.toLowerCase().replace(/:\d+$/, '');
  return LOOPBACK.has(name) || CONFIG.extraHosts.includes(name);
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, ...SECURITY_HEADERS });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > limit) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  });
}

function createServer(monitor, opts = {}) {
  const clients = new Set();
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const broadcast = () => { for (const r of clients) r.write(`event: update\ndata: ${monitor.version}\n\n`); };

  const server = http.createServer(async (req, res) => {
    if (!hostAllowed(req.headers.host)) return send(res, 403, { error: 'forbidden host' });
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'POST') {
      // Custom header => a cross-site page cannot send it without a CORS preflight, which we never grant.
      if (req.headers['x-token-monitor'] !== '1') return send(res, 403, { error: 'missing header' });
      if (url.pathname === '/api/calibrate') {
        try { const body = await readBody(req); const cal = monitor.calibrate(body); broadcast(); return send(res, 200, cal); }
        catch { return send(res, 400, { error: 'bad request' }); }
      }
      if (url.pathname === '/api/export') {
        const { execFile } = require('child_process');
        const py = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
        const out = path.join(CONFIG.outDir, 'token-usage.xlsx');
        return execFile(py, [path.join(__dirname, 'export_excel.py'), out], { env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, timeout: 60000 },
          (err, stdout, stderr) => send(res, err ? 500 : 200, { ok: !err, msg: (err ? (stderr || String(err)) : stdout).trim().slice(0, 500) }));
      }
      return send(res, 404, { error: 'not found' });
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });

    switch (url.pathname) {
      case '/': return send(res, 200, html, 'text/html; charset=utf-8');
      case '/healthz': return send(res, 200, { ok: true });
      case '/api/stats': {
        const r = url.searchParams.get('range');
        return send(res, 200, monitor.stats(['today', '7d', 'all'].includes(r) ? r : 'today'));
      }
      case '/events': {
        if (clients.size >= 20) return send(res, 503, { error: 'too many clients' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', ...SECURITY_HEADERS });
        res.write(`event: update\ndata: ${monitor.version}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 20000);
        req.on('close', () => { clearInterval(ping); clients.delete(res); });
        return;
      }
      default: return send(res, 404, { error: 'not found' });
    }
  });

  const timer = setInterval(() => { if (monitor.poll()) broadcast(); }, opts.pollMs || CONFIG.pollMs);
  server.on('close', () => { clearInterval(timer); for (const r of clients) r.end(); });
  return server;
}

module.exports = { createMonitor, createServer, costOf, hostAllowed, CONFIG };

if (require.main === module) {
  if (process.argv.includes('--demo')) {
    // Fresh fictional data in a temp folder, so the dashboard can be tried without real transcripts.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-demo-'));
    require('./demo/generate').generate(path.join(dir, 'projects'));
    // Also in the environment, so the Excel export (a child process) reads the demo data too.
    CONFIG.root = process.env.TOKEN_MONITOR_ROOT = path.join(dir, 'projects');
    CONFIG.dataDir = process.env.TOKEN_MONITOR_DATA = path.join(dir, 'state');
    console.log('Demo mode: fictional data in ' + dir);
  }
  const monitor = createMonitor(CONFIG.root, CONFIG.dataDir);
  monitor.poll();
  if (process.argv.includes('--daily-json')) {
    process.stdout.write(JSON.stringify({ rows: monitor.daily(), cal: monitor.loadCal() }));
  } else {
    if (!LOOPBACK.has(CONFIG.host) && CONFIG.host !== '0.0.0.0') console.warn(`Warning: listening on ${CONFIG.host}. Transcripts stay private, but aggregated usage is visible to anyone who can reach this address.`);
    createServer(monitor).listen(CONFIG.port, CONFIG.host, () => {
      console.log(`Token monitor on http://127.0.0.1:${CONFIG.port}  (${monitor.events.length} responses from ${CONFIG.root})`);
    });
  }
}
