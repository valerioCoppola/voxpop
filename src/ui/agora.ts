import { clear, h, icon } from './dom';
import type { App } from './app';
import { MAX_STREAMS, type CopyState, type PeerInfo } from '../net/agora';
import { cleanName, cleanRoom, randomName } from '../net/names';
import { makePassword, mixesLookalikeScripts, passwordStrength, MIN_PASSWORD } from '../net/room-keys';
import { isTurnUrl } from '../net/config';

interface Card {
  el: HTMLElement;
  video: HTMLVideoElement;
  name: HTMLElement;
  since: HTMLElement;
  seatLine: HTMLElement;
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
      return `No copy: ${c.error ?? 'a piece did not verify'}`;
  }
}

const LOOKALIKE = 'This name mixes alphabets (for example Latin and Cyrillic letters that look the same). It may pose as another room. Type the name yourself instead of pasting it.';

const STRENGTH: Record<ReturnType<typeof passwordStrength>, string> = {
  none: 'No password: a public room. Anyone who knows or guesses the name can enter and watch.',
  'too-short': `Too short: at least ${MIN_PASSWORD} characters.`,
  weak: 'Weak: someone who records the network traffic could guess it. Longer is better, or tap "Make one".',
  ok: 'Good.',
  strong: 'Strong.',
};

function restartPanel(app: App): HTMLElement {
  const recording = app.session().status.recording;
  return h(
    'div',
    { class: 'setting restart' },
    h('h2', {}, 'Restart to join another room'),
    h('p', {}, 'On the network, this session of VoxPop has one hidden identity. Using it in a second room would let someone present in both rooms see it is the same person. A restart gives you a new one.'),
    recording ? h('p', { class: 'form-error' }, 'Stop your recording first: restarting would end it.') : null,
    h('button', { class: 'btn primary', type: 'button', disabled: recording, onclick: () => restart() }, 'Restart now'),
  );
}

/** Reload into the Agora tab: fresh peer id and relay key, nothing else changes. */
function restart() {
  location.hash = '#agora';
  location.reload();
}

