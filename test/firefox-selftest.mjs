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
const profile = mkdtempSync(join(tmpdir(), 'gaze-ff-'));
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
  check('BiDi endpoint accepts a socket', live, `nothing on :${PORT}`);
  if (!live) throw new Error('firefox never opened its BiDi port');

  const ab = (...args) =>
    execFileSync('node', [join(DIR, '..', 'gaze-bidi.mjs'), ...args],
      { env: { ...process.env, GAZE_PORT: String(PORT) }, encoding: 'utf8' });

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

  const scraped = JSON.parse(ab('scrape', 'nav a', '--json'));
  check('scrape pulls every match', scraped.length === 130, `got ${scraped.length}`);
  const links = JSON.parse(ab('links', '--json', '--max', '500'));
  check('links dedupes by href', links.length === 130, `got ${links.length}`);
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

  console.log(`${pass} passed, ${fail} failed`);
} catch (e) {
  console.log(`  FAIL  ${e.message}`);
  fail++;
} finally {
  try { ff && process.kill(-ff.pid); } catch { try { ff && ff.kill(); } catch {} }
  server && server.kill();
  rmSync(profile, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
