import { MotoGPAuth } from '@exhumer/motogp-auth';

import { Dispatcher, getGlobalDispatcher, request } from 'undici';

import type * as Schema from './schema';
import { MotoGP } from './type';
import { name, repository, version } from '../package.json';

/** `undefined` values are left out of the query string. */
type Query = Record<string, string | number | boolean | undefined>;

/** The token endpoint, the licence list and the stream URL resolver. */
export const ACCOUNT_URL = 'https://api.motogp.com';
/** Everything else the web app reads: timing, sessions, results, riders and the video gateway. */
export const API_URL = 'https://api.pulselive.motogp.com/motogp/v1';

const SITE_URL = 'https://www.motogp.com';

/** A request the motogp.com servers refused. `body` is the raw answer. */
export class MotoGPError extends Error {
  override readonly name = 'MotoGPError';

  constructor(
    readonly statusCode: number,
    readonly body: string,
    readonly url: string,
  ) {
    super(`MotoGP request failed (HTTP ${statusCode}): ${url}`);
  }

  /**
   * 423 from `playerData()`: the account is already streaming on as many devices as the Video Pass
   * allows. The body is `{ data: { details: { user_ip } } }`, which the web app shows on its wall.
   */
  get concurrentStreamLimit() {
    return this.statusCode === 423;
  }

  /** 403 from `playerData()`: the web app tells the user their session expired. */
  get sessionExpired() {
    return this.statusCode === 403;
  }

  /** 410 from `playerData()`: the broadcast is gone. */
  get gone() {
    return this.statusCode === 410;
  }
}

export type MotoGPClientOptions = {
  /**
   * A session to share, e.g. with `@exhumer/motogp-live-timing`. When given, `accessToken`,
   * `refreshToken` and `onTokens` are ignored.
   */
  auth?: MotoGPAuth;
  /** The `DAT` cookie or `access_token`. */
  accessToken?: string | null;
  /** The `DRT` cookie or `refresh_token`. Used to renew an expired access token. */
  refreshToken?: string | null;
  /** Called after every sign-in and refresh. Refresh tokens rotate, so store the new one here. */
  onTokens?: (tokens: MotoGP.TokenResponse) => void | Promise<void>;
  dispatcher?: Dispatcher;
  userAgent?: string;
  /** Sent as `accept-language`; the rider endpoints translate with it. Default `en`. */
  language?: string;
  /**
   * How `playerData()` sends the account. `cookie` (default) is what the web page does and what the
   * captures show. `bearer` is the player's other path: `Authorization: Bearer` plus
   * `x-dorna-preview: false`. Not checked against the server.
   */
  videoAuth?: 'cookie' | 'bearer';
  /**
   * Extra headers for every request, e.g. a browser `user-agent` if the login endpoint
   * (behind Imperva) challenges the default one.
   */
  headers?: Record<string, string>;
};

export class MotoGPClient {
  private _auth: MotoGPAuth;
  private _dispatcher: Dispatcher;
  private _headers: Record<string, string>;
  private _language: string;
  private _videoAuth: 'cookie' | 'bearer';
  private _user_agent: string;

  private constructor(
    auth: MotoGPAuth,
    {
      dispatcher,
      userAgent,
      headers = {},
      language = 'en',
      videoAuth = 'cookie',
    }: MotoGPClientOptions & { dispatcher: Dispatcher; userAgent: string },
  ) {
    this._auth = auth;
    this._language = language;
    this._videoAuth = videoAuth;
    this._dispatcher = dispatcher;
    this._headers = headers;
    this._user_agent = userAgent;
  }

  /**
   * Creates a client. With an `accessToken` it is used as is; if it has expired (or is missing) and
   * a `refreshToken` is given, a new one is fetched. Rejects on a malformed or expired token that
   * can't be renewed.
   */
  static async create(options: MotoGPClientOptions = {}) {
    const dispatcher = options.dispatcher ?? getGlobalDispatcher();
    const userAgent = options.userAgent ?? `${name}/${version} (${repository.url})`;
    const auth =
      options.auth ??
      (await MotoGPAuth.create({
        accessToken: options.accessToken || undefined,
        refreshToken: options.refreshToken || undefined,
        onTokens: options.onTokens,
        dispatcher,
        headers: { 'user-agent': userAgent, ...options.headers },
      }));

    return new MotoGPClient(auth, { ...options, dispatcher, userAgent });
  }

