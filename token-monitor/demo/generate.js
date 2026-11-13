// Writes fictional Claude Code transcripts so the monitor can be demoed and tested
// without anyone's real conversations. Usage: node demo/generate.js <output-dir> [days=14]
'use strict';
const fs = require('fs');
const path = require('path');

const out = process.argv[2];
const days = Number(process.argv[3] || 14);
if (!out) { console.error('Usage: node demo/generate.js <output-dir> [days]'); process.exit(1); }

let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const int = (a, b) => Math.floor(a + rnd() * (b - a));

const PROJECTS = [
  { dir: 'demo-recipe-app', cwd: '/home/demo/projects/recipe-app', titles: ['Add search to recipes', 'Fix login redirect'] },
  { dir: 'demo-portfolio-site', cwd: '/home/demo/projects/portfolio-site', titles: ['Landing page redesign', 'SEO pass'] },
  { dir: 'demo-cli-tool', cwd: '/home/demo/projects/cli-tool', titles: ['Parse config files'] },
];

let msgN = 0;
function line(ts, model, usage, extra = {}) {
  return JSON.stringify({
    type: 'assistant', timestamp: new Date(Math.min(ts, Date.now() - 60e3)).toISOString(), cwd: extra.cwd,
    message: { id: extra.id || `msg_demo_${++msgN}`, model, role: 'assistant', content: [{ type: 'text', text: '(demo)' }], usage },
  });
}
function usage(prompt, outTok, ttl) {
  const cw = int(500, 4000);
  return {
    input_tokens: int(2, 40), cache_creation_input_tokens: cw, cache_read_input_tokens: Math.max(0, prompt - cw),
    output_tokens: outTok, cache_creation: ttl === '1h' ? { ephemeral_1h_input_tokens: cw, ephemeral_5m_input_tokens: 0 } : { ephemeral_5m_input_tokens: cw, ephemeral_1h_input_tokens: 0 },
  };
}

const now = Date.now();
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
    const turns = int(15, 60);
    for (let i = 0; i < turns; i++) {
      ctx += int(500, 6000);
      t += int(20, 240) * 1000;
      main.push(line(t, 'claude-opus-5-5', usage(ctx, int(100, 3000), '1h'), { cwd: p.cwd }));
    }
    // a duplicated message (as written when a reply spans several lines): must be counted once
    main.push(main[main.length - 1]);
    fs.writeFileSync(path.join(dir, id + '.jsonl'), main.join('\n') + '\n');
    // subagents
    const subs = [['junior-haiku', 'claude-haiku-5-5', int(1, 4)], ['senior-opus', 'claude-opus-5-5', int(0, 2)]];
    let a = 0;
    for (const [type, model, count] of subs) {
      for (let k = 0; k < count; k++) {
        const name = `agent-demo${++a}`;
        let sctx = type === 'junior-haiku' ? 25000 : 30000;
        const ls = [];
        for (let i = 0; i < int(5, 20); i++) {
          sctx += int(800, type === 'junior-haiku' ? 5000 : 8000);
          ls.push(line(t + i * 15000, model, usage(sctx, int(100, 1500), '5m'), { cwd: p.cwd }));
        }
        fs.writeFileSync(path.join(dir, id, 'subagents', name + '.jsonl'), ls.join('\n') + '\n');
        fs.writeFileSync(path.join(dir, id, 'subagents', name + '.meta.json'), JSON.stringify({ agentType: type }));
      }
    }
  }
}
console.log(`Demo transcripts written to ${out} (${sessions} sessions over ${days} days)`);
