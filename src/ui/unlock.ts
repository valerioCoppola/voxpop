import { h } from './dom';
import { isUnlocked, tryAutoUnlock, unlock } from '../storage/vault';

/** Makes sure the vault is open, asking for the passphrase if needed. Resolves false if cancelled. */
export async function ensureUnlocked(): Promise<boolean> {
  if (isUnlocked() || (await tryAutoUnlock())) return true;
  return new Promise((resolve) => {
    const input = h('input', { type: 'password', autocomplete: 'current-password', required: true, id: 'unlock-pass', 'aria-label': 'Passphrase' });
    const err = h('p', { class: 'form-error', role: 'alert' });
    const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Unlock');
    const cancel = h('button', { class: 'btn', type: 'button' }, 'Cancel');
    const form = h(
      'form',
      { method: 'dialog', class: 'dialog-body' },
      h('h2', {}, 'Unlock your recordings'),
      h('p', { class: 'muted' }, 'Your recordings are encrypted with your passphrase. Recording works without it; watching and sharing need it.'),
      h('label', { for: 'unlock-pass' }, 'Passphrase'),
      input,
      err,
      h('div', { class: 'row end' }, cancel, submit),
    );
    const dlg = h('dialog', { class: 'dialog' }, form);
    document.body.appendChild(dlg);
    const finish = (ok: boolean) => {
      dlg.close();
      dlg.remove();
      resolve(ok);
    };
    cancel.addEventListener('click', () => finish(false));
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      finish(false);
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submit.disabled = true;
      submit.textContent = 'Unlocking…';
      try {
        await unlock(input.value);
        input.value = '';
        finish(true);
      } catch (ex) {
        err.textContent = (ex as Error).message;
        submit.disabled = false;
        submit.textContent = 'Unlock';
        input.select();
      }
    });
    dlg.showModal();
    input.focus();
  });
}