  /** The account session: tokens, refresh and licences. Share it with other MotoGP clients. */
  public get auth() {
    return this._auth;
  }

  public get accessToken() {
    return this._auth.accessToken;
  }

  public get refreshToken() {
    return this._auth.refreshToken;
  }

  public get claims() {
    return this._auth.claims;
  }

  /** UTC epoch milliseconds, or `null` when signed out. */
  public get accessTokenExpiry() {
    return this._auth.expiresAt;
  }

  public get loggedIn() {
    return this._auth.signedIn;
  }

  /** Signs in with the account's email and password, the way the motogp.com login page does. */
  public login = (username: string, password: string) => this._auth.login(username, password);

  /**
   * Exchanges the refresh token for a new access token. Refresh tokens rotate, so store the new
   * {@link MotoGPClient.refreshToken} afterwards. Rejects when the token is unknown or used up.
   */
  public refresh = () => this._auth.refresh();

  public logout = () => this._auth.logout();

  /** All seasons, newest first. */
  public seasons = () => this.get<MotoGP.Season[]>('/results/seasons');

  public riders = () => this.get<MotoGP.Rider[]>('/riders');

  public rider = (riderId: string) => this.get<MotoGP.Rider>(`/riders/${encodeURIComponent(riderId)}`);

  public event = (eventId: string) => this.get<MotoGP.Event>(`/events/${encodeURIComponent(eventId)}`);

  /** The running session, or the next one when none is. */
  public nextSession = (live = true) => this.get<MotoGP.NextSession>('/sessions/next', { live });

  /** Classification of the session on track. The web app polls it every 30 seconds. */
  public liveTiming = () =>
    this.get<MotoGP.LiveTiming<MotoGP.LiveTimingRider>>('/timing-gateway/livetiming-lite');

  /** Championship standing in the category of the session on track. */
  public liveStanding = () =>
    this.get<MotoGP.LiveTiming<MotoGP.LiveStandingRider>>('/timing-gateway/live-standing');

  public ridersPlacement = (circuitUuid: string, categoryName: MotoGP.CategoryName) =>
    this.get<Schema.RidersPlacement>('/results/riders-placement', { circuitUuid, categoryName });

  public ridersPoles = (circuitUuid: string, categoryName: MotoGP.CategoryName) =>
    this.get<MotoGP.Paginated<{ times: number; rider: Record<string, unknown> }>>(
      '/results/riders-poles',
      { circuitUuid, categoryName },
    );

  public circuitRecords = (circuitUuid: string) =>
    this.get<{ circuit: Record<string, unknown>; records: Record<string, Record<string, unknown>> }>(
      `/results/circuit/${encodeURIComponent(circuitUuid)}/records`,
    );

  public riderComparison = (season: number, riderId1: string, riderId2: string) =>
    this.get<Record<string, unknown>>('/sportsdata-gateway/riders/pulse/statistics/comparison', {
      season,
      rider_id1: riderId1,
      rider_id2: riderId2,
    });

  // The endpoints below are the rest of what the web app's API layer calls. Their answers were
  // not in the captures, so they are not typed yet.

  /** `/events?seasonYear=…`; `params` adds more filters. */
  public events = (seasonYear: number, params: Query = {}) => this.get<Schema.EventList>('/events', { seasonYear, ...params });

  public categories = (seasonYear: number) => this.get<Schema.CategoryList>('/categories', { seasonYear });

  public teams = (categoryUuid: string, seasonYear: number) =>
    this.get<Schema.Teams>('/teams', { categoryUuid, seasonYear });

  /** Rider summary stats, by the rider's `legacy_id`. */
  public riderStatsSummary = (riderLegacyId: number) => this.get<Schema.RiderStatsSummary>(`/riders/${riderLegacyId}/stats`);

  public riderLegacyStatistics = (riderLegacyId: number) =>
    this.get<Schema.RiderLegacyStatistics>(`/riders/${riderLegacyId}/statistics`);

  /** Events of a season, `isFinished` picks finished or upcoming ones. */
  public resultsEvents = (seasonUuid: string, isFinished: boolean) =>
    this.get<Schema.ResultsEvents>('/results/events', { seasonUuid, isFinished });

