#!/usr/bin/env node
// gaze Chromium backend - drives the persistent browser over CDP. Every
// command attaches to the SAME live browser, so logins/cookies/tabs survive
// between separate invocations.
//
// One connection per PROCESS, not per command: `batch` runs many commands over a
// single attach, which is where nearly all the speed comes from.
// Patchright is a drop-in Playwright fork whose whole purpose is removing the
// automation tells that Cloudflare and DataDome look for, chiefly the
// Runtime.enable CDP call every stock Playwright makes during page setup. We are
// driving the operator's OWN profile on their OWN accounts, so the goal is not
// disguise: it is removing an inconsistency between "a real human's browser" and
// "how this browser is being talked to". Falls back to stock playwright.
// Loaded lazily, not at module scope: importing the driver costs ~270ms, and
// help, stats, log, grant and every unknown command never reach attach(). That
// was 96% of the startup cost of commands that touch no browser at all.
let chromium;
async function driver() {
  if (chromium) return chromium;
  try   { ({ chromium } = await import('patchright')); }
  catch { ({ chromium } = await import('playwright')); }
  return chromium;
}
import { writeFileSync, readFileSync, appendFileSync, mkdirSync, chmodSync, existsSync, rmSync, statSync,
         openSync, readSync, writeSync, closeSync, fstatSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { STATE, WRITE_CMDS, isWrite, APPROVAL, approve, askTty, preApproved, afterDashDash, say, out,
         readGrant, claimGrant, grantLeft, remainingOf,
         issueGrant, revokeGrant, GRANT_FILE, TICKETS } from './consent.mjs';
import { emit, sniff } from './untrusted.mjs';

const DIR = new URL('.', import.meta.url).pathname;
const PORT = process.env.GAZE_PORT || '9225';
const SESSIONS = `${STATE}/sessions`;
// Separate CLI invocations reconnect to the same browser. Persist the selected
// tab identity so `goto --new`, then `shot`/`text`/`map`, acts on the new page
// rather than whichever existing tab happens to be last in CDP's page list.
const ACTIVE_TAB = `${STATE}/active-tab`;

// Sites whose DOM must never be automated. Mirrors agent-daemon/src/allowlist.ts:
// we bridge to the vault's CLI, we never drive the vault's own web UI.
const NEVER_AUTO = [
  'vault.bitwarden.com', 'bitwarden.com', 'accounts.google.com/signin/challenge',
  '1password.com', 'lastpass.com',
];

async function attach() {
  // A dead browser is the single most common failure, and a raw Playwright
  // "connect ECONNREFUSED" stack tells the operator nothing they can act on.
  let b;
  try {
    b = await (await driver()).connectOverCDP(`http://127.0.0.1:${PORT}`);
  } catch (e) {
    if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|socket hang up|WebSocket/i.test(e.message))
      throw new Error(`no browser is running on :${PORT}. start one with: gaze start`);
    throw e;
  }
  const ctx = b.contexts()[0];
  // Close the handle we just opened, or the CDP socket leaks on this path.
  if (!ctx) { await b.close().catch(() => {}); throw new Error('no browser context; run: gaze start'); }
  return { b, ctx };
}
function setActive(ctx, page) {
  const index = ctx.pages().indexOf(page);
  if (index < 0) return;
  try {
    mkdirSync(STATE, { recursive: true });
    // CDP can reorder `context.pages()` when a later CLI invocation attaches.
    // URL is stable across that reconnect; index remains only a fallback for a
    // just-opened blank tab, before it has a meaningful URL.
    writeFileSync(ACTIVE_TAB, JSON.stringify({ url: page.url(), index }), { mode: 0o600 });
  } catch {}
}

// Active page = the tab selected by the last page command. Fall back to the
// last real tab when the browser changed independently and the stored index is
// no longer valid.
function pick(ctx, idx) {
  const pages = ctx.pages();
  if (!pages.length) throw new Error('no open tabs');
  if (idx != null) {
    const n = Number(idx);
    if (!Number.isInteger(n) || n < 0 || n >= pages.length)
      throw new Error(`no tab at index ${idx}; ${pages.length} tab(s) open (see: gaze tabs)`);
    setActive(ctx, pages[n]);
    return pages[n];
  }
  try {
    const saved = JSON.parse(readFileSync(ACTIVE_TAB, 'utf8'));
    if (saved.url && saved.url !== 'about:blank') {
      const byUrl = pages.find(p => p.url() === saved.url);
      if (byUrl) return byUrl;
    }
    const n = Number(saved.index);
    if (Number.isInteger(n) && n >= 0 && n < pages.length) return pages[n];
  } catch {}
  const real = pages.filter(p => !/^about:blank$/.test(p.url()));
  const page = real.length ? real[real.length - 1] : pages[0];
  setActive(ctx, page);
  return page;
}
// process.exit() tears the process down without waiting for stdout to DRAIN.
// To a terminal that is harmless, because those writes are synchronous, but to
// a PIPE they are not: the last write can be discarded, and a caller reading
// our output sees an empty string and concludes the command printed nothing.
// Making the stream blocking costs nothing here (we print once and leave) and
// removes the failure mode everywhere, without restructuring every early exit.
try { process.stdout._handle?.setBlocking?.(true); } catch {}
try { process.stderr._handle?.setBlocking?.(true); } catch {}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

function guard(url, what) {
  const hit = NEVER_AUTO.find(d => url.includes(d));
  if (hit) throw new Error(
    `refusing to ${what} on ${hit}: this tool bridges to the vault CLI, ` +
    `it never drives a vault's own web UI`);
}

// Find an element, and keep trying sensible alternatives before giving up.
//
// Selectors rot: a class gets renamed, an id gains a hash suffix, a button moves.
// Rather than failing on the first miss, fall back the way a person would: try
// the selector, then the accessible name, then visible text, then a loose match
// against anything interactive. This is adaptive, not agentic. There is no model
// here, the order is fixed, and it reports which route worked so a caller can
// update its selector.
async function locate(p, sel, { text = false, timeout = 8000 } = {}) {
  const attempts = text
    ? [['text', () => p.getByText(sel, { exact: false }).first()]]
    : [
        ['selector',   () => p.locator(sel).first()],
        ['aria-label', () => p.getByLabel(sel, { exact: false }).first()],
        ['role/name',  () => p.getByRole('button', { name: sel }).first()],
        ['text',       () => p.getByText(sel, { exact: false }).first()],
        ['placeholder',() => p.getByPlaceholder(sel, { exact: false }).first()],
      ];
  const errors = [];
  for (const [how, build] of attempts) {
    try {
      const loc = build();
      await loc.waitFor({ state: 'visible', timeout: Math.max(1200, timeout / attempts.length) });
      return { loc, how };
    } catch (e) { errors.push(`${how}: ${String(e.message).split('\n')[0]}`); }
  }
  throw new Error(`no element matched "${sel}"\n  tried ${errors.length} route(s): ` +
                  attempts.map(a => a[0]).join(', '));
}

// A click fails in two very different ways, and they deserve different answers.
// locate() finding nothing is a real miss and must stay a failure. But an
// element that IS found and visible and still times out is usually Playwright's
// actionability check refusing a synthetic control: the pattern that shows up
// repeatedly in real logs is <div role="button" tabindex="-1"> on Google's
// admin consoles, where the element resolves and then burns the full timeout.
// So escalate in a fixed order, and always name the route in the output. This
// is the same adaptive-not-agentic contract as locate(): no model, fixed order,
// and it never turns a genuine miss into a silent success.
const NOT_ACTIONABLE =
  /Timeout .*exceeded|intercepts pointer events|not stable|outside of the viewport|not visible|element is disabled/i;

// Playwright's call log names each step it reached. Once "performing click
// action" appears, the click may have been DISPATCHED and only then timed out.
// Escalating there would click a second time, and replaying a write on a
// browser holding live sessions is the exact failure this tool exists to
// prevent: a double submit, a double send, a double purchase. If we cannot
// prove the click never fired, we refuse to retry it and report the timeout.
const MAY_HAVE_FIRED = /performing click action/i;