function joinForm(app: App): HTMLElement {
  const s = app.settings;
  const room = h('input', { type: 'text', id: 'room-name', value: 'agora', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', maxlength: 48 });
  const roomWarn = h('p', { class: 'form-error', role: 'status' });
  const pass = h('input', { type: 'password', id: 'room-pass', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: 'Leave empty for a public room' });
  const strength = h('p', { class: 'hint', id: 'pass-strength', 'aria-live': 'polite' });
  const show = h('button', { class: 'btn small ghost', type: 'button', 'aria-pressed': 'false' }, 'Show');
  const make = h('button', { class: 'btn small', type: 'button' }, 'Make one');
  const name = h('input', { type: 'text', id: 'my-name', value: s.name || randomName(), maxlength: 40, autocomplete: 'off' });
  const keep = h('input', { type: 'checkbox', id: 'keep-name', checked: !!s.name });
  const save = h('input', { type: 'checkbox', id: 'save-live', checked: s.saveLive });
  const turnReady = !!s.turn?.urls && isTurnUrl(s.turn.urls);
  const hide = h('input', { type: 'checkbox', id: 'hide-ip', checked: s.hideIp && turnReady, disabled: !turnReady });
  const err = h('p', { class: 'form-error', role: 'alert' });
  const submit = h('button', { class: 'btn primary big', type: 'submit' }, 'Join room');

  const checkRoom = () => {
    roomWarn.textContent = mixesLookalikeScripts(room.value) ? LOOKALIKE : '';
  };
  const checkPass = () => {
    const st = passwordStrength(pass.value);
    strength.textContent = STRENGTH[st];
    strength.className = `hint${st === 'too-short' || st === 'weak' ? ' warn-text' : ''}`;
  };
  room.addEventListener('input', checkRoom);
  pass.addEventListener('input', checkPass);
  show.addEventListener('click', () => {
    const on = pass.type === 'password';
    pass.type = on ? 'text' : 'password';
    show.textContent = on ? 'Hide' : 'Show';
    show.setAttribute('aria-pressed', String(on));
  });
  make.addEventListener('click', () => {
    pass.value = makePassword();
    pass.type = 'text';
    show.textContent = 'Hide';
    checkPass();
  });
  checkRoom();
  checkPass();

  const form = h(
    'form',
    { class: 'join-form' },
    h('label', { for: 'room-name' }, 'Room'),
    room,
    roomWarn,
    h('p', { class: 'hint' }, 'Everyone who types the same room name meets here. Capitals and spaces don\'t matter. Try "agora", or a city or cause.'),
    h('label', { for: 'room-pass' }, 'Password (optional)'),
    h('div', { class: 'row pass-row' }, pass, show, make),
    strength,
    h('p', { class: 'hint' }, 'With a password the room is hidden: relays cannot tell it exists or link it to the public room of the same name. Share the password by other means, never inside VoxPop.'),
    h('label', { for: 'my-name' }, 'Name others see'),
    name,
    h('div', { class: 'check-row' }, keep, h('label', { for: 'keep-name' }, 'Keep this name on this phone')),
    h('p', { class: 'hint' }, 'Off (safest): a new random name in every room, so rooms can\'t be linked by your name. It is never linked to your recordings.'),
    h('div', { class: 'check-row' }, save, h('label', { for: 'save-live' }, 'When I go live, also save the recording on this phone')),
    h('p', { class: 'hint' }, 'Off: live only, nothing stored, less battery. On: you keep signed evidence, and viewers can ask you for a verified copy.'),
    h('div', { class: 'check-row' }, hide, h('label', { for: 'hide-ip' }, 'Hide my IP address from room members')),
    h('p', { class: 'hint' }, turnReady ? 'Sends everything through your TURN relay, so others see its address instead of yours. Slower; the relay operator sees your IP.' : 'Needs a TURN relay: add one in Safety, network settings.'),
    err,
    submit,
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const r = cleanRoom(room.value);
    if (!r) return void (err.textContent = 'Type a room name.');
    const chosen = cleanName(name.value);
    await app.updateSettings({ ...app.settings, name: keep.checked ? chosen : '', saveLive: save.checked, hideIp: hide.checked });
    submit.disabled = true;
    submit.textContent = pass.value ? 'Preparing the room key…' : 'Joining…';
    try {
      await app.agora.join({ room: r, password: pass.value, name: chosen, relays: app.settings.relays, turn: app.settings.turn, hideIp: hide.checked });
      pass.value = '';
    } catch (ex) {
      err.textContent = (ex as Error).message;
      submit.disabled = false;
      submit.textContent = 'Join room';
    }
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
      h('p', {}, 'Joining connects your phone directly to the others in the room. They can see your IP address, and so can the public relays used to find each other. An IP address reveals your approximate area and internet provider. If that is a risk for you, use a VPN, or hide your IP with a TURN relay.'),
    ),
  );
}

export function agoraView(app: App): HTMLElement {
  const agora = app.agora;
  const body = h('div');
  const cards = new Map<string, Card>();
  let mode: 'form' | 'room' | 'restart' | null = null;

  // Joined-room parts
  const title = h('h2', { class: 'room-title' });
  const code = h('p', { class: 'room-code' });
  const lookalike = h('p', { class: 'form-error' });
  const status = h('p', { class: 'room-status', 'aria-live': 'polite' });
  const relays = h('p', { class: 'muted small' });
  const peerErr = h('p', { class: 'muted small' });
  const me = h('div', { class: 'me-live' });
  const liveGrid = h('div', { class: 'live-grid' });
  const liveEmpty = h('p', { class: 'empty' }, 'Nobody is live right now. When someone in the room starts recording, their picture appears here.');
  const people = h('ul', { class: 'people' });
  const leave = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      onclick: () => {
        agora.leave();
        if (!app.session().status.recording) return restart();
        render();
      },
    },
    'Leave room',
  );

  const roomView = h(
    'div',
    {},
    h('div', { class: 'row between wrap' }, h('div', {}, title, status), leave),
    code,
    lookalike,
    h('h3', {}, 'Live now'),
    liveGrid,
    liveEmpty,
    me,
    h('h3', {}, 'In the room'),
    people,
    relays,
    peerErr,
  );

  const makeCard = (): Card => {
    const video = h('video', { autoplay: true, playsinline: true, muted: true, controls: true, class: 'live-video' }) as HTMLVideoElement;
    video.muted = true;
    const name = h('strong', {});
    const since = h('span', { class: 'live-since' });
    const seatLine = h('p', { class: 'seat-line small' });
    const copyLine = h('p', { class: 'copy-line small' });
    const actions = h('div', { class: 'row wrap' });
    const el = h('article', { class: 'live-card' }, video, h('div', { class: 'live-meta' }, h('span', { class: 'live-dot', 'aria-hidden': 'true' }), name, since), seatLine, actions, copyLine);
    return { el, video, name, since, seatLine, copyLine, actions };
  };

  const updateCard = (c: Card, p: PeerInfo) => {
    if (p.stream && c.video.srcObject !== p.stream) {
      c.video.srcObject = p.stream;
      void c.video.play().catch(() => {});
    }
    if (!p.stream && c.video.srcObject) c.video.srcObject = null;
    c.name.textContent = `${p.name} ·${p.tag}`;
    c.since.textContent = p.live ? `live since ${new Date(p.live.since).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : '';
    c.seatLine.textContent = p.stream
      ? ''
      : p.live && p.live.seats.used >= p.live.seats.max
        ? `Full: a phone can send live video to ${p.live.seats.max} people at once. You get the picture as soon as a place frees up.`
        : 'Connecting the picture…';
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
  };

  const renderRoom = () => {
    title.textContent = `#${agora.roomName}${agora.isPrivate ? ' (private)' : ''}`;
    code.textContent = `Room code ${agora.roomCode}. Everyone in the same room sees this code. Compare it with the people you meet: a different code means a different name or password.`;
    lookalike.textContent = mixesLookalikeScripts(agora.roomName) ? LOOKALIKE : '';
    const n = agora.othersCount;
    status.textContent =
      n === 0
        ? agora.status === 'joined'
          ? 'Everyone else has left.'
          : agora.isPrivate
            ? 'Waiting for others. Only people with the same name and password can find this room.'
            : 'Looking for others in this room…'
        : `${n} other${n === 1 ? '' : 's'} here`;
    const r = agora.relayStatus();
    relays.textContent = `Meeting points: connected to ${r.connected} of ${r.total} public relays.${r.connected === 0 ? ' Reconnecting… check your internet connection.' : ''}`;
    peerErr.textContent = agora.peerError ? `Someone could not connect: ${agora.peerError}.` : '';

    clear(me);
    const st = app.session().status;
    if (st.live) {
      const v = agora.viewers;
      const w = agora.waitingViewers;
      me.append(
        h(
          'p',
          { class: 'me-on' },
          h('span', { class: 'live-dot' }),
          `You are live to ${v} ${v === 1 ? 'person' : 'people'}${w ? ` (${w} waiting: your phone sends to at most ${MAX_STREAMS})` : ''}. ${st.saving ? 'Also saving on this phone.' : 'Not saving: live only.'}`,
        ),
        h('a', { class: 'btn small', href: '#witness' }, 'Back to camera'),
      );
    } else {
      me.append(
        h('p', {}, `To go live, open Witness and press the record button. ${app.settings.saveLive ? 'Your broadcast will also be saved on this phone.' : 'Live only: nothing will be saved.'}`),
        h('a', { class: 'btn primary small', href: '#witness' }, 'Open camera'),
      );
    }

    const live = [...agora.peers.values()].filter((p) => p.live || p.stream);
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
    people.append(h('li', {}, h('strong', {}, agora.myName), h('span', { class: 'muted' }, ` ·${agora.selfTag} (you)`), st.live ? h('span', { class: 'badge busy' }, 'live') : null));
    for (const p of agora.peers.values()) {
      people.append(h('li', {}, p.name, h('span', { class: 'muted' }, ` ·${p.tag}`), p.live ? h('span', { class: 'badge busy' }, 'live') : null));
    }
  };

  const render = () => {
    const want = agora.joined ? 'room' : agora.spent ? 'restart' : 'form';
    if (want !== mode) {
      clear(body);
      for (const c of cards.values()) c.video.srcObject = null;
      cards.clear();
      clear(liveGrid);
      body.append(want === 'room' ? roomView : want === 'restart' ? restartPanel(app) : joinForm(app));
      mode = want;
    }
    if (mode === 'room') renderRoom();
    if (mode === 'restart') {
      clear(body);
      body.append(restartPanel(app));
    }
  };

  const unsub = agora.subscribe(render);
  const sessionUnsub = app.onSession(() => mode !== 'form' && render());
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
