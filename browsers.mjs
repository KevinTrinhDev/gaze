#!/usr/bin/env node
// Browser discovery probe — ROADMAP part 5, first slice.
//
// Walks PATH (plus well-known snap/flatpak locations) for installed browser
// binaries, asks each for `--version`, classifies the family (chromium vs
// firefox), and prints a table (or --json). This is the seed for the
// capability resolver that will pick CDP / BiDi / WebDriver per browser; the
// bash launcher's hand-maintained table stays authoritative for now, and this
// module is what will replace it as the source of truth once the Node launcher
// lands.
//
// Probe is safe: `--version` never opens a window or touches a profile.

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const FAMILIES = {
  'google-chrome': ['google-chrome', 'google-chrome-stable', '/snap/bin/google-chrome'],
  chromium: ['chromium', 'chromium-browser', '/snap/bin/chromium'],
  edge: ['microsoft-edge', 'microsoft-edge-stable', '/snap/bin/microsoft-edge'],
  brave: ['brave-browser', '/snap/bin/brave'],
  vivaldi: ['vivaldi'],
  opera: ['opera'],
  firefox: ['firefox', 'firefox-esr', '/snap/bin/firefox'],
};

function inPath(name) {
  const dirs = (process.env.PATH || '').split(':');
  for (const d of dirs) {
    const p = `${d}/${name}`;
    if (existsSync(p)) return p;
  }
  return null;
}

function versionOf(path) {
  try {
    const r = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: 4000 });
    const line = ((r.stdout || '') + (r.stderr || '')).split('\n')[0] || '';
    const m = /(\d+(?:\.\d+)+)/.exec(line);
    return { brand: line.trim().slice(0, 60) || null, version: m ? m[1] : null };
  } catch { return { brand: null, version: null }; }
}

export function discover() {
  const out = [];
  for (const [name, paths] of Object.entries(FAMILIES)) {
    let found = null;
    for (const cand of paths) {
      const p = cand.includes('/') ? (existsSync(cand) ? cand : null) : inPath(cand);
      if (p) { found = p; break; }
    }
    if (!found) continue;
    const { brand, version } = versionOf(found);
    const family = /firefox|basilisk|waterfox|devedition/i.test(brand || '') || name === 'firefox'
      ? 'firefox' : 'chromium';
    out.push({ name, path: found, family,
               version: version || null,
               brand: brand || null });
  }
  // A flatpak Firefox would not be on PATH; detect via flatpak when present.
  const flatpak = spawnSync('flatpak', ['list', '--app', '--columns=application'],
    { encoding: 'utf8', timeout: 4000 });
  if (!flatpak.error && /org\.mozilla\.firefox/.test(flatpak.stdout || '')) {
    if (!out.some(b => b.family === 'firefox'))
      out.push({ name: 'firefox-flatpak', path: 'flatpak run org.mozilla.firefox',
                 family: 'firefox', version: null, brand: 'Mozilla Firefox (flatpak)' });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const found = discover();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(found, null, 2));
  } else {
    if (!found.length) { console.log('no supported browser found on PATH'); process.exit(2); }
    console.log('name'.padEnd(16) + 'family'.padEnd(10) + 'version'.padEnd(12) + 'path');
    for (const b of found)
      console.log(b.name.padEnd(16) + b.family.padEnd(10) +
                  (b.version || '?').padEnd(12) + b.path);
  }
}
