// Self-test for the Firefox / WebDriver BiDi backend (gaze-bidi.mjs).
//
// Launches a THROWAWAY headless Firefox with a fresh temp profile on its own
// port. It never touches a real profile, so it is safe to run at any time.
// Skips cleanly if no Firefox-family browser is installed.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const PORT = 9228;
const DIR = new URL('.', import.meta.url).pathname;

const CANDIDATES = [
  join(homedir(), '.local/opt/firefox-devedition/firefox'),
  '/usr/bin/firefox',
  '/snap/bin/firefox',
];
const BIN = CANDIDATES.find(p => existsSync(p));
if (!BIN) {
  console.log('firefox selftest: no Firefox-family browser installed, skipping');
  process.exit(0);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Same guard as the Chromium suite: a leftover browser on this port would be
// driven instead of the one we start, and the failures would look like product
// bugs rather than a dirty environment.
const ffPortOwner = execFileSync('bash', ['-c',
  `ss -ltnp 2>/dev/null | grep ":${PORT} " || true`], { encoding: 'utf8' }).trim();
if (ffPortOwner) {
  console.error(`port ${PORT} is already in use:\n  ${ffPortOwner}\n` +
                `clear it with:  bash killauto.sh ${PORT}`);
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), 'gaze-ff-'));
// Its own state directory, so the suite never touches the operator's real
// standing grant or telemetry.
const state = mkdtempSync(join(tmpdir(), 'gaze-ff-state-'));
let server, ff;
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { console.log(`  ok    ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ' -- ' + detail : ''}`); fail++; }
};

