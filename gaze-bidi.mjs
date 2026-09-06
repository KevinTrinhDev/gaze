#!/usr/bin/env node
// gaze Firefox backend, spoken over WebDriver BiDi.
//
// Firefox removed CDP in 141, so the Chromium path (gaze.mjs, Playwright over CDP)
// cannot drive it. --remote-debugging-port on Firefox now serves BiDi, which this
// speaks directly: Node 22 ships a global WebSocket, so no extra dependency.
import { writeFileSync, chmodSync } from 'node:fs';
// The SAME gate and the SAME untrusted envelope as the Chromium backend. Before
// this, neither existed here: `GAZE_BROWSER=firefox gaze click ...` ran with no
// approval at all, and page text came back bare with no injection scan, while
// the README and the MCP server both claimed the two backends behaved
// identically. Importing the one implementation is what makes that true.
import { isWrite, approve, preApproved, say } from './consent.mjs';
import { emit } from './untrusted.mjs';

const PORT = process.env.GAZE_PORT || '9225';
const DIR = new URL('.', import.meta.url).pathname;
// process.exit() tears the process down without waiting for stdout to DRAIN.
// To a terminal that is harmless, because those writes are synchronous, but to
// a PIPE they are not: the last write can be discarded, and a caller reading
// our output sees an empty string and concludes the command printed nothing.
// Making the stream blocking costs nothing here (we print once and leave) and
// removes the failure mode everywhere, without restructuring every early exit.
try { process.stdout._handle?.setBlocking?.(true); } catch {}
try { process.stderr._handle?.setBlocking?.(true); } catch {}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

