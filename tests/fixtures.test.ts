import { readFileSync } from 'node:fs';

import type { MockAgent } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MotoGPClient } from '../src/client';
import { API, clientWith, JSON_HEADERS, mockAgent, PREFIX } from './helpers';

/**
 * Made-up responses with the shape of real ones (`npm run probe && npm run make-fixtures` keeps the keys and types
 * and fakes every value): the client must hand them back untouched.
 */
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

let agent: MockAgent;
let api: ReturnType<MockAgent['get']>;

beforeEach(() => {
  agent = mockAgent();
  api = agent.get(API);
});

afterEach(async () => {
  agent.assertNoPendingInterceptors();
  await agent.close();
});

const V1 = PREFIX;
const V2 = PREFIX.replace('/v1', '/v2');

const rows: [string, string, (c: MotoGPClient) => Promise<unknown>][] = [
  ['seasons', `${V1}/results/seasons`, (c) => c.seasons()],
  ['riders', `${V1}/riders`, (c) => c.riders()],
  ['rider', `${V1}/riders/r1`, (c) => c.rider('r1')],
  ['event', `${V1}/events/e1`, (c) => c.event('e1')],
  ['nextSession', `${V1}/sessions/next?live=true`, (c) => c.nextSession()],
  ['events', `${V1}/events?seasonYear=2026`, (c) => c.events(2026)],
  ['categories', `${V1}/categories?seasonYear=2026`, (c) => c.categories(2026)],
  ['teams', `${V1}/teams?categoryUuid=c1&seasonYear=2026`, (c) => c.teams('c1', 2026)],
  ['resultsEvents', `${V1}/results/events?seasonUuid=s1&isFinished=true`, (c) => c.resultsEvents('s1', true)],
  ['resultsCategories', `${V1}/results/categories?eventUuid=e1`, (c) => c.resultsCategories({ eventUuid: 'e1' })],
  ['resultsSessions', `${V1}/results/sessions?eventUuid=e1&categoryUuid=c1`, (c) => c.resultsSessions('e1', 'c1')],
  ['classification', `${V2}/results/classifications?session=s1&test=false`, (c) => c.classification('s1')],
  ['standings', `${V1}/results/standings?seasonUuid=s1&categoryUuid=c1`, (c) => c.standings('s1', 'c1')],
  ['standingsFiles', `${V1}/results/standings/files?seasonUuid=s1&categoryUuid=c1`, (c) => c.standingsFiles('s1', 'c1')],
  ['worldStandings', `${V2}/results/world-standings?category=c1&type=RIDER`, (c) => c.worldStandings({ category: 'c1', type: 'RIDER' })],
  ['bmwAward', `${V2}/results/bmw-award?season_year=2026`, (c) => c.bmwAward(2026)],
  ['entryList', `${V2}/results/entries?categoryId=c1&eventId=e1`, (c) => c.entryList('e1', 'c1')],
  ['championshipFiles', `${V1}/results/event/e1/category/c1/files`, (c) => c.championshipFiles('e1', 'c1')],
  ['lastSession', `${V1}/sessions/last?event-type=SPORT&broadcast-type=SESSION`, (c) => c.lastSession({ eventType: 'SPORT', broadcastType: 'SESSION' })],
  ['worldChampions', `${V1}/sportsdata-gateway/riders/pulse/statistics/world-champions?category=motogp`, (c) => c.worldChampions({ category: 'motogp' })],
  ['circuitRecords', `${V1}/results/circuit/c1/records`, (c) => c.circuitRecords('c1')],
  ['ridersPlacement', `${V1}/results/riders-placement?circuitUuid=c1&categoryName=motogp`, (c) => c.ridersPlacement('c1', 'motogp')],
  ['ridersPoles', `${V1}/results/riders-poles?circuitUuid=c1&categoryName=motogp`, (c) => c.ridersPoles('c1', 'motogp')],
  ['riderCareer', `${V1}/sportsdata-gateway/riders/pulse/statistics?rider_id=r1&show_career=true`, (c) => c.riderCareer('r1')],
  ['riderInfo', `${V1}/sportsdata-gateway/riders/pulse/rider/r1`, (c) => c.riderInfo('r1')],
  ['riderEventStats', `${V1}/sportsdata-gateway/riders/pulse/event-stats?rider_id=r1`, (c) => c.riderEventStats('r1')],
  ['riderStatsSummary', `${V1}/riders/9958/stats`, (c) => c.riderStatsSummary(9958)],
  ['riderLegacyStatistics', `${V1}/riders/9958/statistics`, (c) => c.riderLegacyStatistics(9958)],
  ['liveTiming', `${V1}/timing-gateway/livetiming-lite`, (c) => c.liveTiming()],
  ['liveStanding', `${V1}/timing-gateway/live-standing`, (c) => c.liveStanding()],
  ['riderComparison', `${V1}/sportsdata-gateway/riders/pulse/statistics/comparison?season=2026&rider_id1=r1&rider_id2=r2`, (c) => c.riderComparison(2026, 'r1', 'r2')],
];

describe('recorded responses', () => {
  it.each(rows)('%s comes back as recorded', async (name, path, call) => {
    const body = fixture(name);
    api.intercept({ path, method: 'GET' }).reply(200, JSON.stringify(body), { headers: JSON_HEADERS });
    expect(await call(await clientWith(agent))).toEqual(body);
  });
});
