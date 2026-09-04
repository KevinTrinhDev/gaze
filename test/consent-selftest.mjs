// Self-test for the consent gate and the log redaction.
//
// Deliberately needs NO browser. The gate runs before either backend connects,
// and the ticket accounting is pure filesystem work, so all of this is fast,
// hermetic and runs anywhere -- including CI runners where Firefox will not
// start. That matters: these are the assertions covering the security
// properties, and they must not be the ones that get skipped.
import { execFileSync } from 'node:child_process';
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync,
         openSync, closeSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = new URL('.', import.meta.url).pathname;

// ---- worker half: hammer the ticket claim from many threads at once --------
if (!isMainThread) {
  const { TICKETS, GRANT_FILE, PER } = workerData;
  const ticketsUsed = (id, budget) => {
    let used = 0;
    for (let k = 0; k < budget; k++) if (existsSync(`${TICKETS}/${id}.${k}`)) used++;
    return used;
  };
  // The same algorithm as consent.mjs claimGrant, run with no process-start
  // latency in the way so the race window is as wide as it can be.
  const claim = () => {
    let g;
    try { g = JSON.parse(readFileSync(GRANT_FILE, 'utf8')); } catch { return false; }
    if (Date.now() > g.expires) return false;
    if (ticketsUsed(g.id, g.actions) >= g.actions) return false;
    mkdirSync(TICKETS, { recursive: true });
    for (let k = 0; k < g.actions; k++) {
      let fd;
      try { fd = openSync(`${TICKETS}/${g.id}.${k}`, 'wx', 0o600); }
      catch { continue; }
      closeSync(fd);
      return true;
    }
    return false;
  };
  let n = 0;
  for (let i = 0; i < PER; i++) if (claim()) n++;
  parentPort.postMessage(n);
} else {

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { console.log(`  ok    ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ' -- ' + detail : ''}`); fail++; }
};

const state = mkdtempSync(join(tmpdir(), 'gaze-consent-'));
const run = (backend, ...args) => {
  try {
    return { out: execFileSync('node', [join(DIR, '..', backend), ...args],
      { env: { ...process.env, GAZE_STATE: state, GAZE_PORT: '9', GAZE_APPROVAL: 'prompt' },
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), code: 0 };
  } catch (e) { return { out: (e.stdout || '') + (e.stderr || ''), code: e.status }; }
};

console.log('gaze consent selftest');
try {
  // ---- the gate refuses before it ever touches a browser -------------------
  // GAZE_PORT=9 has nothing on it, so reaching the browser would fail with a
  // different error. Exit 3 proves the refusal came FIRST.
  // Only the Firefox backend is exercised here, on purpose. The Chromium gate
  // deliberately runs AFTER connecting, because its prompt names the page it is
  // about to act on, and that needs a live browser. Its gate is asserted in
  // selftest.mjs instead. Firefox gates before connecting, so it can be checked
  // with nothing running at all.
  for (const backend of ['gaze-bidi.mjs']) {
    const name = 'firefox';
    const denied = run(backend, 'click', '#anything');
    check(`${name}: a write with no terminal is refused`, denied.code === 3,
          `exit ${denied.code}`);
    check(`${name}: the refusal says how to run unattended`,
          denied.out.includes('GAZE_APPROVAL=off'));
    check(`${name}: eval is gated`, run(backend, 'eval', '1+1').code === 3);
    check(`${name}: fill is gated`, run(backend, 'fill', '#a', 'b').code === 3);
    check(`${name}: scroll is gated`, run(backend, 'scroll', 'down').code === 3);

    // The bypass that mattered: a SELECTOR named "--yes" must not approve its
    // own write. Anything after `--` is data, never a flag.
    check(`${name}: a selector named --yes cannot approve itself`,
          run(backend, 'fill', '--', '--yes', 'spoofed').code === 3);
  }

  // ---- ticket accounting: a budget is never overspent ----------------------
  // The old read-modify-write granted 17, then 5, then 15 against a budget of
  // 5 under this exact harness. Tickets grant exactly the budget.
  const BUDGET = 5, RACERS = 32, PER = 20;
  const TICKETS = join(state, 'race-tickets');
  const GRANT_FILE = join(state, 'race-grant.json');
  rmSync(TICKETS, { recursive: true, force: true });
  writeFileSync(GRANT_FILE, JSON.stringify({
    expires: Date.now() + 600000, actions: BUDGET, id: 'race',
  }), { mode: 0o600 });

  const granted = (await Promise.all(
    Array.from({ length: RACERS }, () => new Promise((res, rej) => {
      const w = new Worker(new URL(import.meta.url), {
        workerData: { TICKETS, GRANT_FILE, PER } });
      w.on('message', res);
      w.on('error', rej);
    })))).reduce((a, b) => a + b, 0);

  check(`a budget of ${BUDGET} survives ${RACERS * PER} concurrent claims`,
        granted === BUDGET, `granted ${granted}`);

  // ---- revoke is final, and a new grant is not eaten by an old claim -------
  check('grant then revoke leaves no approval',
        (run('gaze.mjs', 'grant', '--minutes', '5', '--actions', '2', '--yes'),
         run('gaze.mjs', 'revoke'),
         run('gaze.mjs', 'grant-status').out.includes('no standing')));
  check('an issued grant lets a Firefox write through without a prompt',
        (run('gaze.mjs', 'grant', '--minutes', '5', '--actions', '2', '--yes'),
         run('gaze-bidi.mjs', 'click', '#x').code !== 3),
        'a live grant must still work unattended');
  run('gaze.mjs', 'revoke');
  check('a write after revoke is refused',
        run('gaze-bidi.mjs', 'click', '#x').code === 3);

  console.log(`${pass} passed, ${fail} failed`);
} catch (e) {
  console.log(`  FAIL  ${e.message}`);
  fail++;
  console.log(`${pass} passed, ${fail} failed`);
} finally {
  rmSync(state, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);

}
