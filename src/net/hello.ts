/**
 * The "hello" each person in a room sends: display name and live status.
 * It comes from strangers, so it is read strictly: anything unexpected is dropped.
 */

export interface Hello {
  v: 2;
  seq: number;
  name: string;
  live: { id: string; copy: boolean; age: number; seats: { max: number; used: number } } | null;
}

const HEX32 = /^[0-9a-f]{32}$/;
const isInt = (x: unknown, min: number, max: number): x is number => Number.isSafeInteger(x) && (x as number) >= min && (x as number) <= max;

/** Strict reading of a peer's untrusted "hello". Returns null if anything is off. */
export function parseHello(x: unknown): Hello | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const m = x as Record<string, unknown>;
  if (m.v !== 2 || !isInt(m.seq, 0, Number.MAX_SAFE_INTEGER) || typeof m.name !== 'string' || m.name.length > 200) return null;
  if (m.live === null) return { v: 2, seq: m.seq, name: m.name, live: null };
  const l = m.live as Record<string, unknown> | undefined;
  const seats = l?.seats as Record<string, unknown> | undefined;
  if (
    !l || typeof l !== 'object' || typeof l.id !== 'string' || !HEX32.test(l.id) || typeof l.copy !== 'boolean' ||
    !isInt(l.age, 0, 7 * 86_400) || !seats || !isInt(seats.max, 1, 64) || !isInt(seats.used, 0, seats.max as number)
  ) return null;
  return { v: 2, seq: m.seq, name: m.name, live: { id: l.id, copy: l.copy, age: l.age, seats: { max: seats.max, used: seats.used } } };
}
