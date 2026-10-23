# motogp-api

[![CI](https://github.com/eXhumer/motogp-api/actions/workflows/ci.yml/badge.svg)](https://github.com/eXhumer/motogp-api/actions/workflows/ci.yml)
[![Coverage](https://codecov.io/gh/eXhumer/motogp-api/branch/main/graph/badge.svg)](https://codecov.io/gh/eXhumer/motogp-api)
[![npm](https://img.shields.io/npm/v/@exhumer/motogp-api)](https://www.npmjs.com/package/@exhumer/motogp-api)

Unofficial MotoGP API client for JavaScript/TypeScript: sign-in, live timing snapshots, sessions, results and live video streams.

> **Status: early.** Written from browser captures of motogp.com and checked against the live API during the
> 2026 Australian GP (a Moto3 practice session). Race and qualifying behaviour has not been checked yet.

**This package is unofficial and is not associated in any way with MotoGP Sports Entertainment Group (formerly Dorna Sports) or the FIM. MotoGP, Moto2, Moto3 and related marks are trade marks of their owners.**

This package covers the REST side the website uses: accounts, the schedule, results, riders, the polled timing
snapshots and the video gateway. For the live Socket.IO feed, replays and recordings, see
[`@exhumer/motogp-live-timing`](https://github.com/eXhumer/motogp-live-timing). Sign-in and token refresh come from
[`@exhumer/motogp-auth`](https://github.com/eXhumer/motogp-auth), which both packages share.

## Installation
To install this package from npm registry:
  ```bash
  npm install @exhumer/motogp-api
  ```

To install this package from Git:
  ```bash
  npm install git+https://github.com/eXhumer/motogp-api.git
  ```

Node.js 22.19 or later. The package ships ESM and CJS builds with type declarations.

## Usage
```ts
import { MotoGPClient } from '@exhumer/motogp-api';

// Everything under "Public data" and "Results" works signed out.
const motogp = await MotoGPClient.create({
  // accessToken: the DAT cookie of a signed-in browser (or access_token from login())
  // refreshToken: the DRT cookie. Renews the access token whenever it is due.
  // onTokens: (tokens) => save(tokens.refresh_token)   // refresh tokens rotate!
  // auth: a MotoGPAuth session to share (then the three options above are ignored)
  // language: accept-language for translated rider data (default 'en')
  // dispatcher: an undici Dispatcher (default: the global dispatcher)
  // userAgent: custom User-Agent header
  // headers: extra headers for every request
});

// Or sign in with the account's email and password.
await motogp.login(email, password);
```

The access token is renewed before it expires. Refresh tokens rotate: every refresh returns a new one, so store it
from `onTokens` (or read `motogp.refreshToken` afterwards).

A plain client was not challenged when signing in. If Imperva (in front of the login endpoint) ever challenges yours,
pass a browser `user-agent` through `headers`, or start from the `DAT` and `DRT` cookies of a signed-in browser.

`motogp.auth` is the underlying [`MotoGPAuth`](https://github.com/eXhumer/motogp-auth) session. Pass it as `auth` to
another client, or hand `await motogp.auth.token()` to `@exhumer/motogp-live-timing`, so one account session is
shared.

### Public data
```ts
await motogp.nextSession();   // running session, else the next one (with all sessions of the event)
await motogp.liveTiming();    // classification of the session on track: best/last lap, gaps, pit status
await motogp.liveStanding();  // championship standing of that category
await motogp.onAir();         // { on_air, access_type }; onAir('360') for the 360° feed

await motogp.seasons();
await motogp.currentSeason();
await motogp.riders();
await motogp.rider(riderId);
await motogp.riderInfo(riderId);
await motogp.riderCareer(riderId);
await motogp.event(eventId);
await motogp.events(2026);
await motogp.teams(categoryUuid, 2026);
await motogp.ridersPlacement(circuitUuid, 'motogp');
await motogp.circuitRecords(circuitUuid);
await motogp.riderComparison(2026, riderId1, riderId2);
```

The web app polls both timing feeds every 30 seconds and the data only changes every 30 to 60 seconds, so polling
faster only returns cached answers.

### Results
```ts
// The newest session of a category that has a classification (current event first, then finished ones).
const latest = await motogp.latestClassification('MotoGP'); // { event, category, session, classification }

// Or step through it yourself with the /results UUIDs.
const season = await motogp.currentSeason();
const events = await motogp.resultsEvents(season!.id, true);              // finished events
const categories = await motogp.resultsCategories({ eventUuid: events[0].id });
const sessions = await motogp.resultsSessions(events[0].id, categories[0].id);
await motogp.classification(sessions[0].id);

await motogp.standings(season!.id, categories[0].id);
await motogp.worldStandings({ category: categories[0].id, type: 'RIDER', season_year: 2026 });
await motogp.entryList(events[0].id, categories[0].id);
await motogp.championshipFiles(events[0].id, categories[0].id);           // result PDFs
```

Most answers are typed from real responses; the types are exported as `Schema` (e.g. `Schema.Classification`).
Still `unknown`: `startingGrid`, `pulseEvent`, `pulseGrid`, `statisticsBy` and `pulseBy`.

### Video Pass
```ts
await motogp.hasLicence('VideoPass'); // active and not ended
const { cdns, dvr_range } = await motogp.playerData(); // needs a signed-in account

// Valid cdnId / feedId pairs, e.g. { cdnId: 'auto', feedId: 'ipfmix', feedLabel: 'Commentary', ... }
const feeds = await motogp.feeds();

// Signed master playlist for the commentary feed (`ipfmix`; `ipfamb` is the ambient one) on the auto CDN.
const m3u8 = await motogp.streamUrl('ipfmix', 'auto');
```

`playerData()` can fail with a `MotoGPError` whose `concurrentStreamLimit` (423), `sessionExpired` (403) or `gone` (410)
flag is set. `sessionCheck()` is the web player's 5-minute check: its `status` is 403 once another stream has taken
over. Pass `videoAuth: 'bearer'` to send the token as `Authorization: Bearer` instead of the `DAT` cookie (the
player's other path).

The stream is plain HLS (fMP4 segments, 6 seconds each, five renditions up to 1080p), with no DRM. The playlist URL is
signed (it carries a timestamp), so resolve it again instead of storing it.

### HLS helpers
```ts
import { dvrStart, parseMaster, parseMedia, pickRendition, withStart } from '@exhumer/motogp-api';

const master = parseMaster(await (await fetch(m3u8)).text(), m3u8);
const rendition = pickRendition(master.renditions, { maxHeight: 720 });
const media = parseMedia(await (await fetch(rendition!.url)).text(), rendition!.url);

// Start 10 minutes behind the live edge.
const rewound = withStart(m3u8, dvrStart(dvr_range, 600));
```

### Errors
| Error | When |
| --- | --- |
| `MotoGPError` | An API request failed; carries `statusCode`, `body` and `url` |
| `LoginError` | The account refused a login or refresh (e.g. `invalid_grant`) |
| `PermissionsError` | The licence list refused the token |
| `NotSignedInError` | A call needs an account but the client is signed out |

## Development
```bash
npm install
npm run typecheck
npm run build
npm test
```

The scripts in `scripts/` run against the real API and need `npm run build` first:

| Script | What it does |
| --- | --- |
| `npm run verify` | Signs in and checks login, refresh, licences and every stream feed; `--login` saves the session to `.motogp-session.json` |
| `npm run probe` | Calls every endpoint and saves redacted samples to `probe-out/` |
| `npm run gen-schema` | Regenerates `src/schema.ts` from `probe-out/` |
| `npm run make-fixtures` | Regenerates `tests/fixtures/` from `probe-out/`, with every value replaced by fake data |
| `npm run contract` | Compares the shape of live public answers with the fixtures |
| `npm run record-live` | Records the timing feeds of a live session to `live-recording.ndjson` |

`.motogp-session.json` holds your tokens. Don't commit it, `probe-out/` or recordings.

## License

MIT
