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
        refused.code !== 0 && /refusing to (wipe|touch)/.test(refused.out), `exit ${refused.code}`);
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

  // ---- a stale profile lock must not look like a browser that died ---------
  // When a browser exits uncleanly it leaves SingletonLock behind. The next
  // launch opens the debug port, fails the ProcessSingleton check a moment
  // later, and aborts -- so `start` reports "up" and the browser vanishes
  // seconds afterwards. Clearing the lock happens before the cookie check, so
  // this exercises it without ever launching a browser.
  // Must live under the real clone root: the path guard (correctly) refuses a
  // scratch directory in /tmp, even one named gaze-auth. This is a throwaway
  // name no browser in the table uses, and it is removed again below.
  const staleProfile = join(process.env.HOME, '.local/share/gaze/profiles',
                            'selftest-stale-lock');
  mkdirSync(staleProfile, { recursive: true });
  writeFileSync(join(staleProfile, 'SingletonLock'), '');
  // A port nothing is on, so this never short-circuits on "already running"
  // against a browser the operator happens to have up on the default port.
  const stale = run({ GAZE_PROFILE: staleProfile, GAZE_PORT: '9247' }, 'start');
  check('start clears a stale profile lock',
        stale.out.includes('cleared a stale profile lock'), stale.out.trim().split('\n')[0]);
  check('the stale lock is actually gone',
        !existsSync(join(staleProfile, 'SingletonLock')));
  // It still refuses to run: the profile has no cookies, so it is not a clone.
  check('a profile with no cookies is still refused',
        stale.code !== 0 && /gaze sync/.test(stale.out), `exit ${stale.code}`);
  rmSync(staleProfile, { recursive: true, force: true });

  // ---- the path guard, exercised directly -----------------------------------
  // `sync` and `start` both delete things under GAZE_PROFILE, so the guard that
  // decides what counts as a clone is the single most dangerous function here.
  // It is extracted and called directly: driving it through `gaze sync` would
  // mean actually deleting a real profile to test the accept cases.
  const guard = (path) => {
    try {
      execFileSync('bash', ['-c',
        `set -uo pipefail
         CLONES="$HOME/.local/share/gaze/profiles"
         eval "$(sed -n '/^assert_clone(){/,/^}/p' ${JSON.stringify(GAZE)})"
         assert_clone ${JSON.stringify(path)}`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return true;                       // accepted
    } catch { return false; }            // refused
  };
  const HOME = process.env.HOME;
  const CLONES = `${HOME}/.local/share/gaze/profiles`;

  // The traversal that defeats a lexical check: it matches a glob on $CLONES
  // while resolving to $HOME, which is exactly the case the guard exists for.
  check('a traversal out of the clone root is refused',
        !guard(`${CLONES}/../../../..`));
  check('$HOME itself is refused', !guard(HOME));
  check('/ is refused', !guard('/'));
  check('an unrelated directory is refused', !guard('/tmp'));
  // A bare */gaze-auth match would accept these. They have nothing to do with
  // gaze, and both would have been handed to `rm -rf`.
  check('/tmp/gaze-auth is refused', !guard('/tmp/gaze-auth'));
  check('/etc/gaze-auth is refused', !guard('/etc/gaze-auth'));
  check('a traversal ending in gaze-auth is refused',
        !guard(`${CLONES}/../../../../../../tmp/gaze-auth`));

  // ...and every legitimate clone path in the BROWSERS table still works,
  // including ones that do not exist yet, which is the first-sync case.
  check('a clone under the clone root is accepted', guard(`${CLONES}/brave`));
  check('a snap clone is accepted',
        guard(`${HOME}/snap/brave/current/.config/BraveSoftware/gaze-auth`));
  check('a clone that does not exist yet is accepted',
        guard(`${HOME}/snap/chromium/common/gaze-auth`));
  check('a browser never synced before is accepted', guard(`${CLONES}/vivaldi`));

  console.log(`${pass} passed, ${fail} failed`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
