// Display names and room names. Kept free of network code so storage can use it.

const ADJ = ['Amber', 'Brave', 'Calm', 'Clear', 'Coral', 'Dawn', 'Deep', 'Ember', 'Free', 'Gentle', 'Golden', 'Green', 'Grey', 'Iron', 'Jade', 'Keen', 'Light', 'Lunar', 'Night', 'Ochre', 'Olive', 'Quiet', 'Red', 'Rust', 'Silver', 'Solar', 'Steady', 'Swift', 'True', 'Violet', 'Warm', 'Wild'];
const NOUN = ['Albatross', 'Badger', 'Cedar', 'Crane', 'Delta', 'Falcon', 'Fern', 'Fox', 'Harbor', 'Hawk', 'Heron', 'Ibex', 'Lynx', 'Maple', 'Marten', 'Meadow', 'Oak', 'Orca', 'Otter', 'Owl', 'Pine', 'Raven', 'Reed', 'River', 'Robin', 'Sparrow', 'Stone', 'Swan', 'Tide', 'Willow', 'Wolf', 'Wren'];

/** A random display name. Not an identity: anyone can pick any name. */
export function randomName(): string {
  const r = crypto.getRandomValues(new Uint16Array(3));
  return `${ADJ[r[0] % ADJ.length]} ${NOUN[r[1] % NOUN.length]} ${(r[2] % 90) + 10}`;
}

export function cleanName(s: unknown): string {
  return typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮]/g, '').trim().slice(0, 40) || 'Anonymous' : 'Anonymous';
}

export function cleanRoom(s: string): string {
  return s.trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 48);
}
