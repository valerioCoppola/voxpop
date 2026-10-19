import { clear, h, icon, toast } from './dom';
import { witnessView } from './witness';
import { ledgerView } from './ledger';
import { verifyView } from './verify';
import { safetyView } from './safety';
import { agoraView } from './agora';
import { Agora } from '../net/agora';
import { WitnessSession } from '../media/session';
import { getSettings, saveSettings, wipeEverything, type Settings } from '../storage/repo';
import { isUnlocked } from '../storage/vault';

type Route = 'witness' | 'agora' | 'ledger' | 'verify' | 'safety';
const ROUTES: { id: Route; label: string; icon: string }[] = [
  { id: 'witness', label: 'Witness', icon: 'witness' },
  { id: 'agora', label: 'Agora', icon: 'agora' },
  { id: 'ledger', label: 'Ledger', icon: 'ledger' },
  { id: 'verify', label: 'Verify', icon: 'verify' },
  { id: 'safety', label: 'Safety', icon: 'safety' },
];

export class App {
  settings!: Settings;
  private _session: WitnessSession | null = null;
  readonly agora = new Agora();
  private sessionListeners = new Set<() => void>();
  private main = h('main', { id: 'main', tabindex: -1 });
  private nav = h('nav', { class: 'tabs', 'aria-label': 'Sections' });
  private lockBadge = h('span', { class: 'lock-state' });
  private current: (HTMLElement & { cleanup?: () => void }) | null = null;

  async init(root: HTMLElement) {
    this.settings = await getSettings();
    const header = h(
      'header',
      { class: 'top' },
      h('a', { class: 'wordmark', href: '#witness', 'aria-label': 'VoxPop home' }, h('span', { class: 'mark', 'aria-hidden': 'true' }), 'VoxPop'),
      this.lockBadge,
    );
    root.replaceChildren(header, this.main, this.nav);
    window.addEventListener('hashchange', () => this.route());
    this.agora.subscribe(() => this.refreshNav());
    window.addEventListener('pagehide', () => this.agora.leave());
    this.route();
  }

  session(): WitnessSession {
    if (!this._session) {
      this._session = new WitnessSession(this.settings);
      this._session.agora = this.agora;
      this._session.onChange = () => {
        this.refreshNav();
        for (const l of this.sessionListeners) l();
      };
    }
    return this._session;
  }

  /** Get notified when the camera/recording status changes. Returns an unsubscribe function. */
  onSession(fn: () => void): () => void {
    this.sessionListeners.add(fn);
    return () => this.sessionListeners.delete(fn);
  }

  async updateSettings(s: Settings) {
    this.settings = s;
    await saveSettings(s);
    this._session?.updateSettings(s);
  }

  refreshNav() {
    const r = this.routeId();
    const recording = this._session?.status.recording ?? false;
    clear(this.nav);
    for (const t of ROUTES) {
      this.nav.append(
        h(
          'a',
          { href: `#${t.id}`, class: `tab${t.id === r ? ' active' : ''}`, 'aria-current': t.id === r ? 'page' : null },
          icon(t.icon),
          h('span', {}, t.label),
          t.id === 'witness' && recording ? h('span', { class: 'rec-pip', 'aria-label': 'recording' }) : null,
          t.id === 'agora' && this.agora.joined ? h('span', { class: 'room-pip', 'aria-label': `in room, ${this.agora.othersCount} others` }, String(this.agora.othersCount)) : null,
        ),
      );
    }
    clear(this.lockBadge);
    this.lockBadge.append(icon(isUnlocked() ? 'unlock' : 'lock'), isUnlocked() ? 'Unlocked' : 'Locked');
    this.lockBadge.title = isUnlocked() ? 'Recordings can be watched on this device now' : 'Recordings are locked; recording still works';
  }

  private routeId(): Route {
    const id = location.hash.slice(1) as Route;
    return ROUTES.some((r) => r.id === id) ? id : 'witness';
  }

  private route() {
    this.current?.cleanup?.();
    const id = this.routeId();
    const view =
      id === 'agora' ? agoraView(this) : id === 'ledger' ? ledgerView(this) : id === 'verify' ? verifyView(this) : id === 'safety' ? safetyView(this) : witnessView(this);
    this.current = view;
    this.main.replaceChildren(view);
    document.body.dataset.route = id;
    this.refreshNav();
    // Leaving the camera screen stops the preview, unless a recording is running.
    if (id !== 'witness' && this._session && !this._session.status.recording && this._session.status.camera === 'on') {
      this._session.stopCamera();
    }
  }

  async wipe(removeApp: boolean) {
    try {
      await this._session?.destroy();
    } catch {
      /* keep wiping */
    }
    this._session = null;
    this.agora.leave();
    await wipeEverything({ removeApp });
    toast('Everything was wiped.');
    location.replace(location.pathname + (removeApp ? '' : '#witness'));
    location.reload();
  }
}
