// Self-test for bin/gaze, the bash launcher.
//
// The launcher is where the two worst bugs lived, and neither backend self-test
// could ever have caught them: `gaze doctor` built shell test expressions as
// strings and ran them through `eval`, and `gaze sync` called `rm -rf` on an
// operator-supplied path with no check on where it pointed.
//
// Nothing here starts a browser or touches a real profile.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
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

  // A second shape that also escaped the old single-quoted string. `$(...)` is
  // NOT a useful payload here -- single quotes neutralise it either way, so a
  // test using one passes even against the vulnerable code and proves nothing.
  const marker2 = join(scratch, 'executed2');
  run({ GAZE_PROFILE: `x' || touch ${marker2} || echo '` }, 'doctor');
  check('a quote plus || in GAZE_PROFILE cannot execute a command',
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

  // ---- gaze icon: its own taskbar identity, so it stops stacking -----------
  // Runs against a throwaway HOME so it never touches the real desktop config.
  const fakeHome = join(scratch, 'home');
  mkdirSync(fakeHome, { recursive: true });
  const iconRun = run({ HOME: fakeHome }, 'icon');
  const desktop = join(fakeHome, '.local/share/applications/gaze.desktop');
  check('icon installs a desktop entry', iconRun.code === 0 && existsSync(desktop),
        `exit ${iconRun.code}`);
  check('icon installs at least one icon size',
        existsSync(join(fakeHome, '.local/share/icons/hicolor/128x128/apps/gaze.png')));
  const entry = existsSync(desktop) ? readFileSync(desktop, 'utf8') : '';
  check('the desktop entry claims the gaze window class',
        entry.includes('StartupWMClass=gaze'), entry.slice(0, 60));

  // The desktop entry only matches the window if the browser is actually
  // launched with that class. If these two drift, the icon silently stops
  // working and the window stacks under the everyday browser again.
  const launcherSrc = readFileSync(GAZE, 'utf8');
  check('the launcher starts the browser with that same class',
        /--class[= ]gaze/.test(launcherSrc) &&
        (launcherSrc.match(/--class[= ]gaze/g) || []).length >= 2,
        'chromium and firefox branches must both set it');

  console.log(`${pass} passed, ${fail} failed`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
