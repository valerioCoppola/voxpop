import { h } from './dom';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

export function captureInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    listeners.forEach((l) => l());
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    listeners.forEach((l) => l());
  });
}

export function isInstalled(): boolean {
  return matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

function dismissed(): boolean {
  try {
    return sessionStorage.getItem('voxpop-install-dismissed') === '1';
  } catch {
    return false;
  }
}

export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  await deferred.prompt();
  const { outcome } = await deferred.userChoice;
  deferred = null;
  return outcome === 'accepted';
}

export function canPromptInstall(): boolean {
  return deferred !== null;
}

/** Encourages installing: an installed app works offline, full screen, and keeps its data longer. */
export function installBanner(): HTMLElement {
  const box = h('div', { class: 'install', hidden: true });
  const render = () => {
    box.replaceChildren();
    if (isInstalled() || dismissed() || (!deferred && !isIos())) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const text = deferred
      ? 'Install VoxPop to use it offline, full screen, with no browser bar.'
      : 'Install VoxPop: tap Share, then Add to Home Screen. It then works offline and full screen.';
    box.append(h('p', {}, text));
    if (deferred) box.append(h('button', { class: 'btn primary small', type: 'button', onclick: async () => { await promptInstall(); render(); } }, 'Install'));
    box.append(
      h(
        'button',
        {
          class: 'btn ghost small',
          type: 'button',
          'aria-label': 'Hide install suggestion',
          onclick: () => {
            try {
              sessionStorage.setItem('voxpop-install-dismissed', '1');
            } catch {
              /* ignore */
            }
            render();
          },
        },
        'Not now',
      ),
    );
  };
  listeners.add(render);
  render();
  return box;
}
