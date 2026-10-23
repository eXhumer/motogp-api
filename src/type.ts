/**
 * Shapes of the motogp.com responses, as seen in browser captures of the web
 * app. Fields the app doesn't read are left out or typed loosely.
 */
export namespace MotoGP {
  /** Category names the results endpoints accept (`categoryName`). */
  export type CategoryName = 'motogp' | 'moto2' | 'moto3' | 'motoe';

  /** Feed of the video gateway: the main broadcast or the 360° one. */
  export type VideoFeed = 'prod' | '360';

  /**
   * `session_status_id` of the timing feeds: `N` before the session, `S` running, `I` interrupted
   * (red flag; `remaining` stops), `R` running again after a red flag, `C` from the chequered flag
   * until the results are final, `F` finished. A red-flagged session goes `S → I → R → C → F`.
   */
  export type TimingSessionStatus = 'N' | 'S' | 'I' | 'R' | 'C' | 'F';

  /** `status.value` of a {@link Broadcast}. */
  export type BroadcastStatus = 'NOT-STARTED' | 'LIVE' | 'FINISHED' | 'CURRENT';

  /** What a video needs: `pay` is the Video Pass, `registered` any account, `free` nothing. */
  export type VideoAccess = 'premium' | 'registered' | 'free' | 'pay';

  /** Licence names the web app checks (`pro` is a tier, not a `Permission`). */
  export type LicenceName = 'VideoPass' | 'TimingPass' | 'pro' | 'registered';

  /** One feed of one CDN, flattened from {@link PlayerData}. */
  export interface StreamFeed {
    cdnId: string;
    cdnLabel: string;
    feedId: string;
    feedLabel: string;
    type: string;
    /** The feed's `protocols.hls.url`, if it has one: pass it to `resolveStreamUrl()`. */
    hlsUrl: string | null;
  }

  /** Response of `POST /login/token` for both the password and refresh token grants. */
  export type TokenResponse = import('@exhumer/motogp-auth').TokenResponse;

  /** Claims of the access token (`DAT`). */
  export type AccessTokenClaims = import('@exhumer/motogp-auth').TokenClaims;

  /** One licence held by the account (`GET /perms/me?active=true`). */
  export type Permission = import('@exhumer/motogp-auth').Permission;

  export interface Season {
    id: string;
    name: string | null;
    year: number;
    current: boolean;
  }

  export interface Country {
    iso: string;
    name: string;
    flag: string;
  }

  /** One entry of `GET /riders`. */
  export interface Rider {
    id: string;
    legacy_id: number;
    name: string;
    surname: string;
    nickname: string | null;
    country: Country;
    birth_city: string;
    birth_country: string;
    /** `YYYY-MM-DD`. */
    birth_date: string;
    years_old: number;
    start_year: number;
    retired: boolean;
    retired_year: number | null;
    published: boolean;
    current_career_step: {
      id: string;
      season: number;
      number: number;
      sponsored_team: string;
      in_grid: boolean;
      short_nickname: string;
      current: boolean;
      type: string;
      team: Record<string, unknown>;
      category: Record<string, unknown>;
      pictures: Record<string, unknown>;
    } | null;
    [key: string]: unknown;
  }

  /** `GET /events/{id}`. */
  export interface Event {
    country: string;
    type: string;
    circuit: {
      id: string;
      name: string;
      iso_code: string;
      country: string;
      lat: string;
      lng: string;
      /** The circuit's id in the timing feeds (`circuit_id` of {@link TimingHead}). */
      timing_id: number;
      [key: string]: unknown;
    };
    event_categories: {
      category_id: string;
      category_timing_id: number;
      timing_id: number;
      extra_timing_id: number | null;
      sequence: number;
      num_laps: number | null;
      sprint_num_laps: number | null;
      [key: string]: unknown;
    }[];
    [key: string]: unknown;
  }

  /** A session of an event: practice, qualifying, sprint, race, ... */
  export interface Broadcast {
    id: string;
    name: { value: string };
    /** `FP1`, `Q1`, `SPR`, `RAC`, ... */
    shortname: { value: string };
    /** `CURRENT`, `NOT-STARTED`, `FINISHED`, ... */
    status: { value: string };
    type: { value: string };
    /** `PRACTICE`, `QUALIFYING`, `RACE`, ... */
    kind: { value: string };
    has_results: boolean;
    has_report: boolean;
    has_timing: boolean;
    has_on_demand: boolean;
    has_live: boolean;
    num_laps: number;
    /** The session id in the timing feeds. */
    timing_id: { value: number };
    show_in_ott: boolean;
    show_in_calendar: boolean;
    /** ISO times. */
    date_start: string;
    date_end: string;
    [key: string]: unknown;
  }

