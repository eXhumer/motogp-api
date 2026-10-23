#!/usr/bin/env node
// Opt-in contract check: calls the real API and compares the *shape* of each answer with the recorded
// fixture (tests/fixtures). Fails when a recorded field is gone or has another type; new fields are only listed.
//
//   npm run build && npm run contract [-- --only classification,standings] [-- --strict]
//
// Public endpoints only, no account needed. Shapes are compared, not values.
import { readFile } from 'node:fs/promises';

import { makeClient, parseArgs, errorSummary, sleep } from './lib.mjs';

const args = parseArgs();
const only = typeof args.only === 'string' ? new Set(args.only.split(',')) : undefined;
const client = await makeClient(args);

/** path -> set of kinds, with `[]` for array items and `{}` for id-keyed records. */
function shape(value, path = '$', out = new Map()) {
  const add = (kind) => out.set(path, (out.get(path) ?? new Set()).add(kind));
  if (value === null) add('null');
  else if (Array.isArray(value)) {
    add('array');
    for (const item of value) shape(item, `${path}[]`, out);
  } else if (typeof value === 'object') {
    add('object');
    // Records keyed by rider or entity id; fixtures keep only two entries, so any count counts.
    const idKeyed = Object.keys(value).length > 0 && Object.keys(value).every((k) => /^([0-9a-f-]{36}|\d+)$/i.test(k));
    for (const [k, v] of Object.entries(value)) shape(v, idKeyed ? `${path}{}` : `${path}.${k}`, out);
  } else add(typeof value);
  return out;
}

/** Whether `path` sits below an array of `shapes` that has no items. */
function underEmptyArray(path, shapes) {
  let rest = path;
  for (;;) {
    const match = /^(.*)(\[\]|\{\}|\.[^.[\]{}]+)$/.exec(rest);
    if (!match) return false;
    rest = match[1];
    if (shapes.get(rest)?.has('array') && ![...shapes.keys()].some((key) => key.startsWith(`${rest}[]`))) return true;
  }
}

/** Fields that come and go with the session state, so their absence is not a change. */
const OPTIONAL = { liveTiming: ['$.rider{}.last_lap'] };

const fixture = async (name) => JSON.parse(await readFile(new URL(`../tests/fixtures/${name}.json`, import.meta.url), 'utf8'));
const idOf = (o) => o?.id ?? o?.uuid;

// Find ids the same way the probe does.
const seasons = await client.seasons();
const season = seasons.find((s) => s.current) ?? seasons[0];
// The newest Grand Prix that has ended, so every session has results. `isFinished` also returns the event in
// progress, the list is not in date order, and tests have another shape (no entry list, no lap columns, file
// links as plain URLs).
const finished = await client.resultsEvents(season.id, true);
const event =
  [...finished]
    .filter((e) => !e.test && Date.parse(e.date_end) < Date.now() - 86_400_000)
    .sort((a, b) => b.date_end.localeCompare(a.date_end))[0] ?? finished[0];
const categories = await client.resultsCategories({ eventUuid: event.id });
const category = categories.find((c) => /motogp/i.test(c.name)) ?? categories[0];
const sessions = await client.resultsSessions(event.id, category.id);
// The classification fixture is a practice session; races and sprints have other columns (time, points).
const session = sessions.find((s) => s.type === 'FP') ?? sessions[0];
const riders = await client.riders();
const yearCategory = (await client.categories(season.year)).find((c) => /motogp/i.test(c.name));
const circuit = event.circuit?.id;

const checks = {
  seasons: () => client.seasons(),
  riders: () => client.riders(),
  rider: () => client.rider(riders[0].id),
  nextSession: () => client.nextSession(),
  events: () => client.events(season.year),
  categories: () => client.categories(season.year),
  teams: () => client.teams(idOf(yearCategory), season.year),
  resultsEvents: () => client.resultsEvents(season.id, true),
  resultsCategories: () => client.resultsCategories({ eventUuid: event.id }),
  resultsSessions: () => client.resultsSessions(event.id, category.id),
  classification: () => client.classification(session.id),
  standings: () => client.standings(season.id, category.id),
  standingsFiles: () => client.standingsFiles(season.id, category.id),
  worldStandings: () => client.worldStandings({ category: category.id, type: 'RIDER', season_year: season.year }),
  bmwAward: () => client.bmwAward(season.year),
  entryList: () => client.entryList(event.id, category.id),
  championshipFiles: () => client.championshipFiles(event.id, category.id),
  lastSession: () => client.lastSession({ eventType: 'SPORT', broadcastType: 'SESSION', eventKind: 'GP', category: category.legacy_id }),
  worldChampions: () => client.worldChampions({ category: 'motogp', limit: 20 }),
  circuitRecords: () => client.circuitRecords(circuit),
  ridersPlacement: () => client.ridersPlacement(circuit, 'motogp'),
  ridersPoles: () => client.ridersPoles(circuit, 'motogp'),
  riderCareer: () => client.riderCareer(riders[0].id),
  riderInfo: () => client.riderInfo(riders[0].id),
  riderEventStats: () => client.riderEventStats(riders[0].id),
  riderStatsSummary: () => client.riderStatsSummary(riders[0].legacy_id),
  riderLegacyStatistics: () => client.riderLegacyStatistics(riders[0].legacy_id),
  liveTiming: () => client.liveTiming(),
  liveStanding: () => client.liveStanding(),
  'pulseBy_podiums': () => client.pulseBy('podiums', { season: season.year, category: 'motogp', limit: 10 }),
  'pulseBy_poles': () => client.pulseBy('poles', { season: season.year, category: 'motogp', limit: 10 }),
  'pulseBy_fastest-laps': () => client.pulseBy('fastest-laps', { season: season.year, category: 'motogp', limit: 10 }),
  'statisticsBy_world-champions': () => client.statisticsBy('world-champions', { season: season.year, category: 'motogp', limit: 10 }),
};

let failed = 0;
for (const [name, call] of Object.entries(checks)) {
  if (only && !only.has(name)) continue;
  let live;
  try {
    live = await call();
  } catch (error) {
    console.log(`✗ ${name}: request failed (${errorSummary(error)})`);
    failed++;
    continue;
  }
  const recorded = shape(await fixture(name));
  const current = shape(live);
  const problems = [];
  const added = [];

  for (const [path, kinds] of recorded) {
    const now = current.get(path);
    if (!now) {
      // Under an array that is empty right now (no session running, nothing in a list) nothing can be compared.
      if (!underEmptyArray(path, current) && !OPTIONAL[name]?.includes(path)) problems.push(`${path} gone`);
      continue;
    }
    const lost = [...kinds].filter((k) => k !== 'null' && !now.has(k));
    if (lost.length) problems.push(`${path}: was ${[...kinds].join('|')}, now ${[...now].join('|')}`);
  }
  for (const path of current.keys()) if (!recorded.has(path)) added.push(path);

  const bad = problems.length || (args.strict && added.length);
  console.log(`${bad ? '✗' : '✓'} ${name}${problems.length ? `\n    ${problems.slice(0, 8).join('\n    ')}` : ''}${added.length ? `\n    + ${added.length} new field(s): ${added.slice(0, 5).join(', ')}` : ''}`);
  if (bad) failed++;
  await sleep(150);
}

console.log(failed ? `\n${failed} endpoint(s) differ from the recorded shape.` : '\nAll shapes match the recordings.');
process.exitCode = failed ? 1 : 0;
