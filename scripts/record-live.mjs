#!/usr/bin/env node
// Records the live timing endpoints to NDJSON, one line per poll, for building the live watcher.
//
//   npm run build
//   node scripts/record-live.mjs [--out live-recording.ndjson] [--interval 30] [--hours 3] [--raw]
//
// Start it ~10 minutes before a session and leave it until a minute after the flag. A race or a
// qualifying session is the most useful (red flags, pit stops, lap-time changes). Stop with Ctrl-C.
// Nothing here is secret: the timing endpoints are public. Send the .ndjson (gzip it) back.
import { appendFile } from 'node:fs/promises';

import { errorSummary, makeClient, parseArgs, sleep } from './lib.mjs';

const args = parseArgs();
const out = typeof args.out === 'string' ? args.out : 'live-recording.ndjson';
const interval = Number(args.interval ?? 30) * 1000;
const deadline = Date.now() + Number(args.hours ?? 4) * 3_600_000;
const client = await makeClient(args);

let stop = false;
process.on('SIGINT', () => (stop = true));

const sources = {
  liveTiming: () => client.liveTiming(),
  liveStanding: () => client.liveStanding(),
  nextSession: () => client.nextSession(true),
};

let polls = 0;
let previous = '';
console.log(`Recording to ${out} every ${interval / 1000}s. Ctrl-C to stop.`);

while (!stop && Date.now() < deadline) {
  const started = Date.now();
  const record = { t: new Date().toISOString() };

  await Promise.all(
    Object.entries(sources).map(async ([name, fn]) => {
      try {
        record[name] = await fn();
      } catch (error) {
        record[name] = { error: errorSummary(error) };
      }
    }),
  );

  const signature = JSON.stringify([record.liveTiming, record.liveStanding]);
  record.changed = signature !== previous;
  previous = signature;

  await appendFile(out, `${JSON.stringify(record)}\n`);
  polls++;
  const head = record.liveTiming?.head;
  console.log(
    `${record.t} #${polls} ${record.changed ? 'changed' : 'same   '} ${head ? `${head.session_name ?? ''} status=${head.session_status_id ?? '?'}` : record.liveTiming?.error ?? 'no head'}`,
  );

  const wait = interval - (Date.now() - started);
  if (wait > 0 && !stop) await sleep(wait);
}
console.log(`Stopped after ${polls} polls.`);
