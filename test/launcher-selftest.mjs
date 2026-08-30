// Self-test for bin/gaze, the bash launcher.
//
// The launcher is where the two worst bugs lived, and neither backend self-test
// could ever have caught them: `gaze doctor` built shell test expressions as
// strings and ran them through `eval`, and `gaze sync` called `rm -rf` on an
// operator-supplied path with no check on where it pointed.
//
// Nothing here starts a browser or touches a real profile.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = new URL('.', import.meta.url).pathname;
const GAZE = join(DIR, '..', 'bin', 'gaze');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { console.log(`  ok    ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ' -- ' + detail : ''}`); fail++; }
};

// Run the launcher, capturing output and exit code rather than throwing.
const run = (env, ...args) => {
  try {
    return { out: execFileSync('bash', [GAZE, ...args],
      { env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), code: 0 };
  } catch (e) { return { out: (e.stdout || '') + (e.stderr || ''), code: e.status }; }
};

const scratch = mkdtempSync(join(tmpdir(), 'gaze-launcher-'));
console.log('gaze launcher selftest');

try {
  // ---- doctor must not execute anything embedded in a profile path ---------
  // GAZE_PROFILE landed inside a single-quoted string that was passed to `eval`,
  // so a quote in the path was enough to run arbitrary commands.
  const marker = join(scratch, 'executed');
  run({ GAZE_PROFILE: `x'; touch ${marker}; echo '` }, 'doctor');
  check('a quote in GAZE_PROFILE cannot execute a command',
        !existsSync(marker), `${marker} was created`);

  // The same path reaches doctor from a Firefox profiles.ini Path= value, so the
  // check has to hold for any hostile-looking path, not just this one shape.
  const marker2 = join(scratch, 'executed2');
  run({ GAZE_PROFILE: `$(touch ${marker2})` }, 'doctor');
  check('command substitution in GAZE_PROFILE does not run',
        !existsSync(marker2), `${marker2} was created`);

  // doctor still has to work normally.
  const doc = run({}, 'doctor');
  check('doctor still reports its checks', doc.out.includes('gaze doctor') && /\d+ ok/.test(doc.out),
        doc.out.split('\n')[0]);

  // ---- sync must refuse to delete anything that is not a gaze clone --------
  // `rm -rf "$AUTH"` ran on whatever GAZE_PROFILE pointed at. A typo such as
  // GAZE_PROFILE=$HOME would have wiped the home directory.
  const precious = join(scratch, 'precious');
  mkdirSync(precious, { recursive: true });
  writeFileSync(join(precious, 'keep.txt'), 'do not delete me');
  const refused = run({ GAZE_PROFILE: precious }, 'sync');
  check('sync refuses a path that is not a gaze clone',
        refused.code !== 0 && refused.out.includes('refusing to wipe'), `exit ${refused.code}`);
  check('sync left the directory untouched', existsSync(join(precious, 'keep.txt')));

  // ---- an explicitly named browser that is not installed fails fast --------
  const missing = run({ GAZE_BROWSER: 'opera' }, 'status');
  check('an uninstalled GAZE_BROWSER is reported, not launched',
        missing.code === 2 && /not installed/.test(missing.out), `exit ${missing.code}`);

  // ---- an unknown browser name is still rejected ---------------------------
  const unknown = run({ GAZE_BROWSER: 'netscape' }, 'status');
  check('an unknown GAZE_BROWSER is rejected',
        unknown.code === 2 && /unknown browser/.test(unknown.out), `exit ${unknown.code}`);

  // ---- version and browsers never need a running browser ------------------
  const ver = run({}, 'version');
  check('version works with no browser', ver.code === 0 && ver.out.startsWith('gaze '), ver.out.trim());
  const brow = run({}, 'browsers');
  check('browsers lists the table', brow.code === 0 && brow.out.includes('DRIVER'));

  console.log(`${pass} passed, ${fail} failed`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
