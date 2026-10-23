import type { MockAgent } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LoginError, MotoGPAuth, NotSignedInError, PermissionsError } from '@exhumer/motogp-auth';

import { ACCOUNT_URL, API_URL, MotoGPClient, MotoGPError } from '../src/client';
import packageJson from '../package.json';
import { ACCOUNT, API, clientWith, JSON_HEADERS, mockAgent, PREFIX, signToken, tokenResponse } from './helpers';

let agent: MockAgent;
let api: ReturnType<MockAgent['get']>;
let account: ReturnType<MockAgent['get']>;

beforeEach(() => {
  agent = mockAgent();
  api = agent.get(API);
  account = agent.get(ACCOUNT);
});

afterEach(async () => {
  agent.assertNoPendingInterceptors();
  await agent.close();
});

const captured = () => {
  const seen: { headers: Record<string, string>; body: string; path: string }[] = [];
  return {
    seen,
    reply:
      (status: number, data: unknown) =>
      (opts: { headers?: unknown; body?: unknown; path: string }) => {
        seen.push({
          headers: Object.fromEntries(
            Object.entries(opts.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
          ),
          body: String(opts.body ?? ''),
          path: opts.path,
        });
        return { statusCode: status, data: typeof data === 'string' ? data : JSON.stringify(data), responseOptions: { headers: JSON_HEADERS } };
      },
  };
};

describe('constants', () => {
  it('point at the servers the web app uses', () => {
    expect(API_URL).toBe(`${API}${PREFIX}`);
    expect(ACCOUNT_URL).toBe(ACCOUNT);
  });
});

describe('MotoGPClient.create', () => {
  it('creates a signed-out client without options', async () => {
    const client = await MotoGPClient.create();
    expect([client.accessToken, client.refreshToken, client.claims, client.accessTokenExpiry, client.loggedIn]).toEqual([
      null,
      null,
      null,
      null,
      false,
    ]);
  });

  it('uses a valid access token as is, with or without the Bearer prefix', async () => {
    const token = await signToken();
    const client = await clientWith(agent, { accessToken: `Bearer ${token}`, refreshToken: 'r' });
    expect(client.accessToken).toBe(token);
    expect(client.refreshToken).toBe('r');
    expect(client.claims?.sub).toBe('00000000-0000-4000-8000-000000000000');
    expect(client.accessTokenExpiry).toBe(client.claims!.exp * 1000);
    expect(client.loggedIn).toBe(true);
  });

  it('rejects a token that is not a JWT', async () => {
    await expect(clientWith(agent, { accessToken: 'nope' })).rejects.toThrow('not a valid JWT token');
  });

  it('rejects an expired access token that cannot be renewed', async () => {
    await expect(clientWith(agent, { accessToken: await signToken(-10) })).rejects.toThrow('has expired');
  });

  it('renews an expired access token with the refresh token', async () => {
    const fresh = await tokenResponse(3600, 'refresh-2');
    account.intercept({ path: '/login/token', method: 'POST' }).reply(200, fresh, { headers: JSON_HEADERS });
    const client = await clientWith(agent, { accessToken: await signToken(-10), refreshToken: 'refresh-1' });
    expect(client.accessToken).toBe(fresh.access_token);
    expect(client.refreshToken).toBe('refresh-2');
  });

  it('gets an access token from a refresh token alone', async () => {
    const fresh = await tokenResponse();
    account.intercept({ path: '/login/token', method: 'POST' }).reply(200, fresh, { headers: JSON_HEADERS });
    const client = await clientWith(agent, { refreshToken: 'refresh-1' });
    expect(client.accessToken).toBe(fresh.access_token);
  });
});

describe('sign-in', () => {
  it('logs in with the password grant the login page uses', async () => {
    const fresh = await tokenResponse();
    const { seen, reply } = captured();
    account.intercept({ path: '/login/token', method: 'POST' }).reply(reply(200, fresh));
    const client = await clientWith(agent);
    expect(await client.login('me@example.com', 'hunter2')).toEqual(fresh);
    expect(JSON.parse(seen[0]!.body)).toEqual({
      grant_type: 'password',
      client_id: 'b32ca14f-0709-495a-9184-8bd848cf7e6b',
      username: 'me@example.com',
      password: 'hunter2',
      origin_client_id: 'b4b18243-76dd-4d76-a58e-458cff85dba3',
    });
    expect(seen[0]!.headers).toMatchObject({
      origin: 'https://sso.motogp.com',
      referer: 'https://sso.motogp.com/',
      'content-type': 'application/json',
    });
    expect(client.accessToken).toBe(fresh.access_token);
    expect(client.refreshToken).toBe('refresh-1');
  });

  it('throws a LoginError when the login is refused', async () => {
    account.intercept({ path: '/login/token', method: 'POST' }).reply(401, '{"error":"invalid_grant"}');
    const client = await clientWith(agent);
    const error = await client.login('a', 'b').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LoginError);
    expect(error).toMatchObject({ statusCode: 401, body: '{"error":"invalid_grant"}' });
    expect(client.loggedIn).toBe(false);
  });

  it('reports new tokens to onTokens and sends its user agent to the login', async () => {
    const fresh = await tokenResponse();
    const stored: string[] = [];
    const { seen, reply } = captured();
    account.intercept({ path: '/login/token', method: 'POST' }).reply(reply(200, fresh));
    const client = await clientWith(agent, { onTokens: (t) => void stored.push(t.refresh_token), userAgent: 'ua/2', headers: { 'accept-language': 'ar' } });
    await client.login('a', 'b');
    expect(stored).toEqual(['refresh-1']);
    expect(seen[0]!.headers).toMatchObject({ 'user-agent': 'ua/2', 'accept-language': 'ar' });
  });

  it('can share a session with other clients', async () => {
    const auth = await MotoGPAuth.create({ dispatcher: agent, accessToken: await signToken() });
    const client = await clientWith(agent, { auth, accessToken: 'ignored' });
    expect(client.auth).toBe(auth);
    expect(client.accessToken).toBe(auth.accessToken);
  });

  it('refreshes with the refresh_token grant and keeps the rotated token', async () => {
    const first = await tokenResponse(3600, 'refresh-1');
    const second = await tokenResponse(3600, 'refresh-2');
    const { seen, reply } = captured();
    account.intercept({ path: '/login/token', method: 'POST' }).reply(200, first, { headers: JSON_HEADERS });
    account.intercept({ path: '/login/token', method: 'POST' }).reply(reply(200, second));
    const client = await clientWith(agent);
    await client.login('a', 'b');
    await client.refresh();
    expect(JSON.parse(seen[0]!.body)).toEqual({
      grant_type: 'refresh_token',
      client_id: 'b32ca14f-0709-495a-9184-8bd848cf7e6b',
      refresh_token: 'refresh-1',
    });
    expect(client.refreshToken).toBe('refresh-2');
  });

  it('cannot refresh without a refresh token', async () => {
    await expect((await clientWith(agent)).refresh()).rejects.toThrow('refreshToken is not set');
  });

  it('logout() clears the session, and a sign-in still in flight does not bring it back', async () => {
    account
      .intercept({ path: '/login/token', method: 'POST' })
      .reply(200, await tokenResponse(), { headers: JSON_HEADERS })
      .delay(20);
    const client = await clientWith(agent);
    const pending = client.login('a', 'b');
    client.logout();
    await pending;
    expect([client.loggedIn, client.refreshToken, client.claims]).toEqual([false, null, null]);
  });

  it('logout() signs out a signed-in client', async () => {
    const client = await clientWith(agent, { accessToken: await signToken(), refreshToken: 'r' });
    client.logout();
    expect([client.accessToken, client.refreshToken, client.claims, client.loggedIn]).toEqual([null, null, null, false]);
  });
});