class Bidi {
  #ws; #id = 0; #pending = new Map();
  async connect() {
    // The BiDi endpoint is /session on the remote-agent port.
    this.#ws = new WebSocket(`ws://127.0.0.1:${PORT}/session`);
    await new Promise((res, rej) => {
      this.#ws.addEventListener('open', res, { once: true });
      this.#ws.addEventListener('error', () => rej(new Error(
        `no BiDi endpoint on :${PORT}; run: gaze start`)), { once: true });
    });
    this.#ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      const p = this.#pending.get(m.id);
      if (!p) return;                       // an event, not a reply
      clearTimeout(p.timer);                // else the timer holds the event loop open
      this.#pending.delete(m.id);
      m.type === 'error' ? p.rej(new Error(m.message || 'bidi error')) : p.res(m.result);
    });
    // Attaching to an already-running browser still needs a session.
    this.session = await this.send('session.new', { capabilities: { alwaysMatch: {} } })
      .catch(() => null);                   // already has one: fine
  }
  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => this.#pending.has(id) &&
        (this.#pending.delete(id), rej(new Error(`${method} timed out`))), 60000);
      timer.unref?.();                      // never keep the process alive on its own
      this.#pending.set(id, { res, rej, timer });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }
  // A BiDi session is bound to this websocket, and gaze runs one process per
  // command. Leaving the session open would make the NEXT command fail with
  // "session does not exist", so end it explicitly. The browser itself survives:
  // we attached to it, we did not launch it.
  async close() {
    // Fire and forget: Firefox tears the socket down on session.end and never
    // sends a reply, so awaiting one blocks until the request times out.
    try { this.#ws.send(JSON.stringify({ id: ++this.#id, method: 'session.end', params: {} })); } catch {}
    await new Promise(r => setTimeout(r, 150));
    try { this.#ws.close(); } catch {}
  }

  async contexts() {
    const { contexts } = await this.send('browsingContext.getTree', {});
    return contexts;
  }
  // Active tab = last non-blank top-level context, else the first.
  async pick(idx) {
    const cs = await this.contexts();
    if (!cs.length) throw new Error('no open tabs');
    if (idx != null) return cs[Number(idx)].context;
    const real = cs.filter(c => c.url && c.url !== 'about:blank');
    return (real.length ? real[real.length - 1] : cs[0]).context;
  }
  async evaluate(context, expression) {
    const r = await this.send('script.evaluate', {
      expression, target: { context }, awaitPromise: true, resultOwnership: 'none',
    });
    if (r.type === 'exception') throw new Error(r.exceptionDetails?.text || 'eval threw');
    return deserialize(r.result);
  }
}

// BiDi returns a typed value tree; flatten the parts we care about.
function deserialize(v) {
  if (!v || typeof v !== 'object') return v;
  switch (v.type) {
    case 'string': case 'number': case 'boolean': return v.value;
    case 'null': case 'undefined': return null;
    case 'array': return (v.value || []).map(deserialize);
    case 'object': return Object.fromEntries((v.value || [])
      .map(([k, val]) => [deserialize(k), deserialize(val)]));
    default: return v.value ?? null;
  }
}

const [cmd, ...rawArgs] = process.argv.slice(2);
// Everything after `--` is data, never a flag: see preApproved() in consent.mjs
// for why that distinction is a security property and not a nicety.
const dashDash = rawArgs.indexOf('--');
const rest = dashDash === -1 ? rawArgs : rawArgs.slice(0, dashDash);
const tail = dashDash === -1 ? [] : rawArgs.slice(dashDash + 1);
const flag = (n, d) => { const i = rest.indexOf(`--${n}`); return i === -1 ? d : rest[i + 1]; };
const has = n => rest.includes(`--${n}`);
const positional = rest.filter((a, i) =>
  !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--') &&
    !['headed', 'full', 'enter', 'new', 'nav', 'json', 'text', 'raw', 'yes', 'explain',
      'submit', 'totp', 'reload', 'json-only'].includes(rest[i - 1].slice(2))))
  .concat(tail);

// Shared with the Chromium backend in spirit: hide page chrome by default, walk
// shadow roots, emit a reusable selector. Kept as a string so it can be shipped
// through script.evaluate.
const MAP_JS = includeChrome => `(() => {
  const SEL = 'a,button,input,select,textarea,[role=button],[role=link],[role=textbox],[role=combobox],[role=checkbox],[role=tab],[contenteditable=true]';
  const out = [];
  const esc = s => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^\\w-]/g, '\\\\$&');
  const isChrome = e => !!(e.closest && e.closest('nav,header,footer,[role=navigation],[role=banner],[role=contentinfo]'));
  const sel = e => {
    const tag = e.tagName.toLowerCase();
    if (e.id) return '#' + esc(e.id);
    if (e.name) return tag + '[name="' + e.name + '"]';
    const aria = e.getAttribute('aria-label');
    if (aria) return tag + '[aria-label="' + aria.slice(0,40) + '"]';
    const t = (e.innerText || '').trim().replace(/\\s+/g,' ');
    if (t && t.length <= 40) return tag + ':has-text(' + JSON.stringify(t) + ')';
    return tag;
  };
  const walk = root => {
    let nodes = []; try { nodes = root.querySelectorAll(SEL); } catch { return; }
    for (const e of nodes) {
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const chrome = isChrome(e);
      if (chrome && !${includeChrome}) continue;
      const label = (e.getAttribute('aria-label') || e.placeholder || e.name || e.value ||
                     e.innerText || e.title || '').trim().replace(/\\s+/g,' ').slice(0,70);
      out.push({ tag: e.tagName.toLowerCase(), type: e.type || '', id: e.id || '',
                 name: e.name || '', label, selector: sel(e), chrome });
    }
    try { for (const e of root.querySelectorAll('*')) if (e.shadowRoot) walk(e.shadowRoot); } catch {}
  };
  walk(document);
  return JSON.stringify(out);
})()`;

const CHALLENGE_JS = `(() => {
  const marks = ['iframe[src*="recaptcha"]','iframe[src*="hcaptcha"]',
    'iframe[src*="challenges.cloudflare.com"]','iframe[src*="turnstile"]',
    '#challenge-form','.g-recaptcha','.h-captcha','.cf-turnstile',
    '#cf-challenge-running','.cf-browser-verification','#cf-please-wait',
    '#px-captcha','.px-captcha-container','[id^="px-captcha"]',
    '.datadome-captcha','#datadome-captcha',
    'iframe[src*="captcha-delivery.com"]','iframe[src*="perimeterx"]',
    'iframe[src*="funcaptcha"]','[id*="arkose"]','.ChallengeChallenge',
    '[id*="kasada"]','script[src*="kasada"]',
    '#geetest_holder','.geetest_panel',
    '[id*="waf-captcha"]','[id^="awsWaf"]'];
  const shown = el => !!el && (el.getClientRects().length > 0 || !!el.offsetParent);
  const found = marks.filter(m => shown(document.querySelector(m)));
  const t = (document.body ? document.body.innerText : '').toLowerCase();
  const phrase = ['verify you are human','i am not a robot','checking your browser',
    'complete the security check','just a moment','verifying you are human',
    'needs to review the security of your connection',
    'enable javascript and cookies to continue',
    'press & hold','press and hold',
    'funcaptcha','arkose','kasada','geetest','aws waf','slide to continue']
    .find(p => t.includes(p));
  return JSON.stringify({ challenged: found.length > 0 || !!phrase, markers: found,
                          phrase: phrase || null });
})()`;

// The gate runs BEFORE the browser is touched, exactly as it does on the
// Chromium side. A refusal exits 3 so callers can branch on it.
const preApprovedRun = preApproved(rest);
if (isWrite([cmd, ...positional]) && !preApprovedRun) {
  const where = `the page this Firefox is on (:${PORT})`;
  if (!approve([`${cmd} ${positional.join(' ')}`.trim()], where)) {
    say('ERR: not approved\n');
    process.exit(3);
  }
}

const b = new Bidi();
try {
  await b.connect();
  switch (cmd) {
    case 'tabs': {
      const cs = await b.contexts();
      const rows = cs.map((c, i) => ({ index: i, url: c.url }));
      if (has('json')) console.log(JSON.stringify(rows, null, 2));
      else rows.forEach(r => console.log(`[${r.index}] ${r.url}`));
      break;
    }
    case 'goto': {
      const ctx = await b.pick(flag('tab'));
      await b.send('browsingContext.navigate',
        { context: ctx, url: positional[0], wait: 'complete' });
      console.log('URL:', await b.evaluate(ctx, 'location.href'));
      console.log('TITLE:', await b.evaluate(ctx, 'document.title'));
      break;
    }
    case 'text': {
      const ctx = await b.pick(flag('tab'));
      const t = await b.evaluate(ctx, 'document.body.innerText');
      const body = String(t).replace(/\n{3,}/g, '\n\n').slice(0, Number(flag('max', 4000)));
      emit('page text', await b.evaluate(ctx, 'location.href'), body, body,
           { json: has('json'), raw: has('raw') });
      break;
    }
    case 'html': {
      const ctx = await b.pick(flag('tab'));
      const h = String(await b.evaluate(ctx, 'document.documentElement.outerHTML'))
        .slice(0, Number(flag('max', 8000)));
      emit('page html', await b.evaluate(ctx, 'location.href'), h, h,
           { json: has('json'), raw: has('raw') });
      break;
    }
    case 'eval': {
      const ctx = await b.pick(flag('tab'));
      console.log(JSON.stringify(await b.evaluate(ctx, positional[0]), null, 2));
      break;
    }
    case 'shot': {
      const ctx = await b.pick(flag('tab'));
      const out = flag('out', `${DIR}shots/shot-${stamp()}.png`);
      const r = await b.send('browsingContext.captureScreenshot', {
        context: ctx, origin: has('full') ? 'document' : 'viewport' });
      writeFileSync(out, Buffer.from(r.data, 'base64'), { mode: 0o600 });
      // A screenshot outlives the session and can hold anything on screen.
      try { chmodSync(out, 0o600); } catch {}
      console.log(out);
      break;
    }
    case 'map': {
      const ctx = await b.pick(flag('tab'));
      const wantNav = has('nav');
      const max = Number(flag('max', 200));
      const needle = (flag('filter', '') || '').toLowerCase();
      let els = JSON.parse(await b.evaluate(ctx, MAP_JS(wantNav)));
      if (needle) els = els.filter(e =>
        (e.label + ' ' + e.selector + ' ' + e.id + ' ' + e.name).toLowerCase().includes(needle));
      const total = els.length;
      els = els.slice(0, max);
      if (has('json')) {
        console.log(JSON.stringify({ total, shown: els.length, elements: els }, null, 2));
      } else {
        els.forEach((e, i) => console.log(
          `[${i}] <${e.tag}${e.type ? ' type=' + e.type : ''}>${e.chrome ? ' (chrome)' : ''}` +
          `  ${e.label}\n      ${e.selector}`));
        if (total > els.length) console.log(`... ${total - els.length} more (raise --max)`);
        if (!wantNav) console.log('(nav/header/footer hidden; pass --nav to include)');
      }
      break;
    }
    // Firefox/BiDi has input.performActions, but a JS click covers the cases we
    // actually use and keeps the selector syntax identical to the Chromium path.
    case 'click': {
      const ctx = await b.pick(flag('tab'));
      const sel = positional[0];
      const ok = await b.evaluate(ctx, has('text')
        ? `(() => { const el = [...document.querySelectorAll('a,button,[role=button],input,label')]
             .find(e => (e.innerText||e.value||'').includes(${JSON.stringify(sel)}));
             if (!el) return false; el.click(); return true; })()`
        : `(() => { const el = document.querySelector(${JSON.stringify(sel)});
             if (!el) return false; el.click(); return true; })()`);
      if (!ok) { console.error('ERR: no element matched', sel); process.exit(1); }
      console.log('clicked:', sel, '| now:', await b.evaluate(ctx, 'location.href'));
      break;
    }
    case 'fill': {
      const ctx = await b.pick(flag('tab'));
      const [sel, val] = positional;
      const ok = await b.evaluate(ctx,
        `(() => { const el = document.querySelector(${JSON.stringify(sel)});
           if (!el) return false;
           el.focus(); el.value = ${JSON.stringify(val)};
           el.dispatchEvent(new Event('input', {bubbles:true}));
           el.dispatchEvent(new Event('change', {bubbles:true}));
           ${has('enter') ? `el.form && el.form.requestSubmit && el.form.requestSubmit();` : ''}
           return true; })()`);
      if (!ok) { console.error('ERR: no element matched', sel); process.exit(1); }
      console.log('filled:', sel);
      break;
    }
    // Same command, same shape as the Chromium backend.
    case 'scroll': {
      const ctx = await b.pick(flag('tab'));
      const target = (positional[0] || 'down').toLowerCase();
      const px = Number(flag('px', 600));
      let landed;
      if (target === 'to') {
        const sel = positional[1];
        if (!sel) throw new Error('scroll to <selector>: no selector given');
        const ok = await b.evaluate(ctx, `(() => {
          const e = document.querySelector(${JSON.stringify(sel)});
          if (!e) return false;
          e.scrollIntoView({ block: 'center' });
          return true; })()`);
        if (!ok) throw new Error(`no element matched "${sel}"`);
        landed = `to ${sel}`;
      } else {
        if (!['up', 'down', 'top', 'bottom'].includes(target)) throw new Error(
          `scroll: expected up, down, top, bottom or "to <selector>", got "${target}"`);
        await b.evaluate(ctx, `(() => {
          const t = ${JSON.stringify(target)}, px = ${px};
          if (t === 'top') window.scrollTo({ top: 0 });
          else if (t === 'bottom') window.scrollTo({ top: document.body.scrollHeight });
          else window.scrollBy({ top: t === 'up' ? -px : px });
          return true; })()`);
        landed = target === 'top' || target === 'bottom' ? target : `${target} ${px}px`;
      }
      // documentElement, not body: see the note in gaze.mjs.
      const at = JSON.parse(await b.evaluate(ctx, `(() => {
        const doc = document.documentElement, bd = document.body;
        const full = Math.max(doc.scrollHeight, bd ? bd.scrollHeight : 0);
        return JSON.stringify({ y: Math.round(window.scrollY),
          of: Math.max(0, Math.round(full - window.innerHeight)) }); })()`));
      console.log(`scrolled ${landed} | at ${at.y}px of ${at.of}px`);
      break;
    }
    case 'scrape': {
      const ctx = await b.pick(flag('tab'));
      const attr = flag('attr', null);
      const js = `(() => [...document.querySelectorAll(${JSON.stringify(positional[0])})]
        .map(e => ${attr ? `(e.getAttribute(${JSON.stringify(attr)}) ?? null)`
                         : `(e.innerText || e.textContent || '').trim().replace(/\\s+/g,' ')`})
        .filter(v => v !== null && v !== ''))()`;
      const rows = await b.evaluate(ctx, `JSON.stringify(${js})`);
      const out = JSON.parse(rows);
      emit('scraped values', await b.evaluate(ctx, 'location.href'),
           out.join('\n'), out, { json: has('json'), raw: has('raw') });
      break;
    }
    case 'links': {
      const ctx = await b.pick(flag('tab'));
      const needle = (flag('filter', '') || '').toLowerCase();
      let rows = JSON.parse(await b.evaluate(ctx, `JSON.stringify(
        [...document.querySelectorAll('a[href]')].map(a => ({
          text: (a.innerText||'').trim().replace(/\\s+/g,' ').slice(0,80), href: a.href })))`));
      const seen = new Set();
      rows = rows.filter(r => !seen.has(r.href) && seen.add(r.href));
      if (needle) rows = rows.filter(r => (r.text + ' ' + r.href).toLowerCase().includes(needle));
      rows = rows.slice(0, Number(flag('max', 200)));
      emit('links', await b.evaluate(ctx, 'location.href'),
           rows.map(r => `${r.text}\n      ${r.href}`).join('\n'), rows,
           { json: has('json'), raw: has('raw') });
      break;
    }
    // Detect only. Solving is deliberately not implemented; see docs/SECURITY.md.
    case 'challenge': {
      const ctx = await b.pick(flag('tab'));
      const r = JSON.parse(await b.evaluate(ctx, CHALLENGE_JS));
      const explain = has('explain');
      if (has('json')) {
        if (explain) {
          const verdict = r.challenged ? 'challenge' : 'clean';
          const advice = r.challenged
            ? 'Solve it by hand in the visible window (gaze wait-human).'
            : '';
          console.log(JSON.stringify({ ...r, verdict, advice }, null, 2));
        } else console.log(JSON.stringify(r, null, 2));
        break;
      }
      if (explain) {
        console.log('verdict:', r.challenged ? 'challenge' : 'clean');
        const sig = [];
        if (r.markers.length) sig.push('markers: ' + r.markers.join(', '));
        if (r.phrase) sig.push('phrase: ' + r.phrase);
        if (sig.length) console.log('  signals:', sig.join(' | '));
        if (r.challenged) console.log('  advice: Solve it by hand in the visible window (gaze wait-human).');
      }
      if (!r.challenged) { console.log('no challenge detected'); break; }
      console.log('CHALLENGE DETECTED on', await b.evaluate(ctx, 'location.href'));
      if (r.markers.length) console.log('  markers:', r.markers.join(', '));
      if (r.phrase) console.log('  text:', r.phrase);
      console.log('  The browser is visible: solve it by hand, then continue.');
      process.exitCode = 2;
      break;
    }
    case 'wait-human': {
      const ctx = await b.pick(flag('tab'));
      const limit = Number(flag('timeout', 300)) * 1000;
      const started = Date.now();
      console.log('waiting for a human to clear the challenge (Ctrl-C to give up)...');
      let cleared = false;
      while (Date.now() - started < limit) {
        if (!JSON.parse(await b.evaluate(ctx, CHALLENGE_JS)).challenged) { cleared = true; break; }
        await new Promise(r => setTimeout(r, 2000));
      }
      if (cleared) console.log(`cleared after ${Math.round((Date.now()-started)/1000)}s`);
      else { console.error('ERR: still challenged when the timeout expired'); process.exitCode = 1; }
      break;
    }
    default:
      console.log(`gaze (firefox/BiDi backend) <cmd>
  tabs [--json] | goto <url> | text [--max N] | html [--max N]
  map [--nav] [--filter s] [--max N] [--json] | shot [--out f] [--full]
  click <sel> [--text] | fill <sel> <val> [--enter] | eval "<js>"

  scrape <sel> [--attr a] | links [--filter s] | challenge | wait-human

  Chromium-only for now: press, download, session, login, batch.`);
  }
} catch (e) {
  console.error('ERR:', e.message);
  process.exit(1);
} finally {
  await b.close();
}