  /** Categories of a season and/or an event. */
  public resultsCategories = (filter: { seasonUuid?: string; eventUuid?: string }) =>
    this.get<Schema.ResultsCategories>('/results/categories', filter);

  /** The sessions of an event in a category; their `id` goes to {@link MotoGPClient.classification}. */
  public resultsSessions = (eventUuid: string, categoryUuid: string) =>
    this.get<Schema.ResultsSessions>('/results/sessions', { eventUuid, categoryUuid });

  /** Final classification of a session (`/v2`). `test` is for test sessions. */
  public classification = (sessionUuid: string, test = false) =>
    this.get<Schema.Classification>('/results/classifications', { session: sessionUuid, test }, null, 'v2');

  /** The season in progress, if the calendar has one. */
  public currentSeason = async () => (await this.seasons()).find((season) => season.current);

  /**
   * The most recent session of a category that has a classification, looking first at the event in
   * progress and then at finished ones, newest first. `category` is matched on the name without the
   * trade mark sign (`MotoGP`, `Moto2`, `Moto3`). Resolves to `undefined` when nothing has results yet.
   */
  public latestClassification = async (category = 'MotoGP', now = Date.now()) => {
    const season = await this.currentSeason();
    if (!season) return undefined;

    const [finished, upcoming] = await Promise.all([this.resultsEvents(season.id, true), this.resultsEvents(season.id, false)]);
    const events = [
      ...upcoming.filter((event) => event.status === 'CURRENT'),
      ...[...finished].sort((a, b) => b.date_end.localeCompare(a.date_end)),
    ];
    const plain = (text: string) => text.replace(/[^a-z0-9]/gi, '').toLowerCase();

    for (const event of events) {
      const found = (await this.resultsCategories({ eventUuid: event.id })).find((c) => plain(c.name) === plain(category));
      if (!found) continue;

      const sessions = (await this.resultsSessions(event.id, found.id))
        .filter((session) => Date.parse(session.date) <= now)
        .sort((a, b) => b.date.localeCompare(a.date));

      for (const session of sessions) {
        const classification = await this.classification(session.id);
        if (classification.classification.length) return { event, category: found, session, classification };
      }
    }

    return undefined;
  };

  public standings = (seasonUuid: string, categoryUuid: string) =>
    this.get<Schema.Standings>('/results/standings', { seasonUuid, categoryUuid });

  public standingsFiles = (seasonUuid: string, categoryUuid: string) =>
    this.get<Schema.StandingsFiles>('/results/standings/files', { seasonUuid, categoryUuid });

  /** World standings (`/v2`); the web app passes its own filters. */
  /** `category` is a results category UUID (`resultsCategories()`); `type` is required (upper or lower case). */
  public worldStandings = (params: { category: string; type: 'RIDER' | 'TEAM' | 'CONSTRUCTOR'; season_year?: number }) =>
    this.get<Schema.WorldStandings>('/results/world-standings', params, null, 'v2');

  public bmwAward = (seasonYear: number) => this.get<Schema.BmwAward>('/results/bmw-award', { season_year: seasonYear }, null, 'v2');

  public startingGrid = (eventUuid: string, categoryUuid: string) =>
    this.get<unknown>(`/results/event/${encodeURIComponent(eventUuid)}/category/${encodeURIComponent(categoryUuid)}/grid`);

  /** Entry list of an event's category (`/v2`). */
  public entryList = (eventId: string, categoryId: string) =>
    this.get<Schema.EntryList>('/results/entries', { categoryId, eventId }, null, 'v2');

  /** Downloadable result files (PDFs) of an event's category. */
  public championshipFiles = (eventUuid: string, categoryUuid: string) =>
    this.get<Schema.ChampionshipFiles>(`/results/event/${encodeURIComponent(eventUuid)}/category/${encodeURIComponent(categoryUuid)}/files`);

  /**
   * The last finished session of a kind. Verified values: `eventType: 'SPORT'`, `broadcastType: 'SESSION'`,
   * `eventKind: 'GP'`, and `category` the integer legacy id (3 = MotoGP, 2 = Moto2, 1 = Moto3).
   * Other values are rejected ("type not found") or blocked by the WAF.
   */
  public lastSession = (filter: { eventType: string; broadcastType: string; eventKind?: string; category?: string | number }) =>
    this.get<Schema.LastSession>('/sessions/last', {
      'event-type': filter.eventType,
      'broadcast-type': filter.broadcastType,
      'event-kind': filter.eventKind,
      category: filter.category,
    });