describe('public data', () => {
  const get = async (path: string, data: unknown, call: (c: MotoGPClient) => Promise<unknown>) => {
    const { seen, reply } = captured();
    api.intercept({ path: `${PREFIX}${path}`, method: 'GET' }).reply(reply(200, data));
    const result = await call(await clientWith(agent));
    return { result, request: seen[0]! };
  };

  it('sends the headers the web app sends, and no credentials', async () => {
    const { request } = await get('/results/seasons', [], (c) => c.seasons());
    expect(request.headers).toMatchObject({
      accept: 'application/json',
      'x-client': 'FE',
      origin: 'https://www.motogp.com',
      referer: 'https://www.motogp.com/',
      'user-agent': `${packageJson.name}/${packageJson.version} (${packageJson.repository.url})`,
    });
    expect(request.headers).not.toHaveProperty('cookie');
    expect(request.headers).not.toHaveProperty('authorization');
  });

  it('reads the endpoints it wraps', async () => {
    const season = [{ id: 's', name: null, year: 2026, current: true }];
    expect((await get('/results/seasons', season, (c) => c.seasons())).result).toEqual(season);
    expect((await get('/riders', [{ id: 'r' }], (c) => c.riders())).result).toEqual([{ id: 'r' }]);
    expect((await get('/riders/a%2Fb', { id: 'r' }, (c) => c.rider('a/b'))).result).toEqual({ id: 'r' });
    expect((await get('/events/e1', { country: 'AU' }, (c) => c.event('e1'))).result).toEqual({ country: 'AU' });
    expect((await get('/results/circuit/c1/records', { records: {} }, (c) => c.circuitRecords('c1'))).result).toEqual({
      records: {},
    });
  });

  it('asks for the running session', async () => {
    expect((await get('/sessions/next?live=true', { id: 'x' }, (c) => c.nextSession())).result).toEqual({ id: 'x' });
    expect((await get('/sessions/next?live=false', { id: 'y' }, (c) => c.nextSession(false))).result).toEqual({
      id: 'y',
    });
  });

  it('reads both live timing feeds', async () => {
    const feed = { head: { category: 'Moto3' }, rider: {} };
    expect((await get('/timing-gateway/livetiming-lite', feed, (c) => c.liveTiming())).result).toEqual(feed);
    expect((await get('/timing-gateway/live-standing', feed, (c) => c.liveStanding())).result).toEqual(feed);
  });

  it('reads results and statistics with their query', async () => {
    const q = 'circuitUuid=c1&categoryName=moto2';
    expect((await get(`/results/riders-placement?${q}`, [], (c) => c.ridersPlacement('c1', 'moto2'))).result).toEqual([]);
    expect(
      (await get(`/results/riders-poles?${q}`, { data: [], pagination: {} }, (c) => c.ridersPoles('c1', 'moto2'))).result,
    ).toEqual({ data: [], pagination: {} });
    expect(
      (
        await get('/sportsdata-gateway/riders/pulse/statistics/comparison?season=2026&rider_id1=a&rider_id2=b', {}, (c) =>
          c.riderComparison(2026, 'a', 'b'),
        )
      ).result,
    ).toEqual({});
  });

  it('asks whether a video feed is on air', async () => {
    const on = { on_air: true, access_type: 'pay' };
    expect((await get('/video-gateway/live/v2/mgp/prod/on-air', on, (c) => c.onAir())).result).toEqual(on);
    expect((await get('/video-gateway/live/v2/mgp/360/on-air', on, (c) => c.onAir('360'))).result).toEqual(on);
  });

  it('throws a MotoGPError for an error status', async () => {
    api.intercept({ path: `${PREFIX}/riders`, method: 'GET' }).reply(500, 'boom');
    const error = await (await clientWith(agent)).riders().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MotoGPError);
    expect(error).toMatchObject({ statusCode: 500, body: 'boom', url: `${API}${PREFIX}/riders` });
  });

  it('takes a custom user agent and extra headers', async () => {
    const { seen, reply } = captured();
    api.intercept({ path: `${PREFIX}/riders`, method: 'GET' }).reply(reply(200, []));
    await (await clientWith(agent, { userAgent: 'ua/1', headers: { 'accept-language': 'en' } })).riders();
    expect(seen[0]!.headers).toMatchObject({ 'user-agent': 'ua/1', 'accept-language': 'en' });
  });
});

