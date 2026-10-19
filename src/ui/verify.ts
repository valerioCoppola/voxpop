import { clear, fmtBytes, fmtDateTime, fmtDuration, h, icon, toast } from './dom';
import type { App } from './app';
import { parseBundle } from '../core/bundle';
import { verifyManifest, type Check, type VerifyReport } from '../core/verify';
import { describeCell } from '../core/geo';
import { addRejected, getRecording, importVerified } from '../storage/repo';
import type { Manifest } from '../core/types';

const LEVEL_ICON: Record<Check['level'], string> = { pass: 'check', fail: 'x', warn: 'warn', info: 'info' };
const LEVEL_TEXT: Record<Check['level'], string> = { pass: 'Passed', fail: 'Failed', warn: 'Caution', info: 'Note' };

function checkList(r: VerifyReport): HTMLElement {
  return h(
    'ol',
    { class: 'checks' },
    ...r.checks.map((c) =>
      h('li', { class: `check ${c.level}` }, icon(LEVEL_ICON[c.level]), h('div', {}, h('strong', {}, c.title), h('span', { class: 'sr-only' }, ` (${LEVEL_TEXT[c.level]})`), h('p', {}, c.detail))),
    ),
  );
}

export function verifyView(_app: App): HTMLElement {
  const out = h('div', { class: 'verify-out', 'aria-live': 'polite' });
  const input = h('input', { type: 'file', accept: '.voxpop,.zip,application/zip', id: 'verify-file', class: 'sr-only' });
  const drop = h(
    'label',
    { class: 'drop', for: 'verify-file' },
    icon('file', 'icon big'),
    h('strong', {}, 'Choose a .voxpop file'),
    h('span', { class: 'muted' }, 'or drop it here. It is checked on this device; nothing is uploaded.'),
  );
  let videoUrl: string | null = null;

  const run = async (file: File) => {
    clear(out);
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    videoUrl = null;
    out.append(h('p', { class: 'muted' }, `Checking ${file.name} (${fmtBytes(file.size)})…`));
    let report: VerifyReport;
    let parsed: ReturnType<typeof parseBundle> | null = null;
    try {
      parsed = parseBundle(new Uint8Array(await file.arrayBuffer()));
      report = await verifyManifest(parsed.manifest, parsed.video);
    } catch (e) {
      report = { ok: false, checks: [{ level: 'fail', title: 'Opening the file', detail: (e as Error).message }], summary: null };
    }
    clear(out);

    if (!report.ok) {
      const failed = report.checks.find((c) => c.level === 'fail')!;
      const rid = (parsed?.manifest as Manifest | undefined)?.header?.rec?.r;
      await addRejected({ at: Date.now(), fileName: file.name.slice(0, 120), reason: `${failed.title}: ${failed.detail}`, recordingId: typeof rid === 'string' ? rid.slice(0, 32) : null });
      out.append(
        h('div', { class: 'verdict fail' }, icon('x', 'icon big'), h('div', {}, h('h2', {}, 'This file did not pass'), h('p', {}, 'It has been listed under "Files that failed checks" in the Ledger. It will not be played or counted.'))),
        checkList(report),
      );
      return;
    }

    const s = report.summary!;
    const exists = !!(await getRecording(s.recordingId));
    const add = h('button', { class: 'btn primary', type: 'button', disabled: exists }, exists ? 'Already in your ledger' : 'Add to ledger');
    add.addEventListener('click', async () => {
      if (!parsed) return;
      add.disabled = true;
      const res = await importVerified(parsed.manifest as Manifest, parsed.video, report);
      add.textContent = res === 'added' ? 'Added to ledger' : 'Already in your ledger';
      toast(res === 'added' ? 'Added to your ledger, encrypted on this device.' : 'Already in your ledger.');
    });

    videoUrl = URL.createObjectURL(new Blob([parsed!.video as BlobPart], { type: (parsed!.manifest as Manifest).video.mime.split(';')[0] }));
    out.append(
      h(
        'div',
        { class: 'verdict ok' },
        icon('verify', 'icon big'),
        h('div', {}, h('h2', {}, 'Intact and authentic'), h('p', {}, `${fmtDuration(s.durationMs)} recorded ${fmtDateTime(s.start)}${s.cell ? `, ${describeCell(s.cell)}` : ''}. Signed by key ${s.keyFingerprint}.`)),
      ),
      h('video', { class: 'verify-video', src: videoUrl, controls: true, playsinline: true }),
      h('div', { class: 'row' }, add),
      checkList(report),
      h('p', { class: 'muted small' }, 'What this proves: the video is exactly what the recording key signed, piece by piece, and (with time proof) when it was signed. It does not prove who filmed it or that the scene was not staged. Independent recordings of the same event are what make that convincing.'),
    );
  };

  input.addEventListener('change', () => {
    const f = input.files?.[0];
    if (f) void run(f);
    input.value = '';
  });
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = e.dataTransfer?.files?.[0];
    if (f) void run(f);
  });

  return h(
    'section',
    { class: 'view page verify' },
    h('h1', {}, 'Verify'),
    h('p', { class: 'muted' }, 'Check a recording someone sent you: whether any piece was changed, removed or reordered, and what it says about time, place, faces and voices.'),
    input,
    drop,
    out,
  );
}
