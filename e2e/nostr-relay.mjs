// A tiny in-memory Nostr relay, only for the two-user browser tests.
// Real users meet through public relays; this stands in for them offline.
// Supports what VoxPop's signalling uses: EVENT, REQ (kinds, since, #x tag), CLOSE.
import { WebSocketServer } from 'ws';

const port = Number(process.env.RELAY_PORT || 7777);
const wss = new WebSocketServer({ port });
const subs = new Map(); // ws -> Map(subId -> filters[])

const matches = (ev, f) =>
  (!f.kinds || f.kinds.includes(ev.kind)) &&
  (!f.since || ev.created_at >= f.since - 5) &&
  (!f['#x'] || ev.tags.some((t) => t[0] === 'x' && f['#x'].includes(t[1])));

wss.on('connection', (ws) => {
  subs.set(ws, new Map());
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    const [type, a, ...rest] = msg;
    if (type === 'REQ') {
      subs.get(ws).set(a, rest);
      ws.send(JSON.stringify(['EOSE', a]));
    } else if (type === 'CLOSE') {
      subs.get(ws).delete(a);
    } else if (type === 'EVENT') {
      const ev = a;
      ws.send(JSON.stringify(['OK', ev.id, true, '']));
      for (const [client, m] of subs) {
        for (const [subId, filters] of m) {
          if (filters.some((f) => matches(ev, f)) && client.readyState === 1) client.send(JSON.stringify(['EVENT', subId, ev]));
        }
      }
    }
  });
  ws.on('close', () => subs.delete(ws));
});

console.log(`test relay on ws://localhost:${port}`);