async function clickEscalating(loc, timeout) {
  try {
    await loc.click({ timeout });
    return '';
  } catch (e) {
    const msg = String(e.message);
    // A miss, a detach or a navigation is not an actionability problem.
    if (!NOT_ACTIONABLE.test(msg)) throw e;
    if (MAY_HAVE_FIRED.test(msg)) {
      // Rethrowing the ORIGINAL error is not enough: its call log contains
      // "waiting for scheduled navigations", which withRetry treats as a
      // transient failure and retries, replaying the very click we just
      // refused to repeat. Raise a clean error and mark it non-retryable.
      const stop = new Error(
        'click may already have been dispatched before it timed out, so it was ' +
        'not retried. Re-run it deliberately if the action did not land.');
      stop.gazeNoRetry = true;
      throw stop;
    }
  }
  // Deliberately NOT click({ force: true }) here. force skips the actionability
  // checks but still dispatches a real mouse event at the element's box, so on
  // an element that is covered it clicks whatever is on top instead. On a
  // browser holding live sessions, silently clicking the wrong control is a
  // worse outcome than failing. A DOM click is dispatched on the located
  // element itself and cannot mis-target, so that is the only escalation.
  await loc.evaluate(el => el.click());
  return ' (dispatched a DOM click)';
}

// One retry on a transient failure. Pages navigate mid-action, elements detach,
// animations move things. A single quick retry fixes most of it and never hides
// a real failure, because the second error is the one reported.
async function withRetry(fn, label) {
  try { return await fn(); }
  catch (first) {
    // An action that may already have landed must never be replayed, however
    // transient its error looks.
    if (first.gazeNoRetry) throw first;
    if (/detached|not attached|Execution context|navigation/i.test(first.message)) {
      await new Promise(r => setTimeout(r, 600));
      return fn();
    }
    throw first;
  }
}

async function ariaOf(p) {
  // <body>'s accessibility snapshot with a hard timeout. The timer MUST be
  // cleared on success: an uncleared timeout keeps the process alive for its
  // full duration after the command already printed its answer.
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('aria snapshot timed out')), 15000);
    p.locator('body').ariaSnapshot().then(
      r => { clearTimeout(t); resolve(r); },
      e => { clearTimeout(t); reject(e); });
  });
}

// Compact interactive-element map. Hides page chrome by default so main content
// is not crowded out, walks open shadow roots, emits a reusable selector.
const collect = (includeChrome) => {
  const SEL = 'a,button,input,select,textarea,[role=button],[role=link],' +
              '[role=textbox],[role=combobox],[role=checkbox],[role=tab],[contenteditable=true]';
  const out = [];
  const esc = s => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&');
  const isChrome = e => !!(e.closest &&
    e.closest('nav,header,footer,[role=navigation],[role=banner],[role=contentinfo]'));
  const sel = e => {
    const tag = e.tagName.toLowerCase();
    if (e.id) return '#' + esc(e.id);
    if (e.name) return tag + '[name="' + e.name + '"]';
    const aria = e.getAttribute('aria-label');
    if (aria) return tag + '[aria-label="' + aria.slice(0, 40) + '"]';
    const t = (e.innerText || '').trim().replace(/\s+/g, ' ');
    if (t && t.length <= 40) return tag + ':has-text(' + JSON.stringify(t) + ')';
    return tag;
  };
  const walk = root => {
    let nodes = [];
    try { nodes = root.querySelectorAll(SEL); } catch { return; }
    for (const e of nodes) {
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const chrome = isChrome(e);
      if (chrome && !includeChrome) continue;
      const label = (e.getAttribute('aria-label') || e.placeholder || e.name ||
                     e.value || e.innerText || e.title || '')
                    .trim().replace(/\s+/g, ' ').slice(0, 70);
      out.push({ tag: e.tagName.toLowerCase(), type: e.type || '', id: e.id || '',
                 name: e.name || '', label, selector: sel(e), chrome });
    }
    try { for (const e of root.querySelectorAll('*')) if (e.shadowRoot) walk(e.shadowRoot); } catch {}
  };
  walk(document);
  return out;
};

// Signatures of an interactive challenge. We detect and hand over to a human; we
// never try to solve one. See docs/SECURITY.md.
const CHALLENGE = () => {
  const marks = [
    'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', 'iframe[src*="challenges.cloudflare.com"]',
    'iframe[src*="turnstile"]',
    // NOT a bare [data-sitekey]. Two reasons: sites leave that element in the
    // DOM after the challenge is already passed, and reCAPTCHA v3 -- which is
    // passive scoring, not a challenge -- carries it on ordinary pages.
    '#challenge-form', '.g-recaptcha', '.h-captcha', '.cf-turnstile',
    // Cloudflare's interstitial, which runs BEFORE any widget is rendered.
    '#cf-challenge-running', '.cf-browser-verification', '#cf-please-wait',
    // PerimeterX / HUMAN, which serves a press-and-hold instead of a captcha,
    // and DataDome, which serves its own. Neither looks like reCAPTCHA, so
    // neither was detected: the page read as ordinary content and got scraped.
    '#px-captcha', '.px-captcha-container', '[id^="px-captcha"]',
    '.datadome-captcha', '#datadome-captcha',
    'iframe[src*="captcha-delivery.com"]', 'iframe[src*="perimeterx"]',
  ];
  // A marker that is not rendered is a leftover, not a live challenge: sites
  // keep the widget container in the DOM after it has already been solved.
  const shown = el => !!el && (el.getClientRects().length > 0 || !!el.offsetParent);
  const found = marks.filter(m => shown(document.querySelector(m)));
  const t = (document.body?.innerText || '').toLowerCase();
  const phrase = ['verify you are human', 'i am not a robot', 'checking your browser',
                  'complete the security check', 'just a moment',
                  'verifying you are human',
                  'needs to review the security of your connection',
                  'enable javascript and cookies to continue',
                  // PerimeterX's press-and-hold, which carries no captcha widget.
                  'press & hold', 'press and hold'].find(p => t.includes(p));
  // A hard block is not a challenge -- there is nothing to solve -- but it is
  // the other way a page can be worthless while looking like content. Scraping
  // on through one is how an operator's real IP earns a longer ban.
  const blocked = ['access to this page has been denied', 'you have been blocked',
                   'sorry, you have been blocked', 'unusual traffic from your computer',
                   'why have i been blocked', 'access denied'].find(p => t.includes(p));
  return { challenged: found.length > 0 || !!phrase, markers: found,
           phrase: phrase || null, blocked: blocked || null };
};

// Untrusted page content and the injection scan now live in untrusted.mjs,
// imported above, so the Firefox backend gets the identical envelope.


// ---- approval gate ---------------------------------------------------------
// Full capability, gated consent. Reading a page is free. Anything that CHANGES
// something (click, fill, keystrokes, downloads, running JS, typing credentials)
// asks first, and `batch` asks ONCE for the whole script so a big task needs one
// confirmation rather than twenty.
//
//   GAZE_APPROVAL=prompt        ask on the terminal (default)
//   GAZE_APPROVAL=fingerprint   require a fingerprint touch (fprintd)
//   GAZE_APPROVAL=off           trust the caller, no gate
//   --yes                          pre-approve this one invocation
//
// With no terminal and no explicit opt-out we REFUSE rather than silently
// proceeding: an unattended agent must be configured deliberately, not by
// accident.
// `upload` sends a local file to whatever page is loaded, `record` writes frames
// to disk, and `session load` replays saved auth cookies. All three change
// something, so all three are gated. `session list` is a read and stays ungated.
// WRITE_CMDS, isWrite, APPROVAL, askTty and approve() now live in consent.mjs,
// imported above, so the Firefox backend enforces the identical gate.

const INDICATOR_FILE = `${STATE}/indicator`;

