// Runs in a linkedin.com tab. All fetching happens here so the browser attaches
// your session cookies automatically and everything is same-origin.
//
// Why a content script and not a service worker: MV3 kills a service worker
// after ~30s idle, which is fatal for a job that deliberately sleeps 4s between
// requests. A content script in an open tab has no such limit. The cost is that
// you keep one LinkedIn tab open.

if (window.top === window) (() => {
  'use strict';

  const { parseContact, parseProfile, parseAbout, photoUrl, diffRecord, mergeRecord,
          nextPressure, effectiveDelay, noteProbe, probeVerdict } = globalThis.LIB;
  const store = chrome.storage.local;

  const CONTACT_SCREEN = 'com.linkedin.sdui.flagshipnav.profile.ProfileContactDetailsOverlay';
  const PROFILE_SCREEN = 'com.linkedin.sdui.flagshipnav.profile.Profile';
  // The About lives in its own component, not in the profile screen, and answers
  // in about 32 KB where the screen costs 400.
  const ABOUT_COMPONENT = 'com.linkedin.sdui.generated.profile.dsl.impl.profileCardsAboveActivity';
  const LIST_URL = (start, count) =>
    '/voyager/api/relationships/dash/connections' +
    '?decorationId=com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithProfile-16' +
    `&count=${count}&q=search&sortType=RECENTLY_ADDED&start=${start}`;

  const PAGE_SIZE = 40;
  const LIST_DELAY = 2500;
  const DEFAULT_DELAY = 4000;
  const STALE_WORKER_MS = 30000;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (ms, spread = 0.4) => Math.round(ms * (1 + (Math.random() * 2 - 1) * spread));

  const DEFAULT_META = {
    running: false, phase: 'idle', listStart: 0, listComplete: false,
    found: 0, contactDone: 0, errorKey: null, errorInfo: '',
    delayMs: DEFAULT_DELAY, pressure: 1, withProfile: false, withAbout: false, health: {},
    startedAt: null, lastActivity: 0, current: '', currentId: '',
    lastScan: null,
  };

  // A content script outlives the extension that injected it. Reloading or
  // updating the extension leaves this copy running, with every chrome.* call
  // throwing "Extension context invalidated". The console noise is the small
  // part: the loop would carry on hitting LinkedIn while being unable to store a
  // single result, burning rate limit for nothing. So we check before we fetch
  // and stop the moment the context is gone.
  const contextAlive = () => {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  };

  const orphaned = () => Object.assign(new Error('orphaned'), { orphaned: true });
  function assertAlive() {
    if (!contextAlive()) throw orphaned();
  }

  const getMeta = async () => {
    assertAlive();
    return { ...DEFAULT_META, ...(await store.get('meta')).meta };
  };
  const patchMeta = async (patch) => {
    assertAlive();
    const meta = { ...(await getMeta()), ...patch };
    await store.set({ meta });
    return meta;
  };

  const countRecords = async () =>
    Object.keys(await store.get(null)).filter((k) => k.startsWith('p:')).length;

  function csrfToken() {
    const m = document.cookie.match(/JSESSIONID=([^;]+)/);
    return m ? decodeURIComponent(m[1]).replace(/"/g, '') : '';
  }

  // Errors travel as keys, not sentences, so the panel renders them in whatever
  // language the user picked.
  const fatal = (key, info = '') => Object.assign(new Error(key), { fatal: true, key, info });

  // A 429/999 or a checkpoint redirect means LinkedIn already noticed us. Stop
  // outright rather than backing off: more traffic makes a challenge worse.
  function guard(res) {
    if (res.status === 429 || res.status === 999) throw fatal('rateLimited', String(res.status));
    if (/\/(checkpoint|authwall|uas\/login)/.test(res.url)) throw fatal('checkpoint');
  }

  let stopping = false;
  let running = false;
  let pressure = 1; // multiplier on the configured delay, raised by retries
  let health = {};

  // A request that succeeded and produced nothing is the shape of a broken
  // parser. One of them is a private profile; forty in a row is LinkedIn having
  // changed something. Throwing here stops the run before it marks two thousand
  // people as collected with empty fields, which would otherwise force a wipe.
  function probe(key, yielded) {
    health = noteProbe(health, key, yielded);
    if (probeVerdict(health, key) === 'broken') throw fatal('broken', key);
  }

  // --- Pass A: the connection list ---------------------------------------

  async function fetchListPage(start) {
    const res = await fetch(LIST_URL(start, PAGE_SIZE), {
      headers: { 'csrf-token': csrfToken(), accept: 'application/vnd.linkedin.normalized+json+2.1' },
    });
    guard(res);
    if (!res.ok) throw fatal('listFailed', `HTTP ${res.status}`);
    const included = (await res.json()).included || [];
    // The raw count separates "LinkedIn sent nothing, we are at the end" from
    // "LinkedIn sent plenty and we understood none of it".
    const raw = included.length;

    const profiles = new Map();
    for (const e of included) if (e.$type.endsWith('.Profile')) profiles.set(e.entityUrn, e);

    const out = [];
    for (const c of included) {
      if (!c.$type.endsWith('.Connection')) continue;
      const p = profiles.get(c.connectedMember);
      if (!p || !p.publicIdentifier) continue;
      out.push({
        publicId: p.publicIdentifier,
        memberUrn: c.connectedMember,
        firstName: p.firstName || '',
        lastName: p.lastName || '',
        headline: p.headline || '',
        photoUrl: photoUrl(p),
        connectedAt: c.createdAt || null,
      });
    }
    return { records: out, raw };
  }

  // The list is sorted by most recently added, so anything new sits on the first
  // page. Once the initial walk has completed, a sync stops at the first page
  // holding nothing new, which is one request on a quiet week.
  //
  // A full walk is still the only way to notice someone who removed you, since
  // absence from the list is the only signal, so that stays an explicit choice.
  async function runListPhase({ full }) {
    const before = await getMeta();
    const incremental = before.listComplete && !full;
    let start = incremental || full ? 0 : before.listStart;
    // Removal detection needs a walk that saw every page. A resumed first run
    // starts mid-list, so its `seen` set would wrongly look like the whole world
    // and mark everyone on the earlier pages as gone.
    const fromTheTop = start === 0;

    const now = Date.now();
    const seen = new Set();
    let added = 0;
    let updated = 0;
    let complete = false;

    for (;;) {
      if (stopping) return false;
      assertAlive();
      const { records: batch, raw } = await fetchListPage(start);
      if (raw > 0) probe('list', batch.length > 0);
      if (batch.length === 0) { complete = true; break; }

      const keys = batch.map((r) => 'p:' + r.publicId);
      const existing = await store.get(keys);
      const writes = {};
      let freshInPage = 0;

      for (const rec of batch) {
        const key = 'p:' + rec.publicId;
        seen.add(rec.publicId);
        const state = diffRecord(existing[key], rec);
        if (state === 'added') { added += 1; freshInPage += 1; }
        else if (state === 'updated') updated += 1;
        writes[key] = mergeRecord(existing[key], rec, now);
      }
      await store.set(writes);

      start += PAGE_SIZE;
      await patchMeta({
        listStart: incremental ? before.listStart : start,
        found: await countRecords(),
        lastActivity: Date.now(), health,
      });

      if (incremental && freshInPage === 0) { complete = true; break; }
      await sleep(jitter(LIST_DELAY));
    }

    // Only a walk that covered every page can tell absence from "not reached".
    let removed = 0;
    if (complete && !incremental && fromTheTop) {
      const all = await store.get(null);
      const writes = {};
      for (const key of Object.keys(all)) {
        if (!key.startsWith('p:')) continue;
        const rec = all[key];
        if (!seen.has(rec.publicId) && !rec.removed) {
          writes[key] = { ...rec, removed: true, removedAt: now };
          removed += 1;
        }
      }
      if (removed) await store.set(writes);
    }

    await patchMeta({
      listComplete: before.listComplete || complete,
      found: await countRecords(),
      lastScan: { at: now, added, updated, removed, incremental },
      lastActivity: Date.now(),
    });
    return true;
  }

  // --- Pass B: contact info per profile ----------------------------------

  async function fetchScreen(screenId, rec, isModal) {
    return fetch(`/flagship-web/rsc-action/actions/navigation?screenId=${screenId}&sduiid=${screenId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'csrf-token': csrfToken(),
        'x-li-rsc-stream': 'true',
      },
      body: JSON.stringify({
        clientArguments: {
          $type: 'proto.sdui.actions.requests.RequestedArguments',
          requestedStateKeys: [],
          payload: {
            vanityName: rec.publicId,
            givenName: rec.firstName,
            familyName: rec.lastName,
            isVanityNameResolved: true,
          },
          requestMetadata: { $type: 'proto.sdui.common.RequestMetadata' },
          states: [],
          screenId,
          knownTemplateIds: [],
        },
        isModal,
      }),
    });
  }

  async function fetchContact(rec) {
    const res = await fetchScreen(CONTACT_SCREEN, rec, true);
    guard(res);
    if (res.status === 403 || res.status === 404) return { contactError: `no access (HTTP ${res.status})` };
    if (!res.ok) throw new Error(`HTTP ${res.status}`); // retryable
    return parseContact(await res.text());
  }

  // Pass C. Opt-in, because it doubles the number of requests and therefore the
  // exposure. It is the only source of a real location and a real employer; the
  // headline split is a guess by comparison.
  async function fetchProfile(rec) {
    const res = await fetchScreen(PROFILE_SCREEN, rec, false);
    guard(res);
    if (res.status === 403 || res.status === 404) return { profileError: `no access (HTTP ${res.status})` };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseProfile(await res.text());
  }

  // A different endpoint family from the screens: actions/component, keyed by
  // componentId, and a much smaller body. A minimal payload is enough.
  async function fetchAbout(rec) {
    const res = await fetch(
      `/flagship-web/rsc-action/actions/component?componentId=${ABOUT_COMPONENT}&sduiid=${ABOUT_COMPONENT}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'csrf-token': csrfToken(),
          'x-li-rsc-stream': 'true',
        },
        body: JSON.stringify({
          clientArguments: {
            payload: { vanityName: rec.publicId },
            states: [],
            screenId: PROFILE_SCREEN,
            knownTemplateIds: [],
          },
        }),
      },
    );
    guard(res);
    if (res.status === 403 || res.status === 404) return { aboutError: `no access (HTTP ${res.status})` };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { about: parseAbout(await res.text()) };
  }

  async function runContactPhase() {
    const all = await store.get(null);
    const { withProfile, withAbout } = await getMeta();
    // Skipping people already fetched, and people who are gone, is the entire
    // point of the cache: a second run costs only the new connections. Turning
    // pass C on later queues only the profile half for everyone already done.
    const needs = (r) =>
      !r.contactDone || (withProfile && !r.profileDone) || (withAbout && !r.aboutDone);
    const pending = Object.keys(all).filter(
      (k) => k.startsWith('p:') && !all[k].removed && needs(all[k]),
    );
    const total = Object.keys(all).filter((k) => k.startsWith('p:')).length;
    let done = total - pending.length;
    await patchMeta({ contactDone: done });

    for (const key of pending) {
      if (stopping) return false;
      assertAlive();
      const rec = all[key];
      await patchMeta({
        current: `${rec.firstName} ${rec.lastName}`.trim(),
        currentId: rec.publicId,
        lastActivity: Date.now(), health,
      });
      let contact = rec.contactDone ? null : undefined;
      let strained = false; // a retry means LinkedIn is pushing back

      if (contact === undefined) {
        contact = null;
        for (let attempt = 0; attempt < 3 && !contact; attempt++) {
          try {
            contact = await fetchContact(rec);
            if (contact && !contact.contactError) probe('contact', Object.keys(contact).length > 0);
          } catch (err) {
            if (err.fatal || err.orphaned) throw err;
            strained = true;
            if (attempt === 2) contact = { contactError: err.message };
            else await sleep(jitter(5000 * 2 ** attempt));
          }
        }
      }

      let profile = null;
      if (withProfile && !rec.profileDone) {
        // Space the two requests for one person rather than firing them together.
        await sleep(jitter(effectiveDelay((await getMeta()).delayMs, pressure) / 2));
        if (stopping) return false;
        try {
          const fresh = await fetchProfile(rec);
          if (!fresh.profileError) probe('profile', Boolean(fresh.location || fresh.company));
          profile = { ...fresh, profileDone: true };
        } catch (err) {
          if (err.fatal || err.orphaned) throw err;
          strained = true;
          profile = { profileError: err.message, profileDone: true };
        }
      }

      let about = null;
      if (withAbout && !rec.aboutDone) {
        await sleep(jitter(effectiveDelay((await getMeta()).delayMs, pressure) / 2));
        if (stopping) return false;
        try {
          const fresh = await fetchAbout(rec);
          if (!fresh.aboutError) probe('about', Boolean(fresh.about));
          about = { ...fresh, aboutDone: true };
        } catch (err) {
          if (err.fatal || err.orphaned) throw err;
          strained = true;
          about = { aboutError: err.message, aboutDone: true };
        }
      }

      await store.set({ [key]: { ...rec, ...contact, ...profile, ...about, contactDone: true } });
      // Everything queued for this person has now been attempted, failures
      // included, so needs() is false whatever happened.
      done += 1;
      pressure = nextPressure(pressure, !strained);
      const meta = await patchMeta({ contactDone: done, pressure, lastActivity: Date.now(), health });
      await sleep(jitter(effectiveDelay(meta.delayMs, pressure)));
    }
    return true;
  }

  // --- Driver ------------------------------------------------------------

  async function run({ contacts = true, full = false } = {}) {
    if (running) return;
    running = true;
    stopping = false;
    try {
      if (!csrfToken()) throw fatal('noSession');
      await patchMeta({
        running: true, errorKey: null, errorInfo: '',
        phase: contacts ? 'list' : 'scan',
        startedAt: Date.now(), lastActivity: Date.now(),
      });

      pressure = 1;
      // Health describes this run. Carrying it over would keep an old verdict
      // alive long after the cause was fixed.
      health = {};
      if (!(await runListPhase({ full }))) return;
      if (contacts) {
        await patchMeta({ phase: 'contact', lastActivity: Date.now() });
        if (!(await runContactPhase())) return;
      }
      await patchMeta({ running: false, phase: 'done', current: '', currentId: '', lastActivity: Date.now() });
    } catch (err) {
      // An orphan cannot report anything: storage is gone too. It just stops,
      // and the panel notices the missing heartbeat and starts a fresh worker.
      if (err.orphaned) { stopping = true; return; }
      await patchMeta({
        running: false, phase: 'error', current: '', currentId: '',
        errorKey: err.key || 'unknown', errorInfo: err.info || err.message || '',
        lastActivity: Date.now(), health,
      });
    } finally {
      running = false;
      if (stopping && contextAlive()) {
        await patchMeta({ running: false, phase: 'paused', current: '', currentId: '' }).catch(() => {});
      }
    }
  }

  const MODES = {
    start: { contacts: true, full: false },
    scan: { contacts: false, full: false },
    rescan: { contacts: false, full: true },
  };

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    // The panel now drives two networks, so a message names the one it means.
    if (msg.platform && msg.platform !== 'linkedin') return false;
    if (MODES[msg.cmd]) { run(MODES[msg.cmd]); reply({ ok: true }); }
    else if (msg.cmd === 'pause') { stopping = true; reply({ ok: true }); }
    else if (msg.cmd === 'ping') reply({ ok: true });
    return true;
  });

  // Resuming after a navigation or a browser restart. Only one tab should pick
  // the job back up, so take it only if the previous worker stopped heartbeating.
  // ponytail: a staleness check, not a real lock. Two tabs that both go stale in
  // the same instant would double-fetch; swap in a proper lease if that ever bites.
  (async () => {
    try {
      const meta = await getMeta();
      if (meta.running && Date.now() - meta.lastActivity > STALE_WORKER_MS) run();
    } catch {
      /* orphaned before we ever started: nothing to resume, nothing to report */
    }
  })();
})();
