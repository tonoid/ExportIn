'use strict';

const { toRow, toRowFb, toRowIg, toCSV, toICS, rowStatus, fbStatus, fbProfileUrl, igProfileUrl, fbAge,
        sortComparator, fieldValue, birthdayOf, shouldAutoRetry, AUTO_RETRY, paceKey,
        effectiveDelay, PLATFORMS, photosHeld, brokenProbes, diagnostic } = globalThis.LIB;
const { t, setLang, detect, getLang, setNetwork, columnSlugs, LANGS } = globalThis.I18N;
const { icon, prefix } = globalThis.ICONS;
const { zipStore, safeName } = globalThis.ZIP;
const Photos = globalThis.PHOTOS;
const $ = (id) => document.getElementById(id);
const STALE_MS = 30000;
// Bumping this re-prompts everyone, which is the point if the wording ever
// changes in a way that matters.
const DISCLAIMER_VERSION = 3;
const PER_PAGE = 40;
const REPO = 'https://github.com/tonoid/ExportIn';

// --- which network ------------------------------------------------------
// One panel, one worker per network, one network on screen at a time. Every host, storage
// prefix, meta key, column list and file name comes from the descriptor, so
// switching tab is the only thing that changes.

const NETWORK = { linkedin: 'LinkedIn', facebook: 'Facebook', instagram: 'Instagram' };
// Where a label reads wrong on another network, the markup carries a variant
// as data-i18n-fb or data-i18n-ig.
const VARIANT = { facebook: 'Fb', instagram: 'Ig' };
const DEFAULT_SORT = { linkedin: ['connected', -1], facebook: ['birthday', 1], instagram: ['name', 1] };

let platform = 'linkedin';
const P = () => PLATFORMS[platform];
const isFb = () => platform === 'facebook';
const isIg = () => platform === 'instagram';

const statusOf = (rec) => (isFb() ? fbStatus(rec) : rowStatus(rec));
const rowOf = (rec) => (isFb() ? toRowFb(rec) : isIg() ? toRowIg(rec) : toRow(rec));
const linkOf = (rec) =>
  isFb() ? fbProfileUrl(rec) : isIg() ? igProfileUrl(rec) : `https://www.linkedin.com/in/${rec.publicId}/`;
const nameOf = (rec) =>
  `${rec.firstName || ''} ${rec.lastName || ''}`.trim() || rec.name || rec.publicId || '';

// --- talking to the worker tab ------------------------------------------

const workerTabs = () => chrome.tabs.query({ url: P().match });

// This page is orphaned the same way a content script is: reloading the
// extension leaves it running against a context that no longer exists.
const contextAlive = () => {
  try {
    return Boolean(chrome.runtime && chrome.runtime.id);
  } catch {
    return false;
  }
};

// Set while the panel is waiting on the LinkedIn tab. Without this the UI sat
// silent for several seconds after a click, because a tab we just created has to
// load LinkedIn before its content script answers a ping.
let busy = null;

async function ensureWorker() {
  let [tab] = await workerTabs();
  if (!tab) {
    busy = 'opening';
    renderProgress();
    tab = await chrome.tabs.create({ url: P().openUrl, active: false });
  }

  // A tab open since before the extension was installed has no content script,
  // and a freshly created one has not finished loading. One reload covers both.
  for (let attempt = 0; attempt < 2; attempt++) {
    for (let i = 0; i < 12; i++) {
      try {
        await chrome.tabs.sendMessage(tab.id, { cmd: 'ping', platform });
        return tab;
      } catch {
        await new Promise((r) => setTimeout(r, 700));
      }
    }
    if (attempt === 0) await chrome.tabs.reload(tab.id);
  }
  throw Object.assign(new Error('unreachable'), { key: 'unreachable' });
}

let disclaimerOk = false;

// Nothing reaches the network until the risk notice has been read once.
function allowed() {
  if (disclaimerOk) return true;
  $('disclaimer').showModal();
  return false;
}

// --- automatic recovery --------------------------------------------------
// A worker dies when its tab is closed, navigated away or reloaded, and nothing
// inside that tab can report its own death. The panel is the only witness, so it
// restarts the job instead of leaving it stalled until someone notices.
//
// The attempt counter only resets when a retry actually moved the work forward.
// A tab that dies on contact, over and over, therefore stops being retried after
// a few tries rather than looping all night.
let autoAttempts = 0;
let autoLastAttempt = 0;
let autoDoneAtAttempt = -1;

function autoRetryState(meta, stalled) {
  if (!stalled) { autoAttempts = 0; autoDoneAtAttempt = -1; return 'ok'; }
  if (meta.contactDone !== autoDoneAtAttempt) autoAttempts = 0; // progress was made
  return autoAttempts >= AUTO_RETRY.maxAttempts ? 'gaveup' : 'retrying';
}

async function autoRecover(meta) {
  autoAttempts += 1;
  autoLastAttempt = Date.now();
  autoDoneAtAttempt = meta.contactDone;
  await reopenAndResume();
}

// The worker is known dead, so clear the stale running flag and let ensureWorker
// find or open a LinkedIn tab, rather than telling the user to do it by hand.
async function reopenAndResume() {
  await patchMeta({ running: false, phase: 'paused', current: '' });
  const [tab] = await workerTabs();
  if (tab) await chrome.tabs.reload(tab.id);
  await command('start');
}