  /** Rider statistics table `statistics/{accessor}` of the sports data gateway. Verified accessor: `world-champions`. */
  public statisticsBy = (accessor: string, filter: { season: number; category: string; limit?: number }) =>
    this.get<unknown>(`/sportsdata-gateway/riders/pulse/statistics/${encodeURIComponent(accessor)}`, {
      ...filter,
      limit: filter.limit ?? 100,
    });

  /** Rider table `pulse/{accessor}` of the sports data gateway. Verified accessors: `podiums`, `poles`, `fastest-laps`. */
  public pulseBy = (accessor: string, filter: { season: number; category: string; limit?: number }) =>
    this.get<unknown>(`/sportsdata-gateway/riders/pulse/${encodeURIComponent(accessor)}`, {
      ...filter,
      limit: filter.limit ?? 100,
    });

  /** `category` is required by the server (`motogp`, `moto2`, ... as the stats gateway names them). */
  public worldChampions = (filter: { category: string; limit?: number }) =>
    this.get<Schema.WorldChampions>('/sportsdata-gateway/riders/pulse/statistics/world-champions', filter);

  /** Season and career statistics of a rider (by the rider's UUID). */
  public riderCareer = (riderId: string, showCareer = true) =>
    this.get<Schema.RiderCareer>('/sportsdata-gateway/riders/pulse/statistics', {
      rider_id: riderId,
      show_career: showCareer ? 'true' : undefined,
    });

  public riderInfo = (riderId: string) =>
    this.get<Schema.RiderInfo>(`/sportsdata-gateway/riders/pulse/rider/${encodeURIComponent(riderId)}`);

  public riderEventStats = (riderId: string) =>
    this.get<Schema.RiderEventStats>('/sportsdata-gateway/riders/pulse/event-stats', { rider_id: riderId });

  /** An event by season and short name (`AUS`). */
  public pulseEvent = (season: number, shortname: string) =>
    this.get<unknown>('/sportsdata-gateway/events/pulse/event', { season, shortname });

  /** Starting grid from the sports data gateway; `category` is the name without `™` (`MotoGP`). */
  public pulseGrid = (season: number, shortname: string, category: string) =>
    this.get<unknown>('/sportsdata-gateway/events/pulse/grid', { season, shortname, category });

  /** Rider photos by tag (`sport-data-image:rider:main`), optionally for one category. */
  public riderPhotos = (filter: { tag: string; categoryUuid?: string }) =>
    this.get<Schema.RiderPhotos>('/content/riders/photos', { tag: filter.tag, motogp_category: filter.categoryUuid });

  /** Whether a broadcast is live and what it takes to watch it. Public. */
  public onAir = (feed: MotoGP.VideoFeed = 'prod') =>
    this.get<MotoGP.OnAir>(`/video-gateway/live/v2/mgp/${feed}/on-air`);

  /**
   * The CDNs and feeds of the live broadcast. Needs a signed-in account (the `DAT` cookie);
   * the answer is cached for 30 seconds.
   */
  public playerData = async (feed: MotoGP.VideoFeed = 'prod', protocol = 'hls') =>
    this.get<MotoGP.PlayerData>(`/video-gateway/live/v2/mgp/${feed}/player-data`, { protocol }, this._videoAuth);

  /**
   * Every feed of every CDN of the live broadcast: the valid `cdnId` / `feedId` pairs for
   * {@link MotoGPClient.streamUrl}. Needs a signed-in account.
   */
  public feeds = async (video: MotoGP.VideoFeed = 'prod'): Promise<MotoGP.StreamFeed[]> =>
    (await this.playerData(video)).cdns.flatMap((cdn) =>
      cdn.feeds.map((feed) => ({
        cdnId: cdn.id,
        cdnLabel: cdn.label,
        feedId: feed.id,
        feedLabel: feed.label,
        type: feed.type,
        hlsUrl: feed.protocols.hls?.url ?? null,
      })),
    );

