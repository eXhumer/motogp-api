import { describe, expect, it } from 'vitest';

import { dvrStart, parseMaster, parseMedia, pickRendition, withStart } from '../src/hls';

const BASE = 'https://cdn.example/a/b/index.m3u8?start=1';

const MASTER = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="MAIN",NAME="English",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="en",URI="9.m3u8?start=1&"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="S",NAME="x",URI="s.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="ALT",NAME="Muxed"
#EXT-X-STREAM-INF:BANDWIDTH=5400000,RESOLUTION=1920x1080,CODECS="avc1.4D402A, mp4a.40.2",AUDIO="MAIN"
5.m3u8?start=1&
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=5400000,RESOLUTION=1920x1080,CODECS="avc1.4D402A, mp4a.40.2",URI="5.m3u8?start=1&"
#EXT-X-STREAM-INF:BANDWIDTH=1150000,RESOLUTION=640x360
/abs/2.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=650000
#comment instead of a uri
#EXT-X-STREAM-INF:BANDWIDTH=300000
plain.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1
#EXT-X-MEDIA:TYPE=AUDIO
`;

const MEDIA = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:15280
#EXT-X-PROGRAM-DATE-TIME:2026-10-23T00:33:06+00:00
#EXT-X-MAP:URI="3/init.mp4"
#EXTINF:6.000,no-desc
3/a.mp4
#EXTINF:5.500,
3/b.mp4
#EXT-X-ENDLIST
`;

describe('parseMaster', () => {
  const master = parseMaster(MASTER, BASE);

  it('reads renditions with absolute URLs', () => {
    expect(master.renditions).toEqual([
      { url: 'https://cdn.example/a/b/5.m3u8?start=1&', bandwidth: 5400000, width: 1920, height: 1080, codecs: 'avc1.4D402A, mp4a.40.2', audio: 'MAIN' },
      { url: 'https://cdn.example/abs/2.m3u8', bandwidth: 1150000, width: 640, height: 360 },
      { url: 'https://cdn.example/a/b/plain.m3u8', bandwidth: 300000 },
    ]);
  });

  it('reads I-frame playlists and audio groups', () => {
    expect(master.iframes).toHaveLength(2);
    expect(master.iframes[0]!.url).toBe('https://cdn.example/a/b/5.m3u8?start=1&');
    expect(master.audio).toEqual([
      { groupId: 'MAIN', name: 'English', language: 'en', default: true, url: 'https://cdn.example/a/b/9.m3u8?start=1&' },
      { groupId: 'ALT', name: 'Muxed', default: false },
      { groupId: '', name: '', default: false },
    ]);
  });
});

describe('parseMedia', () => {
  it('reads segments with wall-clock times and the init segment', () => {
    const media = parseMedia(MEDIA, BASE);
    expect(media).toMatchObject({ targetDuration: 6, mediaSequence: 15280, init: 'https://cdn.example/a/b/3/init.mp4', ended: true });
    expect(media.segments).toEqual([
      { url: 'https://cdn.example/a/b/3/a.mp4', duration: 6, time: Date.parse('2026-10-23T00:33:06Z') },
      { url: 'https://cdn.example/a/b/3/b.mp4', duration: 5.5, time: Date.parse('2026-10-23T00:33:12Z') },
    ]);
  });

  it('copes with a live playlist without dates or an init segment', () => {
    const media = parseMedia('#EXTM3U\n#EXTINF:6,\nx.mp4\n', BASE);
    expect(media.ended).toBe(false);
    expect(media.init).toBeUndefined();
    expect(media.segments).toEqual([{ url: 'https://cdn.example/a/b/x.mp4', duration: 6 }]);
    expect(parseMedia('#EXT-X-MAP:URI="x"', BASE).init).toBe('https://cdn.example/a/b/x');
    expect(parseMedia('#EXT-X-MAP:FOO=1', BASE).init).toBe(BASE);
  });
});

describe('pickRendition', () => {
  const list = parseMaster(MASTER, BASE).renditions;

  it.each([
    ['the best by default', {}, 5400000],
    ['the best under a height cap', { maxHeight: 720 }, 1150000],
    ['the best under a bandwidth cap', { maxBandwidth: 2_000_000 }, 1150000],
    ['the lowest when asked', { prefer: 'lowest' as const }, 300000],
    ['the lowest when nothing fits', { maxBandwidth: 100 }, 300000],
  ])('picks %s', (_, options, bandwidth) => {
    expect(pickRendition(list, options)?.bandwidth).toBe(bandwidth);
  });

  it('returns nothing for no renditions', () => {
    expect(pickRendition([])).toBeUndefined();
  });

  it('treats a rendition without a resolution as height 0 for the cap', () => {
    expect(pickRendition([{ url: 'u', bandwidth: 1 }], { maxHeight: 10 })?.url).toBe('u');
  });
});

describe('DVR position', () => {
  it('sets the start of a stream URL', () => {
    expect(withStart('https://cdn.example/x/index.m3u8?&start=1', 99)).toBe('https://cdn.example/x/index.m3u8?start=99');
    expect(withStart('https://cdn.example/x/index.m3u8', new Date(5_500))).toBe('https://cdn.example/x/index.m3u8?start=5');
  });

  it('computes a start behind the live edge, within the window', () => {
    const range = { start: 100, end: 1000 };
    expect(dvrStart(range, 300)).toBe(700);
    expect(dvrStart(range, 5000)).toBe(100);
  });
});
