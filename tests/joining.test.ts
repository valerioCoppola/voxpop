import { describe, expect, it } from 'vitest';
import { deriveRoom, makePassword, mixesLookalikeScripts, passwordStrength, cleanPassword } from '../src/net/room-keys';
import { cleanName, cleanRoom, peerTag } from '../src/net/names';
import { parseHello } from '../src/net/hello';
import { isRelayUrl, isTurnUrl } from '../src/net/config';

describe('room secrets', () => {
  it('the same room typed differently gives the same meeting point', async () => {
    const a = await deriveRoom('Café Rome', '');
    const b = await deriveRoom('  #café   rome ', ''); // decomposed é, extra spaces, leading #
    expect(a.name).toBe('café-rome');
    expect(b).toEqual(a);
  });

  it('a private room shares nothing with the public room of the same name', async () => {
    const pub = await deriveRoom('agora', '');
    const priv = await deriveRoom('agora', 'correct horse battery');
    expect(priv.isPrivate).toBe(true);
    expect(priv.topic).not.toBe(pub.topic);
    expect(priv.key).not.toBe(pub.key);
    expect(priv.code).not.toBe(pub.code);
    expect(priv.topic).not.toContain('agora');
  });

  it('a different password gives a different room and room code', async () => {
    const a = await deriveRoom('march', 'k7mq-4tzp-9wxr-h2ce');
    const b = await deriveRoom('march', 'k7mq-4tzp-9wxr-h2cf');
    const again = await deriveRoom('march', ' k7mq-4tzp-9wxr-h2ce '); // stray spaces from copy and paste
    expect(a.topic).not.toBe(b.topic);
    expect(a.code).not.toBe(b.code);
    expect(again).toEqual(a);
    expect(a.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{3}$/);
  });

  it('refuses short passwords and empty names', async () => {
    await expect(deriveRoom('agora', 'short')).rejects.toThrow(/at least 8/);
    await expect(deriveRoom('   ', '')).rejects.toThrow(/room name/);
  });

  it('never exposes the password or name in what the network sees', async () => {
    const r = await deriveRoom('secret-meeting', 'hunter2hunter2');
    for (const v of [r.topic, r.key]) {
      expect(v).not.toContain('secret');
      expect(v).not.toContain('hunter');
    }
  });

  it('makes strong, readable passwords', () => {
    const p = makePassword();
    expect(p).toMatch(/^[0-9a-hjkmnp-tv-z]{4}(-[0-9a-hjkmnp-tv-z]{4}){3}$/);
    expect(new Set(Array.from({ length: 50 }, makePassword)).size).toBe(50);
    expect(passwordStrength(p)).not.toBe('weak');
    expect(passwordStrength('')).toBe('none');
    expect(passwordStrength('abc')).toBe('too-short');
    expect(passwordStrength('password')).toBe('weak');
    expect(cleanPassword('ｐａｓｓ')).toBe('pass'); // full-width letters from some keyboards
  });

  it('flags names that mix look-alike alphabets', () => {
    expect(mixesLookalikeScripts('agora')).toBe(false);
    expect(mixesLookalikeScripts('агора')).toBe(false); // all Cyrillic is a real name
    expect(mixesLookalikeScripts('аgora')).toBe(true); // Cyrillic а + Latin
    expect(mixesLookalikeScripts('東京-agora')).toBe(false);
  });
});

describe('names and tags', () => {
  it('removes invisible and direction-changing characters', () => {
    expect(cleanName('Ali​ce')).toBe('Alice');
    expect(cleanName('‮ecilA')).toBe('ecilA');
    expect(cleanName('Bob⁦⁩')).toBe('Bob');
    expect(cleanName('  ')).toBe('Anonymous');
    expect(cleanName(42)).toBe('Anonymous');
    expect([...cleanName('🙂'.repeat(60))].length).toBe(40);
  });

  it('room names keep letters of every language', () => {
    expect(cleanRoom('Piazza San Marco!')).toBe('piazza-san-marco');
    expect(cleanRoom('नमस्ते दुनिया')).toBe('नमस्ते-दुनिया');
    expect(cleanRoom('ro​om')).toBe('room');
  });

  it('tags are short and differ between peers', () => {
    expect(peerTag('abc')).toMatch(/^[2-9a-hjkmnp-z]{4}$/);
    expect(peerTag('peer-one')).not.toBe(peerTag('peer-two'));
  });
});

describe('hello from strangers', () => {
  const ok = { v: 2, seq: 3, name: 'Fox', live: { id: 'a'.repeat(32), copy: true, age: 60, seats: { max: 8, used: 2 } } };
  it('accepts a well-formed hello', () => {
    expect(parseHello(ok)).toEqual(ok);
    expect(parseHello({ ...ok, live: null })).toEqual({ ...ok, live: null });
  });
  it('drops anything off', () => {
    expect(parseHello(null)).toBeNull();
    expect(parseHello({ ...ok, v: 1 })).toBeNull();
    expect(parseHello({ ...ok, seq: -1 })).toBeNull();
    expect(parseHello({ ...ok, name: 'x'.repeat(500) })).toBeNull();
    expect(parseHello({ ...ok, live: { ...ok.live, id: 'not-hex' } })).toBeNull();
    expect(parseHello({ ...ok, live: { ...ok.live, age: 1e12 } })).toBeNull();
    expect(parseHello({ ...ok, live: { ...ok.live, seats: { max: 8, used: 9 } } })).toBeNull();
    expect(parseHello({ ...ok, live: { ...ok.live, copy: 'yes' } })).toBeNull();
  });
  it('ignores extra fields instead of trusting them', () => {
    const parsed = parseHello({ ...ok, admin: true });
    expect(parsed && 'admin' in parsed).toBe(false);
  });
});

describe('network settings', () => {
  it('accepts only secure relay and valid TURN addresses', () => {
    expect(isRelayUrl('wss://relay.example.org')).toBe(true);
    expect(isRelayUrl('wss://relay.example.org:443/nostr')).toBe(true);
    expect(isRelayUrl('ws://relay.example.org')).toBe(false);
    expect(isRelayUrl('wss://evil.org/"><script>')).toBe(false);
    expect(isTurnUrl('turn:turn.example.org:3478')).toBe(true);
    expect(isTurnUrl('turns:turn.example.org:5349?transport=tcp')).toBe(true);
    expect(isTurnUrl('stun:stun.example.org')).toBe(false);
  });
});
