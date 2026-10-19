import { clear, fmtBytes, fmtDateTime, fmtDuration, h, icon, shareOrDownload, toast, holdButton } from './dom';
import { ensureUnlocked } from './unlock';
import { aggregateCells, worldMap } from './map';
import type { App } from './app';
import { fingerprint } from '../core/crypto';
import { cellKey, describeCell } from '../core/geo';
import type { Cell } from '../core/types';
import {
  deleteRecording, exportBundle, getRecords, listRecordings, listRejected, loadVideo, type RecordingRow,
} from '../storage/repo';
import { buildManifest } from '../core/bundle';

const STATUS_TEXT: Record<RecordingRow['status'], string> = {
  recording: 'In progress',
  sealed: 'Sealed',
  interrupted: 'Interrupted, sealed later',
  unsealed: 'Unsealed',
};

function durationOf(r: RecordingRow): number {
  return Math.max(0, (r.seal?.rec.t ?? r.lastT) - r.header.rec.t);
}

function statusBadge(r: RecordingRow): HTMLElement {
  const cls = r.status === 'sealed' ? 'ok' : r.status === 'recording' ? 'busy' : 'warn';
  return h('span', { class: `badge ${cls}` }, STATUS_TEXT[r.status]);
}

/** What anyone receiving this recording would see: the public manifest, minus the video bytes. */
async function publicRecord(r: RecordingRow): Promise<string> {
  const m = await buildManifest(r.header, await getRecords(r.rid), r.seal, r.beacons, new Uint8Array(0));
  const { video: _v, ...rest } = m;
  void _v;
  return JSON.stringify({ ...rest, video: { file: m.video.file, mime: m.video.mime, size: r.bytes } }, null, 2);
}

async function openDetail(r: RecordingRow, onChange: () => void) {
  const fp = await fingerprint(r.header.rec.pub);
  const videoBox = h('div', { class: 'detail-video' });
  const pre = h('pre', { class: 'json', tabindex: 0 }, 'Loading…');
  const h0 = r.header.rec;
  let url: string | null = null;

  const facts: [string, string][] = [
    ['Recorded', fmtDateTime(h0.t)],
    ['Length', fmtDuration(durationOf(r))],
    ['Area', h0.cell ? describeCell(h0.cell) : 'Not shared'],
    ['Faces', h0.faces === 'unmasked' ? 'Not covered' : h0.faces === 'masked-fast' ? 'Covered, fast scan' : 'Covered, full scan'],
    ['Audio', h0.audio === 'disguised' ? 'Voices disguised' : h0.audio === 'muted' ? 'No audio' : 'Original voices'],
    ['Signing key', `${fp} (${h0.identity === 'one-time' ? 'one-time' : 'pseudonym'})`],
    ['Pieces', `${r.chunks} signed pieces, ${fmtBytes(r.bytes)}`],
    ['Time proof', r.beacons.length ? `drand rounds ${r.beacons[0].round}–${r.beacons.at(-1)!.round}` : 'Device clock only'],
    ['Source', r.origin === 'own' ? 'Recorded on this device' : r.origin === 'live' ? 'Saved while watching live, verified piece by piece' : 'Received as a file and verified'],
    ['Status', STATUS_TEXT[r.status]],
  ];

  const play = h('button', { class: 'btn', type: 'button' }, 'Play');
  play.addEventListener('click', async () => {
    if (!(await ensureUnlocked())) return;
    play.disabled = true;
    play.textContent = 'Decrypting…';
    try {
      const bytes = await loadVideo(r.rid);
      url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: h0.mime.split(';')[0] }));
      clear(videoBox);
      videoBox.append(h('video', { src: url, controls: true, playsinline: true }));
    } catch (e) {
      toast(`Cannot play: ${(e as Error).message}`);
      play.disabled = false;
      play.textContent = 'Play';
    }
  });
  videoBox.append(play);

  const share = h('button', { class: 'btn primary', type: 'button' }, icon('share'), 'Share file');
  share.addEventListener('click', async () => {
    if (!(await ensureUnlocked())) return;
    share.disabled = true;
    try {
      const { bytes, name } = await exportBundle(r.rid);
      const how = await shareOrDownload(bytes, name);
      toast(how === 'shared' ? 'Shared.' : `Saved ${name}`);
    } catch (e) {
      toast(`Export failed: ${(e as Error).message}`);
    } finally {
      share.disabled = false;
    }
  });

  const dlg = h('dialog', { class: 'dialog sheet', 'aria-label': 'Recording details' });
  const close = () => {
    if (url) URL.revokeObjectURL(url);
    dlg.close();
    dlg.remove();
  };
  const del = holdButton('Hold to delete', 1200, async () => {
    await deleteRecording(r.rid);
    close();
    toast('Recording deleted from this device.');
    onChange();
  });

  dlg.append(
    h(
      'div',
      { class: 'dialog-body' },
      h('div', { class: 'row between' }, h('h2', {}, 'Recording'), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: close }, icon('x'))),
      videoBox,
      h('dl', { class: 'facts' }, ...facts.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
      h('div', { class: 'row' }, share, r.status === 'recording' ? null : del),
      h('h3', {}, 'Public record'),
      h('p', { class: 'muted' }, 'This is everything a shared file contains besides the video itself. No name, account, device ID or exact position.'),
      pre,
    ),
  );
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });
  document.body.appendChild(dlg);
  dlg.showModal();
  pre.textContent = await publicRecord(r);
}

