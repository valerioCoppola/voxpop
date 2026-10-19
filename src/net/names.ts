// Display names and room names. Kept free of network code so storage can use it.

const ADJ = ['Amber', 'Brave', 'Calm', 'Clear', 'Coral', 'Dawn', 'Deep', 'Ember', 'Free', 'Gentle', 'Golden', 'Green', 'Grey', 'Iron', 'Jade', 'Keen', 'Light', 'Lunar', 'Night', 'Ochre', 'Olive', 'Quiet', 'Red', 'Rust', 'Silver', 'Solar', 'Steady', 'Swift', 'True', 'Violet', 'Warm', 'Wild'];
const NOUN = ['Albatross', 'Badger', 'Cedar', 'Crane', 'Delta', 'Falcon', 'Fern', 'Fox', 'Harbor', 'Hawk', 'Heron', 'Ibex', 'Lynx', 'Maple', 'Marten', 'Meadow', 'Oak', 'Orca', 'Otter', 'Owl', 'Pine', 'Raven', 'Reed', 'River', 'Robin', 'Sparrow', 'Stone', 'Swan', 'Tide', 'Willow', 'Wolf', 'Wren'];

/** A random display name. Not an identity: anyone can pick any name. */
export function randomName(): string {
  const r = crypto.getRandomValues(new Uint16Array(3));
  return `${ADJ[r[0] % ADJ.length]} ${NOUN[r[1] % NOUN.length]} ${(r[2] % 90) + 10}`;
}

/**
 * Invisible and direction-changing characters: they let one name pass for another
 * (or hide text), so they are removed from anything shown to others.
 */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb]/g;

export function cleanName(s: unknown): string {
  if (typeof s !== 'string') return 'Anonymous';
  const n = s.normalize('NFKC').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  return [...n].slice(0, 40).join('') || 'Anonymous';
}

/** Room names: case, spacing and Unicode form don't matter, so everyone typing "Café Rome" meets. */
export function cleanRoom(s: string): string {
  const n = s
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .trim()
    .toLowerCase()
    .replace(/^#/, '')
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{M}\p{N}_-]/gu, '');
  return [...n].slice(0, 48).join('');
}

/**
 * A short tag shown next to a display name, derived from the random per-session
 * peer id. Two people can pick the same name; their tags still differ. It is not
 * an identity: it changes every time VoxPop restarts.
 */
export function peerTag(peerId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < peerId.length; i++) h = Math.imul(h ^ peerId.charCodeAt(i), 0x01000193) >>> 0;
  const A = '23456789abcdefghjkmnpqrstuvwxyz';
  let t = '';
  for (let i = 0; i < 4; i++) {
    t += A[h % A.length];
    h = Math.floor(h / A.length);
  }
  return t;
}
