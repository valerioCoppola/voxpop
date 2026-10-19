import { get, put } from './db';
import { own, utf8 } from '../core/encoding';

/**
 * The vault encrypts everything VoxPop keeps on the device.
 *
 * Design: one long-lived ECDH key pair ("vault key").
 *  - Recording only needs the PUBLIC half: each recording makes a throwaway
 *    key pair, combines it with the vault public key, and derives an AES key.
 *    So you can always start recording instantly, even while the vault is locked.
 *  - Watching or exporting needs the PRIVATE half, which is stored encrypted:
 *      "device" mode     – under a random key kept in this browser
 *      "passphrase" mode – under a key derived from your passphrase
 *                          (PBKDF2-SHA256, 600 000 rounds). Without it, a seized
 *                          phone shows only ciphertext, even with the app open.
 *  - Panic wipe deletes the keys; the encrypted chunks become unreadable noise.
 */

const PBKDF2_ROUNDS = 600_000;
const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;

interface VaultRecord {
  v: 1;
  pubRaw: Uint8Array; // vault public key, raw
  mode: 'device' | 'passphrase';
  iv: Uint8Array;
  wrapped: Uint8Array; // AES-GCM(pkcs8 private key)
  deviceKek?: CryptoKey; // device mode only (non-extractable)
  salt?: Uint8Array; // passphrase mode only
}

let unlocked: CryptoKey | null = null; // vault private key, in memory only
let cachedPub: CryptoKey | null = null;

async function load(): Promise<VaultRecord | undefined> {
  return get<VaultRecord>('kv', 'vault');
}

async function passKek(pass: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', own(utf8(pass.normalize('NFKC'))), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: own(salt), iterations: PBKDF2_ROUNDS },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function seal(kek: CryptoKey, data: Uint8Array) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, own(data)));
  return { iv, ct };
}

async function importPrivate(pkcs8: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', own(pkcs8), ECDH, false, ['deriveBits']);
}

/** Creates the vault on first run. */
export async function ensureVault(): Promise<void> {
  if (await load()) return;
  const kp = (await crypto.subtle.generateKey(ECDH, true, ['deriveBits'])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const deviceKek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const { iv, ct } = await seal(deviceKek, pkcs8);
  pkcs8.fill(0);
  await put('kv', { v: 1, pubRaw, mode: 'device', iv, wrapped: ct, deviceKek } satisfies VaultRecord, 'vault');
}

export async function vaultMode(): Promise<'device' | 'passphrase'> {
  return (await load())?.mode ?? 'device';
}

export function isUnlocked(): boolean {
  return unlocked !== null;
}

/** Decrypts the private vault key into memory. Throws on a wrong passphrase. */
export async function unlock(pass?: string): Promise<void> {
  const v = await load();
  if (!v) throw new Error('vault missing');
  const kek = v.mode === 'device' ? v.deviceKek! : await passKek(pass ?? '', v.salt!);
  let pkcs8: Uint8Array;
  try {
    pkcs8 = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: own(v.iv) }, kek, own(v.wrapped)));
  } catch {
    throw new Error('Wrong passphrase.');
  }
  unlocked = await importPrivate(pkcs8);
  pkcs8.fill(0);
}

/** Device mode unlocks silently; passphrase mode needs the user. */
export async function tryAutoUnlock(): Promise<boolean> {
  if (unlocked) return true;
  if ((await vaultMode()) === 'device') {
    await unlock();
    return true;
  }
  return false;
}

export function lock(): void {
  unlocked = null;
}

async function currentPkcs8(v: VaultRecord, pass?: string): Promise<Uint8Array> {
  const kek = v.mode === 'device' ? v.deviceKek! : await passKek(pass ?? '', v.salt!);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: own(v.iv) }, kek, own(v.wrapped)));
  } catch {
    throw new Error('Wrong passphrase.');
  }
}

/** Switch to passphrase mode (or change the passphrase). */
export async function setPassphrase(newPass: string, currentPass?: string): Promise<void> {
  if (newPass.length < 8) throw new Error('Use at least 8 characters.');
  const v = (await load())!;
  const pkcs8 = await currentPkcs8(v, currentPass);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const { iv, ct } = await seal(await passKek(newPass, salt), pkcs8);
  pkcs8.fill(0);
  await put('kv', { v: 1, pubRaw: v.pubRaw, mode: 'passphrase', iv, wrapped: ct, salt } satisfies VaultRecord, 'vault');
  lock();
}

/** Back to device mode. */
export async function removePassphrase(currentPass: string): Promise<void> {
  const v = (await load())!;
  const pkcs8 = await currentPkcs8(v, currentPass);
  const deviceKek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const { iv, ct } = await seal(deviceKek, pkcs8);
  pkcs8.fill(0);
  await put('kv', { v: 1, pubRaw: v.pubRaw, mode: 'device', iv, wrapped: ct, deviceKek } satisfies VaultRecord, 'vault');
}

async function vaultPublic(): Promise<CryptoKey> {
  if (cachedPub) return cachedPub;
  const v = await load();
  if (!v) throw new Error('vault missing');
  cachedPub = await crypto.subtle.importKey('raw', own(v.pubRaw), ECDH, false, []);
  return cachedPub;
}

async function deriveAes(priv: CryptoKey, pub: CryptoKey, rid: string): Promise<CryptoKey> {
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256);
  const hk = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: own(utf8('voxpop-vault-v1')), info: own(utf8(rid)) },
    hk,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Key for a new recording. Works while locked. Returns the key and the ephemeral public half to store. */
export async function newRecordingKey(rid: string): Promise<{ key: CryptoKey; ephPub: Uint8Array }> {
  const eph = (await crypto.subtle.generateKey(ECDH, false, ['deriveBits'])) as CryptoKeyPair;
  const key = await deriveAes(eph.privateKey, await vaultPublic(), rid);
  const ephPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  return { key, ephPub }; // eph.privateKey is dropped here: only the vault key can re-derive
}

/** Key to read an existing recording. Needs the vault unlocked. */
export async function openRecordingKey(rid: string, ephPub: Uint8Array): Promise<CryptoKey> {
  if (!unlocked) throw new Error('locked');
  const pub = await crypto.subtle.importKey('raw', own(ephPub), ECDH, false, []);
  return deriveAes(unlocked, pub, rid);
}

export interface Sealed {
  iv: Uint8Array;
  ct: Uint8Array;
}

export async function encryptChunk(key: CryptoKey, data: Uint8Array, aad: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: own(utf8(aad)) }, key, own(data)),
  );
  return { iv, ct };
}

export async function decryptChunk(key: CryptoKey, s: Sealed, aad: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: own(s.iv), additionalData: own(utf8(aad)) }, key, own(s.ct)),
  );
}

/** Forget in-memory keys (after a wipe). */
export function resetVaultMemory(): void {
  unlocked = null;
  cachedPub = null;
}
