import { defaultRelayUrls } from 'trystero/nostr';
import { getRelays } from '@trystero-p2p/core';

/**
 * How VoxPop users find each other without any server of our own.
 *
 * People in the same room find each other through public Nostr relays: free,
 * independent servers run by volunteers worldwide. Only a short "here I am,
 * this is how to reach me" message goes through them, encrypted with a key
 * derived from the room name (or the room password). After that, video flows
 * directly between devices over WebRTC, end-to-end encrypted.
 */

export const APP_ID = 'voxpop-agora-v1';

/** Large, long-running public relays known to carry ephemeral events. */
const WELL_KNOWN = ['wss://nos.lol', 'wss://relay.damus.io', 'wss://relay.primal.net'];

/**
 * Default relay list: the well-known relays plus five from Trystero's
 * curated list, picked deterministically from APP_ID so every VoxPop user
 * connects to the same set. Everyone shares at least these 8 meeting points.
 */
export function defaultRelays(): string[] {
  const curated = getRelays({ appId: APP_ID, relayConfig: { redundancy: 5 } } as never, defaultRelayUrls, 5, true) as string[];
  return [...new Set([...WELL_KNOWN, ...curated])];
}

/** Build-time override (used by the local test relay), then the user's own list, then the defaults. */
export function relayUrls(custom: string[]): string[] {
  const env = (import.meta.env.VITE_VOXPOP_RELAYS as string | undefined)?.split(',').map((s) => s.trim()).filter(Boolean);
  if (env?.length) return env;
  const valid = custom.filter((u) => /^wss:\/\/[a-z0-9.-]+(:\d+)?(\/\S*)?$/i.test(u));
  return valid.length ? valid : defaultRelays();
}

/** STUN servers tell each device its public address so peers can connect directly. Free, public. */
export function iceServers(turn: TurnSetting | null): RTCIceServer[] {
  if (import.meta.env.VITE_VOXPOP_ICE === 'none') return [];
  const servers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }];
  if (turn?.urls) servers.push({ urls: turn.urls, username: turn.username || undefined, credential: turn.credential || undefined });
  return servers;
}

/** Optional relay for networks that block direct connections. Not provided by default (it costs money to run). */
export interface TurnSetting {
  urls: string;
  username: string;
  credential: string;
}
