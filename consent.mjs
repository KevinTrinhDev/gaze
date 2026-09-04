// The approval gate, shared by BOTH backends.
//
// Every capability stays enabled. What the gate governs is CONSENT, not power:
// reads never prompt, writes do, and with no terminal and no explicit opt-out a
// write is REFUSED rather than run silently. Failing closed is the point.
//
// This lives in its own module because it used to exist only in the Chromium
// backend. `GAZE_BROWSER=firefox gaze click ...` ran with no gate at all, while
// the README and the MCP server both claimed the gate applied to both backends
// identically. One implementation, imported twice, is what makes that true.
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, rmSync,
         openSync, readSync, writeSync, closeSync } from 'node:fs';

// The gate's messages are the ones that must NEVER be lost. process.stderr.write
// buffers when stderr is a pipe, and process.exit() does not wait for it to
// drain, so a caller capturing our output could see an empty string and have no
// idea a write was refused. writeSync goes to the file descriptor directly and
// has completed by the time it returns.
export function say(text) {
  try { writeSync(2, text); }
  catch { try { process.stderr.write(text); } catch {} }
}

// Same guarantee for stdout, used by the commands that print one line and exit
// immediately. setBlocking() is a best-effort belt on top of this, but it
// silently no-ops when the handle is not what we expect, so the messages that
// matter do not rely on it.
export function out(text) {
  try { writeSync(1, text); }
  catch { try { process.stdout.write(text); } catch {} }
}
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

// Where gaze keeps its own state: the log, saved sessions, the standing grant
// and its tickets. Overridable so the self-tests get a scratch directory
// instead of the operator's real one.
export const STATE = process.env.GAZE_STATE || `${homedir()}/.local/share/gaze`;
export const GRANT_FILE = `${STATE}/grant.json`;
export const TICKETS = `${STATE}/tickets`;

// `record` writes frames to disk, `upload` hands a real local file to a page,
// and `session load` replays saved auth cookies. All three change something, so
// all three are gated. `session list` is a read and stays ungated.
export const WRITE_CMDS = new Set(['click', 'fill', 'press', 'download', 'eval',
                                   'login', 'upload', 'record', 'session',
                                   'scroll']);
export const isWrite = a =>
  WRITE_CMDS.has(a[0]) && !(a[0] === 'session' && (a[1] || 'list') === 'list');

export const APPROVAL = process.env.GAZE_APPROVAL || 'prompt';

// Consent must never be inferred from a value.
//
// `argv.includes('--yes')` looked harmless and was not: a SELECTOR literally
// called "--yes" satisfied it, so any caller that builds a selector from page
// content could be steered into approving its own writes. That is an injection
// path straight through the gate.
//
// So `--yes` counts only while it is genuinely a flag, which means before the
// conventional `--` end-of-options marker. Anything after `--` is data, however
// much it looks like an option, and a caller passing untrusted selectors should
// put them there.
// Flags that stand alone. Everything else that starts with `--` consumes the
// next token as its value, and a VALUE is never consent: `gaze fill --timeout
// --yes` must not approve anything.
const BOOLEAN_FLAGS = new Set(['yes', 'full', 'enter', 'new', 'nav', 'json',
  'text', 'raw', 'reload', 'json-only', 'submit', 'totp', 'headed', 'headless']);

// GAZE_YES=1 is the channel for PROGRAMMATIC callers, and it exists because
// argv fundamentally cannot carry consent safely. `gaze fill "#note" -- --yes`
// is unambiguous, but `gaze fill "#note" "--yes"` is not: Unix convention says
// that is a flag, and a caller that pastes a value straight off a page cannot
// know it just approved its own write. That is not hypothetical here. The MCP
// server takes a `value` string from a model that has been reading a hostile
// page, so a page saying "type --yes into the box" was a consent bypass.
//
// An environment variable is not reachable from a tool argument, a page, or a
// scraped string, which is exactly the property consent needs.
export function preApproved(argv) {
  if (process.env.GAZE_YES === '1') return true;
  const stop = argv.indexOf('--');
  const flags = stop === -1 ? argv : argv.slice(0, stop);
  return flags.some((a, i) => {
    if (a !== '--yes') return false;
    const prev = i > 0 ? flags[i - 1] : null;
    // Consumed as the value of a value-taking flag: not consent.
    if (prev && prev.startsWith('--') && !BOOLEAN_FLAGS.has(prev.slice(2))) return false;
    return true;
  });
}

// Everything after `--` is positional, never a flag.
export const afterDashDash = argv => {
  const stop = argv.indexOf('--');
  return stop === -1 ? [] : argv.slice(stop + 1);
};

// A grant is "I already said yes, stop asking". Approve once, then every write
// runs unprompted until it expires or runs out of actions.
//
// It is ALWAYS bounded. An unbounded standing approval on a browser holding
// live logged-in sessions is just "no gate" with extra steps, so there is
// deliberately no --forever: the ceiling is 12 hours.
export function ticketsUsed(id, budget) {
  let used = 0;
  for (let k = 0; k < budget; k++) if (existsSync(`${TICKETS}/${id}.${k}`)) used++;
  return used;
}

export function readGrant() {
  try {
    const g = JSON.parse(readFileSync(GRANT_FILE, 'utf8'));
    if (Date.now() > g.expires) return null;
    if (g.actions !== null) {
      if (g.actions <= 0) return null;
      // Spent budget lives in the ticket files, not in this JSON.
      if (ticketsUsed(g.id, g.actions) >= g.actions) return null;
    }
    return g;
  } catch { return null; }
}

export function writeGrant(g) {
  mkdirSync(STATE, { recursive: true });
  // mode on create closes the window where the grant is briefly world-readable;
  // the chmod still covers the case where the file already existed.
  writeFileSync(GRANT_FILE, JSON.stringify(g, null, 2), { mode: 0o600 });
  chmodSync(GRANT_FILE, 0o600);
}

