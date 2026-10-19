import { clear, h, icon } from './dom';
import type { App } from './app';
import type { CopyState, PeerInfo } from '../net/agora';
import { cleanName, cleanRoom } from '../net/names';

interface Card {
  el: HTMLElement;
  video: HTMLVideoElement;
  name: HTMLElement;
  since: HTMLElement;
  copyLine: HTMLElement;
  actions: HTMLElement;
}

function copyText(c: CopyState): string {
  switch (c.status) {
    case 'requested':
      return 'Asking for a copy…';
    case 'saving':
      return `Saving a copy: ${c.pieces} piece${c.pieces === 1 ? '' : 's'} verified so far`;
    case 'done':
      return `Saved and sealed: ${c.pieces} pieces, all verified. It is in your Ledger.`;
    case 'stopped':
      return `${c.error ?? 'Stopped.'} (${c.pieces} pieces in your Ledger)`;
    case 'failed':
      return `Copy refused: ${c.error ?? 'a piece did not verify'}. Nothing after it was kept.`;
  }
}

function joinForm(app: App, rerender: () => void): HTMLElement {
  const s = app.settings;
  const room = h('input', { type: 'text', id: 'room-name', value: s.room || 'agora', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', maxlength: 48 });
  const pass = h('input', { type: 'password', id: 'room-pass', autocomplete: 'off', placeholder: 'Leave empty for a public room' });
  const name = h('input', { type: 'text', id: 'my-name', value: s.name, maxlength: 40, autocomplete: 'off' });
  const save = h('input', { type: 'checkbox', id: 'save-live', checked: s.saveLive });
  const err = h('p', { class: 'form-error', role: 'alert' });
  const form = h(
    'form',
    { class: 'join-form' },
    h('label', { for: 'room-name' }, 'Room'),
    room,
    h('p', { class: 'hint' }, 'Everyone who types the same room name meets here. Try "agora", or a city or cause.'),
    h('label', { for: 'room-pass' }, 'Password (optional)'),
    pass,
    h('p', { class: 'hint' }, 'With a password, only people who know it can enter. Share it by other means.'),
    h('label', { for: 'my-name' }, 'Name others see'),
    name,
    h('p', { class: 'hint' }, 'Any name. It is not linked to your recordings or to you.'),
    h('div', { class: 'check-row' }, save, h('label', { for: 'save-live' }, 'When I go live, also save the recording on this phone')),
    h('p', { class: 'hint' }, 'Off: live only, nothing stored, less battery. On: you keep signed evidence, and viewers can ask you for a verified copy.'),
    err,
    h('button', { class: 'btn primary big', type: 'submit' }, 'Join room'),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = cleanRoom(room.value);
    if (!r) return void (err.textContent = 'Type a room name.');
    await app.updateSettings({ ...app.settings, room: r, name: cleanName(name.value), saveLive: save.checked });
    app.agora.join({ room: r, password: pass.value, name: app.settings.name, relays: app.settings.relays, turn: app.settings.turn });
    pass.value = '';
    rerender();
  });
  return h(
    'div',
    {},
    h('p', { class: 'muted' }, 'Meet people in a room and watch each other live. What you send is the same face-covered, voice-disguised picture Witness records. Nothing is stored on anyone\'s phone unless they choose to save a copy.'),
    form,
    h(
      'div',
      { class: 'notice' },
      h('strong', {}, 'Before you join'),
      h('p', {}, 'Joining connects your phone directly to the others in the room. They can see your IP address, and so can the public relays used to find each other. An IP address reveals your approximate area and internet provider. If that is a risk for you, use a VPN.'),
    ),
  );
}

export function agoraView(app: App): HTMLElement {
  const agora = app.agora;
  const body = h('div');
  const cards = new Map<string, Card>();
  let mode: 'form' | 'room' | null = null;

  // Joined-room parts
  const title = h('h2', { class: 'room-title' });
  const status = h('p', { class: 'room-status', 'aria-live': 'polite' });
  const relays = h('p', { class: 'muted small' });
  const me = h('div', { class: 'me-live' });
  const liveGrid = h('div', { class: 'live-grid' });
  const liveEmpty = h('p', { class: 'empty' }, 'Nobody is live right now. When someone in the room starts recording, their picture appears here.');
  const people = h('ul', { class: 'people' });
  const leave = h('button', { class: 'btn', type: 'button', onclick: () => { agora.leave(); render(); } }, 'Leave room');

  const roomView = h(
    'div',
    {},
    h('div', { class: 'row between wrap' }, h('div', {}, title, status), leave),
    h('h3', {}, 'Live now'),
    liveGrid,
    liveEmpty,
    me,
    h('h3', {}, 'In the room'),
    people,
    relays,
  );

  const makeCard = (): Card => {
    const video = h('video', { autoplay: true, playsinline: true, muted: true, controls: true, class: 'live-video' }) as HTMLVideoElement;
    video.muted = true;
    const name = h('strong', {});
    const since = h('span', { class: 'live-since' });
    const copyLine = h('p', { class: 'copy-line small' });
    const actions = h('div', { class: 'row wrap' });
    const el = h('article', { class: 'live-card' }, video, h('div', { class: 'live-meta' }, h('span', { class: 'live-dot', 'aria-hidden': 'true' }), name, since), actions, copyLine);
    return { el, video, name, since, copyLine, actions };
  };

  const updateCard = (c: Card, p: PeerInfo) => {
    if (p.stream && c.video.srcObject !== p.stream) {
      c.video.srcObject = p.stream;
      void c.video.play().catch(() => {});
    }
    c.name.textContent = p.name;
    c.since.textContent = p.live ? `live since ${new Date(p.live.since).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : '';
    const copy = p.live ? agora.copies.get(p.live.id) : undefined;
    clear(c.actions);
    if (p.live?.copy) {
      if (!copy || copy.status === 'failed') {
        c.actions.append(h('button', { class: 'btn small', type: 'button', onclick: () => agora.saveCopy(p.id) }, icon('download'), 'Save a copy'));
      } else if (copy.status === 'saving' || copy.status === 'requested') {
        c.actions.append(h('button', { class: 'btn small ghost', type: 'button', onclick: () => agora.stopCopy(copy.rid) }, 'Stop saving'));
      }
    }
    c.copyLine.textContent = copy ? copyText(copy) : p.live?.copy ? 'Watching only: nothing is stored on your phone.' : 'Watching only. This person is not saving, so no copy can be made.';
    c.copyLine.className = `copy-line small${copy?.status === 'failed' ? ' bad' : copy?.status === 'done' ? ' good' : ''}`;
    if (!p.stream) c.video.poster = '';
  };

  const renderRoom = () => {
    title.textContent = `#${agora.roomName}${agora.isPrivate ? ' (private)' : ''}`;
    const n = agora.othersCount;
    status.textContent =
      agora.status === 'joining' && n === 0
        ? 'Looking for others in this room…'
        : n === 0
          ? 'You are the only one here. Others appear as soon as they join with the same room name.'
          : `${n} other${n === 1 ? '' : 's'} here`;
    const r = agora.relayStatus();
    relays.textContent = agora.error
      ? `Connection problem: ${agora.error}`
      : `Meeting points: connected to ${r.connected} of ${r.total} public relays.${r.connected === 0 ? ' Check your internet connection.' : ''}`;

    clear(me);
    const st = app.session().status;
    if (st.live) {
      me.append(
        h('p', { class: 'me-on' }, h('span', { class: 'live-dot' }), `You are live to ${n} ${n === 1 ? 'person' : 'people'}. ${st.saving ? 'Also saving on this phone.' : 'Not saving: live only.'}`),
        h('a', { class: 'btn small', href: '#witness' }, 'Back to camera'),
      );
    } else {
      me.append(
        h('p', {}, `To go live, open Witness and press the record button. ${app.settings.saveLive ? 'Your broadcast will also be saved on this phone.' : 'Live only: nothing will be saved.'}`),
        h('a', { class: 'btn primary small', href: '#witness' }, 'Open camera'),
      );
    }

    const live = [...agora.peers.values()].filter((p) => p.live);
    for (const [id, c] of cards) {
      if (!live.some((p) => p.id === id)) {
        c.video.srcObject = null;
        c.el.remove();
        cards.delete(id);
      }
    }
    for (const p of live) {
      let c = cards.get(p.id);
      if (!c) {
        c = makeCard();
        cards.set(p.id, c);
        liveGrid.append(c.el);
      }
      updateCard(c, p);
    }
    liveEmpty.hidden = live.length > 0;

    clear(people);
    people.append(h('li', {}, h('strong', {}, app.settings.name), h('span', { class: 'muted' }, ' (you)'), st.live ? h('span', { class: 'badge busy' }, 'live') : null));
    for (const p of agora.peers.values()) {
      people.append(h('li', {}, p.name, p.live ? h('span', { class: 'badge busy' }, 'live') : null));
    }
  };

  const render = () => {
    const want = agora.joined ? 'room' : 'form';
    if (want !== mode) {
      clear(body);
      for (const c of cards.values()) c.video.srcObject = null;
      cards.clear();
      clear(liveGrid);
      body.append(want === 'room' ? roomView : joinForm(app, render));
      mode = want;
    }
    if (mode === 'room') renderRoom();
  };

  const unsub = agora.subscribe(render);
  const sessionUnsub = app.onSession(render);
  const tick = window.setInterval(() => mode === 'room' && renderRoom(), 3000);
  render();

  const view = h('section', { class: 'view page agora' }, h('h1', {}, 'Agora'), body) as HTMLElement & { cleanup?: () => void };
  view.cleanup = () => {
    unsub();
    sessionUnsub();
    clearInterval(tick);
    for (const c of cards.values()) c.video.srcObject = null;
  };
  return view;
}
