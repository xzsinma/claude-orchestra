// Writes fictional Claude Code transcripts so the monitor can be demoed and tested
// without anyone's real conversations.
//   CLI:    node demo/generate.js <output-dir> [days=14]
//   Module: require('./demo/generate').generate(dir, days)   (used by `node server.js --demo`)
'use strict';
const fs = require('fs');
const path = require('path');

const PROJECTS = [
  { dir: 'demo-recipe-app', cwd: '/home/demo/projects/recipe-app', titles: ['Add search to recipes', 'Fix login redirect'] },
  { dir: 'demo-portfolio-site', cwd: '/home/demo/projects/portfolio-site', titles: ['Landing page redesign', 'SEO pass'] },
  { dir: 'demo-cli-tool', cwd: '/home/demo/projects/cli-tool', titles: ['Parse config files'] },
];

function generate(out, days = 14) {
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const int = (a, b) => Math.floor(a + rnd() * (b - a));
  let msgN = 0;
  const now = Date.now();

  const line = (ts, model, usage, cwd) => JSON.stringify({
    type: 'assistant', timestamp: new Date(Math.min(ts, now - 60e3)).toISOString(), cwd,
    message: { id: `msg_demo_${++msgN}`, model, role: 'assistant', content: [{ type: 'text', text: '(demo)' }], usage },
  });
  const usage = (prompt, outTok, ttl) => {
    const cw = int(500, 4000);
    return {
      input_tokens: int(2, 40), cache_creation_input_tokens: cw, cache_read_input_tokens: Math.max(0, prompt - cw), output_tokens: outTok,
      cache_creation: ttl === '1h' ? { ephemeral_1h_input_tokens: cw, ephemeral_5m_input_tokens: 0 } : { ephemeral_5m_input_tokens: cw, ephemeral_1h_input_tokens: 0 },
    };
  };

  let sessions = 0;
  for (let d = days - 1; d >= 0; d--) {
    const perDay = int(0, 3);
    for (let s = 0; s < perDay; s++) {
      const p = PROJECTS[int(0, PROJECTS.length)];
      const id = `demo-${String(++sessions).padStart(4, '0')}-0000-0000-000000000000`;
      const dir = path.join(out, p.dir);
      fs.mkdirSync(path.join(dir, id, 'subagents'), { recursive: true });
      fs.writeFileSync(path.join(dir, id, 'custom-title.json'), JSON.stringify({ customTitle: p.titles[int(0, p.titles.length)] }));
      let t = now - d * 86400e3 - int(1, 8) * 3600e3;
      const main = [];
      let ctx = 30000;
      for (let i = 0, turns = int(15, 60); i < turns; i++) {
        ctx += int(500, 6000);
        t += int(20, 240) * 1000;
        main.push(line(t, 'claude-opus-5-5', usage(ctx, int(100, 3000), '1h'), p.cwd));
      }
      main.push(main[main.length - 1]); // duplicated message, as in real transcripts: must be counted once
      fs.writeFileSync(path.join(dir, id + '.jsonl'), main.join('\n') + '\n');
      let a = 0;
      for (const [type, model, count] of [['junior-haiku', 'claude-haiku-5-5', int(1, 4)], ['senior-opus', 'claude-opus-5-5', int(0, 2)]]) {
        for (let k = 0; k < count; k++) {
          const name = `agent-demo${++a}`;
          let sctx = type === 'junior-haiku' ? 25000 : 30000;
          const ls = [];
          for (let i = 0, n = int(5, 20); i < n; i++) {
            sctx += int(800, type === 'junior-haiku' ? 5000 : 8000);
            ls.push(line(t + i * 15000, model, usage(sctx, int(100, 1500), '5m'), p.cwd));
          }
          fs.writeFileSync(path.join(dir, id, 'subagents', name + '.jsonl'), ls.join('\n') + '\n');
          fs.writeFileSync(path.join(dir, id, 'subagents', name + '.meta.json'), JSON.stringify({ agentType: type }));
        }
      }
    }
  }
  return sessions;
}

module.exports = { generate };

if (require.main === module) {
  const out = process.argv[2];
  if (!out) { console.error('Usage: node demo/generate.js <output-dir> [days]'); process.exit(1); }
  const n = generate(out, Number(process.argv[3] || 14));
  console.log(`Demo transcripts written to ${out} (${n} sessions)`);
}