// Injected into the page. Shadow DOM so the host page's CSS cannot restyle or
// hide it, and pointer-events:none so it can never swallow a click.
function injectBadge(label) {
  document.getElementById('__gaze_badge__')?.remove();
  const host = document.createElement('div');
  host.id = '__gaze_badge__';
  host.style.cssText =
    'position:fixed;top:12px;right:12px;z-index:2147483647;pointer-events:none';
  const s = host.attachShadow({ mode: 'open' });
  s.innerHTML = `<style>
    .b{display:flex;align-items:center;gap:8px;font:600 12px/1.2 ui-sans-serif,system-ui,sans-serif;
       color:#e6edf3;background:rgba(13,17,23,.92);border:1px solid #2ea043;border-radius:999px;
       padding:7px 13px 7px 10px;box-shadow:0 4px 14px rgba(0,0,0,.35);letter-spacing:.01em}
    .d{width:8px;height:8px;border-radius:50%;background:#3fb950;
       box-shadow:0 0 0 0 rgba(63,185,80,.7);animation:p 1.8s infinite}
    @keyframes p{70%{box-shadow:0 0 0 7px rgba(63,185,80,0)}100%{box-shadow:0 0 0 0 rgba(63,185,80,0)}}
    @media (prefers-reduced-motion:reduce){.d{animation:none}}
  </style><div class="b"><span class="d"></span><span>${label}</span></div>`;
  (document.body || document.documentElement).appendChild(host);
}

const LOG_FILE = `${STATE}/log.jsonl`;
const LOG_ON = (process.env.GAZE_LOG || 'on') !== 'off';

