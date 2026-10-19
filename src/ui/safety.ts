import { h, holdButton, toast } from './dom';
import type { App } from './app';
import type { Settings } from '../storage/repo';
import { removePassphrase, setPassphrase, vaultMode, lock } from '../storage/vault';
import { canPromptInstall, isInstalled, promptInstall } from './install';
import { defaultRelays } from '../net/config';

type Opt<K extends keyof Settings> = { value: Settings[K]; label: string; note: string };

function choice<K extends keyof Settings>(app: App, key: K, title: string, opts: Opt<K>[]): HTMLElement {
  const name = `opt-${key}`;
  const note = h('p', { class: 'opt-note' });
  const update = () => {
    note.textContent = opts.find((o) => o.value === app.settings[key])?.note ?? '';
  };
  const group = h(
    'div',
    { class: 'seg', role: 'radiogroup', 'aria-label': title },
    ...opts.map((o) => {
      const id = `${name}-${String(o.value)}`;
      const input = h('input', { type: 'radio', name, id, checked: app.settings[key] === o.value });
      input.addEventListener('change', async () => {
        if (app.session().status.recording) toast('Applies from your next recording.');
        await app.updateSettings({ ...app.settings, [key]: o.value });
        update();
      });
      return h('span', { class: 'seg-item' }, input, h('label', { for: id }, o.label));
    }),
  );
  update();
  return h('fieldset', { class: 'setting' }, h('legend', {}, title), group, note);
}

function passphraseBlock(): HTMLElement {
  const box = h('div', { class: 'setting' });
  const render = async () => {
    box.replaceChildren();
    const mode = await vaultMode();
    const cur = h('input', { type: 'password', autocomplete: 'current-password', id: 'pp-cur' });
    const next = h('input', { type: 'password', autocomplete: 'new-password', id: 'pp-new', minlength: 8 });
    const again = h('input', { type: 'password', autocomplete: 'new-password', id: 'pp-again', minlength: 8 });
    const err = h('p', { class: 'form-error', role: 'alert' });
    const save = h('button', { class: 'btn primary', type: 'submit' }, mode === 'device' ? 'Set passphrase' : 'Change passphrase');
    const form = h(
      'form',
      { class: 'pp-form' },
      mode === 'passphrase' ? h('label', { for: 'pp-cur' }, 'Current passphrase') : null,
      mode === 'passphrase' ? cur : null,
      h('label', { for: 'pp-new' }, 'New passphrase (8 characters or more)'),
      next,
      h('label', { for: 'pp-again' }, 'Repeat it'),
      again,
      err,
      h('div', { class: 'row' }, save),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      if (next.value !== again.value) return void (err.textContent = 'The two passphrases differ.');
      save.disabled = true;
      save.textContent = 'Encrypting…';
      try {
        await setPassphrase(next.value, mode === 'passphrase' ? cur.value : undefined);
        toast('Passphrase set. Recordings are locked until you enter it.');
        void render();
      } catch (ex) {
        err.textContent = (ex as Error).message;
        save.disabled = false;
        save.textContent = mode === 'device' ? 'Set passphrase' : 'Change passphrase';
      }
    });
    box.append(
      h('h3', {}, 'Lock recordings with a passphrase'),
      h(
        'p',
        { class: 'muted' },
        mode === 'device'
          ? 'Now: recordings are encrypted, but anyone holding this unlocked phone can open them in VoxPop. With a passphrase they see only locked files. You can always record without entering it.'
          : 'On: watching and sharing need your passphrase. Recording never does. There is no recovery: a forgotten passphrase means those recordings are gone.',
      ),
      form,
    );
    if (mode === 'passphrase') {
      const lockNow = h('button', { class: 'btn', type: 'button', onclick: () => { lock(); toast('Locked.'); } }, 'Lock now');
      const remove = h('button', { class: 'btn ghost', type: 'button' }, 'Remove passphrase');
      remove.addEventListener('click', async () => {
        if (!cur.value) return void (err.textContent = 'Enter your current passphrase above to remove it.');
        try {
          await removePassphrase(cur.value);
          toast('Passphrase removed.');
          void render();
        } catch (ex) {
          err.textContent = (ex as Error).message;
        }
      });
      box.append(h('div', { class: 'row' }, lockNow, remove));
    }
  };
  void render();
  return box;
}

function networkBlock(app: App): HTMLElement {
  const relays = h('textarea', { id: 'relays', rows: 4, spellcheck: 'false', autocapitalize: 'none', placeholder: defaultRelays().join('\n') }) as HTMLTextAreaElement;
  relays.value = app.settings.relays.join('\n');
  const turnUrl = h('input', { type: 'text', id: 'turn-url', value: app.settings.turn?.urls ?? '', placeholder: 'turn:turn.example.org:3478', autocapitalize: 'none', spellcheck: 'false' });
  const turnUser = h('input', { type: 'text', id: 'turn-user', value: app.settings.turn?.username ?? '', autocapitalize: 'none', spellcheck: 'false' });
  const turnPass = h('input', { type: 'password', id: 'turn-pass', value: app.settings.turn?.credential ?? '' });
  const save = h('button', { class: 'btn', type: 'submit' }, 'Save network settings');
  const form = h(
    'form',
    { class: 'pp-form' },
    h('label', { for: 'relays' }, 'Meeting-point relays (one per line, wss:// only; empty = defaults)'),
    relays,
    h('label', { for: 'turn-url' }, 'TURN relay (optional)'),
    turnUrl,
    h('label', { for: 'turn-user' }, 'TURN username'),
    turnUser,
    h('label', { for: 'turn-pass' }, 'TURN password'),
    turnPass,
    h('div', { class: 'row' }, save),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const list = relays.value.split(/\s+/).map((x) => x.trim()).filter((x) => /^wss:\/\/\S+$/i.test(x));
    const turn = turnUrl.value.trim() ? { urls: turnUrl.value.trim(), username: turnUser.value.trim(), credential: turnPass.value } : null;
    await app.updateSettings({ ...app.settings, relays: list, turn });
    toast(app.agora.joined ? 'Saved. Leave and re-join the room to use them.' : 'Network settings saved.');
  });
  return h(
    'details',
    { class: 'setting' },
    h('summary', {}, h('h3', { class: 'inline' }, 'Network for live rooms (advanced)')),
    h('p', { class: 'muted' }, 'People find each other through public Nostr relays: free servers run by volunteers. If the defaults are blocked where you are, list relays that work for you; everyone in a room needs at least one relay in common. A TURN relay forwards video when two networks refuse a direct connection (some mobile carriers and offices do). VoxPop provides none, because it costs money to run; add one if you have it.'),
    form,
  );
}

