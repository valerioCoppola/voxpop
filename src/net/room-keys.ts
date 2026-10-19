import { scryptAsync } from '@noble/hashes/scrypt.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { cleanRoom } from './names';

/**
 * Turns what people type (room name, optional password) into what the network sees.
 *
 * Nobody outside the room should learn the name or the password from the network:
 *
 *  - A slow, memory-hard function (scrypt) turns them into a 256-bit room secret.
 *    Public rooms use a lighter setting; private rooms a heavy one (64 MiB), so
 *    every password guess costs an attacker real memory and time, even on GPUs.
 *  - From that secret come three independent values: the meeting-point topic the
 *    relays see, the key that encrypts the connection details, and a short room
 *    code people can read to each other to confirm they are in the same room.
 *  - A private room's topic depends on the password, so it shares nothing with
 *    the public room of the same name, and relays cannot tell the two are related.
 *
 * Public rooms remain guessable by name: that is what "public" means.
 */

export const ROOM_PROTOCOL = 2;
const PUBLIC_N = 2 ** 14; // 16 MiB: slows bulk listing of public rooms by name
const PRIVATE_N = 2 ** 16; // 64 MiB: about 1–2 s on a phone, once per join
export const MIN_PASSWORD = 8;

export interface RoomSecrets {
  name: string; // normalized room name
  isPrivate: boolean;
  topic: string; // what relays see (hashed again by the library)
  key: string; // encrypts connection details
  code: string; // short check code, e.g. "K7Q-4TZ"
}

const enc = new TextEncoder();
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function label(secret: Uint8Array, what: string): Uint8Array {
  return hmac(sha256, secret, enc.encode(`voxpop/room/v${ROOM_PROTOCOL}/${what}`));
}

function code(b: Uint8Array): string {
  // 6 characters × 5 bits = 30 bits: enough to catch a mistyped name or password.
  let n = ((b[0] << 22) | (b[1] << 14) | (b[2] << 6) | (b[3] >> 2)) >>> 0;
  let s = '';
  for (let i = 0; i < 6; i++) {
    s = CROCKFORD[n & 31] + s;
    n >>>= 5;
  }
  return `${s.slice(0, 3)}-${s.slice(3)}`;
}

/** The same password typed on different phones must give the same room. */
export function cleanPassword(p: string): string {
  return p.normalize('NFKC').trim();
}

export async function deriveRoom(room: string, password: string): Promise<RoomSecrets> {
  const name = cleanRoom(room);
  if (!name) throw new Error('Type a room name.');
  const pw = cleanPassword(password);
  const isPrivate = pw.length > 0;
  if (isPrivate && [...pw].length < MIN_PASSWORD) throw new Error(`Use a password of at least ${MIN_PASSWORD} characters, or tap "Make one".`);
  const secret = isPrivate
    ? await scryptAsync(enc.encode(pw), enc.encode(`voxpop/room/v${ROOM_PROTOCOL}/private\u0000${name}`), { N: PRIVATE_N, r: 8, p: 1, dkLen: 32 })
    : await scryptAsync(enc.encode(name), enc.encode(`voxpop/room/v${ROOM_PROTOCOL}/public`), { N: PUBLIC_N, r: 8, p: 1, dkLen: 32 });
  const out = {
    name,
    isPrivate,
    topic: `${isPrivate ? 'p' : 'o'}${hex(label(secret, 'topic')).slice(0, 40)}`,
    key: hex(label(secret, 'key')),
    code: code(label(secret, 'code')),
  };
  secret.fill(0);
  return out;
}

/** A random password that is easy to read aloud and type: 4 groups of 4 (80 bits). */
export function makePassword(): string {
  const r = crypto.getRandomValues(new Uint8Array(16));
  const s = Array.from(r, (x) => CROCKFORD[x & 31]).join('');
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}`.toLowerCase();
}

/** Rough strength label for a typed password. Never stored or sent. */
export function passwordStrength(p: string): 'none' | 'too-short' | 'weak' | 'ok' | 'strong' {
  const pw = cleanPassword(p);
  const n = [...pw].length;
  if (n === 0) return 'none';
  if (n < MIN_PASSWORD) return 'too-short';
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  const bits = n * Math.log2([0, 26, 52, 62, 90][classes] || 26);
  return bits >= 70 ? 'strong' : bits >= 50 ? 'ok' : 'weak';
}

const SCRIPTS = ['Latin', 'Cyrillic', 'Greek', 'Armenian', 'Cherokee'] as const;

/**
 * True when a name mixes alphabets whose letters look alike (Latin "a" and
 * Cyrillic "а"): such a name can pass for another room's name.
 */
export function mixesLookalikeScripts(s: string): boolean {
  const found = SCRIPTS.filter((sc) => new RegExp(`\\p{Script=${sc}}`, 'u').test(s));
  return found.length > 1;
}
