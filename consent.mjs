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
export function claimGrant() {
  const g = readGrant();
  if (!g) return null;
  if (g.actions === null) return g;            // unlimited: nothing to spend

  mkdirSync(TICKETS, { recursive: true });
  for (let k = 0; k < g.actions; k++) {
    let fd;
    try { fd = openSync(`${TICKETS}/${g.id}.${k}`, 'wx', 0o600); }
    catch { continue; }                        // someone else holds ticket k
    closeSync(fd);
    return { ...g, left: Math.max(0, g.actions - ticketsUsed(g.id, g.actions)) };
  }
  // Every ticket is taken. Retire the grant so grant-status stops advertising
  // an approval that can no longer be used.
  try { rmSync(GRANT_FILE, { force: true }); } catch {}
  clearTickets();
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
    process.stderr.write(`  [standing approval: ${grantLeft(granted)}]\n`);
    return true;
  }
  const lines = actions.map(a => `    ${a}`).join('\n');
  process.stderr.write(
    `\ngaze wants to perform ${actions.length} action(s) that change something:\n` +
    `${lines}\n  on: ${where}\n`);

  if (APPROVAL === 'fingerprint') {
    process.stderr.write('  touch the fingerprint reader to approve...\n');
    const r = spawnSync('fprintd-verify', [], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    const ok = r.status === 0 && /verify-match/.test((r.stdout || '') + (r.stderr || ''));
    process.stderr.write(ok ? '  approved (fingerprint)\n' : '  DENIED (no fingerprint match)\n');
    return ok;
  }
  const answer = askTty('  approve? [y/N] ');
  if (answer === null) {
    process.stderr.write(
      '  DENIED: no terminal to ask on.\n' +
      '  Pass --yes, or set GAZE_APPROVAL=off, to run unattended.\n');
    return false;
  }
  const ok = answer === 'y' || answer === 'yes';
  process.stderr.write(ok ? '  approved\n' : '  denied\n');
  return ok;
}
