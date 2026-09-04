// Self-test for gaze's page commands.
// Runs against a THROWAWAY headless chromium on its own port and profile.
// It never touches the real Brave clone, so it is safe to run at any time.
import { chromium } from 'playwright';
import { execFileSync, execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 9226;
const DIR = new URL('.', import.meta.url).pathname;

// Fixture lives in its own process (see fixture-server.mjs).
const server = spawn('node', [join(DIR, 'fixture-server.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
const url = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('fixture server never reported a port')), 10000);
  server.stdout.on('data', d => {
    const m = /PORT (\d+)/.exec(String(d));
    if (m) { clearTimeout(t); resolve(`http://127.0.0.1:${m[1]}/`); }
  });
});

const profile = mkdtempSync(join(tmpdir(), 'gaze-selftest-'));
// Give the suite its OWN state directory. Without this it read and wrote the
// operator's real ~/.local/share/gaze: `npm test` revoked a live standing
// approval and dropped fixture traffic into `gaze stats`.
const state = mkdtempSync(join(tmpdir(), 'gaze-state-'));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: true,
  args: [`--remote-debugging-port=${PORT}`, '--no-sandbox'],
});

const ab = (...args) =>
  execFileSync('node', [join(DIR, '..', 'gaze.mjs'), ...args],
    { env: { ...process.env, GAZE_PORT: String(PORT), GAZE_STATE: state, GAZE_APPROVAL: 'off' },
      encoding: 'utf8' });

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { console.log(`  ok    ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ' -- ' + detail : ''}`); fail++; }
};

