#!/usr/bin/env node
// Turns the probe's samples into small test fixtures: arrays and id-keyed records are cut to two entries,
// then every value is replaced with made-up data of the same type, so only the API's shape is kept.
// Run `npm run probe` first.
//
//   node scripts/make-fixtures.mjs [--in probe-out] [--out tests/fixtures]
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';

import { fake, parseArgs, redact } from './lib.mjs';

const args = parseArgs();
const input = typeof args.in === 'string' ? args.in : 'probe-out';
const output = typeof args.out === 'string' ? args.out : 'tests/fixtures';
const KEEP = Number(args.keep ?? 2);
const SKIP = /^(permissions|playerData|riderPhotos|startingGrid|pulseGrid)$/;
const ID_KEY = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function trim(value) {
  if (Array.isArray(value)) return value.slice(0, KEEP).map(trim);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    const kept = entries.length > KEEP && entries.every(([k]) => ID_KEY.test(k)) ? entries.slice(0, KEEP) : entries;
    return Object.fromEntries(kept.map(([k, v]) => [k, trim(v)]));
  }
  return value;
}

// Older probe runs wrote one sample as the bare response and several as an array; the report says which.
let multi = new Set();
try {
  const report = await readFile(`${input}/report.md`, 'utf8');
  const counts = new Map();
  for (const line of report.split('\n')) {
    const m = /^\| (\S+) \|.*\| ✓ \|/.exec(line);
    if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  multi = new Set([...counts].filter(([, n]) => n > 1).map(([name]) => name));
} catch {
  // no report: assume single samples
}

await mkdir(output, { recursive: true });
let written = 0;
for (const file of (await readdir(`${input}/samples`)).filter((f) => f.endsWith('.json'))) {
  const name = file.replace(/\.json$/, '');
  if (SKIP.test(name)) continue;

  const raw = JSON.parse(await readFile(`${input}/samples/${file}`, 'utf8'));
  const first =
    raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 1 && Array.isArray(raw.samples)
      ? raw.samples[0]
      : multi.has(name.split('_')[0]) && Array.isArray(raw)
        ? raw[0]
        : raw;
  if (first === undefined || first === null || (Array.isArray(first) && !first.length)) continue;

  await writeFile(`${output}/${name}.json`, `${JSON.stringify(fake(redact(trim(first))), null, 2)}\n`);
  written++;
}
console.log(`Wrote ${written} fixtures to ${output}`);