export function ledgerView(_app: App): HTMLElement {
  const summary = h('p', { class: 'lede' }, 'Loading…');
  const mapBox = h('figure', { class: 'map-figure' });
  const filterRow = h('div', { class: 'seg', role: 'group', 'aria-label': 'Show' });
  const cellNote = h('div', { class: 'cell-note' });
  const list = h('div', { class: 'list', role: 'list' });
  const rejectedBox = h('div');
  let source: 'all' | 'own' | 'imported' = 'all';
  let cellFilter: Cell | null = null;
  let rows: RecordingRow[] = [];

  const renderList = async () => {
    clear(list);
    const shown = rows.filter(
      (r) => (source === 'all' || (source === 'own' ? r.origin === 'own' : r.origin !== 'own')) && (!cellFilter || (r.header.rec.cell && cellKey(r.header.rec.cell) === cellKey(cellFilter))),
    );
    clear(cellNote);
    if (cellFilter) {
      cellNote.append(
        h('span', {}, `Showing ${describeCell(cellFilter)}`),
        h('button', { class: 'btn ghost small', type: 'button', onclick: () => { cellFilter = null; void renderList(); } }, 'Show all areas'),
      );
    }
    if (!shown.length) {
      list.append(
        h('div', { class: 'empty' },
          h('p', {}, rows.length ? 'Nothing matches this filter.' : 'No recordings yet. Record one in Witness, or check a file someone sent you in Verify.'),
        ),
      );
      return;
    }
    for (const r of shown) {
      const fp = await fingerprint(r.header.rec.pub);
      list.append(
        h(
          'button',
          { class: 'list-row', type: 'button', role: 'listitem', onclick: () => void openDetail(r, refresh) },
          h('span', { class: 'lr-when' }, fmtDateTime(r.header.rec.t)),
          h('span', { class: 'lr-len' }, fmtDuration(durationOf(r))),
          h('span', { class: 'lr-area' }, r.header.rec.cell ? describeCell(r.header.rec.cell) : 'No area'),
          h('span', { class: 'lr-src' }, r.origin === 'own' ? 'Yours' : r.origin === 'live' ? 'Saved live' : 'Received'),
          h('span', { class: 'lr-key' }, fp),
          statusBadge(r),
        ),
      );
    }
  };

  const renderFilters = () => {
    clear(filterRow);
    for (const [k, label] of [['all', 'All'], ['own', 'Yours'], ['imported', 'Received']] as const) {
      filterRow.append(
        h('button', { type: 'button', 'aria-pressed': String(source === k), onclick: () => { source = k; renderFilters(); void renderList(); } }, label),
      );
    }
  };

  async function refresh() {
    rows = await listRecordings();
    const rejected = await listRejected();
    const total = rows.reduce((n, r) => n + durationOf(r), 0);
    const areas = aggregateCells(rows.map((r) => r.header.rec.cell));
    const by = (s: RecordingRow['status']) => rows.filter((r) => r.status === s).length;
    const own = rows.filter((r) => r.origin === 'own').length;
    summary.textContent = rows.length
      ? `${rows.length} recording${rows.length === 1 ? '' : 's'} (${own} yours, ${rows.length - own} received), ${fmtDuration(total)} in total, from ${areas.length} area${areas.length === 1 ? '' : 's'}. ${by('sealed')} sealed, ${by('interrupted')} interrupted, ${by('unsealed')} unsealed. ${rejected.length} file${rejected.length === 1 ? '' : 's'} rejected.`
      : 'Nothing recorded or received yet.';

    clear(mapBox);
    const noArea = rows.filter((r) => !r.header.rec.cell).length;
    if (areas.length) {
      mapBox.append(
        worldMap(areas, (c) => { cellFilter = c; void renderList(); }),
        h('figcaption', {}, `Recordings per area; dot size shows how many. Tap a dot to filter the list.${noArea ? ` ${noArea} ${noArea === 1 ? 'recording shared' : 'recordings shared'} no area and ${noArea === 1 ? 'is' : 'are'} not on the map.` : ''}`),
      );
    }
    renderFilters();
    await renderList();

    clear(rejectedBox);
    if (rejected.length) {
      rejectedBox.append(
        h('h2', {}, 'Files that failed checks'),
        h('p', { class: 'muted' }, 'Listed so nothing is hidden, but never played and never counted above.'),
        h('ul', { class: 'rejected' }, ...rejected.map((x) =>
          h('li', {}, h('strong', {}, x.fileName), h('span', { class: 'muted' }, ` ${fmtDateTime(x.at)}: `), x.reason),
        )),
      );
    }
  }
  void refresh();

  return h(
    'section',
    { class: 'view page ledger' },
    h('h1', {}, 'Ledger'),
    h('p', { class: 'muted' }, 'Every recording on this device, yours and received, with the facts anyone can check. A received file appears here only after passing every check in Verify.'),
    summary,
    mapBox,
    h('div', { class: 'row between wrap' }, filterRow, cellNote),
    h('div', { class: 'list-head', 'aria-hidden': 'true' }, h('span', {}, 'When'), h('span', {}, 'Length'), h('span', {}, 'Area'), h('span', {}, 'Source'), h('span', {}, 'Key'), h('span', {}, 'Status')),
    list,
    rejectedBox,
  );
}