  /** `GET /sessions/next?live=true`: the running session, or else the next one. */
  export interface NextSession {
    broadcast: Broadcast & {
      event_category: {
        id: string;
        broadcasts: Broadcast[];
        event: Record<string, unknown>;
        category: Record<string, unknown>;
        [key: string]: unknown;
      };
    };
    id: string;
    type: string;
    gp_day: number;
    has_timing: boolean;
    has_live: boolean;
    has_on_demand: boolean;
    show_in_ott: boolean;
    event: {
      id: string;
      name: string;
      shortname: string;
      country: string;
      timing_id: number;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  }

  /** Session metadata shared by both timing feeds. */
  export interface TimingHead {
    championship_id: string;
    /** `MotoGP`, `Moto2`, `Moto3`. */
    category: string;
    circuit_id: string;
    circuit_name: string;
    global_event_id: string;
    event_id: string;
    event_tv_name: string;
    event_shortname: string;
    /** `DD/MM/YYYY`. */
    date: string;
    datet: number;
    datst: number;
    num_laps: number;
    gmt: string;
    trsid: number;
    session_id: string;
    session_type: number;
    session_name: string;
    session_shortname: string;
    /** Milliseconds. */
    duration: string;
    /** Seconds left; the feed moves in steps of about a minute. */
    remaining: string;
    /** See {@link TimingSessionStatus}. `session_status_name` repeats the same letter. */
    session_status_id: string;
    session_status_name: string;
    date_formated: string;
    url: string | null;
  }

  interface TimingRiderBase {
    rider_id: number;
    rider_number: string;
    /** Team colour, hex without `#`. */
    color: string;
    text_color: string;
    pos: number;
    rider_shortname: string;
    rider_name: string;
    rider_surname: string;
    /** Three-letter code: `SPA`, `AUS`, ... */
    rider_nation: string;
    team_name: string;
    bike_name: string;
  }

  /** A rider of `GET /timing-gateway/livetiming-lite`: the session classification. */
  export interface LiveTimingRider extends TimingRiderBase {
    order: number;
    /** Only `CL` has been seen. */
    status_name: string;
    status_id: string;
    /** Best lap, `m'ss.mmm`. */
    lap_time: string;
    /** Laps done on the best lap's tyre/run count; the app shows it as the lap number. */
    num_lap: number;
    last_lap_time: string;
    /** Missing between sessions (seen 2026-10-23, before a session had started). */
    last_lap?: number;
    /** `T` on track, `B` in the box. */
    trac_status: string;
    bike_id: number;
    /** Seconds behind the leader / the rider ahead, `s.mmm`. */
    gap_first: string;
    gap_prev: string;
    on_pit: boolean;
  }

  /** A rider of `GET /timing-gateway/live-standing`: the championship standing. */
  export interface LiveStandingRider extends TimingRiderBase {
    gap_first: number;
    gap_prev: number;
    points: number;
  }

  /** Both timing feeds key riders by their position as a string. */
  export interface LiveTiming<R> {
    head: TimingHead;
    rider: Record<string, R>;
  }

  export interface OnAir {
    on_air: boolean;
    /** `pay` for the Video Pass. `null` while the feed is off air. */
    access_type: string | null;
  }

  export interface PlayerFeed {
    /** `ipfmix` (Commentary), `ipfamb` (Ambient), ... */
    id: string;
    label: string;
    type: string;
    protocols: { hls?: { url: string; credentials: boolean } };
    audio_tracks: { identifier: string; label: string }[];
    '360v_params': { maxlat: number; minlat: number; initfov: number; maxfov: number };
  }

  export interface PlayerCdn {
    /** `auto`, `mgp_fl`, `mgp_cf`, ... */
    id: string;
    label: string;
    feeds: PlayerFeed[];
  }

  /** `GET /video-gateway/live/v2/mgp/{feed}/player-data` */
  export interface PlayerData {
    cdns: PlayerCdn[];
    /** UTC epoch seconds of the rewindable window. */
    dvr_range: { start: number; end: number };
    user: { uid: string };
    video_info: {
      access: string;
      event: string;
      category: string;
      session: string;
      sid: number;
      clips_and_tags_url: string | null;
    };
  }

  export interface Paginated<T> {
    data: T[];
    pagination: Record<string, string>;
  }
}
