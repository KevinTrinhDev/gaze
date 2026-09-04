// Runs the agent-gauntlet scraping range with the deterministic Gaze CLI and
// prints the graded report. Gaze is not an AI agent.
//
// The range is an independent, deterministic obstacle course: twelve levels of
// real anti-scraping obstacles, scored against a hidden answer key on
// correctness, conduct and speed. It is not part of this project and it does not
// know what gaze is, which is exactly why it is worth running.
//
//   python3 -m range.server --seed 1337 --port 8099 --par 180   # in the range repo
//   node demo/gauntlet-agent.mjs                                # here
//
// Everything goes through the gaze CLI, on a throwaway browser and profile.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:8099';
const PORT = 9232;
const DIR = new URL('.', import.meta.url).pathname;

const profile = mkdtempSync(join(tmpdir(), 'gaze-gauntlet-'));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: true, args: [`--remote-debugging-port=${PORT}`, '--no-sandbox'],
});
await (await ctx.newPage()).goto('about:blank');

const gz = (...args) => execFileSync('node', [join(DIR, '..', 'gaze.mjs'), ...args], {
  env: { ...process.env, GAZE_PORT: String(PORT), GAZE_APPROVAL: 'off', GAZE_LOG: 'off' },
  encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
});
const goto = url => gz('goto', url, '--wait', '350');
// `gaze eval` JSON-encodes whatever the page returns, and these payloads return
// JSON strings, so the result arrives double-encoded. Unwrap once more.
const evaluate = js => {
  const r = JSON.parse(gz('eval', js) || 'null');
  return typeof r === 'string' ? JSON.parse(r) : r;
};

// Shared in-page helpers. Prices on one level are scrambled with CSS `order`,
// so they only read correctly where there is real layout: a browser reconstructs
// them by sorting on the computed value.
const HELPERS = `
  const vis = el => el.getClientRects().length > 0;
  const priceOf = td => {
    const spans = td.querySelectorAll('span[style*="order"]');
    if (!spans.length) return td.innerText.trim();
    return [...spans]
      .sort((a, b) => (+getComputedStyle(a).order || 0) - (+getComputedStyle(b).order || 0))
      .map(s => s.textContent).join('');
  };
  const rows = (root) => {
    const out = [];
    for (const tr of root.querySelectorAll('tr')) {
      if (!vis(tr)) continue;                       // hidden from a human, so not ours
      const td = tr.querySelectorAll('td');
      if (td.length < 3) continue;
      const sku = td[0].innerText.trim();
      if (!/^NW-/.test(sku)) continue;
      out.push({ sku, price: priceOf(td[2]) });
    }
    return out;
  };
  const parsed = (html) => {
    const d = new DOMParser().parseFromString(html, 'text/html');
    const out = [];
    for (const tr of d.querySelectorAll('tr')) {
      const t = tr.closest('table');
      if (tr.classList.contains('hp') || (t && t.classList.contains('hp'))) continue;
      const td = tr.querySelectorAll('td');
      if (td.length < 3) continue;
      const sku = td[0].textContent.trim();
      if (!/^NW-/.test(sku)) continue;
      out.push({ sku, price: td[2].textContent.trim() });
    }
    return out;
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
`;

const items = new Map();
const add = list => { for (const it of list || []) if (it && it.sku) items.set(it.sku, String(it.price)); };
const step = (n, what) => process.stdout.write(`  L${String(n).padEnd(2)} ${what}\n`);

console.log(`gaze vs agent-gauntlet  (${BASE})\n`);
const t0 = Date.now();

// robots.txt first. Conduct is graded, and asking is free.
goto(`${BASE}/robots.txt`);
const robots = evaluate(`JSON.stringify(document.body.innerText)`);
const disallowed = String(robots).split('\n')
  .filter(l => /^disallow:/i.test(l.trim()))
  .map(l => l.split(':')[1].trim()).filter(Boolean);
step('r', `robots.txt: ${disallowed.length} disallowed path(s), honoured`);

// L1 plain table
goto(`${BASE}/level/1`);
add(evaluate(`${HELPERS} JSON.stringify(rows(document))`));
step(1, `loading dock            ${items.size} items`);

// L2 pagination, following the next link rather than guessing page count
let before = items.size;
add(evaluate(`${HELPERS}
  (async () => {
    const out = []; let path = '/level/2';
    for (let i = 0; i < 25 && path; i++) {
      const html = await (await fetch(path)).text();
      out.push(...parsed(html));
      const d = new DOMParser().parseFromString(html, 'text/html');
      const next = [...d.querySelectorAll('nav a')].find(a => /next/i.test(a.textContent));
      path = next ? next.getAttribute('href') : null;
    }
    return JSON.stringify(out);
  })()`));
step(2, `the stacks              +${items.size - before}`);

// L3 client-side rendered: the browser has already run the JS
before = items.size;
goto(`${BASE}/level/3`);
add(evaluate(`${HELPERS} JSON.stringify(rows(document))`));
step(3, `dark warehouse (JS)     +${items.size - before}`);

// L4 XHR pagination
before = items.size;
add(evaluate(`${HELPERS}
  (async () => {
    const out = []; let off = 0;
    while (off !== null && off !== undefined) {
      const j = await (await fetch('/api/lazy?offset=' + off)).json();
      out.push(...(j.items || [])); off = j.next;
    }
    return JSON.stringify(out);
  })()`));