async function command(cmd) {
  if (!allowed()) return;
  busy = 'connecting';
  renderProgress();
  try {
    const tab = await ensureWorker();
    await chrome.tabs.sendMessage(tab.id, { cmd, platform });
  } catch (err) {
    await patchMeta({ running: false, phase: 'error', errorKey: err.key || 'unknown', errorInfo: '' });
  } finally {
    busy = null;
  }
  renderProgress();
}

// --- i18n ---------------------------------------------------------------

// A handful of labels read wrong on the other network: a Facebook friend is not
// a connection. Rather than branching in the renderer, the markup names the
// variant and this picks it.
function applyI18n() {
  const v = VARIANT[platform];
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t((v && el.dataset['i18n' + v]) || el.dataset.i18n);
  }
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) {
    el.placeholder = t((v && el.dataset['i18nPlaceholder' + v]) || el.dataset.i18nPlaceholder);
  }
  document.documentElement.lang = globalThis.I18N.getLang();
  // tonoid.com has a French edition and serves English to everyone else.
  document.querySelector('.brand').href = getLang() === 'fr' ? 'https://www.tonoid.com/fr' : 'https://www.tonoid.com';
}

// --- record cache -------------------------------------------------------
// Kept in memory and patched from storage events. Re-reading the whole store on
// a timer would mean pulling roughly a megabyte every few seconds just to redraw
// 40 rows.

let cache = [];
let byId = new Map();
let page = 0;
let query = '';
let sortKey = 'connected';
let sortDir = -1; // most recent first
let statusFilter = '';

function resort() {
  cache.sort((a, b) => (b.connectedAt || 0) - (a.connectedAt || 0));
  byId = new Map(cache.map((r) => [r.publicId, r]));
}

async function loadCache() {
  const all = await chrome.storage.local.get(null);
  cache = Object.keys(all).filter((k) => k.startsWith(P().prefix)).map((k) => all[k]);
  resort();
  await refreshPhotoCount();
  renderList();
}

// Only the photos belonging to the network on screen. Recomputed when the cache
// is reloaded, when photos are saved and when data is cleared, which is every
// moment the number can change; reading IndexedDB on the render tick would cost
// a store scan eight times a second for a figure that moves twice an hour.
async function refreshPhotoCount() {
  try {
    photoCount = photosHeld(cache, await Photos.ids(), platform);
  } catch {
    photoCount = 0;
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const keys = Object.keys(changes).filter((k) => k.startsWith(P().prefix));
  if (!keys.length) return;

  let added = false;
  for (const key of keys) {
    const rec = changes[key].newValue;
    if (!rec) return void loadCache(); // a deletion or a clear: start over
    const existing = byId.get(rec.publicId);
    if (existing) Object.assign(existing, rec);
    else { cache.push(rec); added = true; }
  }
  if (added) resort();
  renderListSoon();
});

// A running sync stores a record every few seconds, and rebuilding the rows
// under the pointer threw away the tooltip being hovered and moved the row
// being read. So the table waits until the pointer leaves it.
let listDeferred = false;
function renderListSoon() {
  if ($('rows').matches(':hover')) listDeferred = true;
  else renderList();
}
$('rows').addEventListener('mouseleave', () => {
  if (!listDeferred) return;
  listDeferred = false;
  renderList();
});

// --- list rendering -----------------------------------------------------

function matches(rec) {
  if (statusFilter && statusOf(rec) !== statusFilter) return false;
  if (!query) return true;
  const hay = isFb()
    ? rec.name || ''
    : isIg()
      ? `${rec.name || ''} ${rec.username || ''} ${rec.bio || ''} ${fieldValue(rec, 'email')}`
      : `${rec.firstName} ${rec.lastName} ${rec.headline || ''} ${fieldValue(rec, 'email')}`;
  return hay.toLowerCase().includes(query);
}

function initials(rec) {
  // By code point, not [0]: an emoji name would give half a surrogate pair,
  // which renders as a replacement glyph.
  const first = [...(rec.firstName || '').trim()][0] || '';
  const last = [...(rec.lastName || '').trim()][0] || '';
  return (first + last).toUpperCase() || '?';
}

function fallbackAvatar(rec) {
  const span = document.createElement('span');
  span.className = 'avatar';
  span.textContent = initials(rec);
  return span;
}

function avatar(rec) {
  if (!rec.photoUrl) return fallbackAvatar(rec);
  const img = document.createElement('img');
  img.className = 'avatar';
  img.src = rec.photoUrl;
  img.alt = '';
  img.loading = 'lazy';
  // Instagram's CDN answers with Cross-Origin-Resource-Policy: same-origin,
  // so an <img> on this page is refused. A fetch from the extension is not,
  // thanks to the host permission, so the bytes come in that way instead.
  img.onerror = async () => {
    if (img.src.startsWith('blob:')) return img.replaceWith(fallbackAvatar(rec));
    try {
      const res = await fetch(rec.photoUrl);
      if (!res.ok) throw new Error(String(res.status));
      const url = URL.createObjectURL(await res.blob());
      img.onload = () => URL.revokeObjectURL(url);
      img.src = url;
    } catch {
      img.replaceWith(fallbackAvatar(rec));
    }
  };
  return img;
}

// Names and headlines are attacker-controlled text from LinkedIn, and this page
// holds chrome.* privileges. Everything below is built with textContent.
function cell(text, className) {
  const td = document.createElement('td');
  if (className) td.className = className;
  const span = document.createElement('span');
  if (text) {
    span.className = 'trunc';
    span.textContent = text;
  } else {
    span.className = 'dash';
    span.textContent = '·';
  }
  td.append(span);
  return td;
}

