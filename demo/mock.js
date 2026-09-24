// Fake backend for the screenshot build. Loaded between photos.js and panel.js,
// it replaces the chrome.* APIs and the photo store with in-memory stand-ins and
// seeds a cache of invented people.
//
// Every name, email, phone and birthday below is made up. No real connection
// data has ever been near this file.
//
// Drive it with query parameters:
//   ?state=done|running|sync|stalled|menu|settings|disclaimer&lang=en|fr|es&platform=linkedin|facebook|instagram

(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  const state = params.get('state') || 'done';
  const lang = params.get('lang') || 'en';
  const platform = params.get('platform') || 'linkedin';

  // --- invented people ---------------------------------------------------
  // [first, last, headline, email, phone, [birthMonth, birthDay]]
  const ROWS = [
    ['Amélie', 'Roussel', 'Directrice marketing chez Vermillon Studio', 'amelie.roussel@example.com', '+33 6 12 34 56 78', [3, 14]],
    ['Tomás', 'Iglesias', 'Head of Growth at Northwind Labs', 'tomas@example.org', '', [6, 3]],
    ['Priya', 'Raghunathan', 'Staff Engineer at Vantage Systems', 'p.raghunathan@example.com', '', ''],
    ['Bastien', 'Lefevre', 'Fondateur | Atelier Clairvoie', 'bastien@example.net', '+33 7 45 89 12 03', [9, 27]],
    ['Nina', 'Halvorsen', 'Product Designer at Fjordline', '', '', [4, 11]],
    ['Marco', 'Benedetti', 'CTO at Quadra Analytics', 'marco.b@example.com', '', [1, 22]],
    ['Zineb', 'El Khatib', 'Consultante RSE indépendante', 'zineb@example.org', '+33 6 98 76 54 32', ''],
    ['Oliver', 'Grant', 'Building something new. Ex-Meridian', '', '', ''],
    ['Sofía', 'Duarte', 'Responsable de operaciones en Talara', 'sofia.duarte@example.com', '', [5, 9]],
    ['Karim', 'Benslimane', 'Lead Data Scientist at Helio', 'karim@example.net', '', [8, 30]],
    ['Élodie', 'Marchand', 'Recruteuse tech | Cabinet Northgate', 'elodie.m@example.com', '+33 6 22 41 07 88', [12, 2]],
    ['Jasper', 'Okonkwo', 'Engineering Manager at Larkspur', '', '', [5, 17]],
    ['Hanne', 'De Vries', 'Freelance UX Researcher', 'hanne@example.org', '', ''],
    ['Rafael', 'Monteiro', 'Head of Sales at Coreline', 'rafael.monteiro@example.com', '+351 91 234 5678', [10, 5]],
    ['Juliette', 'Perrin', 'Avocate en droit des affaires', '', '', [7, 18]],
    ['Daniel', 'Weisz', 'Principal Architect at Stonebridge', 'dweisz@example.net', '', ''],
    ['Yuki', 'Tanabe', 'Growth Lead at Kitefoot', 'yuki@example.com', '', [2, 8]],
    ['Camille', 'Fontaine', 'Cheffe de produit chez Lumenis', 'camille.fontaine@example.org', '+33 6 55 12 90 44', [4, 23]],
    ['Adam', 'Whitfield', 'Investor | Former operator', '', '', ''],
    ['Lucía', 'Ferrer', 'Directora de personas en Aurea', 'lucia.ferrer@example.com', '', [11, 30]],
    ['Mehdi', 'Bouaziz', 'DevOps Engineer at Trellis', 'mehdi@example.net', '', [7, 12]],
    ['Charlotte', 'Nyberg', 'Brand Strategist, self-employed', '', '', [3, 26]],
    ['Idris', 'Abubakar', 'Founder at Nimbus Freight', 'idris@example.org', '+44 7700 900123', ''],
    ['Manon', 'Girard', 'Data Analyst chez Solveig', 'manon.girard@example.com', '', [1, 6]],
    ['Peter', 'Lindqvist', 'VP Engineering at Harrowgate', '', '', ''],
    ['Aisha', 'Nasser', 'Product Marketing at Bellwether', 'aisha.n@example.com', '', [9, 19]],
    ['Théo', 'Vasseur', 'Ingénieur logiciel | Freelance', 'theo@example.net', '+33 6 74 03 55 21', ''],
    ['Grace', 'Mbeki', 'Head of Partnerships at Solane', 'grace@example.org', '', [11, 2]],
    ['Fabian', 'Kruse', 'Senior Backend Engineer at Ostwerk', '', '', [12, 14]],
    ['Inès', 'Berthier', 'Consultante en transformation digitale', 'ines.berthier@example.com', '', ''],
  ];

  // LinkedIn renders a birthday in the locale of whoever is reading it, so the
  // demo does the same rather than mixing languages in one screenshot.
  const MONTHS = {
    en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
    fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
    es: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
  };

  function birthdayText(pair) {
    if (!pair) return '';
    const [month, day] = pair;
    const name = (MONTHS[lang] || MONTHS.en)[month - 1];
    if (lang === 'fr') return `${day} ${name}`;
    if (lang === 'es') return `${day} de ${name}`;
    return `${name} ${day}`;
  }

  const AVATAR_HUES = [211, 12, 148, 268, 33, 191, 338, 96, 258, 172];

  function avatar(first, last, seed) {
    const hue = AVATAR_HUES[seed % AVATAR_HUES.length];
    const initials = ((first[0] || '') + (last[0] || '')).toUpperCase();
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">` +
      `<rect width="100" height="100" fill="hsl(${hue} 42% 44%)"/>` +
      `<text x="50" y="54" font-family="system-ui,-apple-system,sans-serif" font-size="38" ` +
      `font-weight="600" fill="#fff" text-anchor="middle" dominant-baseline="middle">${initials}</text></svg>`;
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }

  const slug = (s) =>
    s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]+/g, '-');

  const DAY = 86400000;
  const BASE = Date.parse('2026-09-19T09:00:00Z');
  const store = {};
  let photoCount = 0;

  ROWS.forEach(([first, last, headline, email, phone, birthday], i) => {
    // A handful of people are left unfetched or blocked so the status column and
    // its filter have something to show.
    const blocked = i === 7 || i === 24;
    const pending = i >= ROWS.length - 3 && state === 'running';
    const rec = {
      publicId: `${slug(first)}-${slug(last)}-${(1000 + i * 37).toString(16)}`,
      memberUrn: `urn:li:fsd_profile:DEMO${String(i).padStart(4, '0')}`,
      firstName: first,
      lastName: last,
      headline,
      photoUrl: avatar(first, last, i),
      connectedAt: BASE - i * 11 * DAY - (i % 5) * DAY,
      firstSeen: BASE - i * 11 * DAY,
      lastSeen: BASE,
      contactDone: !pending,
      ...(blocked ? { contactError: 'no access (HTTP 403)' } : { email, phone, birthday: birthdayText(birthday) }),
      // Every third person carries what the two optional passes buy, so the
      // extra row line has something to render in a screenshot.
      ...(i % 3 === 0 ? {
        location: ['Bordeaux, Nouvelle-Aquitaine', 'Lisboa, Portugal', 'Berlin, Deutschland'][i % 3 === 0 ? (i / 3) % 3 : 0],
        profileDone: true,
      } : {}),
      ...(i % 3 === 0 ? {
        about: 'Je construis des produits depuis douze ans, surtout des outils internes que personne ne voit mais que tout le monde utilise.',
        aboutDone: true,
      } : {}),
    };
    if (pending) delete rec.contactDone;
    if (!pending) photoCount += 1;
    store['p:' + rec.publicId] = rec;
  });

  // The same invented people, as Facebook hands them over: a full date of birth
  // including the year, and mutual friends.
  const MUTUAL = { en: 'mutual friends', fr: 'amis en commun', es: 'amigos en común' };
  let fbPhotoCount = 0;

  ROWS.forEach(([first, last, headline, email, phone, birthday], i) => {
    // Two thirds share a birth year, which is roughly what a real account gives.
    const year = i % 3 === 0 ? 0 : 1966 + ((i * 7) % 34);
    const rec = {
      publicId: String(100000000000001 + i * 1317),
      source: 'facebook',
      name: `${first} ${last}`,
      firstName: first,
      lastName: last,
      photoUrl: avatar(first, last, i),
      profileUrl: `https://www.facebook.com/${slug(first)}.${slug(last)}`,
      gender: i % 2 ? 'male' : 'female',
      mutual: `${2 + ((i * 5) % 40)} ${MUTUAL[lang] || MUTUAL.en}`,
      firstSeen: BASE - i * 9 * DAY,
      lastSeen: BASE,
      ...(birthday ? { birthMonth: birthday[0], birthDay: birthday[1], ...(year ? { birthYear: year } : {}) } : {}),
    };
    fbPhotoCount += 1;
    store['f:' + rec.publicId] = rec;
  });

  // And as Instagram mutuals: a handle and a bio, with an email only when the
  // bio carries one. The profile query has no phone, so neither does the demo.
  ROWS.forEach(([first, last, headline, email], i) => {
    const handle = `${slug(first)}.${slug(last)}`;
    const rec = {
      publicId: String(5000000000 + i * 7919),
      source: 'instagram',
      username: handle,
      name: `${first} ${last}`,
      firstName: first,
      lastName: last,
      photoUrl: avatar(first, last, i),
      firstSeen: BASE - i * 7 * DAY,
      lastSeen: BASE,
      contactDone: true,
      bio: i % 3 === 0 && email ? `${headline} · ${email}` : headline,
      ...(i % 3 === 0 ? { email, website: `https://${slug(last)}.studio` } : {}),
    };
    store['i:' + rec.publicId] = rec;
  });
  const igRecords = Object.keys(store).filter((k) => k.startsWith('i:')).map((k) => store[k]);

  const fbRecords = Object.keys(store).filter((k) => k.startsWith('f:')).map((k) => store[k]);

  const total = ROWS.length;
  const fetched = Object.keys(store).filter((k) => k.startsWith('p:') && store[k].contactDone).length;

  const META = {
    done: {
      running: false, phase: 'done', listComplete: true, listStart: total,
      found: total, contactDone: fetched, delayMs: 4000, lastActivity: Date.now(),
      lastScan: { at: BASE, added: 0, updated: 0, removed: 0, incremental: true },
    },
    running: {
      running: true, phase: 'contact', listComplete: true, listStart: total,
      found: total, contactDone: fetched, delayMs: 4000, pressure: 1.7, withProfile: true,
      startedAt: Date.now() - 41 * 60 * 1000, lastActivity: Date.now(),
      current: 'Inès Berthier',
      currentId: 'ines-berthier-' + (1000 + 29 * 37).toString(16),
      demoSeen: ['Inès Berthier', 'Fabian Kruse', 'Grace Mbeki', 'Théo Vasseur'],
      lastScan: { at: BASE, added: 6, updated: 0, removed: 0, incremental: true },
    },
    sync: {
      running: false, phase: 'done', listComplete: true, listStart: total,
      found: total, contactDone: fetched, delayMs: 4000, lastActivity: Date.now(),
      lastScan: { at: BASE, added: 4, updated: 2, removed: 1, incremental: false },
    },
  };
  // lastActivity far in the past: the panel should treat the worker as dead,
  // re-enable the controls and offer the one-click recovery.
  META.stalled = {
    ...META.running,
    lastActivity: Date.now() - 5 * 60 * 1000,
    current: '',
  };
  // What the panel shows when LinkedIn changes the shape of its answers: forty
  // successful requests in a row that yielded nothing.
  META.broken = {
    ...META.done,
    phase: 'error', errorKey: 'broken', errorInfo: 'contact',
    contactDone: 12,
    health: { list: [6, 6], contact: [40, 0] },
  };
  META.menu = META.done;
  META.settings = { ...META.done, withProfile: true, withAbout: true };
  META.disclaimer = META.done;

  const FB_META = {
    done: {
      running: false, phase: 'done', listComplete: true,
      found: fbRecords.length, contactDone: fbRecords.length,
      withBirthday: fbRecords.filter((r) => r.birthMonth).length,
      delayMs: 4000, lastActivity: Date.now(),
      lastScan: { at: BASE, added: 0, updated: 0, removed: 0, incremental: true },
    },
    running: {
      running: true, phase: 'friends', listComplete: false, scanPage: 12, scanSeen: 360,
      found: fbRecords.length, contactDone: fbRecords.length,
      withBirthday: fbRecords.filter((r) => r.birthMonth).length,
      delayMs: 4000, startedAt: Date.now() - 4 * 60 * 1000, lastActivity: Date.now(),
      current: 'Inès Berthier',
      demoSeen: ['Inès Berthier', 'Fabian Kruse', 'Grace Mbeki', 'Théo Vasseur'],
    },
  };
  FB_META.sync = { ...FB_META.done, lastScan: { at: BASE, added: 3, updated: 1, removed: 0, incremental: false } };
  FB_META.stalled = { ...FB_META.running, lastActivity: Date.now() - 5 * 60 * 1000, current: '' };
  FB_META.broken = {
    ...FB_META.done,
    phase: 'error', errorKey: 'broken', errorInfo: 'birthdays',
    health: { birthdays: [2, 0] },
    learnt: ['BirthdayCometMonthlyBirthdaysRefetchQuery'],
  };
  FB_META.menu = FB_META.done;
  FB_META.settings = FB_META.done;
  FB_META.disclaimer = FB_META.done;

  store.meta = META[state] || META.done;
  store.metaFb = FB_META[state] || FB_META.done;
  store.metaIg = {
    running: false, phase: 'done', listComplete: true, delayMs: 7000,
    found: igRecords.length, contactDone: igRecords.filter((r) => r.contactDone).length,
    lastActivity: Date.now(), lastScan: { at: BASE, added: 2, updated: 0, removed: 0, incremental: false },
  };
  store.platform = platform;
  store.lang = lang;
  // Must track DISCLAIMER_VERSION in panel.js, or every shot is a modal.
  if (state !== 'disclaimer') store.disclaimer = 3;

  // --- chrome.* stand-ins -------------------------------------------------

  const TAB = { id: 1, windowId: 1 };
  globalThis.chrome = {
    // The panel checks chrome.runtime.id to tell a live extension from one that
    // has been reloaded out from under it. Without this the demo renders the
    // "extension was reloaded" notice instead of the interface.
    runtime: { id: 'exportin-demo', getManifest: () => ({ version: '1.1.0' }) },
    storage: {
      local: {
        async get(keys) {
          if (keys === null || keys === undefined) return { ...store };
          const wanted = typeof keys === 'string' ? [keys] : keys;
          const out = {};
          for (const k of wanted) if (k in store) out[k] = store[k];
          return out;
        },
        async set(obj) { Object.assign(store, obj); },
        async clear() { for (const k of Object.keys(store)) delete store[k]; },
      },
      onChanged: { addListener() {} },
    },
    tabs: {
      async query() { return [TAB]; },
      async create() { return TAB; },
      async update() { return TAB; },
      async reload() {},
      async sendMessage() { return { ok: true }; },
    },
    windows: { async update() {} },
    i18n: { getUILanguage: () => lang },
  };

  globalThis.PHOTOS = {
    async ids() {
      const out = new Set();
      for (const [key, rec] of Object.entries(store)) {
        if (!rec || !rec.publicId) continue;
        out.add(key.startsWith('f:') ? 'fb:' + rec.publicId : key.startsWith('i:') ? 'ig:' + rec.publicId : rec.publicId);
      }
      return out;
    },
    async count() { return platform === 'facebook' ? fbPhotoCount : photoCount; },
    async all() { return []; },
    async put() {},
    async clear() {},
    extFor: () => 'jpg',
  };

  // The retrying notice is transient by nature: the panel fires the recovery in
  // the same render that shows it. Exhausting the budget photographs the state
  // that actually persists, the one where the user has something to press.
  if (state === 'stalled' && globalThis.LIB) globalThis.LIB.AUTO_RETRY.maxAttempts = 0;

  // Seed the fade stack so a still frame shows what the animation builds up.
  const ACTIVE_META = platform === 'facebook' ? (FB_META[state] || {}) : (META[state] || {});
  if (ACTIVE_META.demoSeen) {
    addEventListener('DOMContentLoaded', () => {
      setTimeout(() => {
        const box = document.getElementById('current');
        if (!box) return;
        box.replaceChildren();
        ACTIVE_META.demoSeen.forEach((name, i) => {
          const rec = Object.values(store).find(
            (r) => r && `${r.firstName} ${r.lastName}`.trim() === name,
          );
          const line = document.createElement('div');
          line.className = 'seen';
          const img = document.createElement('img');
          img.className = 'avatar';
          img.src = rec ? rec.photoUrl : '';
          const label = document.createElement('span');
          label.textContent = name;
          line.append(img, label);
          line.style.setProperty('--depth', i);
          box.append(line);
        });
      }, 900);
    });
  }

  if (state === 'settings') {
    addEventListener('DOMContentLoaded', () => {
      setTimeout(() => document.getElementById('settings')?.showModal(), 250);
    });
  }

  // The export menu is a <details>; opening it is the only way to photograph it.
  if (state === 'menu') {
    addEventListener('DOMContentLoaded', () => {
      setTimeout(() => document.getElementById('menu')?.setAttribute('open', ''), 150);
    });
  }
})();