try {
  server = spawn('node', [join(DIR, 'fixture-server.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
  const url = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('fixture server never reported a port')), 10000);
    server.stdout.on('data', d => {
      const m = /PORT (\d+)/.exec(String(d));
      if (m) { clearTimeout(t); res(`http://127.0.0.1:${m[1]}/`); }
    });
  });

  ff = spawn(BIN, ['--headless', '--profile', profile, '--no-remote',
                   `--remote-debugging-port=${PORT}`, 'about:blank'],
             { stdio: 'ignore', detached: true });

  // Wait for the remote agent to accept a BiDi socket.
  let live = false;
  for (let i = 0; i < 30 && !live; i++) {
    await sleep(1000);
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/session`);
      live = await new Promise(r => {
        ws.addEventListener('open', () => { ws.close(); r(true); }, { once: true });
        ws.addEventListener('error', () => r(false), { once: true });
      });
    } catch { /* not up yet */ }
  }

  console.log(`gaze firefox selftest (${BIN})`);
  // A Firefox that is installed but will not open a BiDi port is an
  // ENVIRONMENT limitation, not a gaze regression: GitHub's ubuntu runner ships
  // /usr/bin/firefox but it never comes up there. Skip loudly rather than fail
  // loudly, and keep the security assertions elsewhere -- test:consent covers
  // the Firefox consent gate with no browser at all, so nothing that matters
  // gets skipped with it. Set GAZE_REQUIRE_FIREFOX=1 to make this fatal.
  if (!live && !process.env.GAZE_REQUIRE_FIREFOX) {
    console.log('  SKIP  firefox did not open a BiDi port in this environment');
    console.log('        (the consent gate is covered browser-free by test:consent)');
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(0);
  }
  check('BiDi endpoint accepts a socket', live, `nothing on :${PORT}`);
  if (!live) throw new Error('firefox never opened its BiDi port');

  const ab = (...args) =>
    execFileSync('node', [join(DIR, '..', 'gaze-bidi.mjs'), ...args],
      { env: { ...process.env, GAZE_PORT: String(PORT), GAZE_STATE: state,
               GAZE_APPROVAL: 'off' }, encoding: 'utf8' });

  const goto = ab('goto', url);
  check('goto reports the URL', goto.includes('127.0.0.1'), goto.trim());

  const tabs = JSON.parse(ab('tabs', '--json'));
  check('tabs --json is machine readable', Array.isArray(tabs) && tabs.length > 0);

  const text = ab('text', '--max', '2000');
  check('text reads the page body', text.includes('Nav item 0'));

  const map = JSON.parse(ab('map', '--json', '--max', '500'));
  const has = s => map.elements.some(e => (e.selector + e.label).includes(s));
  check('main-content input survives a 130-link nav', has('email'));
  check('open shadow DOM traversed', has('Shadow action'));
  check('nav hidden by default', !map.elements.some(e => e.chrome));
  check('every element carries a selector', map.elements.every(e => e.selector));

  const withNav = JSON.parse(ab('map', '--json', '--nav', '--max', '500'));
  check('--nav is a superset', withNav.total > map.total);

  const scrapeEnv = JSON.parse(ab('scrape', 'nav a', '--json'));
  check('scraped output is marked untrusted', scrapeEnv._untrusted === true);
  check('untrusted envelope names its source', String(scrapeEnv.source).includes('127.0.0.1'));
  const scraped = scrapeEnv.data;
  check('scrape pulls every match', scraped.length === 130, `got ${scraped.length}`);
  const links = JSON.parse(ab('links', '--json', '--max', '500')).data;
  check('links dedupes by href', links.length === 130, `got ${links.length}`);
  check('plain-text output carries the banner',
        ab('text', '--max', '200').includes('BEGIN UNTRUSTED'));
  const rawFf = JSON.parse(ab('scrape', 'nav a', '--json', '--raw'));
  check('--raw opts out of the envelope on Firefox too',
        Array.isArray(rawFf) && rawFf.length === 130);

  // ---- perception parity with the Chromium backend (ROADMAP part 4) ----
  const snap = JSON.parse(ab('snapshot', '--json', '--max', '4000'));
  check('firefox snapshot returns an enveloped a11y tree',
        snap._untrusted === true && snap.kind === 'a11y snapshot'
        && String(snap.data).length > 50, `snapshot ${String(snap.data).length} chars`);
  const st1 = JSON.parse(ab('state', '--json', '--raw'));
  const st2 = JSON.parse(ab('state', '--json', '--raw'));
  check('firefox state reports the real url', String(st1.url).includes('127.0.0.1'));
  check('firefox state fingerprint is sha256', /^[0-9a-f]{64}$/.test(st1.fingerprint));
  check('firefox state fingerprint is stable', st1.fingerprint === st2.fingerprint);
  const hostProbe = new URL(url).host;
  const wUrl = ab('wait', '--for', 'url', hostProbe, '--timeout', '5');
  check('firefox wait --for url returns when satisfied', /waited .* for url/.test(wUrl), wUrl.trim());
  const wSel = ab('wait', '--for', 'selector', 'input', '--timeout', '5');
  check('firefox wait --for selector returns when satisfied', /waited .* for selector/.test(wSel), wSel.trim());
  let wOut = '', wCode = 0;
  try { ab('wait', '--for', 'selector', '#nope', '--timeout', '1'); }
  catch (e) { wOut = (e.stdout || '') + (e.stderr || ''); wCode = e.status; }
  check('firefox wait times out with exit 1', wCode === 1 && /never selector/.test(wOut), `exit ${wCode}`);
  let niOut = '', niCode = 0;
  try { ab('wait', '--for', 'network-idle', 'x', '--timeout', '1'); }
  catch (e) { niOut = (e.stdout || '') + (e.stderr || ''); niCode = e.status; }
  check('firefox wait --for network-idle errors clearly',
        niCode === 1 && /not supported on the Firefox backend/.test(niOut), `exit ${niCode}`);

  check('no false challenge on a normal page', ab('challenge').includes('no challenge detected'));
  ab('goto', url + 'challenged');
  let cOut = '', cCode = 0;
  try { cOut = ab('challenge'); } catch (e) { cOut = e.stdout || ''; cCode = e.status; }
  check('detects a challenge page', cOut.includes('CHALLENGE DETECTED'));
  check('exits 2 so scripts can branch', cCode === 2, `exit ${cCode}`);
  ab('goto', url);

  ab('fill', 'input[name="email"]', 'someone@example.test');
  const filled = JSON.parse(ab('eval', 'document.querySelector(\'input[name="email"]\').value'));
  check('fill writes into the field', filled === 'someone@example.test', String(filled));
  const fillTrusted = ab('fill', 'input[name="password"]', 'pw-trusted');
  check('fill reports which input path ran',
        fillTrusted.includes('filled:') && /trusted input|synthetic fallback/.test(fillTrusted),
        fillTrusted.trim());
  ab('click', '#click-me');
  check('click is a trusted pointer action (isTrusted)',
        JSON.parse(ab('eval', 'document.getElementById(\'click-count\').textContent')).includes('1'));

  // ---- the consent gate exists on THIS backend too ------------------------
  // It did not, for the whole life of the Firefox backend: writes ran with no
  // approval at all while the README claimed both backends were identical.
  // These assertions exist so that can never quietly come back.
  const gated = (...args) => {
    try {
      return { out: execFileSync('node', [join(DIR, '..', 'gaze-bidi.mjs'), ...args],
        { env: { ...process.env, GAZE_PORT: String(PORT), GAZE_STATE: state },
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), code: 0 };
    } catch (e) { return { out: (e.stdout || '') + (e.stderr || ''), code: e.status }; }
  };
  const denied = gated('fill', 'input[name="email"]', 'blocked@example.test');
  check('a Firefox write with no terminal is refused', denied.code === 3, `exit ${denied.code}`);
  check('the refusal explains how to run unattended',
        denied.out.includes('GAZE_APPROVAL=off'));
  check('eval is gated on Firefox', gated('eval', '1+1').code === 3);
  check('click is gated on Firefox', gated('click', '#signin').code === 3);
  check('reads stay ungated on Firefox', gated('text', '--max', '50').code === 0);
  check('--yes pre-approves a Firefox write',
        gated('fill', 'input[name="email"]', 'ok@example.test', '--yes').code === 0);
  check('a selector named --yes cannot approve its own Firefox write',
        gated('fill', '--', '--yes', 'spoofed@example.test').code === 3);
  check('firefox snapshot stays ungated', gated('snapshot').code === 0);
  check('firefox wait stays ungated', gated('wait', '--for', 'url', hostProbe, '--timeout', '1').code === 0);

  console.log(`${pass} passed, ${fail} failed`);
} catch (e) {
  console.log(`  FAIL  ${e.message}`);
  fail++;
} finally {
  try { ff && process.kill(-ff.pid); } catch { try { ff && ff.kill(); } catch {} }
  server && server.kill();
  rmSync(profile, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