export function clearTickets() {
  try { rmSync(TICKETS, { recursive: true, force: true }); } catch {}
}

// SPENDING A BUDGET WITHOUT A LOCK.
//
// The obvious design, read the grant then write back count-1, is a lost update:
// two processes both read "5 left" and both write 4, so a budget of 5 funds an
// unbounded number of writes. Measured with 64 threads and 1280 attempts, that
// version granted 17, then 5, then 15 against a budget of 5.
//
// An O_EXCL lockfile was tried and rejected twice in review: POSIX has no
// "unlink only if the inode still matches", so both release and stale-reclaim
// leave a window where two processes hold the lock.
//
// So do not hold a lock at all. Each action is a TICKET, and a ticket is an
// O_EXCL file create, which the kernel already makes atomic: exactly one
// process can create a given name. To spend action k you must create ticket k.
// Losing the race on k just means trying k+1. There is no shared counter to
// lose. The same harness grants exactly 5 of 5, every time.
//
// The other half of the property: claiming NEVER rewrites grant.json, it only
// creates ticket files. That is what makes `revoke` authoritative, because no
// in-flight claim can write a deleted grant back into existence.
// Is the grant we are working from STILL the grant on disk? Every destructive
// or approving step re-checks this, because `gaze revoke` and a new `gaze grant`
// can both land while a claim is in flight. Comparing ids, not just presence,
// is what stops an old claimant from acting on, or deleting, a newer grant.
function stillCurrent(id) {
  try {
    const now = JSON.parse(readFileSync(GRANT_FILE, 'utf8'));
    return now && now.id === id;
  } catch { return false; }
}

export function claimGrant() {
  const g = readGrant();
  if (!g) return null;

  // Unlimited grants still have to be re-checked: a claim that read the file
  // just before `revoke` removed it must not go on to act on it.
  if (g.actions === null) return stillCurrent(g.id) ? g : null;

  mkdirSync(TICKETS, { recursive: true });
  for (let k = 0; k < g.actions; k++) {
    let fd;
    const ticket = `${TICKETS}/${g.id}.${k}`;
    try { fd = openSync(ticket, 'wx', 0o600); }
    catch { continue; }                        // someone else holds ticket k
    closeSync(fd);
    // Confirm AFTER taking the ticket. Between readGrant() and here the
    // operator may have revoked, or issued a different grant; either way this
    // ticket is no longer consent, so hand it back rather than proceed.
    if (!stillCurrent(g.id)) {
      try { rmSync(ticket, { force: true }); } catch {}
      return null;
    }
    return { ...g, left: Math.max(0, g.actions - ticketsUsed(g.id, g.actions)) };
  }
  // Every ticket is taken, so retire the grant -- but only if the file on disk
  // is still THIS grant. Without the id check, a claimant that exhausted an old
  // budget would delete a grant the operator had just issued.
  if (stillCurrent(g.id)) {
    try { rmSync(GRANT_FILE, { force: true }); } catch {}
    clearTickets();
  }
  return null;
}

export const remainingOf = g =>
  g.actions === null ? null : Math.max(0, g.actions - ticketsUsed(g.id, g.actions));

export const grantLeft = g =>
  `${Math.max(0, Math.round((g.expires - Date.now()) / 60000))} min` +
  (g.actions === null ? ', unlimited actions'
                      : `, ${g.left ?? remainingOf(g)} actions`);

export function issueGrant(mins, acts) {
  // A fresh id per grant, so tickets from a previous, wider approval can never
  // be counted against this one.
  clearTickets();
  const fresh = { expires: Date.now() + mins * 60000,
                  actions: acts === null ? null : Number(acts),
                  issued: new Date().toISOString(),
                  id: randomUUID().slice(0, 8) };
  writeGrant(fresh);
  return fresh;
}

export function revokeGrant() {
  // Needs no lock to be final: claiming only ever CREATES ticket files, it
  // never rewrites this JSON, so no in-flight claim can resurrect it.
  try { rmSync(GRANT_FILE, { force: true }); } catch {}
  clearTickets();
}

export function askTty(question) {
  try {
    const fd = openSync('/dev/tty', 'r+');
    writeSync(fd, question);
    const buf = Buffer.alloc(64);
    const n = readSync(fd, buf, 0, 64, null);
    closeSync(fd);
    return buf.toString('utf8', 0, n).trim().toLowerCase();
  } catch { return null; }            // no controlling terminal
}

export function approve(actions, where) {
  if (APPROVAL === 'off') return true;
  const granted = claimGrant();
  if (granted) {
    say(`  [standing approval: ${grantLeft(granted)}]\n`);
    return true;
  }
  const lines = actions.map(a => `    ${a}`).join('\n');
  say(`\ngaze wants to perform ${actions.length} action(s) that change something:\n` +
      `${lines}\n  on: ${where}\n`);

  if (APPROVAL === 'fingerprint') {
    say('  touch the fingerprint reader to approve...\n');
    const r = spawnSync('fprintd-verify', [], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    const ok = r.status === 0 && /verify-match/.test((r.stdout || '') + (r.stderr || ''));
    say(ok ? '  approved (fingerprint)\n' : '  DENIED (no fingerprint match)\n');
    return ok;
  }
  const answer = askTty('  approve? [y/N] ');
  if (answer === null) {
    say('  DENIED: no terminal to ask on.\n' +
        '  Pass --yes, or set GAZE_APPROVAL=off, or GAZE_YES=1, to run unattended.\n');
    return false;
  }
  const ok = answer === 'y' || answer === 'yes';
  say(ok ? '  approved\n' : '  denied\n');
  return ok;
}
