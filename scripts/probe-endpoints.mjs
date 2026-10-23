#!/usr/bin/env node
// Calls every untyped endpoint of the client, saves redacted samples and infers TypeScript types.
//
//   npm run build
//   node scripts/probe-endpoints.mjs [--out probe-out] [--season 2026] [--rider-limit 3] [--user-agent "…"]
//
// Public endpoints need nothing. Set MOTOGP_ACCESS_TOKEN / MOTOGP_REFRESH_TOKEN (or run
// `node scripts/verify.mjs --login` once, which saves .motogp-session.json) to include the account ones.
//
// Output (default ./probe-out):
//   samples/<endpoint>.json  redacted responses (send these back, or the whole folder zipped)
//   shapes.d.ts              types inferred from the samples
//   report.md                one row per call: status, size, parameters used
import { inferType, pascal } from './infer-types.mjs';
import { errorSummary, makeClient, parseArgs, redact, sleep, writeJson } from './lib.mjs';
import { writeFile } from 'node:fs/promises';

const args = parseArgs();
const out = typeof args.out === 'string' ? args.out : 'probe-out';
const riderLimit = Number(args['rider-limit'] ?? 3);
const delay = Number(args.delay ?? 250);
const client = await makeClient(args);

const rows = [];
const samples = new Map(); // endpoint name -> redacted responses

/** Runs one call, records it, returns the data (or undefined). */
async function call(name, params, fn) {
  const started = Date.now();
  let data;
  let status = 'ok';
  try {
    data = await fn();
    if (data === undefined || data === null || (Array.isArray(data) && !data.length)) status = 'empty';
  } catch (error) {
    status = errorSummary(error);
  }
  const size = data === undefined ? 0 : JSON.stringify(data).length;
  rows.push({ name, params, status, size, ms: Date.now() - started });
  console.log(`${status === 'ok' ? '✓' : status === 'empty' ? '∅' : '✗'} ${name} ${JSON.stringify(params)} ${status === 'ok' ? `${size}B` : status}`);
  if (data !== undefined && data !== null) {
    const list = samples.get(name) ?? [];
    list.push(redact(data));
    samples.set(name, list);
  }
  await sleep(delay);
  return data;
}

/** Arrays hide under different keys; find the list in a response. */
function list(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object')
    for (const key of ['data', 'results', 'events', 'categories', 'sessions', 'items', 'riders', 'classification', 'teams'])
      if (Array.isArray(data[key])) return data[key];
  return [];
}
const idOf = (o) => o?.id ?? o?.uuid ?? o?.legacy_id;
/** Some fields are `{ value }` wrappers, others plain. */
const unwrap = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);

// ---- discovery chain ------------------------------------------------------------------------
const seasons = list(await call('seasons', {}, () => client.seasons()));
const season =
  seasons.find((s) => String(s.year) === String(args.season)) ?? seasons.find((s) => s.current) ?? seasons[0];
const year = Number(season?.year ?? args.season ?? new Date().getFullYear());

const ctx = { year };
const next = await call('nextSession', { live: true }, () => client.nextSession(true));
const nextEvent = next?.broadcast?.event_category?.event;
ctx.shortname = unwrap(next?.event?.shortname ?? nextEvent?.shortname ?? nextEvent?.short_name);
const nextEventId = next?.event?.id ?? nextEvent?.id;

const riders = list(await call('riders', {}, () => client.riders()));
const rider = riders[0];

const events = list(await call('resultsEvents', { season: season?.id, isFinished: true }, () => client.resultsEvents(season.id, true)));
const upcoming = list(await call('resultsEvents', { season: season?.id, isFinished: false }, () => client.resultsEvents(season.id, false)));
// Prefer the event that is on now (it has the live data); else the latest finished one.
// /results ids differ from the ones in sessions/next, so match on the 3-letter short name.
const event = [...events, ...upcoming].find((e) => ctx.shortname && unwrap(e.short_name) === ctx.shortname) ?? events.at(-1) ?? events[0];
ctx.eventId = idOf(event);
ctx.shortname ??= unwrap(event?.shortname ?? event?.short_name);

const categories = list(await call('resultsCategories', { seasonUuid: season?.id }, () => client.resultsCategories({ seasonUuid: season.id })));
const eventCategories = list(
  await call('resultsCategories', { eventUuid: ctx.eventId }, () => client.resultsCategories({ eventUuid: ctx.eventId })),
);
const category = (eventCategories.length ? eventCategories : categories).find((c) => /motogp/i.test(c.name ?? '')) ?? categories[0];
ctx.categoryId = idOf(category);
ctx.categoryName = String(category?.name ?? 'MotoGP').toLowerCase().replace(/[^a-z0-9]/g, '');

