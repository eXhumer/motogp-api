// Shared helpers for the scripts in this folder. Run `npm run build` first: they use ./dist.
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline';

import { MotoGPClient } from '../dist/index.mjs';

export const SESSION_FILE = '.motogp-session.json';

/** `--flag`, `--key value` and `--key=value`; everything else is positional. */
export function parseArgs(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) args._.push(a);
    else if (a.includes('=')) args[a.slice(2, a.indexOf('='))] = a.slice(a.indexOf('=') + 1);
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) args[a.slice(2)] = argv[++i];
    else args[a.slice(2)] = true;
  }
  return args;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

/** Drops anything that looks like a credential or personal detail before it is written to disk. */
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /token|password|secret|authorization|cookie|e-?mail|phone|user_ip|^uid$/i.test(k) ? '<redacted>' : redact(v),
      ]),
    );
  return value;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Keys whose upper-case values are names, not codes (`GUEVARA`, `JM89`, `AUSTRALIA`). */
const NAME_KEY = /^(name|full_name)$|surname|nickname|additional_name/i;

/**
 * Replaces every value with made-up data of the same type, so fixtures keep the API's shape but none of
 * its content (names, results, text, media). Keys stay, except id-like ones, which are faked the same
 * way as id values. Booleans and nulls stay; each distinct id maps to one fake id, so references still match.
 */
export function fake(value) {
  const ids = new Map();
  let n = 0;
  const next = () => ++n;
  const id = (text) => {
    if (!ids.has(text))
      ids.set(text, UUID.test(text) ? `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, '0')}` : String(1000 + ids.size));
    return ids.get(text);
  };
  const string = (text, key) => {
    if (!text) return text;
    if (NAME_KEY.test(key)) return `Text ${next()}`;
    if (UUID.test(text)) return id(text);
    if (/^https?:\/\//.test(text)) return `https://example.com/${next()}`;
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.replace(/^\d{4}-\d{2}-\d{2}/, '2026-01-01').replace(/\d{2}:\d{2}:\d{2}/, '12:00:00');
    if (/^[\d\s:.,+-]+$/.test(text)) return text.replace(/\d/g, '0');
    if (/^[A-Z][A-Z0-9_]{0,11}$/.test(text)) return text; // codes and enums: RIDER, INSTND, ES, AUS
    return `Text ${next()}`;
  };
  const walk = (v, key = '') => {
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [UUID.test(k) || /^\d+$/.test(k) ? id(k) : k, walk(x, k)]));
    if (typeof v === 'string') return string(v, key);
    if (typeof v === 'number') return Number.isInteger(v) ? next() : next() + 0.5;
    return v;
  };
  return walk(value);
}

export async function loadSession(file = SESSION_FILE) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return {};
  }
}

export async function saveSession(tokens, file = SESSION_FILE) {
  await writeFile(file, JSON.stringify({ accessToken: tokens.access_token, refreshToken: tokens.refresh_token }, null, 2));
  await chmod(file, 0o600).catch(() => undefined);
}

/**
 * A client from the flags and environment: `--user-agent`, `--language`, `--session-file`,
 * `MOTOGP_ACCESS_TOKEN` / `MOTOGP_REFRESH_TOKEN`, or the session file a previous run saved.
 * New tokens (refresh tokens rotate!) are written back to the session file.
 */
export async function makeClient(args, extra = {}) {
  const file = typeof args['session-file'] === 'string' ? args['session-file'] : SESSION_FILE;
  const saved = await loadSession(file);
  const accessToken = process.env.MOTOGP_ACCESS_TOKEN ?? saved.accessToken;
  const refreshToken = process.env.MOTOGP_REFRESH_TOKEN ?? saved.refreshToken;
  const headers = typeof args['user-agent'] === 'string' ? { 'user-agent': args['user-agent'] } : undefined;

  const options = {
    ...(headers && { headers, userAgent: headers['user-agent'] }),
    ...(typeof args.language === 'string' && { language: args.language }),
    onTokens: (tokens) => saveSession(tokens, file),
    ...extra,
  };

  try {
    return await MotoGPClient.create({ ...options, accessToken, refreshToken });
  } catch (error) {
    // A stale saved session shouldn't stop the public endpoints from working.
    console.warn(`(ignoring the saved session: ${error.message})`);
    return MotoGPClient.create(options);
  }
}

/** Reads a line from the terminal; with `hidden` the typing is not echoed. */
export function prompt(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stdout, terminal: true });
    let answered = false;
    if (hidden) {
      rl._writeToOutput = (text) => {
        if (text.includes(question)) stdout.write(text);
      };
    }
    // stdin closed without an answer (no terminal): give up instead of hanging.
    rl.on('close', () => {
      if (!answered) resolve('');
    });
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      if (hidden) stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

export async function writeJson(file, data) {
  await mkdir(file.slice(0, file.lastIndexOf('/')) || '.', { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2));
}

export const errorSummary = (error) =>
  error?.statusCode ? `HTTP ${error.statusCode} ${String(error.body ?? '').slice(0, 160)}` : String(error?.message ?? error);