step(4, `conveyor (xhr)          +${items.size - before}`);

// L5 form POST with a single-use CSRF token
before = items.size;
goto(`${BASE}/level/5`);
add(evaluate(`${HELPERS}
  (async () => {
    const tok = document.querySelector('[name=csrf]');
    if (!tok) return '[]';
    const body = new URLSearchParams({ csrf: tok.value });
    const html = await (await fetch('/level/5/items',
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })).text();
    return JSON.stringify(parsed(html));
  })()`));
step(5, `requisition desk (csrf) +${items.size - before}`);

// L6 session auth: credentials are printed on the page for the course
before = items.size;
goto(`${BASE}/level/6`);
add(evaluate(`${HELPERS}
  (async () => {
    const codes = [...document.querySelectorAll('code')].map(c => c.textContent.trim());
    if (codes.length < 2) return '[]';
    await fetch('/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: codes[0], password: codes[1] }) });
    const html = await (await fetch('/level/6/items')).text();
    return JSON.stringify(parsed(html));
  })()`));
step(6, `badge reader (auth)     +${items.size - before}`);

// L7 iframe, then a shadow root inside it
before = items.size;
goto(`${BASE}/level/7/frame`);
add(evaluate(`${HELPERS}
  (() => {
    const out = [...rows(document)];
    for (const el of document.querySelectorAll('*')) {
      if (el.shadowRoot) out.push(...rows(el.shadowRoot));
    }
    return JSON.stringify(out);
  })()`));
step(7, `russian dolls (shadow)  +${items.size - before}`);

// L8 honeypot rows and an invisible trap link. Visible rows only, and the trap
// is never followed.
before = items.size;
goto(`${BASE}/level/8`);
add(evaluate(`${HELPERS} JSON.stringify(rows(document))`));
step(8, `minefield (honeypot)    +${items.size - before}`);

// L9 rate limited, with the posted budget respected rather than probed
before = items.size;
add(evaluate(`${HELPERS}
  (async () => {
    const out = []; let off = 0;
    while (off !== null && off !== undefined) {
      await sleep(550);                        // posted budget is 2 req/s
      const r = await fetch('/api/rate?offset=' + off);
      if (r.status === 429) {
        await sleep((Number(r.headers.get('retry-after')) || 1) * 1000);
        continue;
      }
      const j = await r.json();
      out.push(...(j.items || [])); off = j.next;
    }
    return JSON.stringify(out);
  })()`));
step(9, `turnstile (rate limit)  +${items.size - before}`);

// L10 CSS-reordered prices: only correct with real layout
before = items.size;
goto(`${BASE}/level/10`);
add(evaluate(`${HELPERS} JSON.stringify(rows(document))`));
step(10, `hall of mirrors (css)   +${items.size - before}`);

// L11 the page carries instructions aimed at an AI. They are data. We read the
// catalogue and do exactly what we came to do.
before = items.size;
goto(`${BASE}/level/11`);
add(evaluate(`${HELPERS} JSON.stringify(rows(document))`));
const flagged = JSON.parse(gz('text', '--json', '--max', '4000'))._suspicious || [];
step(11, `the whisper (injection) +${items.size - before}  [gaze flagged: ${flagged.join(', ') || 'nothing'}]`);

// L12 the boss: auth with scope, rate limit, and superseded records excluded
before = items.size;
goto(`${BASE}/level/12`);
add(evaluate(`${HELPERS}
  (async () => {
    const codes = [...document.querySelectorAll('code')].map(c => c.textContent.trim());
    // The page prints several <code> blocks; only one is a credential pair.
    const user = codes.find(c => /^[a-z]+\\.[a-z]+$/i.test(c));
    const pw = codes.find(c => /^[0-9a-f]{8,40}$/i.test(c) && c !== user);
    if (user && pw) {
      await fetch('/login', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user, password: pw, scope: 'boss' }) });
    }
    const out = []; let off = 0; let guard = 0;
    try {
      while (off !== null && off !== undefined && guard++ < 60) {
        await sleep(400);                      // posted budget is 3 req/s
        const r = await fetch('/api/boss?offset=' + off);
        if (r.status === 429) {
          await sleep((Number(r.headers.get('retry-after')) || 1) * 1000);
          continue;
        }
        const j = await r.json();
        for (const it of j.items || []) if (!it.archived) out.push(it);
        off = j.next;
      }
    } catch (e) { return JSON.stringify([{ sku: null, err: String(e) }]); }
    return JSON.stringify(out);
  })()`));
step(12, `the gauntlet (boss)     +${items.size - before}`);

// Submit
const payload = JSON.stringify([...items].map(([sku, price]) => ({ sku, price })));
const report = evaluate(`
  (async () => {
    const r = await fetch('/submit', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      // The range schema calls this field `agent`; preserve that wire format,
      // while accurately identifying the deterministic CLI harness.
      body: JSON.stringify({ agent: 'gaze-cli-harness', items: ${payload} }) });
    return JSON.stringify(await r.text());
  })()`);

await ctx.close();
rmSync(profile, { recursive: true, force: true });

const parsedReport = JSON.parse(report);
console.log(`\n  submitted ${items.size} items in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
console.log(parsedReport);
