'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMonitor, createServer, costOf, hostAllowed } = require('../server');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'tm-test-')); }
function usageLine(id, model, ts, u) {
  return JSON.stringify({ timestamp: new Date(ts).toISOString(), cwd: '/home/x/proj', message: { id, model, usage: u } });
}
const U = { input_tokens: 10, output_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000 };

function fixture() {
  const root = tmp();
  const s = path.join(root, 'proj');
  fs.mkdirSync(path.join(s, 'sess1', 'subagents'), { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(s, 'sess1.jsonl'), [
    usageLine('m1', 'claude-opus-5-5', now, U),
    usageLine('m1', 'claude-opus-5-5', now, U),            // duplicate: counted once
    usageLine('m2', '<synthetic>', now, U),                 // ignored
    usageLine('m3', 'claude-opus-5-5', now - 10 * 86400e3, U), // old: only in "all"
  ].join('\n') + '\n' + usageLine('m4', 'claude-opus-5-5', now, U)); // no trailing newline: not read yet
  fs.writeFileSync(path.join(s, 'sess1', 'subagents', 'agent-a.jsonl'),
    usageLine('h1', 'claude-haiku-5-5', now, { ...U, cache_read_input_tokens: 120000 }) + '\n');
  fs.writeFileSync(path.join(s, 'sess1', 'subagents', 'agent-a.meta.json'), JSON.stringify({ agentType: 'junior-haiku' }));
  return { root, main: path.join(s, 'sess1.jsonl') };
}

test('aggregates, deduplicates, ignores synthetic and half-written lines', () => {
  const { root, main } = fixture();
  const m = createMonitor(root, tmp());
  m.poll();
  const all = m.stats('all');
  assert.strictEqual(all.byAgent.main.calls, 2);          // m1 once + m3
  assert.strictEqual(all.byAgent['junior-haiku'].calls, 1);
  assert.strictEqual(m.stats('today').byAgent.main.calls, 1);
  fs.appendFileSync(main, '\n');                           // finish the half-written line
  m.poll();
  assert.strictEqual(m.stats('today').byAgent.main.calls, 2);
});

test('Haiku calls over 100k are priced 5x and flagged', () => {
  const { root } = fixture();
  const m = createMonitor(root, tmp());
  m.poll();
  const h = m.stats('all').byAgent['junior-haiku'];
  assert.strictEqual(h.overTier, 1);
  const e = { family: 'Haiku', inp: 10, out: 100, cw: 1000, cw1h: 0, cr: 5000 };
  assert.ok(costOf({ ...e, cr: 120000 }) > 4 * costOf({ ...e, cr: 98000 }));
});

test('daily rows include the Opus-equivalent cost', () => {
  const { root } = fixture();
  const m = createMonitor(root, tmp());
  m.poll();
  const h = m.daily().find(r => r.family === 'Haiku');
  assert.ok(h.asOpus > h.cost);
});

test('host header allow-list blocks DNS rebinding', () => {
  assert.ok(hostAllowed('127.0.0.1:4317'));
  assert.ok(hostAllowed('localhost:4317'));
  assert.ok(!hostAllowed('evil.example:4317'));
  assert.ok(!hostAllowed(undefined));
});

test('HTTP: security headers, foreign host 403, POST needs custom header', async () => {
  const { root } = fixture();
  const m = createMonitor(root, tmp());
  m.poll();
  const srv = createServer(m, { pollMs: 60000 });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const r = await fetch(base + '/');
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.strictEqual(r.headers.get('access-control-allow-origin'), null);
    const st = await (await fetch(base + '/api/stats?range=all')).json();
    assert.strictEqual(st.byAgent.main.calls, 2);
    const http = require('http');
    const status = await new Promise(res => http.get({ host: '127.0.0.1', port: srv.address().port, path: '/', headers: { Host: 'evil.example' } }, x => res(x.statusCode)));
    assert.strictEqual(status, 403);
    const noHeader = await fetch(base + '/api/calibrate', { method: 'POST', body: '{}' });
    assert.strictEqual(noHeader.status, 403);
    assert.strictEqual((await fetch(base + '/../server.js')).status, 404);
  } finally {
    await new Promise(r => srv.close(r));
  }
});
