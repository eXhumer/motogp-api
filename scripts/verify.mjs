#!/usr/bin/env node
// Checks the assumptions the client could not verify from the HAR captures and prints a matrix.
//
//   npm run build
//   MOTOGP_USERNAME=you@example.com MOTOGP_PASSWORD=… node scripts/verify.mjs [--login] [--user-agent "…"] [--json result.json]
//
// Without the env vars it asks on the terminal (the password is not echoed). Credentials are never
// written anywhere; only the tokens are, to .motogp-session.json (mode 600) so later runs and
// the other scripts can reuse the session. Pass --no-save to skip that.
//
// Checks (live ones are skipped unless a broadcast is on air):
//   1 login works from a non-browser client (Imperva/Incapsula)      4 bearer vs cookie for player-data
//   2 refresh token rotates and the new access token works          5 each CDN x feed resolves to a manifest
//   3 permissions / VideoPass / TimingPass                           6 the 360° feed
import { request } from 'undici';

import { dvrStart, MotoGPClient, parseMaster, parseMedia, pickRendition, withStart } from '../dist/index.mjs';
import { errorSummary, makeClient, parseArgs, prompt, saveSession, writeJson } from './lib.mjs';

const args = parseArgs();
const results = [];
const UA = typeof args['user-agent'] === 'string' ? args['user-agent'] : undefined;

async function check(id, title, fn) {
  let result;
  try {
    result = await fn();
  } catch (error) {
    result = { ok: false, note: errorSummary(error) };
  }
  const { ok, note = '', skipped } = result ?? { ok: true };
  const mark = skipped ? '–' : ok ? '✓' : '✗';
  results.push({ id, title, status: skipped ? 'skipped' : ok ? 'pass' : 'fail', note });
  console.log(`${mark} ${id}. ${title}${note ? `  — ${note}` : ''}`);
  return result;
}

const options = UA ? { headers: { 'user-agent': UA }, userAgent: UA } : {};
const saved = args['no-save'] ? undefined : saveSession;

// ---- 1. login --------------------------------------------------------------------------------------
let client;
const existing = !args.login && (process.env.MOTOGP_ACCESS_TOKEN || process.env.MOTOGP_REFRESH_TOKEN) ? await makeClient(args) : undefined;

const login = await check('1', 'Login from a non-browser client', async () => {
  if (existing?.loggedIn) return { ok: true, note: 'skipped: using the tokens from the environment', skipped: true };
  if (!process.stdin.isTTY && !(process.env.MOTOGP_USERNAME && process.env.MOTOGP_PASSWORD))
    return { ok: false, note: 'no terminal: set MOTOGP_USERNAME and MOTOGP_PASSWORD' };
  const username = process.env.MOTOGP_USERNAME ?? (await prompt('MotoGP e-mail: '));
  const password = process.env.MOTOGP_PASSWORD ?? (await prompt('Password: ', true));
  client = await MotoGPClient.create({ ...options, ...(saved && { onTokens: (t) => saved(t) }) });
  await client.login(username, password);
  return { ok: client.loggedIn, note: `signed in, access token expires ${new Date(client.accessTokenExpiry ?? 0).toISOString()}` };
});
client ??= existing;

