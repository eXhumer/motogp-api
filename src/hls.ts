/** Minimal HLS playlist helpers for the formats MotoGP serves (fMP4 segments, one audio group, I-frame lists). */

export interface HlsRendition {
  /** Absolute URL of the media playlist. */
  url: string;
  bandwidth: number;
  /** Absent when the playlist doesn't say. */
  width?: number;
  height?: number;
  codecs?: string;
  /** `GROUP-ID` of the audio rendition group it plays with. */
  audio?: string;
}

export interface HlsAudio {
  groupId: string;
  name: string;
  language?: string;
  default: boolean;
  /** Absolute URL of the audio media playlist, if it is not muxed into the video. */
  url?: string;
}

export interface HlsMaster {
  renditions: HlsRendition[];
  /** Trick-play (I-frame only) playlists, not needed for normal playback. */
  iframes: HlsRendition[];
  audio: HlsAudio[];
}

export interface HlsSegment {
  /** Absolute URL. */
  url: string;
  /** Seconds. */
  duration: number;
  /** Wall-clock time (epoch milliseconds) of the segment's first sample, when the playlist has one. */
  time?: number;
}

export interface HlsMedia {
  targetDuration: number;
  mediaSequence: number;
  /** Absolute URL of the fMP4 initialisation segment. */
  init?: string;
  segments: HlsSegment[];
  /** `false` for a live playlist that keeps growing. */
  ended: boolean;
}

/** `KEY=value,KEY="quoted, value"` attribute lists. */
function attributes(line: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const match of line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) result[match[1]!] = match[2]!.replace(/^"|"$/g, '');

  return result;
}

const get = (attrs: Record<string, string>, key: string) => attrs[key] ?? '';

function rendition(attrs: Record<string, string>, uri: string, base: string): HlsRendition {
  const size = /^(\d+)x(\d+)$/.exec(get(attrs, 'RESOLUTION'));

  return {
    url: new URL(uri, base).toString(),
    bandwidth: Number(attrs['BANDWIDTH']),
    ...(size && { width: Number(size[1]), height: Number(size[2]) }),
    ...(attrs['CODECS'] && { codecs: attrs['CODECS'] }),
    ...(attrs['AUDIO'] && { audio: attrs['AUDIO'] }),
  };
}

/** Parses a master playlist; `base` is the URL it was fetched from. */
export function parseMaster(text: string, base: string): HlsMaster {
  const master: HlsMaster = { renditions: [], iframes: [], audio: [] };
  const lines = text.split(/\r?\n/).map((line) => line.trim());

  lines.forEach((line, index) => {
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const uri = lines[index + 1];
      if (uri && !uri.startsWith('#')) master.renditions.push(rendition(attributes(line), uri, base));
    } else if (line.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) {
      const attrs = attributes(line);
      master.iframes.push(rendition(attrs, get(attrs, 'URI'), base));
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = attributes(line);

      if (attrs['TYPE'] === 'AUDIO')
        master.audio.push({
          groupId: get(attrs, 'GROUP-ID'),
          name: get(attrs, 'NAME'),
          ...(attrs['LANGUAGE'] && { language: attrs['LANGUAGE'] }),
          default: attrs['DEFAULT'] === 'YES',
          ...(attrs['URI'] && { url: new URL(attrs['URI'], base).toString() }),
        });
    }
  });

  return master;
}

/** Parses a media playlist; `base` is the URL it was fetched from. */
export function parseMedia(text: string, base: string): HlsMedia {
  const media: HlsMedia = { targetDuration: 0, mediaSequence: 0, segments: [], ended: false };
  let duration = 0;
  let time: number | undefined;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();

    if (line.startsWith('#EXT-X-TARGETDURATION:')) media.targetDuration = Number(line.split(':')[1]);
    else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) media.mediaSequence = Number(line.split(':')[1]);
    else if (line.startsWith('#EXT-X-MAP:')) media.init = new URL(get(attributes(line), 'URI'), base).toString();
    else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) time = Date.parse(line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length));
    else if (line.startsWith('#EXTINF:')) duration = Number.parseFloat(line.slice('#EXTINF:'.length));
    else if (line === '#EXT-X-ENDLIST') media.ended = true;
    else if (line && !line.startsWith('#')) {
      media.segments.push({ url: new URL(line, base).toString(), duration, ...(time !== undefined && { time }) });
      time = time === undefined ? undefined : time + duration * 1000;
    }
  }

  return media;
}

/**
 * Picks a rendition. `maxHeight` / `maxBandwidth` cap the choice; the best one that fits wins, or the
 * lowest if none does. `'lowest'` returns the smallest instead.
 */
export function pickRendition(
  renditions: readonly HlsRendition[],
  options: { maxHeight?: number; maxBandwidth?: number; prefer?: 'highest' | 'lowest' } = {},
): HlsRendition | undefined {
  const sorted = [...renditions].sort((a, b) => b.bandwidth - a.bandwidth);

  if (options.prefer === 'lowest') return sorted.at(-1);

  const fits = sorted.filter(
    (r) => (options.maxHeight === undefined || (r.height ?? 0) <= options.maxHeight) && (options.maxBandwidth === undefined || r.bandwidth <= options.maxBandwidth),
  );

  return fits[0] ?? sorted.at(-1);
}

/**
 * Starts the stream at another point of the DVR window. The playlist URL carries the position as
 * `start` (epoch seconds, `PlayerData.dvr_range.start` by default); `seconds` can be a number or a
 * `Date`. Use `dvrStart()` to build one relative to the live edge.
 */
export function withStart(url: string, seconds: number | Date): string {
  const next = new URL(url);

  next.searchParams.set('start', String(Math.floor(seconds instanceof Date ? seconds.getTime() / 1000 : seconds)));

  return next.toString();
}

/** The `start` value `secondsBack` seconds behind the live edge, never before the window opens. */
export function dvrStart(range: { start: number; end: number }, secondsBack: number): number {
  return Math.max(range.start, range.end - secondsBack);
}
