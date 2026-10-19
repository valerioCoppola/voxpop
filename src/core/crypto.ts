import { canonicalJson, fromB64, own, toB64, toHex, utf8 } from './encoding';

export type SigAlg = 'Ed25519' | 'ECDSA-P256';

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', own(data)));
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  return toHex(await sha256(data));
}

/** Hash of the canonical form of a signed object: this is what chain links point to. */
export async function objectHash(obj: unknown): Promise<string> {
  return sha256Hex(utf8(canonicalJson(obj)));
}

const ALG_PARAMS: Record<SigAlg, { gen: EcKeyGenParams | Algorithm; sign: Algorithm | EcdsaParams }> = {
  Ed25519: { gen: { name: 'Ed25519' }, sign: { name: 'Ed25519' } },
  'ECDSA-P256': {
    gen: { name: 'ECDSA', namedCurve: 'P-256' } as EcKeyGenParams,
    sign: { name: 'ECDSA', hash: 'SHA-256' } as EcdsaParams,
  },
};

export interface Signer {
  alg: SigAlg;
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

let preferred: SigAlg | null = null;

/** Ed25519 where the browser supports it, otherwise ECDSA P-256 (supported everywhere). */
export async function preferredAlg(): Promise<SigAlg> {
  if (preferred) return preferred;
  try {
    await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
    preferred = 'Ed25519';
  } catch {
    preferred = 'ECDSA-P256';
  }
  return preferred;
}

/** New signing key. The private half is non-extractable: it can sign, never be read out. */
export async function generateSigner(alg?: SigAlg): Promise<Signer> {
  const a = alg ?? (await preferredAlg());
  const kp = (await crypto.subtle.generateKey(ALG_PARAMS[a].gen, false, ['sign', 'verify'])) as CryptoKeyPair;
  return { alg: a, publicKey: kp.publicKey, privateKey: kp.privateKey };
}

export async function exportPublicKey(key: CryptoKey): Promise<string> {
  return toB64(new Uint8Array(await crypto.subtle.exportKey('raw', key)));
}

export async function importPublicKey(alg: SigAlg, b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', own(fromB64(b64)), ALG_PARAMS[alg].gen, true, ['verify']);
}

/** Signs the canonical JSON of `obj`. Returns base64 signature (ECDSA: raw r||s, 64 bytes). */
export async function signObject(signer: Signer, obj: unknown): Promise<string> {
  const sig = await crypto.subtle.sign(ALG_PARAMS[signer.alg].sign, signer.privateKey, own(utf8(canonicalJson(obj))));
  return toB64(new Uint8Array(sig));
}

export async function verifyObject(alg: SigAlg, publicKey: CryptoKey, obj: unknown, sigB64: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify(ALG_PARAMS[alg].sign, publicKey, own(fromB64(sigB64)), own(utf8(canonicalJson(obj))));
  } catch {
    return false;
  }
}

/** Short, human-comparable fingerprint of a public key, e.g. "7f3a-91c2-0be4". */
export async function fingerprint(pubB64: string): Promise<string> {
  const h = await sha256Hex(fromB64(pubB64));
  return `${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}`;
}