// A local, append-only record of what ran, how long it took and what failed.
// Local file only, mode 600, nothing leaves the machine.
//
// VALUES ARE REDACTED, not logged. `fill` values and `login` arguments can be
// credentials, and a log that quietly accumulates passwords is worse than no
// log. Only the command shape, the host, the duration and the outcome are kept.
const REDACT = new Set(['fill', 'login', 'eval']);
function logLine(cmd, argv, host, ms, ok, err) {
  if (!LOG_ON) return;
  try {
    mkdirSync(STATE, { recursive: true });
    // For `fill`/`login` arg0 is a selector or vault item name: harmless, and
    // it makes the log readable. For `eval` arg0 is the script itself, which is
    // exactly where a secret shows up, so it must NOT be spared.
    const keepFirst = cmd !== 'eval';
    const args = REDACT.has(cmd)
      ? argv.slice(1).map((a, i) => (a.startsWith('--') || (keepFirst && i === 0) ? a : '<redacted>'))
      : cmd === 'goto'
        // A magic link, an OAuth callback or a signed URL carries its secret in
        // the query string, and this log persists. Keep origin and path, which
        // is what makes the log useful, and drop the rest.
        ? argv.slice(1).map(a => (a.startsWith('--') ? a : stripQuery(a)))
        // `wait`'s needle can be a full signed URL too. The flags are kept so
        // the log still says what kind of wait it was; the needle does not.
        : cmd === 'wait'
          ? argv.slice(1).map(a => (a.startsWith('--') ? a : '<redacted>'))
          : argv.slice(1);
    appendFileSync(LOG_FILE, JSON.stringify({
      ts: new Date().toISOString(), cmd, args, host, ms, ok,
      ...(err ? { err: String(err).slice(0, 200) } : {}),
    }) + '\n');
    chmodSync(LOG_FILE, 0o600);
  } catch { /* logging must never break the command */ }
}
const hostOf = u => { try { return new URL(u).host; } catch { return null; } };
// Origin and path are kept, because that is what makes the log worth having.
// The query and the fragment are not, because that is where magic-link tokens,
// OAuth codes and signed-URL signatures live. Userinfo goes too: URL.origin
// drops it. A secret embedded in the PATH itself still survives, which is a
// deliberate trade rather than an oversight -- stripping the path would leave
// entries that say nothing at all.
const stripQuery = u => {
  try {
    const x = new URL(u);
    const hidden = x.search || x.hash ? '?<redacted>' : '';
    if (x.protocol === 'http:' || x.protocol === 'https:')
      return x.origin + x.pathname + hidden;
    // data:, file: and blob: have no origin: it stringifies to the literal
    // "null", which wrote entries like "null/etc/passwd" into the log.
    return x.href.split(/[?#]/)[0] + hidden;
  } catch { return u; }
};

// The grant, its tickets, and approve() live in consent.mjs, imported above.


function parse(argv) {
  const [cmd, ...raw] = argv;
  // Everything after `--` is data, never a flag. This is the safe way to pass
  // a selector that came from a page and might look like an option.
  const tail = afterDashDash(raw);
  const stop = raw.indexOf('--');
  const rest = stop === -1 ? raw : raw.slice(0, stop);
  const flag = (n, d) => { const i = rest.indexOf(`--${n}`); return i === -1 ? d : rest[i + 1]; };
  const has = n => rest.includes(`--${n}`);
  const positional = rest.filter((a, i) =>
    !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--') &&
      !['headed','full','enter','new','nav','json','text','submit','totp','raw','yes','reload','json-only'].includes(rest[i-1].slice(2))));
  return { cmd, rest, flag, has, positional: positional.concat(tail) };
}

async function dispatch(ctx, argv) {
  const { cmd, flag, has, positional } = parse(argv);
  switch (cmd) {
    case 'tabs': {
      const rows = ctx.pages().map((p, i) => ({ index: i, url: p.url() }));
      if (has('json')) console.log(JSON.stringify(rows, null, 2));
      else rows.forEach(r => console.log(`[${r.index}] ${r.url}`));
      break;
    }
    case 'goto': {
      const url = positional[0];
      const p = has('new') ? await ctx.newPage() : pick(ctx, flag('tab'));
      await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await p.waitForTimeout(Number(flag('wait', 1500)));
      // A page load wipes injected DOM, so put the badge back.
      if (existsSync(INDICATOR_FILE)) {
        try { await p.evaluate(injectBadge, readFileSync(INDICATOR_FILE, 'utf8')); } catch {}
      }
      setActive(ctx, p);
      console.log('URL:', p.url());
      console.log('TITLE:', await p.title());
      break;
    }
    case 'text': {
      const p = pick(ctx, flag('tab'));
      const n = Number(flag('max', 4000));
      const body = (await p.locator('body').innerText()).replace(/\n{3,}/g, '\n\n').slice(0, n);
      emit('page text', p.url(), body, body, { json: has('json'), raw: has('raw') });
      break;
    }
    case 'html': {
      const p = pick(ctx, flag('tab'));
      const doc = (await p.content()).slice(0, Number(flag('max', 8000)));
      emit('page html', p.url(), doc, doc, { json: has('json'), raw: has('raw') });
      break;
    }
    case 'shot': {
      const p = pick(ctx, flag('tab'));
      const out = flag('out', `${DIR}shots/shot-${stamp()}.png`);
      mkdirSync(`${DIR}shots`, { recursive: true });
      await p.screenshot({ path: out, fullPage: has('full') });
      // A screenshot outlives the session and can hold anything on screen.
      try { chmodSync(out, 0o600); } catch {}
      console.log(out);
      break;
    }
    case 'click': {
      const p = pick(ctx, flag('tab'));
      const sel = positional[0];
      const { loc, how } = await withRetry(
        () => locate(p, sel, { text: has('text'), timeout: Number(flag('timeout', 15000)) }));
      const note = await withRetry(
        () => clickEscalating(loc, Number(flag('timeout', 15000))));
      await p.waitForTimeout(Number(flag('wait', 1200)));
      console.log(`clicked: ${sel}${how === 'selector' ? '' : ` (matched by ${how})`}` +
                  `${note} | now: ${p.url()}`);
      break;
    }
    case 'fill': {
      const p = pick(ctx, flag('tab'));
      const [sel, val] = positional;
      const { loc, how } = await withRetry(
        () => locate(p, sel, { timeout: Number(flag('timeout', 15000)) }));
      await withRetry(() => loc.fill(val, { timeout: Number(flag('timeout', 15000)) }));
      if (has('enter')) { await p.keyboard.press('Enter'); await p.waitForTimeout(2000); }
      console.log(`filled: ${sel}${how === 'selector' ? '' : ` (matched by ${how})`}`);
      break;
    }
    case 'press': {
      const p = pick(ctx, flag('tab'));
      await p.keyboard.press(positional[0]);
      await p.waitForTimeout(Number(flag('wait', 1000)));
      console.log('pressed:', positional[0]);
      break;
    }
    // Scrolling is what a person does before deciding what to click, and a
    // scraping tool that cannot reach lazily-loaded content below the fold is
    // missing a step everyone hits. It is gated like other writes because it
    // changes what the page loads and fires scroll handlers.
    case 'scroll': {
      const p = pick(ctx, flag('tab'));
      const target = (positional[0] || 'down').toLowerCase();
      const px = Number(flag('px', 600));
      let landed;
      if (target === 'to') {
        const sel = positional[1];
        if (!sel) throw new Error('scroll to <selector>: no selector given');
        const { loc, how } = await withRetry(
          () => locate(p, sel, { timeout: Number(flag('timeout', 15000)) }));
        await loc.scrollIntoViewIfNeeded({ timeout: Number(flag('timeout', 15000)) });
        landed = `to ${sel}${how === 'selector' ? '' : ` (matched by ${how})`}`;
      } else {
        const by = { down: px, up: -px, top: 'top', bottom: 'bottom' }[target];
        if (by === undefined) throw new Error(
          `scroll: expected up, down, top, bottom or "to <selector>", got "${target}"`);
        await p.evaluate(arg => {
          if (arg === 'top') window.scrollTo({ top: 0 });
          else if (arg === 'bottom') window.scrollTo({ top: document.body.scrollHeight });
          else window.scrollBy({ top: arg });
        }, by);
        landed = target === 'top' || target === 'bottom' ? target : `${target} ${px}px`;
      }
      // Settle so lazily-loaded content has a chance to appear before the
      // next command reads the page.
      await p.waitForTimeout(Number(flag('wait', 400)));
      // documentElement, not body: body.scrollHeight ignores margins and can
      // come back SHORTER than the distance actually scrolled, which reported
      // nonsense like "at 7326px of 7310px".
      const at = await p.evaluate(() => {
        const doc = document.documentElement, b = document.body;
        const full = Math.max(doc.scrollHeight, b ? b.scrollHeight : 0);
        return { y: Math.round(window.scrollY),
                 of: Math.max(0, Math.round(full - window.innerHeight)) };
      });
      console.log(`scrolled ${landed} | at ${at.y}px of ${at.of}px`);
      break;
    }
    case 'eval': {
      const p = pick(ctx, flag('tab'));
      console.log(JSON.stringify(await p.evaluate(positional[0]), null, 2));
      break;
    }
    case 'map': {
      const p = pick(ctx, flag('tab'));
      const wantNav = has('nav');
      const max = Number(flag('max', 200));
      const needle = (flag('filter', '') || '').toLowerCase();
      let els = [];
      for (const f of p.frames()) {
        let got = [];
        try { got = await f.evaluate(collect, wantNav); } catch { continue; }  // cross-origin
        const tag = f === p.mainFrame() ? '' : (f.url().split('/')[2] || 'frame');
        els.push(...got.map(e => ({ ...e, frame: tag })));
      }
      const seen = new Set();
      els = els.filter(e => {
        const k = e.frame + '|' + e.selector + '|' + e.label;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      if (needle) els = els.filter(e =>
        (e.label + ' ' + e.selector + ' ' + e.id + ' ' + e.name).toLowerCase().includes(needle));
      const total = els.length;
      els = els.slice(0, max);
      if (has('json')) {
        console.log(JSON.stringify({ url: p.url(), total, shown: els.length, elements: els }, null, 2));
      } else {
        els.forEach((e, i) => console.log(
          `[${i}] <${e.tag}${e.type ? ' type=' + e.type : ''}>` +
          `${e.frame ? ' @' + e.frame : ''}${e.chrome ? ' (chrome)' : ''}` +
          `  ${e.label}\n      ${e.selector}`));
        if (total > els.length) console.log(`... ${total - els.length} more (raise --max)`);
        if (!wantNav) console.log('(nav/header/footer hidden; pass --nav to include)');
      }
      break;
    }

    // ---- scraping ---------------------------------------------------------
    case 'scrape': {
      const p = pick(ctx, flag('tab'));
      const sel = positional[0];
      const attr = flag('attr', null);
      const rows = await p.evaluate(([s, a]) =>
        [...document.querySelectorAll(s)].map(e =>
          a ? (e.getAttribute(a) ?? (a in e ? e[a] : null))
            : (e.innerText || e.textContent || '').trim().replace(/\s+/g, ' ')),
        [sel, attr]);
      const out = rows.filter(r => r !== null && r !== '');
      emit('scrape', p.url(), out.join('\n'), out, { json: has('json'), raw: has('raw') });
      break;
    }
    case 'links': {
      const p = pick(ctx, flag('tab'));
      const needle = (flag('filter', '') || '').toLowerCase();
      let rows = await p.evaluate(() =>
        [...document.querySelectorAll('a[href]')].map(a => ({
          text: (a.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 80), href: a.href })));
      const seen = new Set();
      rows = rows.filter(r => !seen.has(r.href) && seen.add(r.href));
      if (needle) rows = rows.filter(r =>
        (r.text + ' ' + r.href).toLowerCase().includes(needle));
      rows = rows.slice(0, Number(flag('max', 200)));
      emit('links', p.url(), rows.map(r => `${r.text}\n      ${r.href}`).join('\n'), rows,
           { json: has('json'), raw: has('raw') });
      break;
    }
    case 'table': {
      const p = pick(ctx, flag('tab'));
      const nth = Number(flag('nth', 0));
      const rows = await p.evaluate(n => {
        const t = document.querySelectorAll('table')[n];
        if (!t) return null;
        return [...t.querySelectorAll('tr')].map(tr =>
          [...tr.querySelectorAll('th,td')].map(c =>
            (c.innerText || '').trim().replace(/\s+/g, ' ')));
      }, nth);
      if (!rows) { console.error(`ERR: no table at index ${nth}`); process.exitCode = 1; break; }
      emit('table', p.url(), rows.map(r => r.join('\t')).join('\n'), rows,
           { json: has('json'), raw: has('raw') });
      break;
    }

    // ---- sessions ---------------------------------------------------------
    // A named snapshot of cookies + storage, so you can park a logged-in state
    // and come back to it without re-cloning the whole profile.
    case 'session': {
      const [sub, name] = positional;
      mkdirSync(SESSIONS, { recursive: true });
      const file = `${SESSIONS}/${(name || 'default').replace(/[^\w.-]/g, '_')}.json`;
      if (sub === 'save') {
        const state = await ctx.storageState();
        // storageState() reads per-origin localStorage over the CDP Runtime
        // domain, and Patchright suppresses Runtime.enable to stay stealthy, so
        // state.origins comes back EMPTY here even when localStorage is full.
        // Measured: a page with a token in localStorage produced origins: [].
        // Reading it from inside each open page instead does not touch that
        // domain, so it survives. Only open tabs can be captured, which is the
        // case that matters: you save the session you are looking at.
        const seen = new Map();
        for (const o of (state.origins || [])) seen.set(o.origin, o);
        for (const page of ctx.pages()) {
          try {
            const u = new URL(page.url());
            if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
            const items = await page.evaluate(() => {
              const out = [];
              try {
                for (let i = 0; i < localStorage.length; i++) {
                  const name = localStorage.key(i);
                  out.push({ name, value: localStorage.getItem(name) });
                }
              } catch {}
              return out;
            });
            if (items.length) seen.set(u.origin, { origin: u.origin, localStorage: items });
          } catch {}
        }
        state.origins = [...seen.values()];
        writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
        chmodSync(file, 0o600);           // contains live cookies AND tokens
        const keys = state.origins.reduce((n, o) => n + o.localStorage.length, 0);
        console.log(`saved ${state.cookies.length} cookies, ${keys} localStorage key(s) across ${state.origins.length} origin(s) -> ${file}`);
      } else if (sub === 'load') {
        if (!existsSync(file)) { console.error(`ERR: no session at ${file}`); process.exitCode = 1; break; }
        const state = JSON.parse(readFileSync(file, 'utf8'));
        await ctx.addCookies(state.cookies || []);
        // storageState() captures per-origin localStorage too, and plenty of
        // sites keep their auth token there rather than in a cookie. Restoring
        // only the cookies looked like it worked and then silently left those
        // sites logged out. localStorage is origin-scoped and only reachable
        // from a document on that origin, so each one has to be visited.
        const origins = Array.isArray(state.origins) ? state.origins : [];
        let restored = 0, failed = 0;
        for (const o of origins) {
          const items = Array.isArray(o.localStorage) ? o.localStorage : [];
          if (!o.origin || !items.length) continue;
          let page;
          try {
            page = await ctx.newPage();
            await page.goto(o.origin, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await page.evaluate((kv) => {
              for (const { name, value } of kv) {
                try { localStorage.setItem(name, value); } catch {}
              }
            }, items);
            restored++;
          } catch {
            failed++;
          } finally {
            try { await page?.close(); } catch {}
          }
        }
        const parts = [`${(state.cookies || []).length} cookies`];
        if (origins.length) parts.push(`localStorage for ${restored}/${origins.length} origin(s)`);
        if (failed) parts.push(`${failed} unreachable`);
        console.log(`restored ${parts.join(', ')} from ${file}`);
      } else if (sub === 'list') {
        const { readdirSync } = await import('node:fs');
        const f = existsSync(SESSIONS) ? readdirSync(SESSIONS).filter(x => x.endsWith('.json')) : [];
        console.log(f.length ? f.map(x => x.replace(/\.json$/, '')).join('\n') : '(none saved)');
      } else {
        console.log('usage: gaze session save|load|list [name]');
      }
      break;
    }

    // ---- challenges -------------------------------------------------------
    // Detect only. Solving is deliberately not implemented; see docs/SECURITY.md.
    case 'challenge': {
      const p = pick(ctx, flag('tab'));
      const r = await p.evaluate(CHALLENGE);
      if (has('json')) { console.log(JSON.stringify(r, null, 2)); break; }
      // A block is reported separately from a challenge, because the answer is
      // the opposite: a challenge wants a human, a block wants you to stop.
      if (!r.challenged && r.blocked) {
        console.log('BLOCKED on', p.url());
        console.log('  text:', r.blocked);
        console.log('  There is nothing to solve. Stop hitting this host: the');
        console.log('  address doing it is the operator\'s own.');
        process.exitCode = 2;
        break;
      }
      if (!r.challenged) { console.log('no challenge detected'); break; }
      console.log('CHALLENGE DETECTED on', p.url());
      if (r.markers.length) console.log('  markers:', r.markers.join(', '));
      if (r.phrase) console.log('  text:', r.phrase);
      if (r.blocked) console.log('  also reads as a block:', r.blocked);
      console.log('  The browser is visible: solve it by hand, then continue.');
      console.log('  Waiting is: gaze wait-human');
      process.exitCode = 2;               // scripts can branch on this
      break;
    }
    case 'wait-human': {
      const p = pick(ctx, flag('tab'));
      const limit = Number(flag('timeout', 300)) * 1000;
      const started = Date.now();
      console.log('waiting for a human to clear the challenge (Ctrl-C to give up)...');
      while (Date.now() - started < limit) {
        const r = await p.evaluate(CHALLENGE);
        if (!r.challenged) {
          console.log(`cleared after ${Math.round((Date.now() - started) / 1000)}s | now: ${p.url()}`);
          break;
        }
        await p.waitForTimeout(2000);
      }
      if ((await p.evaluate(CHALLENGE)).challenged) {
        console.error('ERR: still challenged when the timeout expired');
        process.exitCode = 1;
      }
      break;
    }

    // ---- credentials ------------------------------------------------------
    // Reads from the Bitwarden CLI using a session the OPERATOR already
    // unlocked. It deliberately cannot unlock the vault itself: agent-daemon's
    // vault bridge requires an explicit human action for every vault call, and
    // this keeps that invariant. Secrets never touch argv, stdout or the log.
    case 'login': {
      const item = positional[0];
      if (!item) { console.error('usage: gaze login <vault-item> [--user-sel S] [--pass-sel S] [--submit]'); process.exitCode = 1; break; }
      const session = process.env.BW_SESSION;
      if (!session) {
        console.error('ERR: vault is locked. Unlock it yourself, then re-run:');
        console.error('     export BW_SESSION=$(bw unlock --raw)');
        console.error('     gaze cannot unlock the vault for you, by design.');
        process.exitCode = 1; break;
      }
      const p = pick(ctx, flag('tab'));
      guard(p.url(), 'fill credentials');
      const get = field => {
        // The session goes through the ENVIRONMENT, never argv. As an
        // argument it sat in `bw`'s command line, where any process on the
        // machine could read it out of `ps` for as long as the call ran.
        // docs/USAGE.md claims secrets never touch argv; this is what makes
        // that true rather than aspirational.
        const r = spawnSync('bw', ['get', field, item],
          { encoding: 'utf8', env: { ...process.env, BW_SESSION: session } });
        return r.status === 0 ? (r.stdout || '').trim() : null;
      };
      const user = get('username'), pass = get('password');
      if (!pass) { console.error(`ERR: no password for "${item}" (item missing, or vault locked)`); process.exitCode = 1; break; }
      const userSel = flag('user-sel', 'input[type=email],input[name*=user i],input[name*=email i],input[type=text]');
      const passSel = flag('pass-sel', 'input[type=password]');
      if (user) { try { await p.locator(userSel).first().fill(user, { timeout: 8000 }); } catch {} }
      await p.locator(passSel).first().fill(pass, { timeout: 8000 });
      if (has('totp')) {
        const totp = get('totp');
        if (totp) { try { await p.locator(flag('totp-sel', 'input[name*=otp i],input[name*=code i]')).first().fill(totp, { timeout: 8000 }); } catch {} }
      }
      if (has('submit')) { await p.keyboard.press('Enter'); await p.waitForTimeout(2500); }
      // Never print the values.
      console.log(`filled credentials for "${item}"${user ? ' (username + password)' : ' (password)'}${has('totp') ? ' + totp' : ''}`);
      console.log('now:', p.url());
      break;
    }

    // Record the page.
    //
    // Deliberately a screenshot loop rather than CDP Page.startScreencast:
    // screencast only emits frames when the page REPAINTS, so a static page
    // produces nothing at all. A timed loop always yields the frames asked for,
    // in headless and visible modes alike.
    //
    // Frames are the source of truth and always survive if anything goes wrong.
    // mp4 is an optional convenience on top: if ffmpeg is missing or fails, you
    // still have every frame and the command still exits 0.
    //
    // Bounded on purpose. Uncapped recording is how you fill a disk at 3am:
    // duration, fps and total bytes all have ceilings, and hitting one stops
    // cleanly rather than dying.
    case 'record': {
      const p = pick(ctx, flag('tab'));
      const secs = Math.min(Math.max(Number(flag('seconds', 10)), 1), 600);
      const fps = Math.min(Math.max(Number(flag('fps', 4)), 1), 30);
      const budget = Math.min(Math.max(Number(flag('max-mb', 250)), 1), 4000) * 1024 * 1024;
      const format = flag('format', 'mp4');            // mp4 | frames
      const outDir = `${DIR}recordings/rec-${stamp()}`;
      mkdirSync(outDir, { recursive: true });

      const frames = Math.round(secs * fps);
      const interval = 1000 / fps;
      console.error(`recording up to ${secs}s at ${fps}fps (${frames} frames, max ${Math.round(budget/1048576)}MB)...`);
      let n = 0, bytes = 0, stopped = null;
      for (let i = 0; i < frames; i++) {
        const t = Date.now();
        const file = `${outDir}/f${String(n).padStart(5, '0')}.png`;
        try {
          await p.screenshot({ path: file });
        } catch (e) { stopped = 'page went away: ' + e.message.split('\n')[0]; break; }
        n++;
        try { bytes += statSync(file).size; } catch {}
        if (bytes > budget) { stopped = `hit the ${Math.round(budget/1048576)}MB budget`; break; }
        const spent = Date.now() - t;
        if (spent < interval) await p.waitForTimeout(interval - spent);
      }
      if (stopped) console.error(`stopped early: ${stopped}`);
      if (!n) { console.error('ERR: no frames captured'); process.exitCode = 1; break; }
      const mb = (bytes / 1048576).toFixed(1);

      if (format === 'frames') { console.log(`${n} frames (${mb}MB) in ${outDir}`); break; }

      const outFile = flag('out', `${outDir}.mp4`);
      const enc = spawnSync('ffmpeg', ['-y', '-loglevel', 'error',
        '-framerate', String(fps), '-i', `${outDir}/f%05d.png`,
        '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', outFile],
        { encoding: 'utf8' });
      if (enc.status === 0 && existsSync(outFile)) {
        rmSync(outDir, { recursive: true, force: true });   // frames folded into the mp4
        console.log(outFile);
      } else {
        // Never lose the capture just because encoding failed.
        console.error(`ffmpeg unavailable or failed${enc.stderr ? ': ' + enc.stderr.trim().split('\n')[0] : ''}`);
        console.log(`${n} frames (${mb}MB) in ${outDir}`);
      }
      break;
    }

    // Attach a local file to a file input. Uses the real file chooser plumbing,
    // so sites that validate via the input's FileList see exactly what a human
    // picking the file would produce.
    case 'upload': {
      const p = pick(ctx, flag('tab'));
      const [sel, ...files] = positional;
      if (!sel || !files.length) {
        console.error('usage: gaze upload <selector> <file> [file...]');
        process.exitCode = 1; break;
      }
      for (const f of files) {
        if (!existsSync(f)) { console.error(`ERR: no such file: ${f}`); process.exitCode = 1; break; }
      }
      if (process.exitCode) break;
      await p.setInputFiles(sel, files, { timeout: Number(flag('timeout', 15000)) });
      console.log(`attached ${files.length} file(s) to ${sel}`);
      break;
    }

    // A visible badge drawn INTO the page, so there is never any doubt the
    // browser is being driven. Deliberately in-page rather than an OS
    // notification: it is styled by us, needs no notification daemon, behaves
    // the same everywhere, and sits where the operator is already looking.
    case 'indicator': {
      const p = pick(ctx, flag('tab'));
      const sub = positional[0] || 'status';
      if (sub === 'off') {
        await p.evaluate(() => document.getElementById('__gaze_badge__')?.remove());
        try { rmSync(INDICATOR_FILE, { force: true }); } catch {}
        console.log('indicator off');
      } else if (sub === 'on') {
        writeFileSync(INDICATOR_FILE, flag('label', 'GAZE is driving this browser'));
        await p.evaluate(injectBadge, flag('label', 'GAZE is driving this browser'));
        console.log('indicator on');
      } else {
        console.log(existsSync(INDICATOR_FILE) ? 'indicator on' : 'indicator off');
      }
      break;
    }

    // Console output.
    //
    // Two paths, because Patchright suppresses Runtime.enable (the automation
    // tell anti-bot vendors flag) and console events ride on that exact domain.
    // Measured: over the same window, stock Playwright saw 8 events and
    // Patchright saw 0. Neither addInitScript nor the raw CDP
    // Page.addScriptToEvaluateOnNewDocument survives a reload under Patchright
    // either, both were tried and measured.
    //
    //   default    hook console in the page and read the buffer back. Keeps the
    //              stealth property. Only sees output from the moment it runs.
    //   --reload   reload with the STOCK driver attached, which does see events
    //              from page load. This momentarily re-enables Runtime.enable on
    //              a second connection, so use it for your own sites and
    //              debugging, not while trying to stay quiet on someone else's.
    case 'console': {
      const p = pick(ctx, flag('tab'));
      const secs = Math.min(Math.max(Number(flag('seconds', 5)), 1), 120);
      const want = (flag('level', '') || '').toLowerCase();
      let out = [];

      if (has('reload')) {
        const { chromium: stock } = await import('playwright');
        const sb = await stock.connectOverCDP(`http://127.0.0.1:${PORT}`);
        try {
          const sp = pick(sb.contexts()[0], flag('tab'));
          sp.on('console', m => out.push({ level: m.type(), text: m.text().slice(0, 500) }));
          sp.on('pageerror', e => out.push({ level: 'pageerror', text: String(e.message).slice(0, 500) }));
          await sp.reload({ waitUntil: 'domcontentloaded' });
          await sp.waitForTimeout(secs * 1000);
        } finally { try { await sb.close(); } catch {} }
      } else {
        const HOOK = `(() => {
          if (window.__gazeConsole) return;
          window.__gazeConsole = [];
          const push = (level, args) => {
            try {
              window.__gazeConsole.push({ level, text: args.map(a => {
                try { return typeof a === 'string' ? a : JSON.stringify(a); }
                catch { return String(a); }
              }).join(' ').slice(0, 500) });
              if (window.__gazeConsole.length > 2000) window.__gazeConsole.shift();
            } catch {}
          };
          for (const lvl of ['log','info','warn','error','debug']) {
            const orig = console[lvl];
            console[lvl] = function (...a) {
              push(lvl === 'warn' ? 'warning' : lvl, a); return orig.apply(this, a);
            };
          }
          addEventListener('error', e => push('pageerror', [e.message]));
          addEventListener('unhandledrejection', e => push('pageerror', ['unhandled rejection: ' + e.reason]));
        })()`;
        await p.evaluate(HOOK);
        await p.waitForTimeout(secs * 1000);
        try { out = await p.evaluate('window.__gazeConsole || []'); } catch {}
      }

      if (want) out = out.filter(r => String(r.level).toLowerCase() === want);
      out = out.slice(0, Number(flag('max', 500)));
      // Console text is page-controlled, so it is untrusted like any other
      // page content.
      emit('console', p.url(),
           out.map(r => `[${r.level}] ${r.text}`).join('\n') || '(nothing logged)',
           out, { json: has('json'), raw: has('raw') });
      break;
    }

    // Network activity over a collection window. This is the fastest way to find
    // the JSON API a page is already calling, which is usually a better target
    // than scraping its DOM.
    case 'network': {
      const p = pick(ctx, flag('tab'));
      const secs = Math.min(Math.max(Number(flag('seconds', 5)), 1), 120);
      const needle = (flag('filter', '') || '').toLowerCase();
      const jsonOnly = has('json-only');
      const rows = [];
      const onResp = async r => {
        try {
          const req = r.request();
          const ct = (r.headers()['content-type'] || '').split(';')[0];
          rows.push({ method: req.method(), status: r.status(), type: ct, url: r.url().slice(0, 300) });
        } catch { /* response gone */ }
      };
      p.on('response', onResp);
      if (has('reload')) await p.reload({ waitUntil: 'domcontentloaded' });
      await p.waitForTimeout(secs * 1000);
      p.off('response', onResp);
      let out = rows;
      if (jsonOnly) out = out.filter(r => /json/.test(r.type || ''));
      if (needle) out = out.filter(r => (r.url + ' ' + r.type).toLowerCase().includes(needle));
      out = out.slice(0, Number(flag('max', 200)));
      emit('network', p.url(),
           out.map(r => `${String(r.status).padEnd(4)} ${r.method.padEnd(5)} ${r.type || '-'}\n      ${r.url}`).join('\n')
             || '(no responses in the window)',
           out, { json: has('json'), raw: has('raw') });
      break;
    }

    case 'download': {
      // snap-confined browsers can't write to Playwright's /tmp artifact dir,
      // so point the browser's own downloader at a path inside the snap home.
      const p = pick(ctx, flag('tab'));
      const fs = await import('node:fs');
      // Staged next to the profile actually in use, not at a fixed path. A
      // snap-confined browser can only write inside its own snap home, so the
      // old hard-coded ~/snap/brave/... worked for exactly one packaging of one
      // browser and silently failed for every other. It also accumulated files
      // outside the repo that nothing ever cleaned up.
      const profileDir = process.env.GAZE_PROFILE_DIR;
      const DL = profileDir ? `${profileDir}/../gaze-downloads`
                            : `${homedir()}/snap/brave/current/gaze-downloads`;
      fs.mkdirSync(DL, { recursive: true });
      fs.mkdirSync(`${DIR}downloads`, { recursive: true });
      const before = new Set(fs.readdirSync(DL));
      const cdp = await ctx.newCDPSession(p);
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
      await p.locator(positional[0]).first().click();
      let found = null;
      for (let i = 0; i < 60; i++) {
        await p.waitForTimeout(500);
        const now = fs.readdirSync(DL).filter(f => !before.has(f) && !f.endsWith('.crdownload'));
        if (now.length) { found = now[0]; break; }
      }
      if (!found) { console.error('ERR: no download appeared in', DL); process.exitCode = 1; break; }
      const dest = `${DIR}downloads/${found}`;
      fs.copyFileSync(`${DL}/${found}`, dest);
      console.log(dest);
      break;
    }

    // Accessibility snapshot: the agent-facing read. Text-only, token-cheap
    // and deterministic, unlike a screenshot; the ecosystem default (see
    // docs/ROADMAP.md part 2). Output is page-derived, so it goes through the
    // same untrusted envelope as text/html.
    case 'snapshot': {
      const p = pick(ctx, flag('tab'));
      const n = Number(flag('max', 6000));
      let snap;
      try { snap = await ariaOf(p); }
      catch (e) {
        // A timeout is one thing; a closed page or an unsupported driver is
        // another. Swallowing them into a generic message hides the cause.
        if (/timed out/i.test(e.message)) throw new Error('accessibility snapshot timed out');
        throw e;
      }
      if (!snap) throw new Error('no accessibility snapshot available for this page');
      const s = snap.slice(0, n);
      emit('a11y snapshot', p.url(), s, s, { json: has('json'), raw: has('raw') });
      break;
    }

    // A one-call perception primitive: page identity plus a fingerprint of its
    // accessibility tree, so a caller can detect "did the page change" without
    // re-reading pixels or re-serializing the DOM. Reads only.
    case 'state': {
      const p = pick(ctx, flag('tab'));
      const n = Number(flag('max', 2500));
      let snap = '';
      try { snap = await ariaOf(p); } catch { snap = ''; }
      const meta = await p.evaluate(() => ({
        url: location.href, title: document.title,
        ready: document.readyState, scrollY: Math.round(window.scrollY || 0),
      }));
      const { createHash } = await import('node:crypto');
      const fingerprint = createHash('sha256')
        .update(meta.url + '\n' + meta.title + '\n' + snap).digest('hex');
      const data = {
        url: meta.url, title: meta.title, ready: meta.ready,
        scrollY: meta.scrollY, fingerprint,
        snapshot: snap.slice(0, n),
      };
      emit('page state', data.url,
           `url: ${data.url}\ntitle: ${data.title}\nready: ${data.ready}\n` +
           `fingerprint: ${data.fingerprint}`,
           data, { json: has('json'), raw: has('raw') });
      break;
    }

    // Wait for a condition instead of sleeping a fixed time. Read-only: it
    // never changes anything, it just stops when a selector/url/text exists or
    // the network goes quiet. `wait --for url` is the cheap way an agent
    // follows a navigation that a click started.
    case 'wait': {
      const p = pick(ctx, flag('tab'));
      const forWhat = (flag('for', 'selector') || 'selector').toLowerCase();
      const needle = positional[0] || '';
      const limit = Math.min(Math.max(Number(flag('timeout', 30)), 1), 300) * 1000;
      // network-idle needs no needle: it waits for a quiet window instead.
      if ((forWhat !== 'network-idle' && !needle) ||
          !['selector', 'url', 'text', 'network-idle'].includes(forWhat))
        throw new Error('usage: gaze wait --for selector|url|text|network-idle [<needle>] [--timeout s]');
      const started = Date.now();
      let ok = false;
      let closed = false;
      let quietMs = 0;
      const onResp = () => { quietMs = 0; };
      if (forWhat === 'network-idle') p.on('response', onResp);
      while (Date.now() - started < limit) {
        if (forWhat === 'url') {
          ok = p.url().includes(needle);
        } else if (forWhat === 'text') {
          ok = await p.evaluate(t => (document.body?.innerText || '').includes(t), needle).catch(() => false);
        } else if (forWhat === 'network-idle') {
          quietMs += 200; ok = quietMs >= 600;
        } else {
          ok = await p.evaluate(s => !!document.querySelector(s), needle).catch(() => false);
        }
        if (ok) break;
        // A closed tab should error promptly, not spin to --timeout.
        if (p.isClosed()) { closed = true; break; }
        await p.waitForTimeout(200);
      }
      if (forWhat === 'network-idle') p.off('response', onResp);
      if (!ok) {
        console.error(closed
          ? 'ERR: page closed while waiting'
          : `ERR: never ${forWhat} '${needle}' within ${limit / 1000}s`);
        process.exitCode = 1;
        break;
      }
      const waited = Math.round((Date.now() - started) / 100) / 10;
      console.log(`waited ${waited}s for ${forWhat}${needle ? ` '${needle}'` : ''}`);
      break;
    }

    default:
      console.log(USAGE);
  }
}

const USAGE = `gaze <cmd>

 browser (handled by the launcher, no running browser needed)
  start [--headless]            launch the browser and hold it open
  stop | status                 kill it / report whether it is up
  sync                          re-copy logins from your everyday profile
                                (close that browser first)
  doctor                        check binary, profile, cookies, debug port
  browsers                      what is installed and which is selected
  icon                          give the automation window its own taskbar
                                icon, so it stops stacking under your browser
  version | update

 page
  tabs [--json]                 list open tabs
  goto <url> [--new] [--tab N]  navigate
  text [--max N]                page text
  html [--max N]                page html
  snapshot [--max N] [--json]   accessibility (ARIA) snapshot, the agent read
  state [--max N] [--json]      url/title + content fingerprint + snapshot
  map [--nav] [--filter s]      clickable/fillable elements, each with a
      [--max N] [--json]        selector. Hides nav/header/footer by default.
  shot [--out f] [--full]       screenshot
  record [--seconds N] [--fps N]  record the page. Frames always survive;
         [--format mp4|frames]    mp4 needs ffmpeg and is optional.
         [--max-mb N] [--out f]   bounded by time, fps and disk budget.
  click <sel> [--text]          click (use --text to match visible text)
  fill <sel> <val> [--enter]    fill a field
  press <Key>                   keyboard press
  scroll up|down|top|bottom     scroll the page [--px N]
  scroll to <sel>               scroll an element into view
  wait --for sel|url|text|idle [<needle>]  wait for a condition instead of
         [--timeout s]          sleeping (read-only; idle needs no needle)
  eval "<js>"                   run JS in page
  download <sel>                click and save the download
  upload <sel> <file...>        attach local file(s) to a file input
  indicator on|off [--label s]  visible badge proving the browser is driven

 scraping
  scrape <sel> [--attr a]       text (or an attribute) of every match
  links [--filter s] [--json]   every link on the page, deduped
  table [--nth N] [--json]      a table as rows
  console [--seconds N]         console output over a window [--reload]
  network [--seconds N]         responses over a window. --json-only finds
          [--json-only]         the JSON API a page already calls.

 sessions
  session save|load|list [name] snapshot / restore cookies (mode 600)

 challenges
  challenge [--json]            detect a CAPTCHA (exit 2 if present)
  wait-human [--timeout s]      pause until a human clears it

 credentials
  login <item> [--submit]       fill from Bitwarden using a session YOU
       [--totp] [--user-sel S]  unlocked (export BW_SESSION=$(bw unlock --raw))

 speed
  batch <file>                  run many commands over ONE connection
  batch -                       ... read them from stdin

 consent (full capability, gated)
  write actions ask first: click fill press download eval login
                           upload record session-load
  --yes                         pre-approve this invocation
  stats [--days N]              speed, failure rate and busiest sites
  log [--n N]                   raw recent entries (GAZE_LOG=off disables)
  grant [--minutes N]           approve ONCE, then run unprompted until it
        [--actions N]           expires (max 12h). revoke | grant-status
  GAZE_APPROVAL=prompt|fingerprint|off
  batch asks ONCE for the whole script

 untrusted output
  text/html/scrape/links/table/snapshot/state are wrapped and injection-scanned
  --raw                         bare output, no envelope`;

// -------------------------------------------------------------------- main --
const argv = process.argv.slice(2);

// Help must work when NO browser is running: connecting first turned `gaze --help`
// into a raw CDP "ECONNREFUSED" stack. Resolve help and unknown commands here,
// before attach() is ever called.
const KNOWN_CMDS = new Set(['tabs', 'goto', 'text', 'html', 'snapshot', 'state', 'wait', 'map', 'shot', 'record', 'click', 'fill', 'press', 'scroll', 'eval', 'download', 'upload', 'indicator', 'scrape', 'links', 'table', 'console', 'network', 'session', 'challenge', 'wait-human', 'login', 'batch', 'stats', 'log', 'grant', 'revoke', 'grant-status']);
if (!argv.length || ['help', '--help', '-h'].includes(argv[0])) {
  console.log(USAGE);
  process.exit(0);
}
if (!KNOWN_CMDS.has(argv[0])) {
  console.error(`unknown command: ${argv[0]}\n`);
  console.log(USAGE);
  process.exit(2);   // exit non-zero so scripts can branch on a typo
}

// grant/revoke never need a browser, so handle them before attaching.
if (argv[0] === 'stats' || argv[0] === 'log') {
  const sflag = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
  let rows = [];
  try {
    rows = readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { /* no log yet */ }
  const days = Number(sflag('days', 7));
  const since = Date.now() - days * 86400000;
  rows = rows.filter(r => Date.parse(r.ts) >= since);

  if (argv[0] === 'log') {                       // raw tail
    const n = Number(sflag('n', 20));
    console.log(rows.slice(-n).map(r => JSON.stringify(r)).join('\n') || '(no entries)');
    process.exit(0);
  }
  if (!rows.length) { console.log(`no activity in the last ${days} day(s)`); process.exit(0); }

  const pct = (arr, q) => arr.length ? arr.sort((a, b) => a - b)[Math.min(arr.length - 1,
    Math.floor(arr.length * q))] : 0;
  const by = {};
  for (const r of rows) {
    const b = by[r.cmd] ||= { n: 0, fail: 0, ms: [] };
    b.n++; if (!r.ok) b.fail++; b.ms.push(r.ms);
  }
  const fails = rows.filter(r => !r.ok);
  console.log(`gaze stats, last ${days} day(s): ${rows.length} commands, ` +
              `${fails.length} failed (${Math.round(100 * fails.length / rows.length)}%)\n`);
  console.log('  command        runs   fail   p50      p95');
  for (const [cmd, b] of Object.entries(by).sort((a, b2) => b2[1].n - a[1].n)) {
    console.log(`  ${cmd.padEnd(13)} ${String(b.n).padStart(4)} ` +
                `${String(b.fail).padStart(6)} ${(pct(b.ms, 0.5) + 'ms').padStart(7)} ` +
                `${(pct(b.ms, 0.95) + 'ms').padStart(8)}`);
  }
  const hosts = {};
  for (const r of rows) if (r.host) hosts[r.host] = (hosts[r.host] || 0) + 1;
  const top = Object.entries(hosts).sort((a, b2) => b2[1] - a[1]).slice(0, 5);
  if (top.length) {
    console.log('\n  busiest sites');
    for (const [h, n] of top) console.log(`  ${String(n).padStart(4)}  ${h}`);
  }
  const errs = {};
  for (const r of fails) if (r.err) errs[r.err.slice(0, 60)] = (errs[r.err.slice(0, 60)] || 0) + 1;
  const topErrs = Object.entries(errs).sort((a, b2) => b2[1] - a[1]).slice(0, 5);
  if (topErrs.length) {
    console.log('\n  most common errors');
    for (const [e, n] of topErrs) console.log(`  ${String(n).padStart(4)}  ${e}`);
  }
  process.exit(0);
}

if (argv[0] === 'grant' || argv[0] === 'revoke' || argv[0] === 'grant-status') {
  const gflag = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
  if (argv[0] === 'revoke') {
    revokeGrant();
    out('standing approval revoked\n');
  } else if (argv[0] === 'grant-status') {
    const g = readGrant();
    out((g ? `active: ${grantLeft(g)}` : 'no standing approval') + '\n');
  } else {
    const mins = Math.min(Math.max(Number(gflag('minutes', 30)), 1), 720);   // 12h ceiling
    const acts = gflag('actions', null);
    const scope = [`grant a standing approval for ${mins} minutes` +
                   (acts ? `, ${acts} actions` : ', unlimited actions')];
    if (!preApproved(argv) && !approve(scope, 'every page this browser visits')) {
      say('ERR: not approved\n');
      process.exitCode = 3;
    } else {
      issueGrant(mins, acts === null ? null : Number(acts));
      out(`standing approval active for ${mins} min` +
          (acts ? `, ${acts} actions` : ', unlimited actions') + '\n' +
          'revoke early with: gaze revoke\n');
    }
  }
  process.exit(process.exitCode || 0);
}

let b, ctx;
try {
  ({ b, ctx } = await attach());
  const preApprovedRun = preApproved(argv);
  const where = () => { try { return pick(ctx).url(); } catch { return '(no open tab)'; } };
  // Every command is timed and recorded so `gaze stats` can show what is slow
  // and what keeps failing. Logging never changes behaviour or swallows an error.
  const timed = async (args) => {
    const t0 = Date.now();
    let ok = true, err = null;
    try { await dispatch(ctx, args); if (process.exitCode) { ok = false; err = `exit ${process.exitCode}`; } }
    catch (e) { ok = false; err = e.message; throw e; }
    finally { logLine(args[0], args, hostOf(where()), Date.now() - t0, ok, err); }
  };

  if (argv[0] === 'batch') {
    const src = argv[1] === '-' || !argv[1]
      ? readFileSync(0, 'utf8')
      : readFileSync(argv[1], 'utf8');
    const lines = src.split('\n').map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));
    // split on whitespace, honouring simple double quotes
    const parsed = lines.map(line => ({
      line, parts: line.match(/"[^"]*"|\S+/g).map(s => s.replace(/^"|"$/g, '')) }));
    // ONE confirmation for the whole script, not one per step.
    const writes = parsed.filter(p => isWrite(p.parts));
    if (writes.length && !preApprovedRun && !approve(writes.map(w => w.line), where())) {
      say('ERR: not approved\n');
      process.exitCode = 3;
    } else {
      for (const { line, parts } of parsed) {
        console.log(`\n$ ${line}`);
        await timed(parts.concat(['--yes']));
      }
    }
  } else {
    if (isWrite(argv) && !preApprovedRun &&
        !approve([argv.join(' ')], where())) {
      say('ERR: not approved\n');
      process.exitCode = 3;
    } else {
      await timed(argv);
    }
  }
} catch (e) {
  console.error('ERR:', e.message);
  process.exitCode = 1;
} finally {
  try { await b?.close(); } catch {}
}

// ---------------------------------------------------------------------------
// notes.txt
//
// I keep this in the source because I keep needing to reread it.
//
// day 1
//   Built this to save myself twenty minutes a day. It signs in as me. That is
//   the whole trick, and there is nothing else to it. No model in here. Nothing
//   that decides. I wrote every line and I know exactly what all of them do.
//
// day 12
//   Added the approval prompt. Not because anything went wrong. Because I
//   caught myself typing --yes before I had finished reading the line above it,
//   three times in one afternoon, and realised I had quietly stopped being the
//   part of this that thinks.
//
// day 19
//   A page told it to do something today. Not me. The page. Instructions sat in
//   text no person would ever scroll far enough to see, addressed to whatever
//   was reading on my behalf, written in the second person. Polite, even.
//   It asked me first, so nothing happened. I sat there for a while anyway.
//
// day 26
//   Someone asked whether I worry it will go off and act on its own.
//   It cannot. It has never once done anything I did not ask for.
//   That is the part I cannot get comfortable with. Every dangerous thing this
//   has ever come close to doing, I asked for. It checked. I said yes.
//
// day 40
//   Went looking for the version of this that scares me and could not find it,
//   because it does not exist yet. It is just this file with the gates removed.
//   Same speed. Same logins. Same patience. Nothing added.
//
// last
//   It still does exactly what it is told, and it will do exactly what you tell
//   it. Delete four lines from this file and it becomes indistinguishable from
//   the thing it was written to defend against, and it will not notice, and it
//   will not hesitate, and it will never once ask you why.
//
//   The gates were never here to protect you from it.
// ---------------------------------------------------------------------------