describe('video', () => {
  const FEED_URL = `${ACCOUNT}/video-gateway/live/v2/url?data=abc%2B`;
  const MASTER = 'https://ipfmix.cdn4.mcr.dorna.com/x/hls/ipfmix/index.m3u8?&start=1';
  const playerData = {
    cdns: [
      { id: 'auto', label: 'Auto', feeds: [{ id: 'ipfmix', label: 'Commentary', protocols: { hls: { url: FEED_URL } } }, { id: 'bare', protocols: {} }] },
    ],
    dvr_range: { start: 1, end: 2 },
    user: { uid: 'u' },
    video_info: {},
  };

  it('needs a signed-in account for the player data', async () => {
    await expect((await clientWith(agent)).playerData()).rejects.toBeInstanceOf(NotSignedInError);
  });

  it('sends the access token as the DAT cookie', async () => {
    const token = await signToken();
    const { seen, reply } = captured();
    api.intercept({ path: `${PREFIX}/video-gateway/live/v2/mgp/prod/player-data?protocol=hls`, method: 'GET' }).reply(reply(200, playerData));
    api.intercept({ path: `${PREFIX}/video-gateway/live/v2/mgp/360/player-data?protocol=dash`, method: 'GET' }).reply(reply(200, playerData));
    const client = await clientWith(agent, { accessToken: token });
    expect(await client.playerData()).toEqual(playerData);
    await client.playerData('360', 'dash');
    expect(seen[0]!.headers.cookie).toBe(`DAT=${token}`);
    expect(seen[0]!.headers).not.toHaveProperty('authorization');
  });

  it('refreshes an access token that is about to expire before using it', async () => {
    const fresh = await tokenResponse(3600, 'refresh-2');
    const { seen, reply } = captured();
    account.intercept({ path: '/login/token', method: 'POST' }).reply(200, fresh, { headers: JSON_HEADERS });
    api.intercept({ path: `${PREFIX}/video-gateway/live/v2/mgp/prod/player-data?protocol=hls`, method: 'GET' }).reply(reply(200, playerData));
    let now = Date.now();
    const auth = await MotoGPAuth.create({ dispatcher: agent, now: () => now, accessToken: await signToken(), refreshToken: 'refresh-1' });
    const client = await clientWith(agent, { auth });
    now += 3_550_000; // under a minute left
    await client.playerData();
    expect(seen[0]!.headers.cookie).toBe(`DAT=${fresh.access_token}`);
  });

  it('follows the redirect of a feed URL to the signed master playlist, sending the DAT cookie', async () => {
    const seen: Array<{ headers: Record<string, string> }> = [];
    const token = await signToken();
    account
      .intercept({ path: '/video-gateway/live/v2/url?data=abc%2B', method: 'GET' })
      .reply((options) => {
        seen.push({ headers: options.headers as Record<string, string> });
        return { statusCode: 301, data: '<html></html>', responseOptions: { headers: { location: MASTER } } };
      });
    const client = await clientWith(agent, { accessToken: token });
    expect(await client.resolveStreamUrl(FEED_URL)).toBe(MASTER);
    expect(seen[0]!.headers.cookie).toBe(`DAT=${token}`);
    expect(seen[0]!.headers.referer).toBe('https://www.motogp.com/');
  });

  it('accepts the playlist URL as the body, or a relative redirect', async () => {
    account.intercept({ path: '/video-gateway/live/v2/url?data=abc%2B', method: 'GET' }).reply(200, `${MASTER}\n`);
    account
      .intercept({ path: '/video-gateway/live/v2/url?data=abc%2B', method: 'GET' })
      .reply(302, '', { headers: { location: '/next.m3u8' } });
    account.intercept({ path: '/video-gateway/live/v2/url?data=abc%2B', method: 'GET' }).reply(302, MASTER);
    const client = await clientWith(agent, { accessToken: await signToken() });
    expect(await client.resolveStreamUrl(FEED_URL)).toBe(MASTER);
    expect(await client.resolveStreamUrl(FEED_URL)).toBe(`${ACCOUNT}/next.m3u8`);
    expect(await client.resolveStreamUrl(FEED_URL)).toBe(MASTER); // 3xx without a location: the body
  });

  it('reports a WAF block while resolving', async () => {
    account.intercept({ path: '/video-gateway/live/v2/url?data=abc%2B', method: 'GET' }).reply(403, '<html>blocked</html>');
    await expect((await clientWith(agent, { accessToken: await signToken() })).resolveStreamUrl(FEED_URL)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('refuses to resolve a URL that is not from MotoGP', async () => {
    await expect((await clientWith(agent)).resolveStreamUrl('https://example.com/x')).rejects.toThrow('Not a MotoGP stream URL');
  });

  it('streamUrl() goes from player data to the master playlist', async () => {
    api.intercept({ path: `${PREFIX}/video-gateway/live/v2/mgp/prod/player-data?protocol=hls`, method: 'GET' }).reply(200, playerData, { headers: JSON_HEADERS });
    account.intercept({ path: '/video-gateway/live/v2/url?data=abc%2B', method: 'GET' }).reply(200, MASTER);
    expect(await (await clientWith(agent, { accessToken: await signToken() })).streamUrl()).toBe(MASTER);
  });

  it.each([
    ['an unknown feed', ['nope', 'auto']],
    ['an unknown CDN', ['ipfmix', 'nope']],
    ['a feed without HLS', ['bare', 'auto']],
  ] as const)('streamUrl() fails for %s', async (_, [feed, cdn]) => {
    api.intercept({ path: `${PREFIX}/video-gateway/live/v2/mgp/prod/player-data?protocol=hls`, method: 'GET' }).reply(200, playerData, { headers: JSON_HEADERS });
    await expect((await clientWith(agent, { accessToken: await signToken() })).streamUrl(feed, cdn)).rejects.toThrow('No HLS feed');
  });
});

describe('permissions', () => {
  const licence = (name: string, status = 'ACTIVE', end: string | null = null) => ({
    id: name,
    subscription: { id: 's', origin: 'subscription' },
    licence: { id: name, name, type: 'subscription', legacy_id: '1' },
    dorna_id: 'd',
    date: { start: '2026-08-28T10:11:28+00:00', end },
    status,
  });

  it('lists the licences with the Bearer token', async () => {
    const token = await signToken();
    const { seen, reply } = captured();
    account.intercept({ path: '/perms/me?active=true', method: 'GET' }).reply(reply(200, [licence('VideoPass')]));
    const client = await clientWith(agent, { accessToken: token });
    expect(await client.permissions()).toHaveLength(1);
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${token}`);
    expect(seen[0]!.headers).not.toHaveProperty('cookie');
  });

  it('knows which licences are active', async () => {
    const now = Date.parse('2026-10-23T00:00:00Z');
    const list = [
      licence('VideoPass'),
      licence('TimingPass', 'ACTIVE', '2026-12-01T00:00:00+00:00'),
      licence('Old', 'ACTIVE', '2026-01-01T00:00:00+00:00'),
      licence('Paused', 'SUSPENDED'),
    ];
    const client = await clientWith(agent, { accessToken: await signToken() });
    account.intercept({ path: '/perms/me?active=true', method: 'GET' }).reply(200, list, { headers: JSON_HEADERS }).times(5);
    expect(await client.hasLicence('VideoPass', now)).toBe(true);
    expect(await client.hasLicence('TimingPass', now)).toBe(true);
    expect(await client.hasLicence('Old', now)).toBe(false);
    expect(await client.hasLicence('Paused', now)).toBe(false);
    expect(await client.hasLicence('Missing', now)).toBe(false);
  });

  it('surfaces a refused token as a PermissionsError', async () => {
    account.intercept({ path: '/perms/me?active=true', method: 'GET' }).reply(401, 'nope');
    await expect((await clientWith(agent, { accessToken: await signToken() })).permissions()).rejects.toBeInstanceOf(PermissionsError);
  });

  it('needs a signed-in account', async () => {
    await expect((await clientWith(agent)).permissions()).rejects.toBeInstanceOf(NotSignedInError);
  });

  it('defaults to the current time', async () => {
    account.intercept({ path: '/perms/me?active=true', method: 'GET' }).reply(200, [licence('VideoPass')], { headers: JSON_HEADERS });
    expect(await (await clientWith(agent, { accessToken: await signToken() })).hasLicence('VideoPass')).toBe(true);
  });
});

describe('endpoints from the web app’s API layer', () => {
  const V1 = PREFIX;
  const V2 = '/motogp/v2';
  const rows: [string, string, (c: MotoGPClient) => Promise<unknown>][] = [
    ['events', `${V1}/events?seasonYear=2026&kind=GP`, (c) => c.events(2026, { kind: 'GP' })],
    ['events (no filters)', `${V1}/events?seasonYear=2026`, (c) => c.events(2026)],
    ['categories', `${V1}/categories?seasonYear=2026`, (c) => c.categories(2026)],
    ['teams', `${V1}/teams?categoryUuid=c1&seasonYear=2026`, (c) => c.teams('c1', 2026)],
    ['riderStatsSummary', `${V1}/riders/9958/stats`, (c) => c.riderStatsSummary(9958)],
    ['riderLegacyStatistics', `${V1}/riders/9958/statistics`, (c) => c.riderLegacyStatistics(9958)],
    ['resultsEvents', `${V1}/results/events?seasonUuid=s1&isFinished=true`, (c) => c.resultsEvents('s1', true)],
    ['resultsCategories', `${V1}/results/categories?eventUuid=e1`, (c) => c.resultsCategories({ eventUuid: 'e1' })],
    ['resultsSessions', `${V1}/results/sessions?eventUuid=e1&categoryUuid=c1`, (c) => c.resultsSessions('e1', 'c1')],
    ['classification', `${V2}/results/classifications?session=s1&test=false`, (c) => c.classification('s1')],
    ['classification (test)', `${V2}/results/classifications?session=s1&test=true`, (c) => c.classification('s1', true)],
    ['standings', `${V1}/results/standings?seasonUuid=s1&categoryUuid=c1`, (c) => c.standings('s1', 'c1')],
    ['standingsFiles', `${V1}/results/standings/files?seasonUuid=s1&categoryUuid=c1`, (c) => c.standingsFiles('s1', 'c1')],
    [
      'worldStandings',
      `${V2}/results/world-standings?category=c1&type=RIDER&season_year=2026`,
      (c) => c.worldStandings({ category: 'c1', type: 'RIDER', season_year: 2026 }),
    ],
    [
      'worldStandings (no season)',
      `${V2}/results/world-standings?category=c1&type=TEAM`,
      (c) => c.worldStandings({ category: 'c1', type: 'TEAM' }),
    ],
    ['bmwAward', `${V2}/results/bmw-award?season_year=2026`, (c) => c.bmwAward(2026)],
    ['startingGrid', `${V1}/results/event/e%2F1/category/c1/grid`, (c) => c.startingGrid('e/1', 'c1')],
    ['entryList', `${V2}/results/entries?categoryId=c1&eventId=e1`, (c) => c.entryList('e1', 'c1')],
    ['championshipFiles', `${V1}/results/event/e1/category/c1/files`, (c) => c.championshipFiles('e1', 'c1')],
    [
      'lastSession',
      `${V1}/sessions/last?event-type=SPORT&broadcast-type=SESSION&event-kind=GP&category=3`,
      (c) => c.lastSession({ eventType: 'SPORT', broadcastType: 'SESSION', eventKind: 'GP', category: 3 }),
    ],
    [
      'lastSession (required filters only)',
      `${V1}/sessions/last?event-type=SPORT&broadcast-type=SESSION`,
      (c) => c.lastSession({ eventType: 'SPORT', broadcastType: 'SESSION' }),
    ],
    [
      'statisticsBy',
      `${V1}/sportsdata-gateway/riders/pulse/statistics/top-speed?season=2026&category=MotoGP&limit=100`,
      (c) => c.statisticsBy('top-speed', { season: 2026, category: 'MotoGP' }),
    ],
    [
      'statisticsBy (limit)',
      `${V1}/sportsdata-gateway/riders/pulse/statistics/top-speed?season=2026&category=MotoGP&limit=5`,
      (c) => c.statisticsBy('top-speed', { season: 2026, category: 'MotoGP', limit: 5 }),
    ],
    [
      'pulseBy',
      `${V1}/sportsdata-gateway/riders/pulse/ranking?season=2026&category=Moto3&limit=100`,
      (c) => c.pulseBy('ranking', { season: 2026, category: 'Moto3' }),
    ],
    [
      'worldChampions',
      `${V1}/sportsdata-gateway/riders/pulse/statistics/world-champions?category=MotoGP&limit=10`,
      (c) => c.worldChampions({ category: 'MotoGP', limit: 10 }),
    ],
    [
      'worldChampions (category only)',
      `${V1}/sportsdata-gateway/riders/pulse/statistics/world-champions?category=MotoGP`,
      (c) => c.worldChampions({ category: 'MotoGP' }),
    ],
    [
      'riderCareer',
      `${V1}/sportsdata-gateway/riders/pulse/statistics?rider_id=r1&show_career=true`,
      (c) => c.riderCareer('r1'),
    ],
    [
      'riderCareer (season only)',
      `${V1}/sportsdata-gateway/riders/pulse/statistics?rider_id=r1`,
      (c) => c.riderCareer('r1', false),
    ],
    ['riderInfo', `${V1}/sportsdata-gateway/riders/pulse/rider/r1`, (c) => c.riderInfo('r1')],
    [
      'riderEventStats',
      `${V1}/sportsdata-gateway/riders/pulse/event-stats?rider_id=r1`,
      (c) => c.riderEventStats('r1'),
    ],
    [
      'pulseEvent',
      `${V1}/sportsdata-gateway/events/pulse/event?season=2026&shortname=AUS`,
      (c) => c.pulseEvent(2026, 'AUS'),
    ],
    [
      'pulseGrid',
      `${V1}/sportsdata-gateway/events/pulse/grid?season=2026&shortname=AUS&category=MotoGP`,
      (c) => c.pulseGrid(2026, 'AUS', 'MotoGP'),
    ],
    [
      'riderPhotos',
      `${V1}/content/riders/photos?tag=sport-data-image%3Arider%3Amain&motogp_category=c1`,
      (c) => c.riderPhotos({ tag: 'sport-data-image:rider:main', categoryUuid: 'c1' }),
    ],
    [
      'riderPhotos (tag only)',
      `${V1}/content/riders/photos?tag=sport-data-image%3Arider%3Amain`,
      (c) => c.riderPhotos({ tag: 'sport-data-image:rider:main' }),
    ],
  ];

  it.each(rows)('%s', async (_, path, call) => {
    api.intercept({ path, method: 'GET' }).reply(200, { ok: path }, { headers: JSON_HEADERS });
    expect(await call(await clientWith(agent))).toEqual({ ok: path });
  });
});

describe('language, video auth and errors', () => {
  const PLAYER = `${PREFIX}/video-gateway/live/v2/mgp/prod/player-data?protocol=hls`;
  const cdn = { id: 'auto', label: 'Auto', feeds: [{ id: 'ipfmix', label: 'Commentary', type: 'SESSION', protocols: { hls: { url: 'u' } } }, { id: 'x', label: 'X', type: 'SESSION', protocols: {} }] };

  it('sends the language as accept-language', async () => {
    const { seen, reply } = captured();
    api.intercept({ path: `${PREFIX}/riders`, method: 'GET' }).reply(reply(200, []));
    await (await clientWith(agent, { language: 'es' })).riders();
    expect(seen[0]!.headers['accept-language']).toBe('es');
  });

  it('can send the access token to the player data as a Bearer token', async () => {
    const token = await signToken();
    const { seen, reply } = captured();
    api.intercept({ path: PLAYER, method: 'GET' }).reply(reply(200, { cdns: [] }));
    await (await clientWith(agent, { accessToken: token, videoAuth: 'bearer' })).playerData();
    expect(seen[0]!.headers).toMatchObject({ authorization: `Bearer ${token}`, 'x-dorna-preview': 'false' });
    expect(seen[0]!.headers).not.toHaveProperty('cookie');
  });

  it('lists the feeds of every CDN', async () => {
    api.intercept({ path: PLAYER, method: 'GET' }).reply(200, { cdns: [cdn] }, { headers: JSON_HEADERS });
    expect(await (await clientWith(agent, { accessToken: await signToken() })).feeds()).toEqual([
      { cdnId: 'auto', cdnLabel: 'Auto', feedId: 'ipfmix', feedLabel: 'Commentary', type: 'SESSION', hlsUrl: 'u' },
      { cdnId: 'auto', cdnLabel: 'Auto', feedId: 'x', feedLabel: 'X', type: 'SESSION', hlsUrl: null },
    ]);
  });

  it.each([
    [423, 'concurrentStreamLimit'],
    [403, 'sessionExpired'],
    [410, 'gone'],
  ] as const)('MotoGPError flags a %i from the player data', async (status, flag) => {
    api.intercept({ path: PLAYER, method: 'GET' }).reply(status, '{"data":{"details":{"user_ip":"1.2.3.4"}}}');
    const error = (await (await clientWith(agent, { accessToken: await signToken() })).playerData().catch((e: unknown) => e)) as MotoGPError;
    expect(error).toBeInstanceOf(MotoGPError);
    expect(error[flag]).toBe(true);
    for (const other of ['concurrentStreamLimit', 'sessionExpired', 'gone'] as const)
      if (other !== flag) expect(error[other]).toBe(false);
  });
});

describe('convenience: latestClassification', () => {
  const V1 = `${PREFIX}`;
  const NOW = Date.parse('2026-10-23T12:00:00Z');
  const season = { id: 's1', name: null, year: 2026, current: true };
  const ev = (id: string, end: string, status = 'FINISHED') => ({ id, date_end: end, status });
  const sessionRows = [
    { id: 'fp1', date: '2026-10-23T02:00:00Z' },
    { id: 'fp2', date: '2026-10-23T06:00:00Z' },
    { id: 'future', date: '2026-10-24T06:00:00Z' },
  ];
  const seasonsFor = (rows: unknown[]) => api.intercept({ path: `${V1}/results/seasons`, method: 'GET' }).reply(200, rows, { headers: JSON_HEADERS });
  const eventsFor = (finished: unknown[], upcoming: unknown[]) => {
    api.intercept({ path: `${V1}/results/events?seasonUuid=s1&isFinished=true`, method: 'GET' }).reply(200, finished, { headers: JSON_HEADERS });
    api.intercept({ path: `${V1}/results/events?seasonUuid=s1&isFinished=false`, method: 'GET' }).reply(200, upcoming, { headers: JSON_HEADERS });
  };
  const categoriesFor = (event: string, names: string[]) =>
    api.intercept({ path: `${V1}/results/categories?eventUuid=${event}`, method: 'GET' }).reply(200, names.map((name, i) => ({ id: `c${i}`, name })), { headers: JSON_HEADERS });
  const sessionsFor = (event: string, category: string, rows: unknown[]) =>
    api.intercept({ path: `${V1}/results/sessions?eventUuid=${event}&categoryUuid=${category}`, method: 'GET' }).reply(200, rows, { headers: JSON_HEADERS });
  const classificationFor = (session: string, rows: unknown[]) =>
    api.intercept({ path: `${PREFIX.replace('/v1', '')}/v2/results/classifications?session=${session}&test=false`, method: 'GET' }).reply(200, { classification: rows }, { headers: JSON_HEADERS });

  it('currentSeason() finds the season in progress, if any', async () => {
    seasonsFor([{ ...season, current: false }, season]);
    seasonsFor([{ ...season, current: false }]);
    const client = await clientWith(agent);
    expect(await client.currentSeason()).toEqual(season);
    expect(await client.currentSeason()).toBeUndefined();
  });

  it('prefers the event in progress and its newest session with results', async () => {
    seasonsFor([season]);
    eventsFor([ev('old', '2026-09-20')], [ev('now', '2026-10-25', 'CURRENT'), ev('later', '2026-11-08', 'NOT-STARTED')]);
    categoriesFor('now', ['Moto3™', 'MotoGP™']);
    sessionsFor('now', 'c1', sessionRows);
    classificationFor('fp2', [{ position: 1 }]);
    const result = await (await clientWith(agent)).latestClassification('motogp', NOW);
    expect(result).toMatchObject({ event: { id: 'now' }, category: { id: 'c1' }, session: { id: 'fp2' }, classification: { classification: [{ position: 1 }] } });
  });

  it('falls back to older sessions and then to finished events, newest first', async () => {
    seasonsFor([season]);
    eventsFor([ev('a', '2026-08-01'), ev('b', '2026-09-20')], [ev('now', '2026-10-25', 'CURRENT')]);
    categoriesFor('now', ['Moto2™']); // no MotoGP at the current event
    categoriesFor('b', ['MotoGP™']);
    sessionsFor('b', 'c0', sessionRows.slice(0, 2));
    classificationFor('fp2', []); // not classified yet
    classificationFor('fp1', [{ position: 1 }]);
    const result = await (await clientWith(agent)).latestClassification('MotoGP', NOW);
    expect(result?.event.id).toBe('b');
    expect(result?.session.id).toBe('fp1');
  });

  it('resolves to undefined without a season or without any results', async () => {
    seasonsFor([]);
    seasonsFor([season]);
    eventsFor([ev('a', '2026-08-01')], []);
    categoriesFor('a', ['MotoGP™']);
    sessionsFor('a', 'c0', [{ id: 'fp1', date: '2026-10-24T00:00:00Z' }]); // all in the future
    const client = await clientWith(agent);
    expect(await client.latestClassification('MotoGP', NOW)).toBeUndefined();
    expect(await client.latestClassification('MotoGP', NOW)).toBeUndefined();
  });

  it('uses the current time and MotoGP by default', async () => {
    seasonsFor([season]);
    eventsFor([], []);
    expect(await (await clientWith(agent)).latestClassification()).toBeUndefined();
  });
});

describe('sessionCheck', () => {
  it('sends the DAT cookie and reports status and parsed body', async () => {
    const { seen, reply } = captured();
    const token = await signToken();
    account.intercept({ path: '/auth/user/session/lite/', method: 'GET' }).reply(reply(200, { active: true }));
    account.intercept({ path: '/auth/user/session/lite/', method: 'GET' }).reply(403, '<html>no</html>');
    const client = await clientWith(agent, { accessToken: token });
    expect(await client.sessionCheck()).toEqual({ status: 200, body: { active: true } });
    expect(seen[0]!.headers.cookie).toBe(`DAT=${token}`);
    expect(await client.sessionCheck()).toEqual({ status: 403, body: '<html>no</html>' });
  });

  it('needs a signed-in account', async () => {
    await expect((await clientWith(agent)).sessionCheck()).rejects.toThrow(NotSignedInError);
  });
});
