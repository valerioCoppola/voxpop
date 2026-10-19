import { clear, fmtDuration, h, icon, toast } from './dom';
import type { App } from './app';
import type { SessionStatus } from '../media/session';
import { installBanner } from './install';

type ChipState = 'ok' | 'off' | 'warn' | 'busy';

function chip(name: string, label: string, state: ChipState): HTMLElement {
  return h('a', { class: `chip ${state}`, href: '#safety', title: `${label} (change in Safety)` }, icon(name), h('span', {}, label));
}

function chips(s: SessionStatus, app: App): HTMLElement[] {
  const set = app.settings;
  const p = s.pipeline;
  let faces: [string, ChipState];
  if (set.faces === 'unmasked') faces = ['Faces visible', 'warn'];
  else if (s.camera !== 'on') faces = [set.faces === 'masked-fast' ? 'Near faces covered' : 'Faces covered', 'off'];
  else if (p.state === 'protected') faces = [set.faces === 'masked-fast' ? 'Near faces covered' : 'Faces covered', set.faces === 'masked-fast' ? 'warn' : 'ok'];
  else if (p.state === 'loading') faces = ['Loading face cover', 'busy'];
  else faces = ['Picture hidden', 'warn'];

  const voice: [string, ChipState] =
    set.audio === 'disguised' ? ['Voice disguised', 'ok'] : set.audio === 'muted' ? ['No audio', 'ok'] : ['Real voice', 'warn'];

  let loc: [string, ChipState];
  if (set.location === 'off') loc = ['No location', 'ok'];
  else if (s.locationState === 'ok') loc = [set.location === 'city' ? 'Area ~11 km' : 'Area ~110 km', 'ok'];
  else if (s.locationState === 'locating') loc = ['Finding area', 'busy'];
  else if (s.locationState === 'unavailable') loc = ['Area unavailable', 'warn'];
  else loc = [set.location === 'city' ? 'Area ~11 km' : 'Area ~110 km', 'off'];

  let time: [string, ChipState];
  if (!set.beacon) time = ['Device clock only', 'off'];
  else if (s.beacon.state === 'ok') time = [`Time proof ${s.beacon.round}`, 'ok'];
  else if (s.beacon.state === 'fetching') time = ['Getting time proof', 'busy'];
  else if (s.beacon.state === 'failed') time = ['Time proof offline', 'warn'];
  else time = ['Time proof on', 'off'];

  const a = app.agora;
  const room: [string, ChipState] = !a.joined
    ? ['Not in a room', 'off']
    : s.live
      ? [`Live to #${a.roomName}, ${a.othersCount} ${a.othersCount === 1 ? 'person' : 'people'}`, 'ok']
      : [`In #${a.roomName}: record to go live`, 'ok'];
  const roomChip = h('a', { class: `chip ${room[1]}${s.live ? ' live' : ''}`, href: '#agora', title: 'Rooms (Agora)' }, icon('agora'), h('span', {}, room[0]));
  return [roomChip, chip('face', ...faces), chip('voice', ...voice), chip('pin', ...loc), chip('clock', ...time)];
}