  /**
   * Turns a feed's `protocols.hls.url` into the signed master playlist URL. The endpoint sits behind the
   * WAF, which only lets the request through with the account's `DAT` cookie; it answers with a redirect
   * to the playlist (the `start=` query is the DVR position), or in older captures with the URL as text.
   */
  public resolveStreamUrl = async (feedUrl: string) => {
    const url = new URL(feedUrl);
    if (url.origin !== ACCOUNT_URL) throw new Error(`Not a MotoGP stream URL: ${feedUrl}`);

    const res = await this.requestUA(feedUrl, {
      headers: { origin: SITE_URL, referer: `${SITE_URL}/`, accept: '*/*', cookie: await this._auth.cookie() },
    });
    const text = await res.body.text();
    const location = res.headers['location'];

    if (res.statusCode >= 300 && res.statusCode < 400 && typeof location === 'string')
      return new URL(location, feedUrl).toString();
    if (res.statusCode >= 400) throw new MotoGPError(res.statusCode, text, feedUrl);

    return text.trim();
  };

  /**
   * Convenience: the signed master playlist URL of a feed (`ipfmix` is the commentary feed)
   * on a CDN (`auto` by default).
   */
  public streamUrl = async (feedId = 'ipfmix', cdnId = 'auto', video: MotoGP.VideoFeed = 'prod') => {
    const { cdns } = await this.playerData(video);
    const feed = cdns.find((cdn) => cdn.id === cdnId)?.feeds.find((f) => f.id === feedId);

    if (!feed?.protocols.hls) throw new Error(`No HLS feed "${feedId}" on CDN "${cdnId}"`);

    return this.resolveStreamUrl(feed.protocols.hls.url);
  };

  /**
   * The player's session check (`/auth/user/session/lite/`, repeated every 5 minutes by the web player): the
   * status says whether this account's stream session is still valid. The player treats 403 as "kicked
   * out" (another stream took over) and 404 as "no session yet". Needs a signed-in account; never throws
   * for an HTTP error status.
   */
  public sessionCheck = async () => {
    const res = await this.requestUA(`${ACCOUNT_URL}/auth/user/session/lite/`, {
      headers: { origin: SITE_URL, referer: `${SITE_URL}/`, accept: 'application/json', cookie: await this._auth.cookie() },
    });
    const text = await res.body.text();
    let body: unknown = text;

    try {
      body = JSON.parse(text);
    } catch {
      // not JSON (an empty body, an HTML block page): keep the text
    }

    return { status: res.statusCode, body };
  };

  /** The account's licences (Video Pass, Timing Pass, ...). Needs a signed-in account. */
  public permissions = () => this._auth.permissions();

  /** Whether the account has a licence called `name` (e.g. `VideoPass`) that is active and has not ended. */
  public hasLicence = (licenceName: string, now?: number) => this._auth.hasLicence(licenceName, now);

  private async get<T>(path: string, query: Query = {}, auth: 'cookie' | 'bearer' | null = null, version = 'v1') {
    const url = new URL(`${API_URL.replace(/v1$/, version)}${path}`);

    for (const [key, value] of Object.entries(query))
      if (value !== undefined) url.searchParams.set(key, String(value));

    return JSON.parse(
      await this.getText(
        url.toString(),
        {
          accept: 'application/json',
          'accept-language': this._language,
          'x-client': 'FE',
          ...(auth === 'bearer' && { 'x-dorna-preview': 'false' }),
        },
        auth,
      ),
    ) as T;
  }

  /**
   * GET returning the body text. `auth` picks how the signed-in account is sent: the video gateway
   * reads the `DAT` cookie, the licence list takes a Bearer token.
   */
  private async getText(url: string, headers: Record<string, string>, auth: 'cookie' | 'bearer' | null) {
    const credentials: Record<string, string> = {};

    if (auth === 'cookie') credentials['cookie'] = await this._auth.cookie();
    else if (auth === 'bearer') credentials['authorization'] = await this._auth.bearer();

    const res = await this.requestUA(url, {
      headers: { origin: SITE_URL, referer: `${SITE_URL}/`, ...headers, ...credentials },
    });
    const text = await res.body.text();

    if (res.statusCode >= 400) throw new MotoGPError(res.statusCode, text, url);

    return text;
  }

  private requestUA(url: string, options: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string }) {
    return request(url, {
      dispatcher: this._dispatcher,
      method: 'GET',
      ...options,
      headers: { 'user-agent': this._user_agent, ...this._headers, ...options.headers },
    });
  }
}
