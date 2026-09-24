// Runs in an instagram.com tab, for the same reason as the other two workers:
// MV3 stops a service worker after ~30s idle and this job sleeps on purpose.
//
// Instagram has no birthdays to give, so this collects the people you follow
// who follow you back, then fetches each one's profile for a bio, a link, a
// category and a follower count.
//
// The lists come from the REST API the web app still calls. Profiles do not:
// users/<id>/info and web_profile_info answered 429 on the first call while
// the account browsed normally, because the web app has moved profiles to a
// GraphQL query. So profiles replay that query, learnt from the page the same
// way the Facebook worker learns its own (see fb-hook.js).
//
// Cost, for 800 following and 900 followers: about 34 list calls at 50 a page,
// then one call per mutual at the configured pace. The per-profile pass is the
// slow part and the risky one, so it paces and backs off exactly like
// LinkedIn's contact pass.

if (window.top === window) (() => {
  'use strict';

  const { igList, igProfile, igBlock, igMutuals, nextPressure, effectiveDelay,
          noteProbe, probeVerdict, fbSynthBody } = globalThis.LIB;
  const store = chrome.storage.local;

  const PREFIX = 'i:';
  // The web app's own id, sent on every call it makes. Instagram answers
  // "useragent mismatch" without it.
  const APP_ID = '936619743392459';
  // The web app asks for 12. Larger pages are honoured and mean fewer calls.
  const PAGE_SIZE = 50;
  const MAX_PAGES = 200; // 10000 per list; Instagram caps following at 7500
  const LIST_DELAY = 2500;
  const DEFAULT_DELAY = 7000;
  const STALE_WORKER_MS = 30000;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (ms, spread = 0.4) => Math.round(ms * (1 + (Math.random() * 2 - 1) * spread));

  const DEFAULT_META = {
    running: false, phase: 'idle', listComplete: false,
    found: 0, contactDone: 0, errorKey: null, errorInfo: '',
    delayMs: DEFAULT_DELAY, pressure: 1, health: {},
    startedAt: null, lastActivity: 0, current: '', currentId: '',
    scanPage: 0, scanSeen: 0, lastScan: null, navPending: false, navTried: false,
  };

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
    return { ...DEFAULT_META, ...(await store.get('metaIg')).metaIg };
  };
  const patchMeta = async (patch) => {
    assertAlive();
    const metaIg = { ...(await getMeta()), ...patch };
    await store.set({ metaIg });
    return metaIg;
  };

  const fatal = (key, info = '') => Object.assign(new Error(key), { fatal: true, key, info });

  const cookie = (name) => {
    const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    return m ? decodeURIComponent(m[1]) : '';
  };
  const myId = () => cookie('ds_user_id');

  async function getJson(path) {
    const res = await fetch(path, {
      credentials: 'include',
      signal: AbortSignal.timeout(30000),
      headers: {
        'x-ig-app-id': APP_ID,
        'x-csrftoken': cookie('csrftoken'),
        'x-requested-with': 'XMLHttpRequest',
      },
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* a login page or an empty body; igBlock reads the url instead */
    }
    const block = igBlock(res.status, res.url, json);
    if (block) throw fatal(block, String(res.status));
    return { status: res.status, ok: res.ok, json };
  }

  // Three tries with a growing pause. A retry is the early sign of pushback,
  // so the caller learns about it and slows down.
  async function withRetry(fn, onStrain) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (err.fatal || err.orphaned || attempt === 2) throw err;
        onStrain();
        await sleep(jitter(5000 * 2 ** attempt));
      }
    }
  }

  const countRecords = async () =>
    Object.keys(await store.get(null)).filter((k) => k.startsWith(PREFIX)).length;

  let stopping = false;
  let running = false;
  let pressure = 1;
  let health = {};

  function probe(key, yielded) {
    health = noteProbe(health, key, yielded);
    if (probeVerdict(health, key) === 'broken') throw fatal('broken', key);
  }

  // --- Pass A: both lists ------------------------------------------------

  // Returns the people on the list, or null when paused. `complete` is false
  // only when the page cap cut the walk short.
  async function walk(kind, onBatch = async () => {}) {
    const me = myId();
    const people = new Map();
    const cursors = new Set();
    let maxId = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      if (stopping) return null;
      assertAlive();
      let url = `/api/v1/friendships/${me}/${kind}/?count=${PAGE_SIZE}`;
      if (kind === 'followers') url += '&search_surface=follow_list_page';
      if (maxId) url += `&max_id=${encodeURIComponent(maxId)}`;

      const { json } = await withRetry(async () => {
        const r = await getJson(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r;
      }, () => {}).catch((err) => {
        throw err.fatal || err.orphaned ? err : fatal('listFailed', err.message);
      });

      const { people: batch, next, raw } = igList(json);
      if (raw > 0) probe(kind, batch.length > 0);
      for (const p of batch) people.set(p.publicId, p);
      await onBatch(batch);
      // Mutuals are only known once the followers are read, so until then the
      // panel shows who the walk is finding rather than an empty table.
      const last = batch[batch.length - 1];
      await patchMeta({
        scanPage: page + 1, scanSeen: people.size, lastActivity: Date.now(), health,
        ...(last ? { current: last.name || '@' + last.username, currentId: last.publicId, currentPhoto: last.photoUrl || '' } : {}),
      });

      if (!next || cursors.has(next)) return { people, complete: true };
      cursors.add(next);
      maxId = next;
      await sleep(jitter(LIST_DELAY));
    }
    return { people, complete: false };
  }

  async function runListPhase() {
    await patchMeta({ phase: 'following', scanPage: 0, scanSeen: 0, lastActivity: Date.now() });
    const following = await walk('following');
    if (!following) return false;

    // Mutuals are stored page by page while the followers are read, rather
    // than once both walks end: the following list is already complete, so
    // each page of followers settles who is mutual on it. Waiting for the end
    // left the table empty for the whole run.
    const now = Date.now();
    const seen = new Set();
    let added = 0;
    let updated = 0;
    const storeMutuals = async (batch) => {
      const mutuals = igMutuals(new Map(batch.map((p) => [p.publicId, p])), new Set(following.people.keys()));
      if (!mutuals.length) return;
      const existing = await store.get(mutuals.map((p) => PREFIX + p.publicId));
      const writes = {};
      for (const person of mutuals) {
        const key = PREFIX + person.publicId;
        const prev = existing[key];
        seen.add(person.publicId);
        if (!prev || prev.removed) added += 1;
        else if (prev.username !== person.username || (prev.name || '') !== person.name) updated += 1;
        const merged = { ...prev, ...person, source: 'instagram', lastSeen: now };
        merged.firstSeen = (prev && prev.firstSeen) || now;
        delete merged.removed;
        delete merged.removedAt;
        writes[key] = merged;
      }
      await store.set(writes);
      await patchMeta({ found: await countRecords() });
    };

    await patchMeta({ phase: 'followers', scanPage: 0, scanSeen: 0, lastActivity: Date.now() });
    const followers = await walk('followers', storeMutuals);
    if (!followers) return false;

    // Absence only means something after two walks that both reached the end.
    // A false flag clears itself on the next sync that sees the person again.
    // ponytail: no lossy-list guard like Facebook's; add one if Instagram's
    // lists turn out to drop people the way Facebook's did.
    const complete = following.complete && followers.complete;
    let removed = 0;
    if (complete) {
      const all = await store.get(null);
      const writes = {};
      for (const key of Object.keys(all)) {
        if (!key.startsWith(PREFIX) || all[key].removed || seen.has(all[key].publicId)) continue;
        writes[key] = { ...all[key], removed: true, removedAt: now };
        removed += 1;
      }
      if (removed) await store.set(writes);
    }

    await patchMeta({
      listComplete: complete, found: await countRecords(),
      lastScan: { at: now, added, updated, removed, incremental: false },
      lastActivity: Date.now(), health,
    });
    return true;
  }


  // --- Pass B: one profile per mutual ------------------------------------

  // --- learning the profile query ---------------------------------------

  const PROFILE_QUERY = 'PolarisProfilePageContentQuery';
  // Copied from a real call on 2026-09-24, for when the query is built from
  // its doc_id rather than copied from one the page sent. The relay provider
  // flags change with Instagram's experiments; a stale one shows up as empty
  // answers, which the igProfile probe reports.
  const SEED_VARS = {
    enable_integrity_filters: true,
    __relay_internal__pv__PolarisCannesGuardianExperienceEnabledrelayprovider: true,
    __relay_internal__pv__PolarisCASB976ProfileEnabledrelayprovider: false,
    __relay_internal__pv__PolarisWebSchoolsEnabledrelayprovider: false,
    __relay_internal__pv__PolarisRepostsConsumptionEnabledrelayprovider: true,
    __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: false,
  };

  // Every GraphQL body the page sends, by query name, forwarded by fb-hook.js.
  const templates = new Map();
  const docIdWaiters = new Map();

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (data && data.__exportin === 'docId' && docIdWaiters.has(data.name)) {
      docIdWaiters.get(data.name)(data.id);
      docIdWaiters.delete(data.name);
      return;
    }
    if (!data || data.__exportin !== 'gql' || typeof data.body !== 'string') return;
    try {
      const name = new URLSearchParams(data.body).get('fb_api_req_friendly_name');
      if (name) templates.set(name, data.body);
    } catch {
      /* we will see the next one */
    }
  });
  window.postMessage({ __exportin: 'replay' }, location.origin);

  const arm = (on) => {
    try {
      window.postMessage({ __exportin: 'arm', on }, location.origin);
    } catch {
      /* the hook keeps its previous state, which is safe either way */
    }
  };

  function askDocId(name) {
    return new Promise((resolve) => {
      docIdWaiters.set(name, resolve);
      window.postMessage({ __exportin: 'docIdAsk', name }, location.origin);
      setTimeout(() => {
        if (docIdWaiters.delete(name)) resolve(null);
      }, 2000);
    });
  }

  const envelope = () => [...templates.values()].reverse().find((b) => b.includes('fb_dtsg='));

  let navigating = false;

  // A body the page sent, else one built from the doc_id in the page's code
  // and the envelope of any call it did send. If the feed page has neither,
  // opening one profile loads both; that is tried once per run.
  async function learnProfileQuery(rec) {
    if (templates.has(PROFILE_QUERY)) return true;
    // The page keeps sending calls while it boots; give it a moment to send one.
    for (let i = 0; i < 20 && !envelope() && !stopping; i++) {
      await patchMeta({ lastActivity: Date.now() });
      await sleep(750);
    }
    const docId = await askDocId(PROFILE_QUERY);
    const body = docId && envelope() && fbSynthBody(envelope(), PROFILE_QUERY, docId, { ...SEED_VARS, id: rec.publicId });
    if (body) {
      templates.set(PROFILE_QUERY, body);
      await patchMeta({ navTried: false });
      return true;
    }
    if ((await getMeta()).navTried) {
      await patchMeta({ learnt: [...templates.keys()].filter((n) => n === PROFILE_QUERY), seenQueries: templates.size });
      throw fatal('needPage', PROFILE_QUERY);
    }
    // The next instance resumes on this flag rather than a stale heartbeat.
    await patchMeta({ navPending: true, navTried: true });
    navigating = true;
    location.assign(`https://www.instagram.com/${encodeURIComponent(rec.username)}/`);
    return false;
  }

  async function fetchProfile(rec) {
    const params = new URLSearchParams(templates.get(PROFILE_QUERY));
    const base = JSON.parse(params.get('variables') || '{}');
    params.set('variables', JSON.stringify({ ...base, id: rec.publicId }));
    const res = await fetch('/api/graphql', {
      method: 'POST',
      credentials: 'include',
      signal: AbortSignal.timeout(30000),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-csrftoken': cookie('csrftoken'),
        'x-ig-app-id': APP_ID,
        'x-fb-friendly-name': PROFILE_QUERY,
        'x-fb-lsd': params.get('lsd') || '',
      },
      body: params.toString(),
    });
    let json = null;
    try {
      json = JSON.parse((await res.text()).replace(/^for \(;;\);/, ''));
    } catch {
      /* a login page or an empty body; igBlock reads the url instead */
    }
    const block = igBlock(res.status, res.url, json);
    if (block) throw fatal(block, String(res.status));
    if (!res.ok) throw new Error(`HTTP ${res.status}`); // retryable
    // A deleted or deactivated account answers with a null user.
    if (json && json.data && json.data.user === null) return { contactError: 'not found' };
    const profile = igProfile(json);
    probe('igProfile', Boolean(profile));
    return profile || { contactError: 'unreadable answer' };
  }

  async function runProfilePhase() {
    const all = await store.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith(PREFIX));
    const pending = keys.filter((k) => !all[k].removed && !all[k].contactDone);
    let done = keys.length - pending.length;
    await patchMeta({ contactDone: done });
    if (pending.length && !(await learnProfileQuery(all[pending[0]]))) return false;

    for (const key of pending) {
      if (stopping) return false;
      assertAlive();
      const rec = all[key];
      await patchMeta({ current: rec.name || rec.username, currentId: rec.publicId, lastActivity: Date.now(), health });

      let strained = false;
      let fields;
      try {
        fields = await withRetry(() => fetchProfile(rec), () => { strained = true; });
      } catch (err) {
        if (err.fatal || err.orphaned) throw err;
        fields = { contactError: err.message };
      }
      await store.set({ [key]: { ...rec, ...fields, contactDone: true } });

      done += 1;
      pressure = nextPressure(pressure, !strained);
      const meta = await patchMeta({ contactDone: done, pressure, lastActivity: Date.now(), health });
      await sleep(jitter(effectiveDelay(meta.delayMs, pressure)));
    }
    return true;
  }

  // --- Driver ------------------------------------------------------------

  async function run({ contacts = true, full = false, resume = false } = {}) {
    if (running) return;
    running = true;
    stopping = false;
    navigating = false;
    try {
      if (!myId()) throw fatal('noSession');
      const before = await getMeta();
      const all = await store.get(null);
      const queued = Object.keys(all).some(
        (k) => k.startsWith(PREFIX) && !all[k].removed && !all[k].contactDone,
      );
      await patchMeta({
        running: true, errorKey: null, errorInfo: '', lastActivity: Date.now(),
        // A resume after the learning navigation is the same run.
        ...(resume ? {} : { startedAt: Date.now(), navTried: false }),
      });
      arm(true);
      pressure = 1;
      health = {};

      // Resuming a paused profile pass should not walk both lists again first.
      const walkLists = full || !contacts || !before.listComplete || !queued;
      if (walkLists && !(await runListPhase())) return;
      if (contacts) {
        await patchMeta({ phase: 'contact', lastActivity: Date.now() });
        if (!(await runProfilePhase())) return;
      }
      await patchMeta({ running: false, phase: 'done', current: '', currentId: '', lastActivity: Date.now() });
    } catch (err) {
      if (err.orphaned) { stopping = true; return; }
      await patchMeta({
        running: false, phase: 'error', current: '', currentId: '',
        errorKey: err.key || 'unknown', errorInfo: err.info || err.message || '',
        lastActivity: Date.now(), health,
      });
    } finally {
      running = false;
      if (!navigating) arm(false);
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
    if (msg.platform !== 'instagram') return false;
    if (MODES[msg.cmd]) { run(MODES[msg.cmd]); reply({ ok: true }); }
    else if (msg.cmd === 'pause') { stopping = true; reply({ ok: true }); }
    else if (msg.cmd === 'ping') reply({ ok: true });
    return true;
  });

  // ponytail: same staleness check as the other workers, not a real lock.
  (async () => {
    try {
      const meta = await getMeta();
      if (!meta.running) { arm(false); return; }
      if (meta.navPending) {
        await patchMeta({ navPending: false });
        run({ resume: true });
      } else if (Date.now() - meta.lastActivity > STALE_WORKER_MS) run({ resume: true });
    } catch {
      /* orphaned before we started: nothing to resume, nothing to report */
    }
  })();
})();