const sessions = list(
  await call('resultsSessions', { event: ctx.eventId, category: ctx.categoryId }, () => client.resultsSessions(ctx.eventId, ctx.categoryId)),
);
for (const s of sessions.slice(0, 4)) {
  await call('classification', { session: idOf(s), type: s.type }, () => client.classification(idOf(s)));
}
const race = sessions.find((s) => /^(RAC|SPR)/i.test(s.type ?? '')) ?? sessions[0];
if (race) await call('classification', { session: idOf(race), test: true }, () => client.classification(idOf(race), true));

// Races and sprints have other columns (time, points) than practice and qualifying. The event on now may not
// have raced yet, so also sample them from the newest Grand Prix that has ended. `isFinished` includes the
// event in progress and is not in date order; tests have no race.
const ended = [...events]
  .filter((e) => !e.test && idOf(e) !== ctx.eventId && Date.parse(e.date_end) < Date.now() - 86_400_000)
  .sort((a, b) => String(b.date_end).localeCompare(String(a.date_end)))[0];
if (ended) {
  const endedCategory =
    list(await call('resultsCategories', { eventUuid: idOf(ended) }, () => client.resultsCategories({ eventUuid: idOf(ended) }))).find((c) =>
      /motogp/i.test(c.name ?? ''),
    ) ?? category;
  const endedSessions = list(
    await call('resultsSessions', { event: idOf(ended), category: idOf(endedCategory) }, () =>
      client.resultsSessions(idOf(ended), idOf(endedCategory)),
    ),
  );
  for (const s of endedSessions.filter((s) => /^(RAC|SPR)$/i.test(s.type ?? '')))
    await call('classification', { session: idOf(s), type: s.type, event: unwrap(ended.short_name) }, () => client.classification(idOf(s)));
}

await call('standings', {}, () => client.standings(season.id, ctx.categoryId));
await call('standingsFiles', {}, () => client.standingsFiles(season.id, ctx.categoryId));
await call('startingGrid', {}, () => client.startingGrid(ctx.eventId, ctx.categoryId));
for (const e of [...new Set([ctx.eventId, nextEventId].filter(Boolean))])
  for (const c of [...new Set([ctx.categoryId, idOf(category), next?.category?.id].filter(Boolean))])
    await call('entryList', { event: e, category: c }, () => client.entryList(e, c));
await call('championshipFiles', {}, () => client.championshipFiles(ctx.eventId, ctx.categoryId));

// ---- season-level -----------------------------------------------------------------------------
await call('events', { seasonYear: year }, () => client.events(year));
const yearCategories = list(await call('categories', { seasonYear: year }, () => client.categories(year)));
const yearCategory = yearCategories.find((c) => /motogp/i.test(c.name ?? '')) ?? yearCategories[0];
// /categories and /results/categories use different UUIDs for the same class.
for (const id of [idOf(yearCategory), ctx.categoryId].filter(Boolean))
  await call('teams', { category: id, seasonYear: year }, () => client.teams(id, year));
await call('bmwAward', { seasonYear: year }, () => client.bmwAward(year));
await call('worldChampions', { category: ctx.categoryName }, () => client.worldChampions({ category: ctx.categoryName, limit: 20 }));

// ---- unknown arguments: try candidates and see what the server accepts ---------------------------
// The server wants a category UUID and a `type` (values unknown: try the likely ones).
const standingsCategories = [ctx.categoryId, idOf(yearCategory)].filter((v, i, all) => v && all.indexOf(v) === i);
for (const cat of standingsCategories)
  for (const type of ['rider', 'team', 'constructor', 'riders', 'teams', 'constructors', 'RIDER', 'TEAM', 'CONSTRUCTOR']) {
    const p = { category: cat, type, season_year: year };
    await call('worldStandings', p, () => client.worldStandings(p));
  }

// sessions/last: `category` is the integer legacy id (3 = MotoGP). Known to work: event-type=SPORT,
// broadcast-type=SESSION. event-type=GP is blocked by the WAF (HTTP 424), RACE/PRACTICE/... are "type not found".
const legacy = category?.legacy_id ?? yearCategory?.legacy_id ?? 3;
const lastCandidates = [
  { eventType: 'SPORT', broadcastType: 'SESSION', eventKind: 'GP', category: legacy },
  { eventType: 'SPORT', broadcastType: 'SESSION' },
  { eventType: 'TEST', broadcastType: 'SESSION', category: legacy },
  { eventType: 'SPORT', broadcastType: 'SESSION', eventKind: 'TEST', category: legacy },
];
for (const f of lastCandidates) await call('lastSession', f, () => client.lastSession(f));