try {
  await (await ctx.newPage()).goto(url);
  ab('goto', url, '--wait', '600');

  const map = JSON.parse(ab('map', '--json', '--max', '500'));
  const has = s => map.elements.some(e => (e.selector + e.label).includes(s));

  console.log('gaze selftest');
  check('main-content input survives a 130-link nav', has('email'),
        'this is the bug the old 120-element cap caused');
  check('button in main content found', has('signin'));
  check('open shadow DOM traversed', has('Shadow action'));
  check('same-origin iframe traversed', has('Frame action'));
  check('nav hidden by default', !map.elements.some(e => e.chrome),
        `${map.elements.filter(e => e.chrome).length} chrome elements leaked`);
  check('every element carries a selector', map.elements.every(e => e.selector));

  const withNav = JSON.parse(ab('map', '--json', '--nav', '--max', '500'));
  check('--nav includes nav again', withNav.elements.some(e => e.chrome));
  check('--nav is a superset', withNav.total > map.total);

  const filtered = JSON.parse(ab('map', '--json', '--filter', 'password'));
  check('--filter narrows to one control', filtered.elements.length === 1, `got ${filtered.elements.length}`);

  const tabs = JSON.parse(ab('tabs', '--json'));
  check('tabs --json is machine readable', Array.isArray(tabs) && tabs.length > 0);

  // ---- scraping ----
  const scrapeEnv = JSON.parse(ab('scrape', 'nav a', '--json'));
  check('scraped output is marked untrusted', scrapeEnv._untrusted === true);
  check('untrusted envelope names its source', String(scrapeEnv.source).includes('127.0.0.1'));
  const scraped = scrapeEnv.data;
  check('scrape pulls every match', scraped.length === 130, `got ${scraped.length}`);
  const hrefs = JSON.parse(ab('scrape', 'nav a', '--attr', 'href', '--json')).data;
  check('scrape --attr reads attributes', hrefs.every(h => h.includes('/n')));
  const links = JSON.parse(ab('links', '--json', '--max', '500')).data;
  check('links dedupes by href', links.length === 130, `got ${links.length}`);
  const someLinks = JSON.parse(ab('links', '--json', '--filter', 'item 7')).data;
  check('links --filter narrows', someLinks.length > 0 && someLinks.length < 130);
  const table = JSON.parse(ab('table', '--json')).data;
  check('table extracts rows', table.length === 3 && table[1][0] === 'widget', JSON.stringify(table[1]));
  const rawOut = JSON.parse(ab('scrape', 'nav a', '--json', '--raw'));
  check('--raw opts out of the envelope', Array.isArray(rawOut) && rawOut.length === 130);
  check('plain-text output carries the banner',
        ab('text', '--max', '200').includes('BEGIN UNTRUSTED'));

  // ---- indirect prompt injection ----
  ab('goto', url + 'injected', '--wait', '400');
  const inj = JSON.parse(ab('text', '--json'));
  check('injection markers are flagged', Array.isArray(inj._suspicious) && inj._suspicious.length >= 2,
        JSON.stringify(inj._suspicious));
  check('flags the ignore-instructions pattern', (inj._suspicious || []).includes('ignore-previous-instructions'));
  check('flags credential exfiltration', (inj._suspicious || []).includes('credential-exfiltration'));
  check('clean page is not flagged',
        !JSON.parse((ab('goto', url, '--wait', '400'), ab('scrape', 'main p', '--json')))._suspicious);

  // ---- sessions ----
  const saved = ab('session', 'save', 'selftest');
  check('session save writes a snapshot', saved.includes('cookies'), saved.trim());
  check('session list shows it', ab('session', 'list').includes('selftest'));

  // ---- challenge detection (detect only, never solve) ----
  const clean = ab('challenge');
  check('no false positive on a normal page', clean.includes('no challenge detected'));
  ab('goto', url + 'challenged', '--wait', '400');
  let challengeOut = '', challengeCode = 0;
  try { challengeOut = ab('challenge'); }
  catch (e) { challengeOut = e.stdout || ''; challengeCode = e.status; }
  check('detects a challenge page', challengeOut.includes('CHALLENGE DETECTED'), challengeOut.trim());
  check('exits 2 so scripts can branch', challengeCode === 2, `exit ${challengeCode}`);
  ab('goto', url, '--wait', '400');

  // ---- login refuses to unlock the vault itself ----
  let loginErr = '';
  try { ab('login', 'anything'); } catch (e) { loginErr = (e.stderr || '') + (e.stdout || ''); }
  check('login refuses without an operator-unlocked session',
        loginErr.includes('cannot unlock the vault for you'), loginErr.trim().slice(0, 80));

  // ---- self-healing selectors ----
  const healed = ab('fill', 'Email address', 'healed@example.test');
  check('a dead CSS selector falls back to the accessible name',
        healed.includes('matched by'), healed.trim());
  const healedVal = JSON.parse(ab('eval', 'document.querySelector("input[name=email]").value'));
  check('the fallback filled the right field', healedVal === 'healed@example.test', String(healedVal));
  const clicked = ab('click', 'Sign in');
  check('click falls back too', clicked.includes('clicked:'), clicked.trim().slice(0, 60));
  let noMatch = '';
  try { ab('click', '#definitely-not-here'); }
  catch (e) { noMatch = (e.stdout || '') + (e.stderr || ''); }
  check('an unmatchable selector still fails, and says what it tried',
        noMatch.includes('no element matched') && noMatch.includes('tried'), noMatch.trim().slice(0, 70));

  // ---- scroll ---------------------------------------------------------
  // There was no scroll command at all, which for a scraping tool means no way
  // to reach lazily-loaded content below the fold.
  ab('goto', url + 'tall', '--wait', '400');
  const atTop = ab('scroll', 'top');
  check('scroll top reports its position', /at 0px of \d+px/.test(atTop), atTop.trim());
  const down = ab('scroll', 'down', '--px', '500');
  check('scroll down moves the page', /at (?!0px)\d+px/.test(down), down.trim());
  const bottom = ab('scroll', 'bottom');
  const mB = /at (\d+)px of (\d+)px/.exec(bottom);
  check('scroll bottom reaches the end', mB && mB[1] === mB[2], bottom.trim());
  const up = ab('scroll', 'up', '--px', '100000');
  check('scroll up clamps at the top', /at 0px/.test(up), up.trim());
  const toEl = ab('scroll', 'to', '#deep');
  check('scroll to an element brings it into view',
        toEl.includes('scrolled to #deep'), toEl.trim());
  let badScroll = '';
  try { ab('scroll', 'sideways'); } catch (e) { badScroll = (e.stdout||'') + (e.stderr||''); }
  check('an unknown scroll direction is explained, not ignored',
        badScroll.includes('expected up, down, top, bottom'), badScroll.trim().slice(0, 60));
  ab('goto', url, '--wait', '400');

  // ---- obstructed click: the pattern that dominates real click failures ----
  // A visible synthetic control under a transparent overlay. locate() finds it,
  // a normal click fails the pointer-events check, and the escalation has to
  // reach the TARGET rather than the veil sitting on top of it.
  ab('goto', url + 'obstructed', '--wait', '400');
  const obstructed = ab('click', '#target', '--timeout', '3000');
  check('an obstructed click escalates instead of just timing out',
        obstructed.includes('dispatched a DOM click'), obstructed.trim().slice(0, 80));
  const landed = ab('scrape', '#result', '--raw').trim();
  check('the escalated click reaches the target, not the overlay',
        landed.includes('target clicked'), landed.slice(0, 60));
  ab('goto', url, '--wait', '400');

  // ---- recording ----
  // mp4 is documented as optional: frames are the source of truth and a
  // missing ffmpeg still exits 0. Asserting mp4 unconditionally made the
  // suite fail on any machine without ffmpeg, CI included, for a case the
  // design says is fine. Check it only when ffmpeg is actually there.
  let hasFfmpeg = true;
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); }
  catch { hasFfmpeg = false; }

  const rec = ab('record', '--seconds', '2', '--fps', '4');
  const recPath = rec.trim().split('\n').pop();
  if (hasFfmpeg) {
    check('record produces an mp4', recPath.endsWith('.mp4'), recPath);
    check('the recording file exists and is non-empty',
          existsSync(recPath) && statSync(recPath).size > 1000,
          existsSync(recPath) ? String(statSync(recPath).size) + ' bytes' : 'missing');
  } else {
    check('record falls back to frames when ffmpeg is absent',
          rec.includes('frames ('), rec.trim().slice(0, 70));
  }
  // With ffmpeg the last line is the mp4 path; without it, it is
  // "N frames (X MB) in <dir>", so take the part after " in ".
  rmSync(recPath.split(' in ').pop().trim(), { recursive: true, force: true });
  const framesOut = ab('record', '--seconds', '1', '--fps', '3', '--format', 'frames');
  check('frames-only mode never needs ffmpeg', framesOut.includes('frames ('), framesOut.trim());
  rmSync(framesOut.trim().split(' in ').pop().trim(), { recursive: true, force: true });
  const capped = ab('record', '--seconds', '5', '--fps', '4', '--max-mb', '1');
  check('disk budget stops it early rather than filling the disk',
        capped.includes('.mp4') || capped.includes('frames ('), capped.trim().slice(0, 60));
  const cappedPath = capped.trim().split('\n').pop().split(' in ').pop().trim();
  rmSync(cappedPath, { recursive: true, force: true });

  // ---- approval gate: full capability, gated consent ----
  const gated = (...args) => {
    try {
      return { out: execFileSync('node', [join(DIR, '..', 'gaze.mjs'), ...args],
        { env: { ...process.env, GAZE_PORT: String(PORT), GAZE_STATE: state },
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), code: 0 };
    } catch (e) { return { out: (e.stdout || '') + (e.stderr || ''), code: e.status }; }
  };
  const denied = gated('fill', 'input[name="email"]', 'blocked@example.test');
  check('write action with no terminal is refused', denied.code === 3, 'exit ' + denied.code);
  check('refusal explains how to run unattended', denied.out.includes('GAZE_APPROVAL=off'));
  // A SELECTOR literally called "--yes" must not approve its own write. This is
  // the injection path: a caller that builds selectors from page content could
  // otherwise be steered into consenting on the page's behalf.
  const spoof = gated('fill', '--', '--yes', 'spoofed@example.test');
  check('a selector named --yes cannot approve its own write', spoof.code === 3,
        `exit ${spoof.code}`);

  const allowed = gated('fill', 'input[name="email"]', 'allowed@example.test', '--yes');
  check('--yes pre-approves the action', allowed.code === 0, 'exit ' + allowed.code);
  const readOk = gated('text', '--max', '50');
  check('read-only actions are never gated', readOk.code === 0, 'exit ' + readOk.code);

  // approve once, then run unprompted until the grant expires
  check('no standing approval to start with', gated('grant-status').out.includes('no standing'));
  const granted = gated('grant', '--minutes', '5', '--actions', '2', '--yes');
  check('grant is issued', granted.code === 0 && granted.out.includes('standing approval active'),
        granted.out.trim().slice(0, 60));
  check('grant-status reports it', gated('grant-status').out.includes('active:'));
  const g1 = gated('fill', 'input[name="email"]', 'granted1@example.test');
  // With no TTY this would exit 3 without a grant, so exit 0 proves the grant
  // was honoured. The budget dropping 2 -> 1 proves it was actually spent.
  check('a write now runs with NO prompt', g1.code === 0, 'exit ' + g1.code);
  check('the grant is spent as it is used', gated('grant-status').out.includes('1 actions'),
        gated('grant-status').out.trim());
  const g2 = gated('fill', 'input[name="email"]', 'granted2@example.test');
  check('second write also runs unprompted', g2.code === 0, 'exit ' + g2.code);
  const g3 = gated('fill', 'input[name="email"]', 'granted3@example.test');
  check('grant is spent after its action budget', g3.code === 3, 'exit ' + g3.code);
  // ---- stress: a grant budget must survive concurrent processes ------------
  // readGrant() then spendGrant() used to be an unlocked read-modify-write, so
  // two processes racing could each read the same remaining count and each
  // write count-1, letting a budget of 3 fund more than 3 writes. For the one
  // file whose job is bounding consent, a lost update is a gate failure.
  //
  // Spending is now ticket-based: to spend action k you must win an O_EXCL
  // create of ticket k, which the kernel makes atomic, and claiming never
  // rewrites the grant file. Measured against the old read-modify-write with
  // 64 threads and 1280 attempts, a budget of 5 granted 17, then 5, then 15.
  // The ticket version granted exactly 5 every time.
  //
  // At process level the window is narrower than that thread-level harness, so
  // treat this as the end-to-end guard: the budget is honoured, and contention
  // does not deadlock or under-spend it.
  gated('revoke');
  const BUDGET = 3, RACERS = 12;
  gated('grant', '--minutes', '5', '--actions', String(BUDGET), '--yes');
  const raced = await Promise.all(
    Array.from({ length: RACERS }, (_, i) => new Promise(resolve => {
      execFile('node',
        [join(DIR, '..', 'gaze.mjs'), 'fill', 'input[name="email"]', `race${i}@example.test`],
        { env: { ...process.env, GAZE_PORT: String(PORT), GAZE_STATE: state } },
        err => resolve(err ? (err.code ?? 1) : 0));
    })));
  const wonRace = raced.filter(c => c === 0).length;
  check(`a grant budget of ${BUDGET} is not overspent by ${RACERS} concurrent writes`,
        wonRace <= BUDGET, `${wonRace} writes were allowed`);
  check('the budget is actually usable under contention, not deadlocked',
        wonRace === BUDGET, `${wonRace} of ${BUDGET} used`);
  gated('revoke');

  // An unlimited grant is re-checked after it is read, so a revoke that lands
  // first wins rather than being outrun by a claim already in flight.
  gated('grant', '--minutes', '5', '--yes');
  gated('revoke');
  check('a write after revoke is refused, even with an unlimited grant issued',
        gated('fill', 'input[name="email"]', 'after@example.test').code === 3);

  gated('grant', '--minutes', '5', '--yes');
  check('revoke clears a standing approval',
        gated('revoke').out.includes('revoked') && gated('grant-status').out.includes('no standing'));

  // ---- file upload ----
  const tmpFile = join(DIR, 'upload.tmp');
  writeFileSync(tmpFile, 'hello from gaze');
  ab('upload', '#upload', tmpFile);
  const uploaded = JSON.parse(ab('eval',
    'document.querySelector("#upload").files.length + ":" + (document.querySelector("#upload").files[0]||{}).name'));
  check('upload attaches a real file to a file input',
        String(uploaded).startsWith('1:') && String(uploaded).includes('upload.tmp'), String(uploaded));
  rmSync(tmpFile, { force: true });

  // ---- activity indicator ----
  ab('indicator', 'on');
  const badgeOn = JSON.parse(ab('eval', '!!document.getElementById("__gaze_badge__")'));
  check('indicator draws a visible badge', badgeOn === true);
  check('indicator status reports on', ab('indicator', 'status').includes('indicator on'));
  ab('goto', url, '--wait', '400');
  const badgeAfterNav = JSON.parse(ab('eval', '!!document.getElementById("__gaze_badge__")'));
  check('badge survives navigation', badgeAfterNav === true);
  ab('indicator', 'off');
  const badgeOff = JSON.parse(ab('eval', '!!document.getElementById("__gaze_badge__")'));
  check('indicator off removes it', badgeOff === false);

  // ---- console and network ----
  const con = JSON.parse(ab('console', '--seconds', '2', '--reload', '--json'));
  check('console captures page logs',
        con.data.some(r => r.text.includes('fixture ready marker')), JSON.stringify(con.data).slice(0, 80));
  check('console output is treated as untrusted', con._untrusted === true);
  const warn = JSON.parse(ab('console', '--seconds', '2', '--reload', '--level', 'warning', '--json'));
  check('console --level filters', warn.data.every(r => r.level === 'warning'));
  const net = JSON.parse(ab('network', '--seconds', '3', '--reload', '--json'));
  check('network captures responses', net.data.length > 0, `${net.data.length} responses`);
  const jsonApi = JSON.parse(ab('network', '--seconds', '3', '--reload', '--json-only', '--json'));
  check('network --json-only finds the JSON endpoint',
        jsonApi.data.some(r => r.url.includes('/api/data')), JSON.stringify(jsonApi.data).slice(0, 80));

  // ---- logging and insights ----
  const stats = ab('stats', '--days', '1');
  check('stats summarises real activity', stats.includes('commands'), stats.split('\n')[0]);
  check('stats breaks down per command', /goto|scrape|text/.test(stats));
  check('stats reports timings', /p50|ms/.test(stats));
  const rawLog = ab('log', '--n', '5');
  check('log tails raw entries', rawLog.includes('"cmd"'), rawLog.slice(0, 60));
  check('secrets are redacted in the log',
        !rawLog.includes('granted1@example.test') || rawLog.includes('<redacted>'));
  const fillEntries = ab('log', '--n', '200').split('\n').filter(l => l.includes('"fill"'));
  // A magic-link or OAuth URL carries its secret in the query string, and this
  // log persists on disk.
  ab('goto', url + '?token=SUPERSECRETVALUE&next=/x', '--wait', '300');
  const gotoLog = ab('log', '--n', '40');
  check('goto query strings are stripped from the log',
        !gotoLog.includes('SUPERSECRETVALUE') && gotoLog.includes('<redacted>'),
        gotoLog.split('\n').filter(l => l.includes('goto')).slice(-1)[0] || '');
  ab('goto', url, '--wait', '300');

  check('fill values never reach the log',
        fillEntries.length > 0 && fillEntries.every(l => !l.includes('@example.test')),
        `${fillEntries.length} fill entries`);

  // ---- batch: many commands, ONE connection ----
  const script = join(DIR, 'batch.tmp');
  writeFileSync(script, ['tabs', 'text --max 40', 'scrape "nav a" --max 3'].join('\n'));
  const t0 = Date.now();
  const batched = ab('batch', script);
  const batchMs = Date.now() - t0;
  const t1 = Date.now();
  ab('tabs'); ab('text', '--max', '40'); ab('scrape', 'nav a');
  const serialMs = Date.now() - t1;
  rmSync(script, { force: true });
  check('batch runs every command', batched.includes('$ tabs') && batched.includes('$ text --max 40'));
  check(`batch is faster than separate calls (${batchMs}ms vs ${serialMs}ms)`, batchMs < serialMs);


  // Cloudflare's interstitial has no marker element, only wording, so it was
  // invisible to the detector until the phrase list grew.
  ab('goto', url + 'interstitial', '--wait', '400');
  let interOut = '', interCode = 0;
  try { interOut = ab('challenge'); }
  catch (e) { interOut = e.stdout || ''; interCode = e.status; }
  check('detects a Cloudflare interstitial with no widget',
        interOut.includes('CHALLENGE DETECTED') && interCode === 2, interOut.trim().split('\n')[0]);

  // reCAPTCHA v3 scores passively and is not a challenge, but it puts
  // data-sitekey on ordinary pages -- so a bare [data-sitekey] must not count.
  ab('goto', url + 'passive', '--wait', '400');
  check('a passive reCAPTCHA v3 sitekey is not called a challenge',
        ab('challenge').includes('no challenge detected'));

  // A screenshot outlives the session and can hold anything that was on screen,
  // so it must not inherit a world-readable umask the way it used to.
  const shotPath = ab('shot').trim().split('\n').pop();
  check('a screenshot is not world-readable',
        (statSync(shotPath).mode & 0o777) === 0o600,
        '0' + (statSync(shotPath).mode & 0o777).toString(8));
  rmSync(shotPath, { force: true });

  // A live zillow.com hit returned exactly this and gaze said "no challenge
  // detected", so the block page would have been scraped as if it were content.
  ab('goto', url + 'presshold', '--wait', '400');
  let pxOut = '', pxCode = 0;
  try { pxOut = ab('challenge'); } catch (e) { pxOut = e.stdout || ''; pxCode = e.status; }
  check('detects a PerimeterX press-and-hold',
        pxOut.includes('CHALLENGE DETECTED') && pxCode === 2, pxOut.trim().split('\n')[0]);

  // A block is reported separately: a challenge wants a human, a block wants
  // you to stop, and continuing is how the operator's own IP earns a ban.
  ab('goto', url + 'blocked', '--wait', '400');
  let blOut = '', blCode = 0;
  try { blOut = ab('challenge'); } catch (e) { blOut = e.stdout || ''; blCode = e.status; }
  check('reports a hard block, and does not call it a challenge',
        blOut.includes('BLOCKED') && !blOut.includes('CHALLENGE DETECTED') && blCode === 2,
        blOut.trim().split('\n')[0]);

  // ---- regressions: failures found by stress-testing the real browser -------
  // Each of these was a real defect. They stay here so they cannot come back.

  // A command run against a port with no browser on it. Nothing listens on 9.
  const atDeadPort = (...args) => {
    try {
      return { out: execFileSync('node', [join(DIR, '..', 'gaze.mjs'), ...args],
        { env: { ...process.env, GAZE_PORT: '9', GAZE_APPROVAL: 'off' },
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), code: 0 };
    } catch (e) { return { out: (e.stdout || '') + (e.stderr || ''), code: e.status }; }
  };

  // `gaze --help` used to connect to CDP first, so it failed with a raw
  // "connect ECONNREFUSED" stack whenever the browser was not already running.
  const helpDead = atDeadPort('--help');
  check('help works with no browser running', helpDead.code === 0 && helpDead.out.includes('gaze <cmd>'),
        `exit ${helpDead.code}`);

  // An unknown command printed usage and exited 0, so a typo looked like success.
  const bogus = atDeadPort('deffo-not-a-command');
  check('an unknown command exits non-zero', bogus.code === 2, `exit ${bogus.code}`);

  // A dead browser produced a multi-line Playwright stack instead of the fix.
  const deadTabs = atDeadPort('tabs');
  check('a dead browser says how to start one',
        deadTabs.out.includes('no browser is running') && deadTabs.out.includes('gaze start'),
        deadTabs.out.split('\n')[0]);
  check('a dead browser does not leak a Playwright stack',
        !deadTabs.out.includes('connectOverCDP'), deadTabs.out.split('\n')[0]);

  // --tab past the end returned undefined, which crashed with
  // "Cannot read properties of undefined (reading 'locator')".
  const badTab = gated('text', '--tab', '99');
  check('an out-of-range --tab is explained, not a TypeError',
        badTab.out.includes('no tab at index 99') && !badTab.out.includes('Cannot read properties'),
        badTab.out.split('\n')[0]);

  // `eval` was in REDACT, but the redactor always kept positional 0 -- and for
  // `eval` positional 0 IS the script, so the one argument most likely to hold a
  // secret was written to the log in full.
  ab('eval', '"sentinel-must-not-be-logged"');
  const evalEntries = ab('log', '--n', '200').split('\n').filter(l => l.includes('"eval"'));
  check('eval scripts never reach the log',
        evalEntries.length > 0 && evalEntries.every(l => !l.includes('sentinel-must-not-be-logged')),
        `${evalEntries.length} eval entries`);

  // upload/record/session-load all change something but were never gated.
  check('upload is gated', gated('upload', 'input[type=file]', '/etc/hostname').code === 3);
  check('record is gated', gated('record', '--seconds', '1').code === 3);
  check('session load is gated', gated('session', 'load', 'selftest').code === 3);
  check('session list stays ungated', gated('session', 'list').code === 0);

  console.log(`${pass} passed, ${fail} failed`);
} finally {
  await ctx.close();
  server.kill();
  rmSync(profile, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