const clip = (text, max) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}\u2026` : text;

const localeDate = (ms) => (ms ? new Date(ms).toLocaleDateString(globalThis.I18N.getLang()) : '');

function whoCell(rec) {
  const who = document.createElement('td');
  const wrap = document.createElement('div');
  wrap.className = 'who';
  const names = document.createElement('div');
  names.className = 'names';
  const link = document.createElement('a');
  link.href = linkOf(rec);
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = nameOf(rec);
  // Facebook has no headline, so its rows keep the name alone. Instagram shows
  // the handle there, which is what people actually recognise.
  const strap = isFb() ? '' : isIg() ? (rec.username ? '@' + rec.username : '') : rec.headline || '';
  const sub = document.createElement('small');
  sub.textContent = strap;
  sub.title = !isFb() && rec.prevHeadline ? `${rec.prevHeadline}  ->  ${rec.headline}` : strap;
  names.append(link, sub);

  // What the two optional LinkedIn passes bought, on one line under the
  // headline. Facebook keeps its single strap: its About is the card text,
  // which the strap already shows the first line of.
  if (!isFb()) {
    const extra = (isIg() ? [rec.bio || ''] : [fieldValue(rec, 'location'), rec.about || ''])
      .map((text) => text.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' \u00b7 ');
    if (extra) {
      const line = document.createElement('small');
      line.className = 'extra';
      line.textContent = clip(extra, 120);
      line.title = clip(extra, 600);
      names.append(line);
    }
  }
  wrap.append(avatar(rec), names);
  who.append(wrap);
  return who;
}

function statusCell(rec) {
  const status = document.createElement('td');
  const chip = document.createElement('span');
  const state = statusOf(rec);
  chip.className = `chip ${state}`;
  chip.textContent = t('st_' + state);
  const why = rec.contactError;
  if (why) chip.title = why;
  status.append(chip);
  return status;
}

// Both tabs format the birthday in the reader's locale. LinkedIn's text is in
// whatever language LinkedIn rendered it, so it is kept only when unparseable.
function birthdayText(rec) {
  const b = birthdayOf(rec);
  if (!b) return fieldValue(rec, 'birthday');
  const when = new Date(2000, b.month - 1, b.day || 1);
  return when.toLocaleDateString(getLang(), { day: 'numeric', month: 'short' });
}

function buildRow(rec) {
  const tr = document.createElement('tr');

  if (isFb()) {
    tr.append(
      whoCell(rec),
      cell(birthdayText(rec), 'c-bday'),
      cell(String(fbAge(rec) || ''), 'num c-age'),
      statusCell(rec),
    );
    return tr;
  }

  const mail = fieldValue(rec, 'email');
  const email = cell(mail);
  if (mail) email.title = mail;

  if (isIg()) {
    tr.append(whoCell(rec), email, cell(fieldValue(rec, 'phone'), 'num c-phone'),
      cell(fieldValue(rec, 'website')), statusCell(rec));
    return tr;
  }

  tr.append(
    whoCell(rec),
    cell(localeDate(rec.connectedAt), 'num'),
    email,
    cell(fieldValue(rec, 'phone'), 'num c-phone'),
    cell(birthdayText(rec), 'c-bday'),
    statusCell(rec),
  );
  return tr;
}

function renderHeaders() {
  for (const th of document.querySelectorAll('th[data-sort]')) {
    const active = th.dataset.sort === sortKey;
    th.setAttribute('aria-sort', active ? (sortDir === 1 ? 'ascending' : 'descending') : 'none');
    const name = active ? (sortDir === 1 ? 'arrow-up' : 'arrow-down') : 'chevrons-up-down';
    th.querySelector('.sorti').replaceChildren(icon(name, 13));
  }
}

function renderList() {
  const filtered = cache.filter(matches).sort(sortComparator(sortKey, sortDir, getLang()));
  const pages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  page = Math.min(page, pages - 1);

  $('rows').replaceChildren(
    ...filtered.slice(page * PER_PAGE, (page + 1) * PER_PAGE).map(buildRow),
  );

  $('empty').style.display = filtered.length ? 'none' : 'block';
  $('empty').textContent = cache.length ? t('emptyFilter') : t('emptyNone' + (VARIANT[platform] || ''));
  $('pageinfo').textContent = filtered.length
    ? `${t('page')} ${page + 1} / ${pages} · ${filtered.length} ${t('shown')}`
    : '';
  $('prev').disabled = page === 0;
  $('next').disabled = page >= pages - 1;
}

// --- progress -----------------------------------------------------------

function duration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}${t('u_s')}`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}${t('u_m')}`;
  return `${Math.floor(m / 60)}${t('u_h')} ${m % 60}${t('u_m')}`;
}

// --- profile photos ------------------------------------------------------
// The signed CDN links LinkedIn hands out expire after a few months, so a photo
// is only really yours once the bytes are on disk. These are plain CDN assets on
// a different host, fetched without a session, so they carry none of the account
// risk the LinkedIn API calls do and need no throttling.

let photoBusy = false;
let photoDone = 0;
let photoTotal = 0;
let photoFailed = 0;
let photoCount = 0;

async function pool(items, width, worker) {
  let next = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < items.length) await worker(items[next++]);
    }),
  );
}

async function savePhotos() {
  if (photoBusy || !allowed()) return;
  photoBusy = true;
  photoFailed = 0;
  photoDone = 0;
  try {
    const have = await Photos.ids();
    const todo = cache.filter((r) => r.photoUrl && !have.has(P().photoKey(r.publicId)));
    photoTotal = todo.length;
    renderProgress();

    await pool(todo, 4, async (rec) => {
      try {
        const res = await fetch(rec.photoUrl);
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        await Photos.put(P().photoKey(rec.publicId), blob, blob.type || 'image/jpeg');
      } catch {
        photoFailed += 1; // usually an expired link; a rescan refreshes them
      }
      photoDone += 1;
      if (photoDone % 5 === 0) renderProgress();
    });
  } finally {
    await refreshPhotoCount();
    photoBusy = false;
    photoTotal = 0;
    renderProgress();
  }
}

let startIcon = null;

// "Start" on a cold cache, "Resume" while there is still work queued, and
// "Sync now" once everything on disk is complete, because at that point the
// button only goes looking for what changed.
function startKey(meta) {
  if (!meta.listComplete) return meta.listStart || meta.found ? 'resume' : 'start';
  // Facebook queues nothing per person, so the button goes straight to "sync"
  // once the sweeps are done.
  const queued = !isFb() && cache.some((r) => !r.contactDone && !r.removed);
  return queued ? 'resume' : 'sync';
}

function decorate() {
  prefix($('pause'), 'pause');
  prefix($('check'), 'refresh-cw');
  prefix($('csv'), 'table');
  prefix($('ics'), 'cake');
  prefix($('json'), 'braces');
  prefix($('rescan'), 'rotate-ccw');
  prefix($('clear'), 'trash-2');
  prefix($('accept'), 'triangle-alert');
  prefix($('photos'), 'image');
  prefix($('zip'), 'archive');
  prefix($('prev'), 'chevron-left');
  $('next').append(icon('chevron-right'));
  const summary = document.querySelector('#menu > summary');
  summary.prepend(icon('download'));
  summary.append(icon('chevron-down', 14));
}

// The millisecond box meant nothing on its own. What people actually decide on
// is how long the job will take and how exposed it makes them, so that is what
// the control shows.
function renderPace(meta, remaining) {
  const delayMs = meta.delayMs || P().delayMs || 4000;
  const active = paceKey(delayMs);
  const PACE_LABEL = { cautious: 'paceCautious', balanced: 'paceBalanced', fast: 'paceFast', custom: 'paceCustomLabel' };
  for (const button of document.querySelectorAll('#pace button')) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.delay) === delayMs));
  }
  if (active === 'custom' && !$('paceCustom').open) $('paceCustom').open = true;

  const perProfile = effectiveDelay(delayMs, meta.pressure);
  const speed = `${(perProfile / 1000).toFixed(perProfile % 1000 ? 1 : 0)}s ${t('perProfile')}`;
  $('paceInfo').textContent = speed;

  // The card shows the outcome; the dialog holds the knobs.
  const summary = $('paceSummary');
  summary.textContent = `${t(PACE_LABEL[active])} \u00b7 ${speed}`;
  const warning =
    meta.pressure > 1.05 ? t('paceThrottled') : active === 'fast' ? t('paceFastWarning') : '';
  if (warning) {
    for (const host of [$('paceInfo'), summary]) {
      const note = document.createElement('span');
      note.className = 'warn';
      note.textContent = warning;
      host.append(note);
    }
  }
}

// --- measured speed ------------------------------------------------------
// The configured delay is what we ask for, not what we get: requests take time,
// retries stretch it and the adaptive back-off changes it mid-run. So the rate
// is measured from actual progress over a rolling window.

let samples = [];

function measuredRate(meta) {
  const now = Date.now();
  if (!meta.running) { samples = []; return null; }
  const last = samples[samples.length - 1];
  if (!last || last.done !== meta.contactDone) samples.push({ at: now, done: meta.contactDone });
  samples = samples.filter((s) => now - s.at < 300000); // five minute window
  if (samples.length < 2) return null;

  const first = samples[0];
  const latest = samples[samples.length - 1];
  const elapsed = latest.at - first.at;
  const gained = latest.done - first.done;
  if (elapsed < 20000 || gained <= 0) return null; // too early to be honest
  return (gained / elapsed) * 60000;
}

// The names already fetched stack up and fade, newest first. Only the new one
// is inserted, so the others keep their place instead of re-animating.
let lastSeen = null;

function pushSeen(id, name, photoUrl = '') {
  const key = id || name;
  if (!name || key === lastSeen) return;
  lastSeen = key;

  // The record carries the photo. It may not be cached yet for someone just
  // discovered, in which case the initials stand in on their own.
  const rec = byId.get(id)
    || { firstName: name.split(' ')[0] || name, lastName: name.split(' ')[1] || '', photoUrl };
  const line = document.createElement('div');
  line.className = 'seen';
  const label = document.createElement('span');
  label.textContent = name;
  line.append(avatar(rec), label);

  const box = $('current');
  box.prepend(line);
  while (box.children.length > 4) box.lastElementChild.remove();
  [...box.children].forEach((el, i) => el.style.setProperty('--depth', i));
}

function renderDiff(meta) {
  const box = $('diff');
  const scan = meta.lastScan;
  box.replaceChildren();
  if (!scan) return box.classList.remove('show');

  const when = document.createElement('span');
  when.textContent = `${t('lastSync')}: ${new Date(scan.at).toLocaleString(globalThis.I18N.getLang())}`;
  box.append(when);

  const counts = [
    ['diffNew', scan.added],
    ['diffUpdated', scan.updated],
    ['diffRemoved', scan.removed],
  ];
  if (counts.every(([, n]) => !n)) {
    const none = document.createElement('span');
    none.textContent = t('noChanges');
    box.append(none);
  } else {
    for (const [key, n] of counts) {
      const chip = document.createElement('span');
      chip.className = n ? 'dchip' : 'dchip zero';
      const label = document.createElement('span');
      label.textContent = t(key) + ' ';
      const value = document.createElement('b');
      value.textContent = n;
      chip.append(label, value);
      box.append(chip);
    }
  }
  // A partial sync cannot see removals, so say what the numbers cover.
  if (scan.incremental) {
    const note = document.createElement('span');
    note.className = 'dchip zero';
    note.textContent = t('cachedNote');
    box.append(note);
  }
  box.classList.add('show');
}

let ticker = null;
// Phases that are still discovering how many people there are.
const SCANNING = ['list', 'scan', 'birthdays', 'friends', 'following', 'followers'];

async function renderProgress() {
  if (!contextAlive()) {
    clearInterval(ticker);
    $('noticeText').textContent = t('notice_orphaned');
    const action = $('noticeAction');
    action.textContent = t('noticeRefresh');
    action.onclick = () => location.reload();
    action.classList.add('show');
    $('notice').classList.add('show');
    return;
  }
  const metas = await chrome.storage.local.get(Object.values(PLATFORMS).map((d) => d.metaKey));
  const meta = metas[P().metaKey] || {};
  const { phase = 'idle', found = 0, running = false } = meta;
  // Facebook has no per-person work: everyone stored is done. Reading its meta
  // instead showed "Not started" over 1486 friends after a failed sync.
  const contactDone = isFb() ? found : meta.contactDone || 0;

  // Each tab carries its own count, so the other network's progress stays
  // visible without switching to it.
  // Both networks can collect at once, each in its own tab, so each tab shows
  // its own ring and a job running out of sight stays visible.
  for (const [key, desc] of Object.entries(PLATFORMS)) {
    const m = metas[desc.metaKey] || {};
    const total = m.found || 0;
    $('count-' + key).textContent = total ? ` ${total}` : '';
    const ring = $('ring-' + key);
    ring.hidden = !(m.running && Date.now() - (m.lastActivity || 0) <= STALE_MS);
    const known = !ring.hidden && total > 0 && !SCANNING.includes(m.phase);
    const pct = known ? Math.round(Math.min(1, (m.contactDone || 0) / total) * 100) : 0;
    ring.classList.toggle('unknown', !ring.hidden && !known);
    // Inline wins over the class, so an unknown length must not carry a 0 here.
    if (known) ring.style.setProperty('--p', pct);
    else ring.style.removeProperty('--p');
    ring.title = known ? `${pct}%` : t('phase_' + (m.phase || 'idle'));
    if (known) ring.setAttribute('aria-valuenow', pct);
    else ring.removeAttribute('aria-valuenow');
  }
  $('enrichedLabel').textContent = t(isFb() ? 'withBirthday' : 'detailsFetched');

  $('found').textContent = found;
  // The Facebook card shows coverage where LinkedIn shows work done, because
  // with the detail pass off there is no per-person work to report.
  $('enriched').textContent = isFb() ? (meta.withBirthday || 0) : contactDone;
  $('photocount').textContent = photoCount;

  const bar = $('bar');
  const scanning = SCANNING.includes(phase);
  $('track').classList.toggle('indeterminate', scanning);

  if (scanning) {
    bar.style.width = '';
    // Facebook says what it is doing inside the phase: learning the query, then
    // how far the walk has got. LinkedIn's list sends neither and keeps the count.
    $('pct').textContent = meta.learning
      ? t('learningQuery')
      : meta.scanPage
        ? `${meta.scanSeen || 0} ${t('readSoFar')} · ${t('pageN')} ${meta.scanPage}`
        : `${found} ${t('foundSoFar')}`;
    $('eta').textContent = '';
  } else if (found > 0 && (['contact', 'done'].includes(phase) || contactDone > 0)) {
    const ratio = Math.min(1, contactDone / found);
    bar.style.width = `${(ratio * 100).toFixed(1)}%`;
    $('pct').textContent = `${contactDone} / ${found} · ${Math.round(ratio * 100)}%`;

    const left = found - contactDone;
    const rate = measuredRate(meta);
    if (running && left > 0) {
      // Fall back to the configured pace until enough has happened to measure.
      const msLeft = rate ? (left / rate) * 60000 : left * effectiveDelay(meta.delayMs, meta.pressure);
      const at = new Date(Date.now() + msLeft);
      $('eta').textContent = [
        rate ? `${rate.toFixed(rate < 10 ? 1 : 0)} ${t('perMinute')}` : t('measuring'),
        `${t('remaining')} ${duration(msLeft)}`,
        `${t('finishAround')} ${at.toLocaleTimeString(getLang(), { hour: '2-digit', minute: '2-digit' })}`,
      ].join(' · ');
    } else {
      $('eta').textContent = '';
    }
  } else {
    bar.style.width = '0%';
    $('pct').textContent = t('notStarted');
    $('eta').textContent = '';
  }

  const status = $('status');
  if (busy) {
    status.className = '';
    status.textContent = t('phase_' + busy);
  } else if (photoBusy) {
    status.className = '';
    status.textContent = `${t('phase_photos')} ${photoDone} / ${photoTotal}`;
    if (photoFailed) status.textContent += ` (${photoFailed} ${t('photosExpired')})`;
  } else if (phase === 'error' && ['needPage', 'broken'].includes(meta.errorKey)) {
    // The banner above already says it, with the button that fixes it.
    status.className = 'err';
    status.textContent = t('phase_stopped');
  } else if (phase === 'error') {
    status.className = 'err';
    status.textContent = t('err_' + (meta.errorKey || 'unknown'));
    // A breakage carries the probe key, which is an identifier, not a sentence.
    const detail = meta.errorKey === 'broken' && meta.errorInfo
      ? t('probe_' + meta.errorInfo)
      : meta.errorInfo;
    if (detail && !String(detail).startsWith('probe_')) status.textContent += ` (${detail})`;
  } else {
    status.className = phase === 'done' ? 'ok' : '';
    status.textContent = t('phase_' + phase) || t('phase_idle');
    if (running && meta.startedAt) {
      status.textContent += ` ${t('runningFor')} ${duration(Date.now() - meta.startedAt)}.`;
    }
  }
  if (running) pushSeen(meta.currentId, meta.current, meta.currentPhoto);
  // Instagram stores nobody until the followers are read, so an empty table
  // during the walk means "not yet", not "press Start".
  if (!cache.length && running && ['following', 'followers'].includes(phase)) {
    $('empty').textContent = t('emptyScanningIg');
  }
  else if (phase === 'idle' || phase === 'done') { $('current').replaceChildren(); lastSeen = null; }

  const key = startKey(meta);
  const label = $('start').querySelector('[data-i18n]');
  label.dataset.i18n = key;
  label.textContent = t(key);
  // Only touch the icon when it actually changes, otherwise the 800ms redraw
  // restarts the spinner animation from zero every tick.
  const wanted = busy ? 'loader-circle' : key === 'sync' ? 'refresh-cw' : 'play';
  if (wanted !== startIcon) {
    startIcon = wanted;
    prefix($('start'), wanted);
    $('start').querySelector('svg').classList.toggle('spin', wanted === 'loader-circle');
  }

  // A stalled worker is not a running one. Leaving `running` true here left every
  // control greyed out while the notice told the user to press Start.
  const stalled = running && Date.now() - (meta.lastActivity || 0) > STALE_MS;
  const active = running && !stalled;
  renderPace(meta, found - contactDone);
  $('start').disabled = active || !!busy;
  // While running, a greyed-out Start next to Pause read as two choices. There
  // is one, so Pause takes the whole row and the primary colour.
  $('start').hidden = active;
  $('pause').classList.toggle('primary', active);
  $('check').disabled = active || !!busy || !meta.listComplete;
  $('pause').disabled = !active;
  // Photos come from a different host entirely, but sharing the status line with
  // the scraper would make both harder to read, so they take turns.
  $('photos').disabled = active || !!busy || photoBusy || !cache.some((r) => r.photoUrl);
  if (document.activeElement !== $('delay')) $('delay').value = meta.delayMs || P().delayMs || 4000;
  for (const id of ['withProfile', 'withAbout']) {
    $(id).checked = Boolean(meta[id]);
    $(id).disabled = active;
  }

  renderDiff(meta);

  // Every notice that has a fix offers it as a button instead of instructions.
  const staleCache = !active && !busy && cache.length > 0 && !cache.some((r) => r.photoUrl);
  const recovery = autoRetryState(meta, stalled);

  const broken = brokenProbes(meta.health || {});

  let hint = null;
  // A shape change outranks every other notice: until it is fixed, nothing else
  // the panel could suggest would help.
  if (broken.length || meta.errorKey === 'broken') {
    const what = (broken.length ? broken : [meta.errorInfo].filter(Boolean))
      .map((key) => t('probe_' + key))
      .filter((label) => label && !label.startsWith('probe_'))
      .join(', ');
    hint = {
      text: what ? `${t('notice_broken')} (${what})` : t('notice_broken'),
      label: t('noticeReport'),
      run: () => openReport(meta),
    };
  } else if (meta.errorKey === 'needPage') {
    hint = { text: t(isIg() ? 'err_needPageIg' : 'err_needPage'), label: t('noticeLearn'), run: showLearnPage };
  } else if (stalled && recovery === 'retrying') hint = { text: t('notice_retrying') };
  else if (stalled) hint = { text: t('notice_gaveUp'), label: t('noticeReopen'), run: manualRetry };
  else if (staleCache) hint = { text: t('photosNeedRescan'), label: t('fullRescan'), run: () => command('rescan') };

  const notice = $('notice');
  $('noticeText').textContent = hint ? hint.text : '';
  const action = $('noticeAction');
  action.classList.toggle('show', !!(hint && hint.label));
  if (hint && hint.label) {
    action.textContent = hint.label;
    action.onclick = hint.run;
  }
  notice.classList.toggle('show', !!hint);
  if (hint) notice.querySelector('svg.lucide') || notice.prepend(icon('triangle-alert', 15));

  // shouldAutoRetry owns the decision, and it refuses on any fatal stop.
  if (
    !busy && disclaimerOk &&
    shouldAutoRetry(meta, { now: Date.now(), attempts: autoAttempts, lastAttemptAt: autoLastAttempt })
  ) {
    autoRecover(meta);
  }
}

// Sends the worker tab back to the page its queries are learnt on and starts
// again. The tab stays in the background: nothing here ever takes the front.
async function showLearnPage() {
  const [tab] = await workerTabs();
  if (tab) await chrome.tabs.update(tab.id, { url: P().openUrl });
  await command('start');
}

// --- reporting a breakage ------------------------------------------------
// Nobody can be expected to audit a bug report before sending it, so the body is
// built from counters only. No record, no name, no identifier, no token: see
// diagnostic() in lib.js, which is what decides that and is tested.

function openReport(meta, title = null) {
  const broken = brokenProbes(meta.health || {});
  const body = diagnostic({
    version: chrome.runtime.getManifest().version,
    platform,
    phase: meta.phase,
    errorKey: meta.errorKey,
    errorInfo: meta.errorInfo,
    lang: getLang(),
    health: meta.health || {},
    learnt: meta.learnt || [],
    seen: meta.seenQueries || 0,
  });
  title = title ?? `${NETWORK[platform]}: ${broken.join(', ') || meta.errorInfo || 'collection broken'}`;
  const url = `${REPO}/issues/new?title=${encodeURIComponent(title)}`
    + `&body=${encodeURIComponent('<!-- counters only, no personal data -->\n\n```\n' + body + '\n```\n\n')}`;
  chrome.tabs.create({ url });
}

// --- export -------------------------------------------------------------

function download(name, mime, text) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const stamp = () => new Date().toISOString().slice(0, 10);
const closeMenu = () => $('menu').removeAttribute('open');

// --- wiring -------------------------------------------------------------

const patchMeta = async (patch) => {
  const key = P().metaKey;
  const stored = (await chrome.storage.local.get(key))[key] || {};
  await chrome.storage.local.set({ [key]: { ...stored, ...patch } });
};

$('start').onclick = async () => {
  $('start').disabled = true;
  await patchMeta({ delayMs: Number($('delay').value) || 4000 });
  await command('start');
};

$('check').onclick = () => command('scan');

$('rescan').onclick = () => { closeMenu(); command('rescan'); };

$('pause').onclick = async () => {
  const [tab] = await workerTabs();
  if (tab) await chrome.tabs.sendMessage(tab.id, { cmd: 'pause', platform }).catch(() => {});
  await patchMeta({ running: false, phase: 'paused' });
  renderProgress();
};

$('delay').onchange = () => patchMeta({ delayMs: Number($('delay').value) || 4000 });

$('withProfile').onchange = (e) => patchMeta({ withProfile: e.target.checked });
$('withAbout').onchange = (e) => patchMeta({ withAbout: e.target.checked });

for (const button of document.querySelectorAll('#pace button')) {
  button.onclick = async () => {
    await patchMeta({ delayMs: Number(button.dataset.delay) });
    renderProgress();
  };
}

$('lang').onchange = async (e) => {
  setLang(e.target.value);
  await chrome.storage.local.set({ lang: globalThis.I18N.getLang() });
  applyI18n();
  renderList();
  renderProgress();
};

// Pressing the button after the automatic attempts ran out starts a fresh streak.
async function manualRetry() {
  autoAttempts = 0;
  autoDoneAtAttempt = -1;
  await reopenAndResume();
}

$('accept').onclick = async () => {
  disclaimerOk = true;
  await chrome.storage.local.set({ disclaimer: DISCLAIMER_VERSION });
  $('disclaimer').close();
  renderProgress();
};

$('showDisclaimer').onclick = () => $('disclaimer').showModal();
$('settingsBtn').onclick = () => $('settings').showModal();
$('settingsClose').onclick = () => $('settings').close();

// A modal <dialog> reports a backdrop click as a click on the dialog itself,
// since the backdrop is a pseudo-element with no node of its own. The
// disclaimer is left out on purpose: consent should take a deliberate answer.
$('settings').addEventListener('click', (e) => {
  if (e.target === $('settings')) $('settings').close();
});

$('statusFilter').onchange = (e) => {
  statusFilter = e.target.value;
  page = 0;
  renderList();
};

for (const th of document.querySelectorAll('th[data-sort]')) {
  th.querySelector('button').onclick = () => {
    const key = th.dataset.sort;
    if (key === sortKey) sortDir = -sortDir;
    else { sortKey = key; sortDir = key === 'connected' ? -1 : 1; } // dates read best newest first
    page = 0;
    renderHeaders();
    renderList();
  };
}

// Switching tab resets everything that is scoped to one network: the sort key
// (the columns are not the same), the filters, the speed samples and the fade
// stack. The record cache is reloaded from the other prefix.
async function switchPlatform(next) {
  if (next === platform || !PLATFORMS[next]) return;
  platform = next;
  document.body.dataset.platform = platform;
  setNetwork(NETWORK[platform]);
  for (const tab of document.querySelectorAll('.tabs button')) {
    tab.setAttribute('aria-selected', String(tab.dataset.platform === platform));
  }
  [sortKey, sortDir] = DEFAULT_SORT[platform];
  page = 0;
  query = '';
  statusFilter = '';
  $('search').value = '';
  $('statusFilter').value = '';
  samples = [];
  lastSeen = null;
  autoAttempts = 0;
  autoDoneAtAttempt = -1;
  $('current').replaceChildren();
  await chrome.storage.local.set({ platform });
  applyI18n();
  renderHeaders();
  await loadCache();
  await renderProgress();
}

for (const tab of document.querySelectorAll('.tabs button')) {
  tab.onclick = () => switchPlatform(tab.dataset.platform);
}

$('search').oninput = (e) => {
  query = e.target.value.trim().toLowerCase();
  page = 0;
  renderList();
};

$('prev').onclick = () => { page = Math.max(0, page - 1); renderList(); };
$('next').onclick = () => { page += 1; renderList(); };

$('csv').onclick = () => {
  closeMenu();
  download(`${P().fileStem}-${stamp()}.csv`, 'text/csv',
    toCSV(cache.map(rowOf), P().columns, columnSlugs()));
};

$('ics').onclick = () => {
  closeMenu();
  const rows = cache.map(rowOf);
  if (!rows.some((r) => r.monthBday)) return alert(t('noBirthdays'));
  download(`${P().icsStem}-${stamp()}.ics`, 'text/calendar', toICS(rows));
};

$('photos').onclick = savePhotos;

$('zip').onclick = async () => {
  closeMenu();
  // Only this network's photos: the store holds both, keyed apart.
  const mine = new Set(cache.map((r) => P().photoKey(r.publicId)));
  const stored = (await Photos.all()).filter((photo) => mine.has(photo.id));
  if (!stored.length) return alert(t('noPhotos'));
  const entries = [
    {
      name: `${P().fileStem}.csv`,
      data: new TextEncoder().encode(toCSV(cache.map(rowOf), P().columns, columnSlugs())),
    },
  ];
  for (const photo of stored) {
    entries.push({
      name: `photos/${safeName(photo.id)}.${Photos.extFor(photo.type)}`,
      data: new Uint8Array(await photo.blob.arrayBuffer()),
    });
  }
  download(`${P().fileStem}-${stamp()}.zip`, 'application/zip', zipStore(entries));
};

$('json').onclick = () => {
  closeMenu();
  download(`${P().fileStem}-${stamp()}.json`, 'application/json', JSON.stringify(cache, null, 2));
};

// Clears the network on screen and leaves the other one alone, which is what
// the tab you are looking at implies. A blanket wipe would be a nasty surprise
// after hours of collecting on the other side.
$('clear').onclick = async () => {
  closeMenu();
  if (!confirm(t('clearConfirm'))) return;
  const all = await chrome.storage.local.get(null);
  const mine = Object.keys(all).filter((k) => k.startsWith(P().prefix));
  await Photos.remove(cache.map((r) => P().photoKey(r.publicId)));
  await chrome.storage.local.remove([...mine, P().metaKey]);
  cache = [];
  byId = new Map();
  await refreshPhotoCount();
  samples = [];
  renderList();
  renderProgress();
};

// Any problem, not only a detected breakage. Same counters-only report, so
// what a developer needs arrives without anyone pasting their own data.
$('reportProblem').onclick = async () => {
  const meta = (await chrome.storage.local.get(P().metaKey))[P().metaKey] || {};
  openReport(meta, `${NETWORK[platform]}: `);
};

// The way out when a run is wedged in a state nothing else clears. Both
// networks, photos and settings, so it asks first and says so.
// ponytail: a worker mid-request may still store one record after the wipe;
// the next sync treats it as already known, which is harmless.
$('resetAll').onclick = async () => {
  if (!confirm(t('resetConfirm'))) return;
  for (const desc of Object.values(PLATFORMS)) {
    for (const tab of await chrome.tabs.query({ url: desc.match })) {
      await chrome.tabs.sendMessage(tab.id, { cmd: 'pause', platform: desc.key }).catch(() => {});
    }
  }
  // Kept so the toolbar icon still finds this tab instead of opening another.
  const { panelTabId } = await chrome.storage.local.get('panelTabId');
  await chrome.storage.local.clear();
  await Photos.clear();
  if (panelTabId !== undefined) await chrome.storage.local.set({ panelTabId });
  location.reload();
};

// <details> does not close on an outside click by itself.
document.addEventListener('click', (e) => {
  if (!$('menu').contains(e.target)) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
});

(async () => {
  const { lang, disclaimer, platform: saved } = await chrome.storage.local.get(
    ['lang', 'disclaimer', 'platform'],
  );
  disclaimerOk = disclaimer === DISCLAIMER_VERSION;
  if (PLATFORMS[saved]) platform = saved;
  document.body.dataset.platform = platform;
  setNetwork(NETWORK[platform]);
  for (const tab of document.querySelectorAll('.tabs button')) {
    tab.setAttribute('aria-selected', String(tab.dataset.platform === platform));
  }
  [sortKey, sortDir] = DEFAULT_SORT[platform];
  // chrome.i18n.getUILanguage() is the browser's own UI language. navigator.language
  // can follow page or accept-language settings instead, so it is only a fallback.
  const browserLang = chrome.i18n?.getUILanguage?.() || navigator.language;
  setLang(LANGS.includes(lang) ? lang : detect(browserLang));
  $('lang').value = getLang();
  decorate();
  applyI18n();
  renderHeaders();
  await loadCache();
  renderProgress();
  ticker = setInterval(renderProgress, 800);
  if (!disclaimerOk) $('disclaimer').showModal();
})();