if (!client?.loggedIn) {
  console.log('\nNot signed in: the remaining account checks cannot run.');
  console.log('If the failure above is HTTP 403 with an Incapsula/Imperva page, sign in a browser, copy the');
  console.log('`refresh_token` from the /login/token response and run with MOTOGP_REFRESH_TOKEN=… instead.');
} else {
  // ---- 2. refresh rotation ---------------------------------------------------------------------------
  await check('2', 'Refresh token rotates and still works', async () => {
    const before = client.refreshToken;
    await client.refresh();
    const rotated = client.refreshToken !== before;
    const me = await client.permissions();
    return { ok: Array.isArray(me), note: `refresh token ${rotated ? 'rotated' : 'NOT rotated'}, permissions call ${Array.isArray(me) ? 'ok' : 'failed'}` };
  });

  // ---- 3. licences -----------------------------------------------------------------------------------
  let videoPass = false;
  await check('3', 'Licences', async () => {
    const permissions = await client.permissions();
    videoPass = await client.hasLicence('VideoPass');
    const timing = await client.hasLicence('TimingPass');
    const names = permissions.map((p) => `${p.licence?.name}:${p.status}`).join(', ');
    return { ok: true, note: `VideoPass=${videoPass} TimingPass=${timing} [${names}]` };
  });

  // ---- 4-6. live video ---------------------------------------------------------------------------------
  const onAir = {};
  for (const feed of ['prod', '360']) onAir[feed] = await client.onAir(feed).catch(() => ({ on_air: false }));
  const live = onAir.prod?.on_air;
  const skip = (why) => ({ ok: true, skipped: true, note: why });

  await check('4', 'player-data: cookie vs bearer', async () => {
    if (!live) return skip('nothing on air (prod)');
    if (!videoPass) return skip('no VideoPass on this account');
    const tokens = { accessToken: client.accessToken, refreshToken: client.refreshToken };
    const notes = [];
    let ok = false;
    for (const videoAuth of ['cookie', 'bearer']) {
      const probe = await MotoGPClient.create({ ...options, ...tokens, videoAuth });
      try {
        const data = await probe.playerData('prod');
        notes.push(`${videoAuth}: ok (${data.cdns.length} CDNs)`);
        ok ||= true;
      } catch (error) {
        notes.push(`${videoAuth}: ${errorSummary(error)}`);
      }
      // the refresh token may have rotated inside the probe client
      if (probe.refreshToken) tokens.refreshToken = probe.refreshToken;
      if (probe.accessToken) tokens.accessToken = probe.accessToken;
    }
    return { ok, note: notes.join(' | ') };
  });

  const fetchWith = async (url, headers) => {
    const response = await request(url, { method: 'GET', headers });
    return { status: response.statusCode, text: await response.body.text() };
  };

  await check('5', 'Stream URL resolves through the client (DAT cookie)', async () => {
    if (!live) return skip('nothing on air (prod)');
    if (!videoPass) return skip('no VideoPass on this account');
    const feed = (await client.feeds('prod')).find((f) => f.hlsUrl);
    if (!feed) return { ok: false, note: 'no feed with an hls url' };
    const url = await client.resolveStreamUrl(feed.hlsUrl);
    return { ok: url.startsWith('https://'), note: `${new URL(url).host}${new URL(url).pathname.replace(/\/[0-9a-f]{20,}/g, '/…').slice(0, 60)}${new URL(url).search}` };
  });

  await check('5b', 'Every CDN x feed gives a playable manifest', async () => {
    if (!live) return skip('nothing on air (prod)');
    if (!videoPass) return skip('no VideoPass on this account');
    const feeds = await client.feeds('prod');
    const notes = [];
    let allOk = feeds.length > 0;
    for (const f of feeds) {
      if (!f.hlsUrl) {
        notes.push(`${f.cdnId}/${f.feedId}: no hls`);
        continue;
      }
      try {
        const url = await client.resolveStreamUrl(f.hlsUrl);
        const manifest = await fetchWith(url, { 'user-agent': UA ?? 'motogp-api', referer: 'https://www.motogp.com/' });
        const good = manifest.status === 200 && manifest.text.startsWith('#EXTM3U');
        allOk &&= good;
        notes.push(`${f.cdnId}/${f.feedId}: ${good ? `ok (${(manifest.text.match(/#EXT-X-STREAM-INF/g) ?? []).length} renditions)` : `manifest HTTP ${manifest.status}`}`);
      } catch (error) {
        allOk = false;
        notes.push(`${f.cdnId}/${f.feedId}: ${errorSummary(error)}`);
      }
    }
    return { ok: allOk, note: notes.join(' | ') };
  });

  await check('5c', 'HLS: master, rendition pick and DVR start', async () => {
    if (!live) return skip('nothing on air (prod)');
    if (!videoPass) return skip('no VideoPass on this account');
    const { dvr_range: range } = await client.playerData('prod');
    const masterUrl = await client.streamUrl('ipfmix', 'auto', 'prod');
    const headers = { 'user-agent': UA ?? 'motogp-api', referer: 'https://www.motogp.com/' };
    const notes = [];

    const wanted = dvrStart(range, 600);
    const shifted = withStart(masterUrl, wanted);
    const master = parseMaster((await fetchWith(shifted, headers)).text, shifted);
    const pick = pickRendition(master.renditions, { maxHeight: 720 });
    notes.push(`${master.renditions.length} renditions, ${master.audio.length} audio, picked ${pick?.height}p ${pick?.bandwidth}`);

    const media = parseMedia((await fetchWith(pick.url, headers)).text, pick.url);
    const first = media.segments[0]?.time;
    const offset = first === undefined ? undefined : Math.round(first / 1000 - wanted);
    notes.push(`${media.segments.length} segments, ${media.ended ? 'ended' : 'live'}, first segment ${offset}s from the requested start`);
    const segment = await request(media.segments[0].url, { method: 'GET', headers });
    await segment.body.dump();
    notes.push(`first segment HTTP ${segment.statusCode}`);

    return { ok: segment.statusCode === 200 && offset !== undefined && Math.abs(offset) < 30, note: notes.join(' | ') };
  });

  await check('5d', 'Session check (the player keep-alive)', async () => {
    const { status, body } = await client.sessionCheck();
    const text = typeof body === 'string' ? body.slice(0, 80).replace(/\s+/g, ' ') : JSON.stringify(body).slice(0, 120);
    // The player treats 403 as "kicked out" and 404 as "no session yet"; anything else keeps polling.
    return { ok: status === 200 || status === 404, note: `HTTP ${status} ${text}` };
  });

  await check('6', '360° feed', async () => {
    if (!onAir['360']?.on_air) return skip('360 feed not on air');
    if (!videoPass) return skip('no VideoPass on this account');
    const feeds = await client.feeds('360');
    return { ok: feeds.length > 0, note: feeds.map((f) => `${f.cdnId}/${f.feedId}`).join(', ') };
  });
}

const failed = results.filter((r) => r.status === 'fail').length;
console.log(`\n${results.filter((r) => r.status === 'pass').length} passed, ${failed} failed, ${results.filter((r) => r.status === 'skipped').length} skipped`);
if (typeof args.json === 'string') await writeJson(args.json, results);
process.exitCode = failed ? 1 : 0;
