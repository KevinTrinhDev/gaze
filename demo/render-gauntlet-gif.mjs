// Renders docs/gauntlet.gif from a real gauntlet run.
//
//   node demo/gauntlet-agent.mjs > /tmp/run.txt
//   node demo/render-gauntlet-gif.mjs /tmp/run.txt
//
// Same renderer as the main demo: the frames are a picture of output that
// actually happened, not a mockup.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const DIR = new URL('.', import.meta.url).pathname;
const SRC = process.argv[2];
if (!SRC) { console.error('usage: node demo/render-gauntlet-gif.mjs <run-output.txt>'); process.exit(1); }

const raw = readFileSync(SRC, 'utf8')
  .replace(/\[[0-9;]*m/g, '')        // strip colour codes from the JSON dump
  .split('\n');

// Keep the run log and the headline numbers, drop the raw JSON body.
const lines = [];
for (const l of raw) {
  if (/^\s*$/.test(l) && lines.at(-1) === '') continue;
  if (/^\s*[{}\[\],]\s*$/.test(l)) continue;
  if (/^\s+(per_level|static|paginated|js-render|lazy|form-gated|auth|nested|honeypot|ratelimit|scrambled|injection|boss|telemetry|cadence|user_agents|trap_links|robots_violations|finished_at|seed|agent):/.test(l)) continue;
  if (/Object\]/.test(l)) continue;
  lines.push(l.replace(/\s+$/, ''));
}

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const colour = l => {
  if (/grade:/.test(l)) return `<span class="ok">${esc(l)}</span>`;
  if (/total:/.test(l)) return `<span class="ok">${esc(l)}</span>`;
  if (/flagged:/.test(l)) return `<span class="warn">${esc(l)}</span>`;
  if (/^\s+L\d|^\s+Lr/.test(l)) return `<span class="sel">${esc(l)}</span>`;
  if (/gaze vs/.test(l)) return `<span class="cmd">${esc(l)}</span>`;
  return esc(l);
};

const page = (ls, cur) => `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;background:#0B0D0F}
  .t{padding:24px 28px;font:14.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
     color:#C5CFD6;white-space:pre;letter-spacing:.2px}
  .cmd{color:#F2F5F3}.ok{color:#2FBF71}.warn{color:#E5C07B}.sel{color:#8FB6CC}
  .cur{background:#2FBF71;color:#0B0D0F}
</style><div class="t">${ls.join('\n')}${cur ? '<span class="cur"> </span>' : ''}</div>`;

const OUT = join(DIR, 'gframes');
mkdirSync(OUT, { recursive: true });
const b = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const view = await b.newPage({ viewport: { width: 760, height: 520 }, deviceScaleFactor: 2 });

let shown = [], n = 0;
const shoot = async (cur = true) => {
  await view.setContent(page(shown.slice(-30), cur), { waitUntil: 'load' });
  await view.screenshot({ path: join(OUT, `f${String(n++).padStart(4, '0')}.png`) });
};

await shoot();
for (const l of lines) {
  shown.push(colour(l));
  await shoot();
  if (/grade:|total:/.test(l)) for (let i = 0; i < 6; i++) await shoot();
}
for (let i = 0; i < 20; i++) await shoot();
await b.close();

const gif = join(DIR, '..', 'docs', 'gauntlet.gif');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '9',
  '-i', join(OUT, 'f%04d.png'),
  '-vf', 'scale=760:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer',
  gif]);
rmSync(OUT, { recursive: true, force: true });
console.log(`wrote ${gif} (${n} frames)`);
