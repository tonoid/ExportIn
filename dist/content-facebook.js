// Runs in a facebook.com tab, in the extension's isolated world.
//
// Same reason as the LinkedIn side for living in a tab rather than a service
// worker: MV3 stops a worker after ~30s idle and this job sleeps between every
// request on purpose.
//
// The difference from LinkedIn is where the requests come from. LinkedIn's
// Voyager API answers a URL we can write down. Facebook only serves persisted
// GraphQL queries, keyed by a doc_id that changes on every deploy, so there is
// nothing stable to hard-code: a doc_id written into this file would work for a
// few days and then fail silently. Instead fb-hook.js watches the page ask for
// its own queries, and we replay those with different variables.
//
// Cost, for 2000 friends: about 6 calls for the whole year of birthdays, about
// 67 for the friend list at Facebook's fixed 30 per page. Nothing per person:
// a hovercard pass for work and location was built and dropped, because it cost
// one request per friend for a line most friends leave empty.

if (window.top === window) (() => {
  'use strict';

  const { fbPeople, fbPageInfo, fbDiffRecord, fbSynthBody, fbRemovals, noteProbe, probeVerdict } = globalThis.LIB;
  const store = chrome.storage.local;

  const GQL = 'https://www.facebook.com/api/graphql/';
  const PREFIX = 'f:';

  const Q = {
    birthdays: 'BirthdayCometMonthlyBirthdaysRefetchQuery',
    friends: 'FriendingCometFriendsListPaginationQuery',
  };

  const PAGE = { birthdays: '/friends/birthdays', friends: '/friends/list' };

  // Facebook ignores `count` on the friend list and always answers 30.
  const FRIEND_PAGE_SIZE = 30;
  // `count` on the birthday query is a number of months, and `cursor` is the
  // month to start from. Asking for twelve costs one call if Facebook honours
  // it and simply pages more often if it does not.
  const MONTHS = 12;
  // `scale` is the device pixel ratio the answer is rendered for. Asking for 4
  // was meant to double the photos; measured on a real account it delivers 60
  // or 120px for a 60px logical size, so Facebook caps it at 2. Kept at 4
  // because it costs nothing. The URL cannot be resized either: its `stp`
  // parameter is signed, and any edit to it gets the image refused.
  const PHOTO_SCALE = 4;
  const MAX_FRIEND_PAGES = 400; // 12000 friends, far past any real account
  const MAX_MONTH_PAGES = 24;
  const LIST_DELAY = 2500;
  const STALE_WORKER_MS = 30000;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (ms, spread = 0.4) => Math.round(ms * (1 + (Math.random() * 2 - 1) * spread));

  const DEFAULT_META = {
    running: false, phase: 'idle', listComplete: false,
    found: 0, contactDone: 0, errorKey: null, errorInfo: '',
    startedAt: null, lastActivity: 0, current: '', currentId: '', navPending: false,
    friendsSkipped: false, stage: 'birthdays', health: {}, learnt: [],
    learning: false, scanPage: 0, scanSeen: 0,
    lastScan: null,
  };

  // Reloading or updating the extension leaves this copy running against a
  // context that no longer exists. Every chrome.* call would throw, so the loop
  // would keep hitting Facebook while unable to store a single result.
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
    return { ...DEFAULT_META, ...(await store.get('metaFb')).metaFb };
  };
  const patchMeta = async (patch) => {
    assertAlive();
    const metaFb = { ...(await getMeta()), ...patch };
    await store.set({ metaFb });
    return metaFb;
  };

  const fatal = (key, info = '') => Object.assign(new Error(key), { fatal: true, key, info });

  const loggedIn = () => /(^|;\s*)c_user=/.test(document.cookie);

  // --- learning the queries ------------------------------------------------
  // fb-hook.js forwards every GraphQL body the page sends. We keep the most
  // recent one per query name and replay it with our own variables, which is why
  // no doc_id, token or envelope parameter is written down anywhere.

  const templates = new Map();

  // Only the three we replay, so a diagnostic never carries an inventory of
  // everything the page happens to ask for.
  const learntNames = () => Object.values(Q).filter((name) => templates.has(name));

  // The hook sits in the call path of every request Facebook makes. Telling it
  // to stay quiet while no collection is running spares a postMessage and a
  // parse on each of them, which on an idle Facebook tab is all day long.
  const arm = (on) => {
    try {
      window.postMessage({ __exportin: 'arm', on }, location.origin);
    } catch {
      /* the hook keeps its previous state, which is safe either way */
    }
  };

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
      /* a body we cannot read is one we will see again on the next call */
    }
  });
  // Whatever the page sent before this script was listening. See fb-hook.js.
  window.postMessage({ __exportin: 'replay' }, location.origin);

  function guard(res) {
    if (res.status === 429) throw fatal('rateLimited', '429');
    if (/\/checkpoint\//.test(res.url)) throw fatal('checkpoint');
  }

  async function replay(name, vars) {
    const template = templates.get(name);
    if (!template) throw fatal('needPage');
    const params = new URLSearchParams(template);
    const base = JSON.parse(params.get('variables') || '{}');
    params.set('variables', JSON.stringify({ ...base, ...vars }));

    const res = await fetch(GQL, {
      method: 'POST',
      credentials: 'include',
      // Without a deadline one request that never answers holds the whole run,
      // silently, with the panel still reading "running".
      signal: AbortSignal.timeout(30000),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    guard(res);
    if (!res.ok) throw new Error(`HTTP ${res.status}`); // retryable
    return res.text();
  }

  // --- getting the page to ask ---------------------------------------------
  // A query we have never seen cannot be replayed, and Facebook only sends one
  // when the interface needs it. Scrolling is what triggers the next page, so we
  // scroll on the user's behalf rather than telling them to.

  function followLink(path) {
    const link = document.querySelector(
      `a[href^="${path}"], a[href^="https://www.facebook.com${path}"]`,
    );
    if (!link) return false;
    link.click(); // in-app routing, so this content script survives it
    return true;
  }

  // Facebook does not always scroll the document. Comet often puts the feed in
  // an inner element with its own overflow, and window.scrollTo on the document
  // then moves nothing at all, so the page never asks for the next page and the
  // query we are waiting for never fires.
  function scrollers() {
    const found = [document.scrollingElement || document.documentElement];
    let seen = 0;
    for (const el of document.querySelectorAll('div')) {
      if (++seen > 4000) break; // Facebook has a lot of divs; this is a scan, not a search
      if (el.scrollHeight - el.clientHeight < 400) continue;
      const overflow = getComputedStyle(el).overflowY;
      if (overflow === 'auto' || overflow === 'scroll') found.push(el);
    }
    return found;
  }

  // Facebook boots slowly, and a background tab boots slower still. Counting
  // the budget from before the page has rendered spends it on an empty document.
  // The panel reloads a worker that has been silent for 30 seconds. Every wait
  // longer than a few seconds beats, or the panel kills the learning it waits on.
  const beat = () => patchMeta({ lastActivity: Date.now() });

  async function settled(budgetMs) {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      if (stopping) return false;
      assertAlive();
      await beat();
      const main = document.querySelector('[role="main"]');
      if (document.readyState === 'complete' && main && main.textContent.length > 200) return true;
      await sleep(800);
    }
    return false;
  }

  async function nudge(name, budgetMs) {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline && !templates.has(name)) {
      if (stopping) return false;
      assertAlive();
      for (const el of scrollers()) {
        el.scrollTop = el.scrollHeight;
        el.dispatchEvent(new WheelEvent('wheel', { deltaY: 1200, bubbles: true }));
      }
      // Without this the panel sees no heartbeat for the whole budget, decides
      // the worker is dead and starts a second one on top of this one.
      await beat();
      await sleep(1200);
    }
    return templates.has(name);
  }

  // Returns false only when this script is about to stop for a legitimate
  // reason: the user paused, or a hard navigation is about to replace it.
  // Failing to learn the query is an error and says so, because returning false
  // here made the driver exit while leaving `running` true, so the panel saw a
  // dead worker, restarted it, and the pair looped without ever reporting why.
  // The variables a query needs beyond the ones every call overrides. Written
  // down because a query the page never sent has no body to copy them from. If
  // Facebook adds a required one, the first page comes back empty and the
  // probes report it rather than this failing quietly.
  const SEED_VARS = {
    [Q.birthdays]: { offset_month: 0, stream_birthday_months: false },
    [Q.friends]: { name: null },
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

  // Learning without waiting for the page: its code already holds the doc_id,
  // and any call it did send carries the envelope. This is what works in a tab
  // that stays in the background, where nothing scrolls and the query itself
  // is never sent. Measured: 12 calls seen, none of them the birthday query.
  async function synthesize(name) {
    const docId = await askDocId(name);
    if (!docId) return false;
    const envelope = [...templates.values()].reverse().find((b) => b.includes('fb_dtsg='));
    const body = envelope && fbSynthBody(envelope, name, docId, SEED_VARS[name] || {});
    if (!body) return false;
    templates.set(name, body);
    return true;
  }

  async function reach(path, name) {
    if (templates.has(name)) return true;
    // Learning and paging share a phase, and without this the panel showed the
    // same line for a minute of scrolling as for a minute of fetching.
    await patchMeta({ learning: true, lastActivity: Date.now() });
    if (location.pathname.startsWith(path) && (await synthesize(name))) {
      await patchMeta({ learning: false });
      return true;
    }
    if (!location.pathname.startsWith(path)) {
      if (!followLink(path)) {
        // The new instance resumes on this flag rather than on a stale
        // heartbeat, which would otherwise cost thirty seconds or race the
        // panel's own recovery.
        await patchMeta({ navPending: true });
        navigating = true;
        location.assign('https://www.facebook.com' + path);
        return false;
      }
      await sleep(4000);
      await beat();
    }
    await settled(20000);
    // Built from the page first; scrolling it into sending the query is the
    // fallback, and it only works in a tab that is actually drawn.
    const learnt = (await synthesize(name)) || (await nudge(name, 45000));
    await patchMeta({ learning: false });
    if (learnt) return true;
    if (stopping) return false;
    // What the hook did see is the difference between "Facebook changed
    // something" and "this page never finished loading", so it is recorded.
    await patchMeta({ learnt: learntNames(), seenQueries: templates.size });
    throw fatal('needPage', name);
  }

  // --- storage -------------------------------------------------------------

  let stopping = false;
  let running = false;
  let navigating = false;
  let health = {};

  function probe(key, yielded) {
    health = noteProbe(health, key, yielded);
    if (probeVerdict(health, key) === 'broken') throw fatal('broken', key);
  }

  // The one thing here that genuinely repairs itself. A Facebook deploy rotates
  // doc_id, the old one answers without the data we expect, and dropping the
  // template lets the page teach us the new one. Used on the first page of a
  // phase only: past that, an empty answer is the end of the list, not a break.
  async function replayOrRelearn(name, path, vars) {
    const text = await replay(name, vars);
    if (fbPeople(text).length) return text;
    templates.delete(name);
    if (!(await reach(path, name))) return text;
    return replay(name, vars);
  }

  async function tally() {
    const all = await store.get(null);
    const records = Object.keys(all).filter((k) => k.startsWith(PREFIX)).map((k) => all[k]);
    return {
      found: records.length,
      // Progress, not coverage: there is no per-person work left once a record
      // exists, so the bar is full. Reporting the birthday count here instead
      // made a finished run read as stuck at 80%.
      contactDone: records.length,
      withBirthday: records.filter((r) => r.birthMonth).length,
    };
  }

  async function storePeople(people, now, stats) {
    if (!people.length) return;
    const keys = people.map((p) => PREFIX + p.publicId);
    const existing = await store.get(keys);
    const writes = {};
    for (const person of people) {
      const key = PREFIX + person.publicId;
      const prev = existing[key];
      const state = fbDiffRecord(prev, person);
      if (state === 'added') stats.added += 1;
      else if (state === 'updated') stats.updated += 1;
      // person only carries fields it actually found, so a friend-list sweep
      // never blanks a birthday collected by a month sweep.
      const merged = { ...prev, ...person, source: 'facebook', lastSeen: now };
      merged.firstSeen = (prev && prev.firstSeen) || now;
      delete merged.removed;
      delete merged.removedAt;
      writes[key] = merged;
    }
    await store.set(writes);
  }

  // --- Phase 1: the year of birthdays --------------------------------------
  // One request per batch of months for every friend at once, which is the
  // cheapest data in either network: name, photo, profile and a full date,
  // including the year when the profile shares it.

  async function runBirthdayPhase(stats) {
    if (!(await reach(PAGE.birthdays, Q.birthdays))) return false;

    let cursor = null;
    const visited = new Set();
    let read = 0;
    for (let page = 0; page < MAX_MONTH_PAGES; page++) {
      if (stopping) return false;
      assertAlive();

      const ask = page === 0 ? replayOrRelearn : (n, _p, v) => replay(n, v);
      let text = await ask(Q.birthdays, PAGE.birthdays,
        { count: MONTHS, cursor, offset_month: 0, scale: PHOTO_SCALE });
      let people = fbPeople(text);
      // Some builds want a month index rather than a null to mean "from the
      // start". Trying the other form costs one request, once.
      if (!people.length && cursor === null) {
        text = await replay(Q.birthdays,
          { count: MONTHS, cursor: '0', offset_month: 0, scale: PHOTO_SCALE });
        people = fbPeople(text);
      }
      probe('birthdays', people.length > 0);
      read += people.length;

      const now = Date.now();
      await storePeople(people, now, stats);
      await patchMeta({ ...(await tally()), scanPage: page + 1, scanSeen: read, lastActivity: now });

      const info = fbPageInfo(text);
      if (!info.hasNext || !info.cursor || visited.has(info.cursor)) break;
      visited.add(info.cursor);
      cursor = info.cursor;
      await sleep(jitter(LIST_DELAY));
    }
    return true;
  }

  // --- Phase 2: the friend list --------------------------------------------
  // Only worth its 30-per-page cost for the friends who hide their birthday:
  // everyone else already arrived in phase 1, with more data attached.

  async function runFriendsPhase(stats) {
    if (!(await reach(PAGE.friends, Q.friends))) return false;

    let cursor = null;
    const visited = new Set();
    const seen = new Set();
    let complete = false;

    for (let page = 0; page < MAX_FRIEND_PAGES; page++) {
      if (stopping) return false;
      assertAlive();

      const vars = { cursor, count: FRIEND_PAGE_SIZE, name: null, scale: PHOTO_SCALE };
      const text = page === 0
        ? await replayOrRelearn(Q.friends, PAGE.friends, vars)
        : await replay(Q.friends, vars);
      const people = fbPeople(text);
      probe('friends', people.length > 0);
      for (const person of people) seen.add(person.publicId);

      const now = Date.now();
      await storePeople(people, now, stats);
      // `found` barely moves here: the birthday sweep already stored most of
      // these people. What the page count shows is that the walk advances.
      await patchMeta({ ...(await tally()), scanPage: page + 1, scanSeen: seen.size, lastActivity: now });

      const info = fbPageInfo(text);
      if (!info.hasNext || !info.cursor || visited.has(info.cursor)) { complete = true; break; }
      visited.add(info.cursor);
      cursor = info.cursor;
      await sleep(jitter(LIST_DELAY));
    }

    // Absence from a complete walk is the only signal that somebody unfriended
    // you, so a partial walk must never be allowed to draw that conclusion.
    if (complete && seen.size) {
      const all = await store.get(null);
      const records = Object.keys(all).filter((k) => k.startsWith(PREFIX)).map((k) => all[k]);
      const { startedAt } = await getMeta();
      const writes = {};
      const now = Date.now();
      const verdict = fbRemovals(records, seen, startedAt || now);
      for (const id of verdict.remove) {
        writes[PREFIX + id] = { ...all[PREFIX + id], removed: true, removedAt: now };
        stats.removed += 1;
      }
      for (const id of verdict.restore) {
        const { removed, removedAt, ...rec } = all[PREFIX + id];
        writes[PREFIX + id] = rec;
      }
      if (Object.keys(writes).length) await store.set(writes);
      await patchMeta({ listSkipped: verdict.skipped });
    }
    return complete;
  }

  // --- Driver --------------------------------------------------------------

  // Each phase lives on a different Facebook page, and reaching a page that has
  // no in-app link means a hard navigation, which replaces this script and wipes
  // the queries it had learnt. So the stage is written down before each phase:
  // without it the next instance would restart at phase 1, navigate back to the
  // birthdays page to relearn its query, then forward again, forever.
  const STAGES = ['birthdays', 'friends'];

  async function run({ full = false, from = 'birthdays', resume = false } = {}) {
    if (running) return;
    running = true;
    stopping = false;
    navigating = false;
    const first = Math.max(0, STAGES.indexOf(from));
    const reached = (stage) => STAGES.indexOf(stage) >= first;
    const stats = { added: 0, updated: 0, removed: 0 };
    try {
      if (!loggedIn()) throw fatal('noSession');
      await patchMeta({
        running: true, errorKey: null, errorInfo: '', learning: false,
        // A resume after a navigation is the same run, so its clock carries on.
        // Restarting it made "running for 23s" drop back to 0s on every reload.
        ...(first === 0 && !resume ? { friendsSkipped: false, startedAt: Date.now() } : {}),
        lastActivity: Date.now(),
      });
      arm(true);
      // Health describes this run, not the history of the install.
      if (first === 0) health = {};

      if (reached('birthdays')) {
        await patchMeta({ stage: 'birthdays', phase: 'birthdays', scanPage: 0, scanSeen: 0, lastActivity: Date.now() });
        if (!(await runBirthdayPhase(stats))) return;
        // A navigation is under way and this script is about to be replaced.
        // Leaving `running` true is deliberate: the next instance resumes on
        // navPending. Carrying on here used to mark the job finished while the
        // page was still loading, so the remaining phases never ran at all.
        if (navigating) return;
      }

      let complete = false;
      if (reached('friends')) {
        await patchMeta({ stage: 'friends', phase: 'friends', scanPage: 0, scanSeen: 0, lastActivity: Date.now() });
        try {
          complete = await runFriendsPhase(stats);
        } catch (err) {
          // Phase 1 already holds everyone with a visible birthday, so losing
          // this one costs only the friends who hide theirs. It is recorded
          // rather than thrown; swallowing it left the panel claiming a clean
          // finish over an incomplete list.
          if (err.fatal && err.key === 'needPage') await patchMeta({ friendsSkipped: true });
          else throw err;
        }
        if (stopping || navigating) return;

        const now = Date.now();
        await patchMeta({
          listComplete: complete,
          lastScan: { at: now, ...stats, incremental: !full },
          lastActivity: now,
        });
      }

      await patchMeta({
        ...(await tally()),
        running: false, phase: 'done', stage: 'birthdays',
        current: '', currentId: '', lastActivity: Date.now(),
      });
    } catch (err) {
      if (err.orphaned) { stopping = true; return; }
      await patchMeta({
        running: false, phase: 'error', stage: 'birthdays', current: '', currentId: '',
        errorKey: err.key || 'unknown', errorInfo: err.info || err.message || '',
        lastActivity: Date.now(),
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
    start: { full: false },
    scan: { full: false },
    rescan: { full: true },
  };

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.platform !== 'facebook') return false;
    if (MODES[msg.cmd]) { run(MODES[msg.cmd]); reply({ ok: true }); }
    else if (msg.cmd === 'pause') { stopping = true; reply({ ok: true }); }
    else if (msg.cmd === 'ping') reply({ ok: true });
    return true;
  });

  // Picking the job back up after a navigation or a browser restart. Only one
  // tab should do it, so it is taken only once the previous worker stopped
  // heartbeating.
  // ponytail: a staleness check, not a real lock. Two tabs going stale in the
  // same instant would double-fetch; swap in a lease if that ever bites.
  (async () => {
    try {
      const meta = await getMeta();
      if (!meta.running) { arm(false); return; }
      if (meta.navPending) {
        await patchMeta({ navPending: false });
        run({ from: meta.stage, resume: true });
      } else if (Date.now() - meta.lastActivity > STALE_WORKER_MS) {
        run({ from: meta.stage, resume: true });
      }
    } catch {
      /* orphaned before we started: nothing to resume, nothing to report */
    }
  })();
})();
