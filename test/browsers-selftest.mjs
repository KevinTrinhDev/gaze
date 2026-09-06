// Self-test for the browser discovery probe (browsers.mjs).
// Builds FAKE browser executables on a temp PATH that print --version lines,
// then checks the probe finds them, classifies the family and parses versions.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = new URL('.', import.meta.url).pathname;
const bin = mkdtempSync(join(tmpdir(), 'gaze-browsers-bin-'));
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { console.log(`  ok    ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ' -- ' + detail : ''}`); fail++; }
};

try {
  const stubs = {
    'google-chrome': '#!/bin/sh\necho "Google Chrome 138.0.0.0"\n',
    'chromium': '#!/bin/sh\necho "Chromium 130.1.2.3"\n',
    'firefox': '#!/bin/sh\necho "Mozilla Firefox 141.0"\n',
    'vivaldi': '#!/bin/sh\necho "Vivaldi 7.0.0.0"\n',
  };
  for (const [n, body] of Object.entries(stubs)) {
    const p = join(bin, n);
    writeFileSync(p, body);
    chmodSync(p, 0o755);
  }

  console.log('browser discovery selftest');
  const env = { ...process.env, PATH: bin + ':' + (process.env.PATH || '') };
  const json = execFileSync('node', [join(DIR, '..', 'browsers.mjs'), '--json'],
    { env, encoding: 'utf8' });
  const found = JSON.parse(json);
  const stubNames = ['google-chrome', 'chromium', 'firefox', 'vivaldi'];
  check('discovery finds the fake browsers',
        stubNames.every(n => found.some(b => b.name === n)), `${found.length} found`);
  const byName = Object.fromEntries(found.map(b => [b.name, b]));
  check('classifies Chromium-family browsers',
        byName['google-chrome']?.family === 'chromium' && byName['chromium']?.family === 'chromium' &&
        byName['vivaldi']?.family === 'chromium',
        JSON.stringify(found));
  check('classifies Firefox family', byName['firefox']?.family === 'firefox');
  check('parses versions', byName['google-chrome']?.version === '138.0.0.0' &&
        byName['firefox']?.version === '141.0',
        JSON.stringify(found.map(b => [b.name, b.version])));
  check('reports real executable paths',
        stubNames.every(n => byName[n] && byName[n].path.includes('gaze-browsers-bin')));

  const human = execFileSync('node', [join(DIR, '..', 'browsers.mjs')], { env, encoding: 'utf8' });
  check('human table prints rows', /google-chrome/.test(human) && /firefox/.test(human));
} catch (e) {
  console.log(`  FAIL  ${e.message}`);
  fail++;
} finally {
  rmSync(bin, { recursive: true, force: true });
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
