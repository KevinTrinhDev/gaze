// Renders the demo GIF you see in the README.
//
// Runs REAL gaze commands against a local fixture with a throwaway browser,
// captures the actual output, then renders it as terminal frames and encodes
// them with ffmpeg. Nothing is faked or hand-written: if a command changes, the
// demo changes with it.
//
//   node demo/record-demo.mjs
//
// Needs ffmpeg for the gif. Frames are kept if encoding fails.
import { chromium } from 'playwright';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 9231;
const DIR = new URL('.', import.meta.url).pathname;
const OUT = join(DIR, 'frames');
const COLS = 83;

const server = spawn('node', [join(DIR, '..', 'test', 'fixture-server.mjs')],
  { stdio: ['ignore', 'pipe', 'inherit'] });
const url = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('fixture server never started')), 10000);
  server.stdout.on('data', d => {
    const m = /PORT (\d+)/.exec(String(d));
    if (m) { clearTimeout(t); res(`http://127.0.0.1:${m[1]}/`); }
  });
});

const profile = mkdtempSync(join(tmpdir(), 'gaze-demo-'));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: true, args: [`--remote-debugging-port=${PORT}`, '--no-sandbox'],
});
await (await ctx.newPage()).goto(url);

const env = { ...process.env, GAZE_PORT: String(PORT), GAZE_LOG: 'on' };
const run = (args, extraEnv = {}) => {
  try {
    return execFileSync('node', [join(DIR, '..', 'gaze.mjs'), ...args],
      { env: { ...env, ...extraEnv }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { return (e.stdout || '') + (e.stderr || ''); }
};

// The story: see the page, extract from it, catch a hostile page, approve once,
// then act. Each step runs for real.
const script = [
  { say: 'gaze map --filter sign', args: ['map', '--filter', 'sign'], env: { GAZE_APPROVAL: 'off' } },
  { say: 'gaze scrape "main p"', args: ['scrape', 'main p'], env: { GAZE_APPROVAL: 'off' } },
  { say: '# a page carrying instructions aimed at your AI', args: null },
  { say: 'gaze goto .../injected && gaze text', args: null,
    pre: () => run(['goto', url + 'injected', '--wait', '400'], { GAZE_APPROVAL: 'off' }),
    args2: ['text', '--max', '300'], env: { GAZE_APPROVAL: 'off' } },
  { say: "gaze fill input[name=email] me@example.com   # a write", args: ["fill", "input[name=email]", "me@example.com"] },
  { say: 'gaze grant --minutes 30', args: ['grant', '--minutes', '30', '--yes'] },
  { say: 'gaze fill "input[name=email]" me@example.com', args: ['fill', 'input[name=email]', 'me@example.com'] },
];

const steps = [];
for (const s of script) {
  if (s.pre) s.pre();
  const out = s.args2 ? run(s.args2, s.env || {})
            : s.args ? run(s.args, s.env || {}) : '';
  steps.push({ cmd: s.say, out: out.replace(/\s+$/, '') });
}
run(['revoke']);

await ctx.close();
server.kill();
rmSync(profile, { recursive: true, force: true });

// ---- render -----------------------------------------------------------------
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const colour = line => {
  if (/^\s*\[WARNING/.test(line)) return `<span class="warn">${esc(line)}</span>`;
  if (/^---\s*(BEGIN|END)/.test(line)) return `<span class="dim">${esc(line)}</span>`;
  if (/^\s*\[data only/.test(line)) return `<span class="dim">${esc(line)}</span>`;
  if (/^ERR:|DENIED|not approved/.test(line)) return `<span class="err">${esc(line)}</span>`;
  if (/standing approval|approved/.test(line)) return `<span class="ok">${esc(line)}</span>`;
  if (/^\s+#\S|^\s{6}\S/.test(line)) return `<span class="sel">${esc(line)}</span>`;
  return esc(line);
};

const page = (lines, cursor) => `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;background:#07080a}
  .t{padding:26px 30px;font:15px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
     color:#c9d3da;white-space:pre;letter-spacing:.2px}
  .p{color:#33D17A}.cmd{color:#EAF0EC}.dim{color:#55636E}.warn{color:#E5C07B}
  .err{color:#E06C75}.ok{color:#33D17A}.sel{color:#7FB0D0}
  .cur{background:#33D17A;color:#07080a}
</style><div class="t">${lines.join('\n')}${cursor ? '<span class="cur"> </span>' : ''}</div>`;

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const view = await browser.newPage({ viewport: { width: 780, height: 470 }, deviceScaleFactor: 2 });

let lines = [];
let n = 0;
const shoot = async (cursor = false) => {
  const tail = lines.slice(-26);
  await view.setContent(page(tail, cursor), { waitUntil: 'load' });
  await view.screenshot({ path: join(OUT, `f${String(n++).padStart(4, '0')}.png`) });
};

await shoot(true);
for (const step of steps) {
  // type the command a few characters at a time
  for (let i = 0; i <= step.cmd.length; i += 3) {
    lines.push(`<span class="p">$</span> <span class="cmd">${esc(step.cmd.slice(0, i))}</span>`);
    await shoot(true);
    lines.pop();
  }
  lines.push(`<span class="p">$</span> <span class="cmd">${esc(step.cmd)}</span>`);
  await shoot(false);
  for (const l of step.out.split('\n')) {
    lines.push(colour(l.length > COLS ? l.slice(0, COLS - 1) + '…' : l));
  }
  lines.push('');
  for (let i = 0; i < 8; i++) await shoot(true);   // hold so it is readable
}
for (let i = 0; i < 14; i++) await shoot(true);
await browser.close();

console.log(`${n} frames in ${OUT}`);
const gif = join(DIR, '..', 'docs', 'demo.gif');
const r = execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '14',
  '-i', join(OUT, 'f%04d.png'),
  '-vf', 'scale=780:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer',
  gif], { encoding: 'utf8' });
rmSync(OUT, { recursive: true, force: true });
console.log('wrote', gif);