export function witnessView(app: App): HTMLElement {
  const session = app.session();
  const strip = h('div', { class: 'strip', 'aria-label': 'Protection status' });
  const stage = h('div', { class: 'stage' });
  const statusMain = h('div', { class: 'rec-time', 'aria-live': 'polite' });
  const statusSub = h('div', { class: 'rec-sub' });
  const recBtn = h('button', { class: 'rec-btn', type: 'button', 'aria-label': 'Start recording' }, h('span', { class: 'rec-dot' }));
  const flipBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Switch camera' }, icon('flip'));
  const bar = h('div', { class: 'rec-bar' }, h('div', { class: 'rec-status' }, statusMain, statusSub), recBtn, h('div', { class: 'rec-side' }, flipBtn));

  const startPanel = () =>
    h(
      'div',
      { class: 'start' },
      h('h1', {}, 'Witness'),
      h('p', {}, 'Record what is happening around you. Faces are covered and voices disguised on this phone before anything is saved. Nothing is uploaded.'),
      h(
        'button',
        {
          class: 'btn primary big',
          type: 'button',
          onclick: () => void session.startCamera(),
        },
        'Start camera',
      ),
      session.status.camera === 'denied'
        ? h('p', { class: 'form-error' }, 'Camera access was refused. Allow camera and microphone for this site in your browser settings, then try again.')
        : session.status.camera === 'error'
          ? h('p', { class: 'form-error' }, `The camera could not start: ${session.status.error ?? 'unknown error'}`)
          : null,
    );

  let mounted: 'start' | 'canvas' | null = null;
  let tick: number | null = null;

  const render = () => {
    const s = session.status;
    const live = s.camera === 'on';
    if (live && mounted !== 'canvas') {
      clear(stage);
      stage.append(session.pipeline.output);
      mounted = 'canvas';
    } else if (!live && mounted !== 'start') {
      clear(stage);
      stage.append(startPanel());
      mounted = 'start';
    } else if (!live && (s.camera === 'denied' || s.camera === 'error')) {
      clear(stage);
      stage.append(startPanel());
    }
    clear(strip);
    strip.append(...chips(s, app));
    // Performance figures, visible to anyone inspecting the page (useful for bug reports).
    stage.dataset.fps = String(s.pipeline.fps);
    stage.dataset.detectMs = String(s.pipeline.detectMs);
    stage.dataset.threads = String(s.pipeline.threads);

    bar.hidden = !live;
    const inRoom = app.agora.joined;
    if (s.recording) {
      recBtn.classList.add('recording');
      recBtn.setAttribute('aria-label', s.live ? 'Stop live' : 'Stop recording');
      recBtn.disabled = false;
      statusMain.textContent = `${s.live ? 'LIVE' : 'REC'} ${fmtDuration(Date.now() - (s.startedAt ?? Date.now()))}`;
      statusMain.classList.add('live');
      const viewers = app.agora.othersCount;
      statusSub.textContent = s.live
        ? `${viewers} watching${s.saving ? `, ${s.chunksSaved} pieces saved` : ', not saving'}`
        : `${s.chunksSaved} ${s.chunksSaved === 1 ? 'piece' : 'pieces'} signed and saved`;
    } else {
      recBtn.classList.remove('recording');
      recBtn.setAttribute('aria-label', inRoom ? 'Go live' : 'Start recording');
      statusMain.classList.remove('live');
      const can = session.canRecord();
      recBtn.disabled = !can.ok;
      statusMain.textContent = can.ok ? (inRoom ? 'Ready to go live' : 'Ready') : '';
      statusSub.textContent = can.ok
        ? inRoom
          ? `In #${app.agora.roomName}${app.settings.saveLive ? ', also saving' : ', live only'}`
          : 'Saved only on this phone'
        : (can.reason ?? '');
    }
    if (s.error) statusSub.textContent = s.error;
  };

  recBtn.addEventListener('click', async () => {
    if (session.status.recording) {
      recBtn.disabled = true;
      const row = await session.stopRecording();
      if (row) toast(`Recording sealed and saved: ${row.chunks} pieces.`);
      else toast('Live ended.');
      app.refreshNav();
    } else {
      try {
        recBtn.disabled = true;
        await session.startRecording();
        app.refreshNav();
      } catch (e) {
        toast((e as Error).message);
        render();
      }
    }
  });

  flipBtn.addEventListener('click', async () => {
    if (session.status.recording) return toast('Stop recording to switch camera.');
    await app.updateSettings({ ...app.settings, camera: app.settings.camera === 'environment' ? 'user' : 'environment' });
  });

  let raf = 0;
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(() => {
      raf = 0;
      render();
    });
  };
  const unsubSession = app.onSession(schedule);
  const unsubAgora = app.agora.subscribe(schedule);
  tick = window.setInterval(render, 1000);
  render();

  const view = h('section', { class: 'view witness' }, installBanner(), stage, strip, bar);
  (view as HTMLElement & { cleanup?: () => void }).cleanup = () => {
    if (tick) clearInterval(tick);
    unsubSession();
    unsubAgora();
  };
  return view;
}
