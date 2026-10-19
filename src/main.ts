import './styles.css';
import { App } from './ui/app';
import { captureInstallPrompt } from './ui/install';
import { ensureVault, tryAutoUnlock } from './storage/vault';
import { recoverInterrupted } from './storage/repo';
import { toast } from './ui/dom';

async function boot() {
  const root = document.getElementById('app')!;
  captureInstallPrompt();
  if (!window.isSecureContext || !crypto?.subtle) {
    root.textContent = 'VoxPop needs a secure connection (https or localhost) to use the camera and encryption.';
    return;
  }
  try {
    await ensureVault();
    await tryAutoUnlock(); // opens silently unless a passphrase is set
    const recovered = await recoverInterrupted();
    const app = new App();
    await app.init(root);
    if (recovered) toast(`${recovered} interrupted recording${recovered === 1 ? ' was' : 's were'} sealed and kept.`);
    // Ask the browser not to evict our storage under pressure.
    void navigator.storage?.persist?.();
  } catch (e) {
    root.textContent = `VoxPop could not start: ${(e as Error).message}`;
  }

  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
  }
}

void boot();