// The only accessors that exist (everything else tried so far is "No static resource").
const accessors = ['podiums', 'poles', 'fastest-laps', 'world-champions'];
for (const accessor of accessors) {
  const f = { season: year, category: ctx.categoryName, limit: 10 };
  await call(`statisticsBy:${accessor}`, f, () => client.statisticsBy(accessor, f));
  await call(`pulseBy:${accessor}`, f, () => client.pulseBy(accessor, f));
}

// ---- events / circuits ------------------------------------------------------------------------
// /events/{id} takes the id from sessions/next, not the /results one.
if (nextEventId ?? ctx.eventId) await call('event', { id: nextEventId ?? ctx.eventId }, () => client.event(nextEventId ?? ctx.eventId));
if (ctx.shortname) {
  await call('pulseEvent', { season: year, shortname: ctx.shortname }, () => client.pulseEvent(year, ctx.shortname));
  for (const cat of [ctx.categoryName, String(legacy), 'MotoGP'])
    await call('pulseGrid', { shortname: ctx.shortname, category: cat }, () => client.pulseGrid(year, ctx.shortname, cat));
}
const circuitId = event?.circuit?.id ?? nextEvent?.circuit?.id;
if (circuitId) {
  await call('circuitRecords', { circuit: circuitId }, () => client.circuitRecords(circuitId));
  await call('ridersPlacement', { circuit: circuitId }, () => client.ridersPlacement(circuitId, ctx.categoryName));
  await call('ridersPoles', { circuit: circuitId }, () => client.ridersPoles(circuitId, ctx.categoryName));
}

// ---- riders -------------------------------------------------------------------------------------
await call('riderPhotos', { tag: 'sport-data-image:rider:main' }, () => client.riderPhotos({ tag: 'sport-data-image:rider:main' }));
for (const r of riders.slice(0, riderLimit)) {
  const id = r.id;
  await call('rider', { id }, () => client.rider(id));
  await call('riderInfo', { id }, () => client.riderInfo(id));
  await call('riderCareer', { id }, () => client.riderCareer(id));
  await call('riderEventStats', { id }, () => client.riderEventStats(id));
  if (r.legacy_id != null) {
    await call('riderStatsSummary', { legacy: r.legacy_id }, () => client.riderStatsSummary(r.legacy_id));
    await call('riderLegacyStatistics', { legacy: r.legacy_id }, () => client.riderLegacyStatistics(r.legacy_id));
  }
}
if (riders.length >= 2) await call('riderComparison', {}, () => client.riderComparison(year, riders[0].id, riders[1].id));

// ---- live (empty or stale outside a session) --------------------------------------------------------
await call('liveTiming', {}, () => client.liveTiming());
await call('liveStanding', {}, () => client.liveStanding());
await call('onAir', { feed: 'prod' }, () => client.onAir('prod'));
await call('onAir', { feed: '360' }, () => client.onAir('360'));

// ---- account (only with a session) ------------------------------------------------------------------
if (client.loggedIn) {
  await call('permissions', {}, () => client.permissions());
  await call('playerData', { feed: 'prod' }, () => client.playerData('prod'));
  await call('sessionCheck', {}, () => client.sessionCheck());
}

// ---- write the results ---------------------------------------------------------------------------------
let dts = `// Inferred by scripts/probe-endpoints.mjs on ${new Date().toISOString()}.\n// Fields missing from some items are optional; arrays/records are merged across all samples.\n\n`;
for (const [name, items] of samples) {
  await writeJson(`${out}/samples/${name.replace(/[^\w-]+/g, '_')}.json`, { samples: items });
  dts += `${inferType(pascal(name), items)}\n\n`;
}
await writeFile(`${out}/shapes.d.ts`, dts);

const table = rows.map((r) => `| ${r.name} | \`${JSON.stringify(r.params)}\` | ${r.status === 'ok' ? '✓' : r.status} | ${r.size} | ${r.ms} |`);
await writeFile(
  `${out}/report.md`,
  `# Probe report\n\nSeason ${year}, event ${ctx.eventId ?? '?'}, category ${ctx.categoryName}. Signed in: ${client.loggedIn}.\n\n| endpoint | params | result | bytes | ms |\n|---|---|---|---|---|\n${table.join('\n')}\n`,
);
console.log(`\nDone: ${rows.filter((r) => r.status === 'ok').length}/${rows.length} calls returned data. See ${out}/report.md`);