export function safetyView(app: App): HTMLElement {
  const install =
    !isInstalled() && canPromptInstall()
      ? h('div', { class: 'setting' }, h('h3', {}, 'Install VoxPop'), h('p', { class: 'muted' }, 'Installed, it works with no connection, opens full screen, and the browser is less likely to clear its storage.'),
          h('button', { class: 'btn primary', type: 'button', onclick: () => void promptInstall() }, 'Install'))
      : null;

  return h(
    'section',
    { class: 'view page safety' },
    h('h1', {}, 'Safety'),
    h('p', { class: 'muted' }, 'The defaults are the safest choices. Every change applies from the next recording, and every recording states in its signed header how it was made.'),

    choice(app, 'faces', 'Faces', [
      { value: 'masked', label: 'Cover all faces', note: 'Every frame is scanned at full resolution before it is shown or saved, catching faces down to about 14 pixels wide: people 15 to 20 metres away. Faces get a solid cover, not a blur, because blurs can be reversed.' },
      { value: 'masked-fast', label: 'Cover near faces', note: 'Scans at half resolution: about four times lighter for older phones, but distant faces in a crowd can be missed. The recording says it used the fast scan.' },
      { value: 'unmasked', label: 'Do not cover', note: 'Faces stay visible and the recording says so. Only for scenes without people, or people who agreed to be shown.' },
    ]),
    choice(app, 'audio', 'Audio', [
      { value: 'disguised', label: 'Disguise voices', note: 'Pitch is shifted by a random amount chosen per recording and never saved. Stops recognition by ear; a forensic analyst may partly undo it.' },
      { value: 'muted', label: 'No audio', note: 'Nothing from the microphone is recorded. The safest choice when a voice must not be identified.' },
      { value: 'original', label: 'Original audio', note: 'Voices are recorded as they are, and the recording says so.' },
    ]),
    choice(app, 'location', 'Location', [
      { value: 'off', label: 'Off', note: 'No location at all. The picture itself may still reveal the place.' },
      { value: 'region', label: '~110 km area', note: 'Only a 1° grid square is saved, roughly a region. Your exact position never leaves the location prompt.' },
      { value: 'city', label: '~11 km area', note: 'Only a 0.1° grid square, roughly a city. In small towns this can narrow things down: think before sharing.' },
    ]),
    choice(app, 'beacon', 'Public time proof', [
      { value: false, label: 'Off', note: 'Times come from this phone clock only, which anyone could set to any date.' },
      { value: true, label: 'On', note: 'Every 15 s VoxPop fetches the drand public random number and burns it into the picture, proving the video was made after that moment. This contacts api.drand.sh or drand.cloudflare.com: they see your IP address, like any website.' },
    ]),
    choice(app, 'identity', 'Signing identity', [
      { value: 'one-time', label: 'One-time key', note: 'A fresh key for every recording. Nobody can tell two of your recordings come from the same person.' },
      { value: 'pseudonym', label: 'Pseudonym', note: 'One key reused across your recordings, so people can learn to trust its track record. The trade-off: your recordings become linkable to each other.' },
    ]),

    passphraseBlock(),
    networkBlock(app),
    install,

    h(
      'div',
      { class: 'setting danger-zone' },
      h('h3', {}, 'Panic wipe'),
      h('p', { class: 'muted' }, 'Deletes every key, recording and setting on this device. Recordings are encrypted, so once the keys are gone any leftover bytes on the phone are unreadable. Files you already shared are not affected.'),
      h('div', { class: 'row wrap' },
        holdButton('Hold 2 s to wipe everything', 2000, () => void app.wipe(false)),
        holdButton('Hold 2 s to wipe and remove app', 2000, () => void app.wipe(true), 'btn ghost danger hold'),
      ),
    ),

    h(
      'div',
      { class: 'setting' },
      h('h3', {}, 'What VoxPop cannot protect you from'),
      h(
        'ul',
        { class: 'limits' },
        h('li', {}, 'Spyware already on your phone can see the camera before VoxPop does.'),
        h('li', {}, 'The picture can reveal a place, a uniform, a tattoo or a car plate. Only faces are covered.'),
        h('li', {}, 'Very distant or turned-away faces can be missed. Crowd mode helps; it is not perfect.'),
        h('li', {}, 'A file you share stays out there. Share only what you are ready to make public.'),
        h('li', {}, 'In a live room, the others and the public relays can see your IP address, which reveals your approximate area. Use a VPN if that is a risk.'),
      ),
    ),
    h('p', { class: 'muted small' }, 'VoxPop 0.2.0. Free and open-source under the GNU AGPL 3.0. No accounts, no ads, no tracking, no money.'),
  );
}
