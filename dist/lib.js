// Pure helpers. No DOM, no chrome.*, no network, so test.mjs can run them in node.
// Loaded as a plain script in the extension (sets globalThis.LIB) and eval'd by the test.

(() => {
  'use strict';

  // --- LinkedIn React Flight parsing -------------------------------------
  // The contact-info overlay comes back as an RSC flight stream, not JSON.
  // Every rendered text node appears as  "children":["some text"]  in document
  // order, and the overlay renders each row as a label <p> followed by a value
  // block. So: collect the leaves, then take whatever follows a known label.
  // Rows a profile hasn't filled in are simply absent from the stream, which is
  // why this pairs by label instead of by position.

  // Three shapes occur in the wild, and the first version of this only saw one:
  //   "children":["text"]                      a plain label or value
  //   "children":[null,"text"]                 the first line of a paragraph
  //   "children":[["$","br",null,{}],"text"]   a continuation line
  // Missing the last two made every multi-line value invisible.
  function flightLeaves(txt) {
    const re = /"children":\[(?:null|\[(?:[^[\]]|\[[^\]]*\])*\])?,?\s*("(?:[^"\\]|\\.)*")\]/g;
    const out = [];
    let m;
    while ((m = re.exec(txt))) {
      try {
        out.push(JSON.parse(m[1]));
      } catch {
        /* a leaf we can't decode is a leaf we don't need */
      }
    }
    return out;
  }

  // LinkedIn renders the overlay in the viewer's interface language, so the
  // labels are matched in the three the extension speaks. A guess that never
  // appears simply never matches, which makes extra entries free.
  const CONTACT_LABELS = {
    Email: 'email', 'E-mail': 'email', 'Correo electrónico': 'email', Correo: 'email',
    Phone: 'phone', Téléphone: 'phone', Teléfono: 'phone',
    Birthday: 'birthday', Anniversaire: 'birthday', Cumpleaños: 'birthday',
    Website: 'website', Websites: 'website',
    'Site web': 'website', 'Sites web': 'website',
    'Sitio web': 'website', 'Sitios web': 'website',
    Address: 'address', Adresse: 'address', Dirección: 'address',
    IM: 'im', 'Messagerie instantanée': 'im', 'Mensajería instantánea': 'im',
    Twitter: 'twitter',
    'Connected since': 'connectedSince',
    'Relation depuis': 'connectedSince',
    'En contacto desde': 'connectedSince',
  };

  // Rows the overlay renders but we do not capture. Listing them matters because
  // a label must never be mistaken for the value of the label before it.
  const OTHER_LABELS = [
    'Contact info', 'Coordonnées', 'Información de contacto',
    'Your Profile', 'Profile', 'Profil', 'Perfil',
  ];

  const NOT_A_VALUE = new Set([...Object.keys(CONTACT_LABELS), ...OTHER_LABELS]);

  // Taking whatever follows a label is only safe if we check what we took. A
  // tracking node slipped between a label and its value would otherwise write a
  // member URN straight into the email column of your CSV.
  const LOOKS_LIKE = {
    email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v),
    phone: (v) => /\d/.test(v) && v.length <= 40,
    website: (v) => /\./.test(v) && !/\s/.test(v),
    birthday: (v) => v.length <= 40,
    connectedSince: (v) => v.length <= 40,
    address: (v) => v.length <= 200,
    twitter: (v) => v.length <= 60,
    im: (v) => v.length <= 60,
  };

  const isIdentifier = (v) => /^(urn:|ACoAA|https?:\/\/www\.linkedin\.com\/in\/)/i.test(v);

  function acceptable(key, value) {
    if (typeof value !== 'string') return false;
    const v = value.trim();
    if (!v || isIdentifier(v)) return false;
    // The row for a label the profile left empty is not rendered at all, so the
    // next leaf after a label can be the *next label*. Storing that put
    // "Connected since" in the address column of real exports.
    if (NOT_A_VALUE.has(v)) return false;
    const check = LOOKS_LIKE[key];
    return check ? check(v) : true;
  }

  function parseContact(txt) {
    const leaves = flightLeaves(txt);
    const rec = {};
    for (let i = 0; i < leaves.length - 1; i++) {
      const key = CONTACT_LABELS[leaves[i]];
      if (!key || rec[key] !== undefined) continue; // first occurrence wins
      // A <br> contributes an empty segment, so skip blanks. Stopping at the
      // first non-blank keeps the rule that a value must follow its own label:
      // scanning further would let the next label pose as this one's value.
      for (let j = i + 1; j < leaves.length && j <= i + 3; j++) {
        if (!leaves[j].trim()) continue;
        if (acceptable(key, leaves[j])) rec[key] = leaves[j].trim();
        break;
      }
    }
    if (!rec.email) {
      const m = txt.match(/"mailto:([^"]+)"/);
      if (m && acceptable('email', m[1])) rec.email = m[1];
    }
    return rec;
  }

  // --- Pass C: the profile screen -----------------------------------------
  // Same SDUI mechanism as the contact overlay, different screen. The top card
  // ends in a fixed order that we anchor on rather than counting from the start:
  //
  //   headline, company, location, "·", "Contact info"
  //
  // So we find the contact-info label and walk backwards. Everything before that
  // point is navigation and menu chatter that shifts between profiles.

  const CONTACT_ANCHORS = new Set(['Contact info', 'Coordonnées', 'Información de contacto']);
  const COUNT_RE = /^[\d][\d.,\u202f\u00a0 ]*\+?\s+(connections?|relations?|contactos?|contactes?)$/i;

  const isFiller = (v) => v === '·' || v === '' || /^\$L[0-9a-f]+$/i.test(v);

  function plausibleLocation(v, headline) {
    if (!v || v.length > 120) return false;
    if (v === headline || v.includes('|')) return false; // that is a headline
    if (NOT_A_VALUE.has(v) || isIdentifier(v)) return false;
    return !COUNT_RE.test(v);
  }

  function parseProfile(txt) {
    const leaves = flightLeaves(txt).map((v) => v.trim());
    const out = {};

    const anchor = leaves.findIndex((v) => CONTACT_ANCHORS.has(v));
    if (anchor > 0) {
      const before = [];
      for (let i = anchor - 1; i >= 0 && before.length < 3; i--) {
        if (!isFiller(leaves[i])) before.push(leaves[i]);
      }
      const [location, company, headline] = before;
      if (plausibleLocation(location, headline)) out.location = location;
      if (company && company !== out.location && plausibleLocation(company, headline)) {
        out.company = company;
      }
    }

    const count = leaves.find((v) => COUNT_RE.test(v));
    if (count) out.connections = count;
    return out;
  }

  // --- The About section ---------------------------------------------------
  // Lives in its own SDUI component, not in the profile screen, and renders as a
  // label followed by paragraphs separated by the empty segments a <br> emits.
  //
  // The trap: "About" is also a link in LinkedIn's own page footer, where it is
  // followed by "Accessibility", "Careers" and friends. Anchoring on the first
  // occurrence would export the footer menu as somebody's biography. So every
  // occurrence is tried and the longest sensible run wins.

  const ABOUT_LABELS = new Set(['About', 'Infos', 'À propos', 'Acerca de']);

  const ABOUT_STOPS = new Set([
    // other profile sections
    'Experience', 'Education', 'Skills', 'Activity', 'Interests', 'Recommendations',
    'Projects', 'Languages', 'Courses', 'Publications', 'Volunteering', 'Organizations',
    'Expérience', 'Formation', 'Compétences', 'Activité', 'Recommandations', 'Langues',
    'Experiencia', 'Educación', 'Aptitudes', 'Actividad', 'Recomendaciones', 'Idiomas',
    // page furniture
    'Accessibility', 'Talent Solutions', 'Community Guidelines', 'Careers',
    'Marketing Solutions', 'Privacy & Terms', 'Ad Choices', 'Advertising',
    'Sales Solutions', 'Mobile', 'Small Business', 'Safety Center', 'Questions?',
    'see more', '…see more', 'See more', 'Show all', 'Voir plus', 'Ver más',
  ]);

  const MAX_ABOUT = 5000;

  function parseAbout(txt) {
    const leaves = flightLeaves(txt).map((v) => v.trim());
    let best = '';

    for (let i = 0; i < leaves.length; i++) {
      if (!ABOUT_LABELS.has(leaves[i])) continue;
      const parts = [];
      for (let j = i + 1; j < leaves.length && parts.length < 20; j++) {
        const v = leaves[j];
        if (!v) continue; // the empty half of a <br> segment
        if (ABOUT_STOPS.has(v) || NOT_A_VALUE.has(v) || isIdentifier(v)) break;
        parts.push(v);
      }
      const candidate = parts.join('\n\n').trim();
      if (candidate.length > best.length) best = candidate;
    }

    // A couple of stray words is page furniture, not a biography.
    return best.length >= 30 ? best.slice(0, MAX_ABOUT) : '';
  }

  // --- Profile photo -----------------------------------------------------
  // LinkedIn hands back a root URL plus one artifact per size. These URLs carry
  // an expiry (a few months out), so they are fine for the list view and will
  // eventually rot in an old CSV.

  function photoUrl(profile, minWidth = 100) {
    const vector = profile?.profilePicture?.displayImageReference?.vectorImage;
    const artifacts = vector?.artifacts;
    if (!vector?.rootUrl || !artifacts?.length) return '';
    const sorted = [...artifacts].sort((a, b) => a.width - b.width);
    const pick = sorted.find((a) => a.width >= minWidth) || sorted[sorted.length - 1];
    if (!pick?.fileIdentifyingUrlPathSegment) return '';
    const url = vector.rootUrl + pick.fileIdentifyingUrlPathSegment;
    return url.startsWith('https://') ? url : '';
  }

  // --- Headline -> title / company ---------------------------------------
  // ponytail: naive split. LinkedIn's connection list gives no structured
  // position, so this guesses from free text and keeps the raw headline in its
  // own CSV column. Upgrade path: replay the SDUI profile screen
  // (com.linkedin.sdui.flagshipnav.profile.Profile) and read the experience
  // block with flightLeaves(). See README "Adding Pass C".

  function splitHeadline(headline) {
    if (!headline) return { title: '', company: '' };
    const first = headline.split(/\s*[|•·—]\s*/)[0].trim();
    // No "en": it is an ordinary French preposition, so "Chercheur en IA"
    // would split into title "Chercheur", company "IA".
    const m = first.match(/^(.*?)\s+(?:at|@|chez|bei|presso)\s+(.+)$/i);
    if (m) return { title: m[1].trim(), company: m[2].trim() };
    return { title: first, company: '' };
  }

  // --- Birthday ----------------------------------------------------------
  // LinkedIn never exposes the year, only a month and a day, rendered in the
  // viewer's locale as either "June 15" or "15 June".

  // Accents are stripped before matching, so "décembre" and "décembre" alike
  // reduce to "dec". "juin" and "juillet" both start with "jui", hence the
  // longer prefixes for those two.
  const MONTH_PREFIXES = [
    ['jan', 'ene'],
    ['feb', 'fev'],
    ['mar'],
    ['apr', 'avr', 'abr'],
    ['may', 'mai'],
    ['jun', 'juin'],
    ['jul', 'juil'],
    ['aug', 'aou', 'ago'],
    ['sep', 'set'],
    ['oct', 'okt'],
    ['nov'],
    ['dec', 'dic'],
  ];

  const deaccent = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  function parseBirthday(text) {
    if (!text) return null;
    const t = deaccent(String(text).toLowerCase());
    const month = MONTH_PREFIXES.findIndex((names) => names.some((n) => t.includes(n)));
    const day = t.match(/\b(\d{1,2})\b/);
    if (month < 0 || !day) return null;
    const d = Number(day[1]);
    if (d < 1 || d > 31) return null;
    return { month: month + 1, day: d };
  }

  // One reading of a birthday for both networks. Facebook hands over numbers,
  // LinkedIn only the text it rendered, in whatever language it rendered it.
  function birthdayOf(rec) {
    if (rec.birthMonth) return { month: rec.birthMonth, day: rec.birthDay || 0 };
    return parseBirthday(fieldValue(rec, 'birthday'));
  }

  // Facebook sends "12 mutual friends" in the account's own language. The number
  // is the only part a CRM can use, and the only part that sorts.
  function fbMutual(rec) {
    const n = String(rec.mutual || '').match(/\d[\d \u00a0\u202f.,]*/);
    return n ? Number(n[0].replace(/\D/g, '')) : '';
  }

  // --- CSV ---------------------------------------------------------------

  function csvCell(value) {
    let s = value === null || value === undefined ? '' : String(value);
    // A cell starting with these is executed as a formula by Excel and Sheets.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  // The header row can be renamed without touching a single field key, so a
  // translated export stays exactly as machine-readable as an English one.
  function toCSV(rows, columns, labels = null) {
    const lines = [columns.map((c) => (labels && labels[c]) || c).join(',')];
    for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(','));
    return '﻿' + lines.join('\r\n'); // BOM so Excel reads UTF-8
  }

  // --- ICS ---------------------------------------------------------------

  function icsEscape(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/[;,]/g, (c) => '\\' + c).replace(/\r?\n/g, '\\n');
  }

  function toICS(records, now = new Date()) {
    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const year = now.getUTCFullYear();
    const out = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//ExportIn//birthdays//EN',
      'CALSCALE:GREGORIAN',
    ];
    for (const r of records) {
      // Facebook rows carry real numbers, LinkedIn rows only a localised string.
      const b = r.monthBday
        ? { month: Number(r.monthBday), day: Number(r.dayBday) }
        : parseBirthday(r.birthday);
      if (!b || !b.month || !b.day) continue;
      // Starting the series on the real birth year makes calendars that know how
      // to count show the age on each occurrence.
      const from = Number(r.yearBday) || year;
      const date = `${from}${String(b.month).padStart(2, '0')}${String(b.day).padStart(2, '0')}`;
      const id = r.publicId || r.facebookId || '';
      const name = `${r.firstName || ''} ${r.lastName || ''}`.trim() || r.name || id;
      const link = r.profileUrl || (id ? `https://www.linkedin.com/in/${id}/` : '');
      out.push(
        'BEGIN:VEVENT',
        `UID:${id}-birthday@exportin`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${date}`,
        'DURATION:P1D',
        'RRULE:FREQ=YEARLY',
        `SUMMARY:${icsEscape('Birthday: ' + name)}`,
        `DESCRIPTION:${icsEscape([r.headline || r.work, link].filter(Boolean).join('\n'))}`,
        'END:VEVENT',
      );
    }
    out.push('END:VCALENDAR');
    return out.join('\r\n');
  }

  // --- Record shaping ----------------------------------------------------

  // yearBday is listed although LinkedIn never fills it: both exports then carry
  // the same four birthday columns, so one CRM mapping imports either file.
  const COLUMNS = [
    'firstName', 'lastName', 'title', 'company', 'headline', 'profileUrl',
    'connectedOn', 'email', 'phone', 'dateBday', 'dayBday', 'monthBday', 'yearBday',
    'location', 'connections', 'about',
    'website', 'address', 'twitter', 'im', 'photoUrl', 'publicId', 'memberUrn',
    'firstSeen', 'lastSeen', 'removed', 'note',
  ];

  // Records collected before parseContact validated its values can still hold a
  // URN where an email belongs. Filtering on read fixes those retroactively,
  // with no migration and no rewrite of the store.
  function fieldValue(rec, key) {
    const raw = rec[key];
    return acceptable(key, raw) ? String(raw).trim() : '';
  }

  function toRow(rec) {
    const guessed = splitHeadline(rec.headline);
    // Pass C knows; splitHeadline only guesses. Prefer the one that knows.
    const title = guessed.title;
    const company = rec.company || guessed.company;
    const b = parseBirthday(fieldValue(rec, 'birthday'));
    return {
      firstName: rec.firstName || '',
      lastName: rec.lastName || '',
      title,
      company,
      headline: rec.headline || '',
      location: fieldValue(rec, 'location'),
      connections: rec.connections || '',
      about: rec.about || '',
      profileUrl: `https://www.linkedin.com/in/${rec.publicId}/`,
      connectedOn: rec.connectedAt ? new Date(rec.connectedAt).toISOString().slice(0, 10) : '',
      email: fieldValue(rec, 'email'),
      phone: fieldValue(rec, 'phone'),
      ...bdayCells(b ? b.month : 0, b ? b.day : 0, 0),
      website: fieldValue(rec, 'website'),
      address: fieldValue(rec, 'address'),
      twitter: fieldValue(rec, 'twitter'),
      im: fieldValue(rec, 'im'),
      photoUrl: rec.photoUrl || '',
      publicId: rec.publicId || '',
      memberUrn: rec.memberUrn || '',
      firstSeen: rec.firstSeen ? new Date(rec.firstSeen).toISOString().slice(0, 10) : '',
      lastSeen: rec.lastSeen ? new Date(rec.lastSeen).toISOString().slice(0, 10) : '',
      removed: rec.removed ? 'yes' : '',
      note: rec.contactError || '',
    };
  }

  // What we know about a connection beyond the list basics.
  function rowStatus(rec) {
    if (rec.removed) return 'removed';
    if (!rec.contactDone) return 'pending';
    if (rec.contactError) return 'blocked';
    return ['email', 'phone', 'birthday', 'website'].some((k) => fieldValue(rec, k)) ? 'found' : 'empty';
  }

  // --- Facebook -----------------------------------------------------------
  // Facebook answers GraphQL with one JSON object per line: a first payload,
  // then streamed deltas. The people we want sit at a different depth in each,
  // so rather than walking a path that moves, we walk the whole tree and keep
  // anything person-shaped. Same spirit as flightLeaves on the LinkedIn side.

  const PERSON_FIELDS = ['birthdate', 'profile_picture', 'profile_url', 'social_context'];
  const MAX_DEPTH = 40;

  function fbJsonLines(text) {
    const out = [];
    for (const line of String(text).split('\n')) {
      const s = line.trim();
      if (!s || (s[0] !== '{' && s[0] !== '[')) continue;
      try {
        out.push(JSON.parse(s));
      } catch {
        /* a truncated frame is not ours to repair */
      }
    }
    return out;
  }

  function fbWalk(value, hit, depth = 0) {
    if (!value || typeof value !== 'object' || depth > MAX_DEPTH) return;
    if (Array.isArray(value)) {
      for (const v of value) fbWalk(v, hit, depth + 1);
      return;
    }
    if (typeof value.id === 'string' && typeof value.name === 'string'
        && PERSON_FIELDS.some((f) => value[f])) {
      hit(value, depth);
    }
    for (const k of Object.keys(value)) fbWalk(value[k], hit, depth + 1);
  }

  // Facebook stores one display name. Splitting it is a guess: everything after
  // the first space becomes the family name, which is wrong for compound given
  // names and right most of the time. The full name is kept verbatim regardless,
  // so a CRM import can use whichever it trusts.
  function splitName(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) return { firstName: parts[0] || '', lastName: '' };
    return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
  }

  function fbRecord(node) {
    // Pages, ads and group entities also carry an id and a name. Real profiles
    // are long numeric strings, and that alone filters most of the noise.
    if (!/^\d{5,}$/.test(String(node.id))) return null;
    const name = String(node.name).trim();
    if (!name) return null;

    const rec = { publicId: String(node.id), name, ...splitName(name) };
    const picture = node.profile_picture || {};
    if (typeof picture.uri === 'string' && picture.uri.startsWith('https://')) {
      rec.photoUrl = picture.uri;
      // Kept so "the photos are too small" can be answered with a measurement
      // rather than an impression.
      if (Number(picture.width) > 0) rec.photoW = Number(picture.width);
    }
    const url = node.profile_url || node.url;
    if (typeof url === 'string' && url.includes('facebook.com')) rec.profileUrl = url.split('?')[0];
    if (node.gender) rec.gender = String(node.gender).toLowerCase();
    const mutual = node.social_context && node.social_context.text;
    if (typeof mutual === 'string' && mutual.trim()) rec.mutual = mutual.trim();

    const b = node.birthdate;
    if (b && Number(b.month) >= 1 && Number(b.month) <= 12 && Number(b.day) >= 1 && Number(b.day) <= 31) {
      rec.birthMonth = Number(b.month);
      rec.birthDay = Number(b.day);
      // The year is only there when the profile shares it, and it is the one
      // thing LinkedIn never gives. Reject placeholders outside a human range.
      const year = Number(b.year);
      if (year >= 1900 && year <= new Date().getFullYear()) rec.birthYear = year;
    }
    return rec;
  }

  // Later fields win, but only fields that are actually present: a node from the
  // friends list has no birthdate and must not erase one found in a month sweep.
  function fbPeople(text) {
    const found = new Map();
    for (const doc of fbJsonLines(text)) {
      fbWalk(doc, (node) => {
        const rec = fbRecord(node);
        if (!rec) return;
        const prev = found.get(rec.publicId);
        found.set(rec.publicId, prev ? { ...prev, ...rec } : rec);
      });
    }
    return [...found.values()];
  }

  // A response can hold several page_info blocks: the connection we are paging
  // plus nested ones inside individual nodes. The one we want is the shallowest,
  // because it belongs to the query itself rather than to a person inside it.
  function fbPageInfo(text) {
    let best = null;
    for (const doc of fbJsonLines(text)) {
      const walk = (v, depth) => {
        if (!v || typeof v !== 'object' || depth > MAX_DEPTH) return;
        if (Array.isArray(v)) {
          for (const x of v) walk(x, depth + 1);
          return;
        }
        if ('has_next_page' in v || 'end_cursor' in v) {
          if (!best || depth < best.depth) {
            best = {
              depth,
              hasNext: Boolean(v.has_next_page),
              cursor: typeof v.end_cursor === 'string' ? v.end_cursor : null,
            };
          }
        }
        for (const k of Object.keys(v)) walk(v[k], depth + 1);
      };
      walk(doc, 0);
    }
    return best ? { hasNext: best.hasNext, cursor: best.cursor } : { hasNext: false, cursor: null };
  }

  // A request for a query the page has never sent, built from one it has. The
  // envelope (token, session and build parameters) is the same on every call
  // the page makes; only the name, the doc_id and the variables differ.
  function fbSynthBody(envelope, name, docId, variables) {
    const params = new URLSearchParams(envelope);
    if (!params.get('fb_dtsg') || !/^\d{5,}$/.test(String(docId))) return null;
    params.set('fb_api_req_friendly_name', name);
    params.set('doc_id', String(docId));
    params.set('variables', JSON.stringify(variables));
    params.delete('fb_api_analytics_tags');
    return params.toString();
  }

  function fbAge(rec, today = new Date()) {
    if (!rec.birthYear || !rec.birthMonth || !rec.birthDay) return '';
    const month = today.getMonth() + 1;
    let age = today.getFullYear() - rec.birthYear;
    const passed = month > rec.birthMonth || (month === rec.birthMonth && today.getDate() >= rec.birthDay);
    if (!passed) age -= 1;
    return age >= 0 && age < 120 ? age : '';
  }

  const fbProfileUrl = (rec) =>
    rec.profileUrl || (rec.publicId ? `https://www.facebook.com/${rec.publicId}` : '');

  const FB_COLUMNS = [
    'firstName', 'lastName', 'name', 'dateBday', 'dayBday', 'monthBday', 'yearBday',
    'age', 'mutualFriends', 'gender', 'profileUrl', 'photoUrl',
    'facebookId', 'firstSeen', 'lastSeen', 'removed',
  ];

  const pad2 = (n) => String(n).padStart(2, '0');

  // ISO, not a local format: "14/03" and "03/14" are the same string to two
  // people in two countries, and a CRM import never asks which one you meant.
  function bdayCells(month, day, year) {
    if (!month || !day) return { dateBday: '', dayBday: '', monthBday: '', yearBday: '' };
    const monthDay = `${pad2(month)}-${pad2(day)}`;
    return {
      dateBday: year ? `${year}-${monthDay}` : monthDay,
      dayBday: day,
      monthBday: month,
      yearBday: year || '',
    };
  }

  function toRowFb(rec, today = new Date()) {
    return {
      firstName: rec.firstName || '',
      lastName: rec.lastName || '',
      name: rec.name || '',
      ...bdayCells(rec.birthMonth, rec.birthDay, rec.birthYear),
      age: fbAge(rec, today),
      mutualFriends: fbMutual(rec),
      gender: rec.gender || '',
      profileUrl: fbProfileUrl(rec),
      photoUrl: rec.photoUrl || '',
      facebookId: rec.publicId || '',
      publicId: rec.publicId || '',
      firstSeen: rec.firstSeen ? new Date(rec.firstSeen).toISOString().slice(0, 10) : '',
      lastSeen: rec.lastSeen ? new Date(rec.lastSeen).toISOString().slice(0, 10) : '',
      removed: rec.removed ? 'yes' : '',
    };
  }

  // No 'pending': a Facebook record only exists once a sweep has stored it.
  function fbStatus(rec) {
    if (rec.removed) return 'removed';
    return rec.birthMonth ? 'found' : 'empty';
  }

  // The list sweep carries no birthday, so it must never blank one. Comparing
  // only the fields a sweep actually sends keeps a rescan quiet.
  const FB_DIFF_FIELDS = ['name', 'birthMonth', 'birthDay', 'birthYear'];

  // Who is gone after a complete friend-list walk. The birthday feed only holds
  // current friends, so anyone it returned during this run is kept whatever the
  // list says. Measured on a real account: the list stopped at 1417 of 1486 and
  // still reported itself complete, and 60 of the 69 it skipped had just been
  // returned by the birthday sweep.
  //
  // So the list only counts as proof when it skipped none of those confirmed
  // friends. Otherwise a friend without a birthday cannot be judged, and flags
  // an earlier lossy walk put on such friends are withdrawn.
  // ponytail: that withdrawal also clears a genuine removal flagged by an older
  // trustworthy walk; tracking which walk set a flag would fix it.
  function fbRemovals(records, seenIds, runStart) {
    const seenNow = (r) => seenIds.has(r.publicId) || (r.lastSeen || 0) >= runStart;
    const skipped = records.filter((r) => r.birthMonth && (r.lastSeen || 0) >= runStart && !seenIds.has(r.publicId)).length;
    const trusted = skipped === 0;
    return {
      skipped,
      remove: records
        .filter((r) => !r.removed && !seenNow(r) && (trusted || r.birthMonth))
        .map((r) => r.publicId),
      restore: trusted ? [] : records.filter((r) => r.removed && !r.birthMonth).map((r) => r.publicId),
    };
  }

  function fbDiffRecord(existing, fresh) {
    if (!existing) return 'added';
    if (existing.removed) return 'added';
    return FB_DIFF_FIELDS.some(
      (f) => fresh[f] !== undefined && (existing[f] || '') !== (fresh[f] || ''),
    ) ? 'updated' : 'same';
  }

  // --- Breakage detection --------------------------------------------------
  // A scraper does not break with an error. It breaks with a 200 OK whose shape
  // it no longer understands, which looks exactly like a run of people who share
  // nothing, except that it never ends. So the signal is a rate, not an event:
  // count how often a request that succeeded actually yielded something.
  //
  // `min` is how many samples are needed before the verdict means anything, and
  // `floor` is the yield rate at or below which we call it broken. Contact
  // details really are empty for most people, so their floor is exactly zero:
  // forty answers in a row carrying nothing is a shape change, not shyness. A
  // list page, by contrast, should nearly always parse.

  const PROBES = {
    list: { min: 2, floor: 0.4 },
    contact: { min: 40, floor: 0 },
    profile: { min: 20, floor: 0 },
    about: { min: 20, floor: 0 },
    birthdays: { min: 2, floor: 0.4 },
    friends: { min: 2, floor: 0.4 },
  };

  const PROBE_KEYS = Object.keys(PROBES);

  // Stored as [attempts, yields] so a full health record stays a handful of
  // bytes in a value that is rewritten on every single request.
  function noteProbe(health, key, yielded) {
    if (!PROBES[key]) return health || {};
    const [attempts, yields] = (health && health[key]) || [0, 0];
    return { ...health, [key]: [attempts + 1, yields + (yielded ? 1 : 0)] };
  }

  function probeVerdict(health, key) {
    const spec = PROBES[key];
    const [attempts, yields] = (health && health[key]) || [0, 0];
    if (!spec || attempts < spec.min) return 'unknown';
    return yields / attempts <= spec.floor ? 'broken' : 'ok';
  }

  const brokenProbes = (health) =>
    PROBE_KEYS.filter((key) => probeVerdict(health, key) === 'broken');

  // A report the user can paste into an issue. Counters, versions and query
  // names only: no record, no name, no identifier, no token ever reaches it,
  // because the person sending it cannot be expected to audit it first.
  function diagnostic({ version = '', platform = '', phase = '', errorKey = '',
                        errorInfo = '', lang = '', health = {}, learnt = [],
                        seen = 0, now = new Date() } = {}) {
    const clean = (v) => String(v).replace(/[^\w .:/-]/g, '').slice(0, 80);
    const lines = [
      `ExportIn ${clean(version)} | ${clean(platform)} | ui ${clean(lang)}`,
      `date ${now.toISOString().slice(0, 10)}`,
      `phase ${clean(phase)}${errorKey ? ` | error ${clean(errorKey)}` : ''}`,
    ];
    if (errorInfo) lines.push(`detail ${clean(errorInfo)}`);
    lines.push('', 'probe            attempts  yields  verdict');
    for (const key of PROBE_KEYS) {
      const [attempts, yields] = health[key] || [0, 0];
      if (!attempts) continue;
      lines.push(
        `${key.padEnd(16)} ${String(attempts).padStart(8)} ${String(yields).padStart(7)}  ${probeVerdict(health, key)}`,
      );
    }
    if (seen) lines.push('', `graphql calls observed: ${Number(seen) || 0}`);
    if (learnt.length) lines.push(seen ? '' : '', 'queries learnt: ' + learnt.map(clean).join(', '));
    return lines.join('\n');
  }

  // --- Platform descriptors ------------------------------------------------
  // Storage prefixes are frozen, not chosen. LinkedIn records were written under
  // 'p:' long before a second network existed, and rewriting 1800 live records to
  // make two constants match would risk real data for cosmetics. A record with no
  // `source` is LinkedIn, which is true by construction.

  const PLATFORMS = {
    linkedin: {
      key: 'linkedin',
      prefix: 'p:',
      metaKey: 'meta',
      match: 'https://www.linkedin.com/*',
      openUrl: 'https://www.linkedin.com/feed/',
      fileStem: 'linkedin-connections',
      icsStem: 'linkedin-birthdays',
      columns: COLUMNS,
      photoKey: (id) => id,
    },
    facebook: {
      key: 'facebook',
      prefix: 'f:',
      metaKey: 'metaFb',
      match: 'https://www.facebook.com/*',
      openUrl: 'https://www.facebook.com/friends/birthdays',
      fileStem: 'facebook-friends',
      icsStem: 'facebook-birthdays',
      columns: FB_COLUMNS,
      // LinkedIn photos were stored under the bare id before this existed, so
      // only the new side gets a namespace. Nothing on disk has to move.
      photoKey: (id) => 'fb:' + id,
    },
  };

  const PLATFORM_KEYS = Object.keys(PLATFORMS);

  // How many of these records have a photo on disk. Counting the whole photo
  // store instead would report LinkedIn's avatars on the Facebook tab, since
  // both networks share one IndexedDB.
  function photosHeld(records, have, platform) {
    const key = (PLATFORMS[platform] || PLATFORMS.linkedin).photoKey;
    let n = 0;
    for (const rec of records) if (rec && rec.publicId && have.has(key(rec.publicId))) n += 1;
    return n;
  }

  // --- Cache reconciliation ----------------------------------------------
  // A list page only carries the list fields. Contact details already on disk
  // must survive, and the fresh copy must win for anything it does carry.

  // photoUrl is deliberately absent: LinkedIn re-signs those URLs with a fresh
  // expiry and signature, so comparing them would report every single connection
  // as changed on each rescan. The fresh value is still stored, just not diffed.
  const DIFF_FIELDS = ['firstName', 'lastName', 'headline'];

  function diffRecord(existing, fresh) {
    if (!existing) return 'added';
    if (existing.removed) return 'added'; // reconnected
    return DIFF_FIELDS.some((f) => (existing[f] || '') !== (fresh[f] || '')) ? 'updated' : 'same';
  }

  function mergeRecord(existing, fresh, now) {
    // fresh last: list fields win. Contact fields are absent from fresh, so the
    // spread leaves them untouched.
    const merged = { ...existing, ...fresh, lastSeen: now };
    merged.firstSeen = existing?.firstSeen || now;
    if (existing && existing.headline && existing.headline !== fresh.headline) {
      merged.prevHeadline = existing.headline;
      merged.headlineChangedAt = now;
    }
    delete merged.removed;
    delete merged.removedAt;
    return merged;
  }

  // --- Sorting -----------------------------------------------------------
  // Blank cells always sink to the bottom whichever way the column points,
  // because a screen of empty rows is never the thing you clicked to see.

  const STATUS_RANK = { found: 0, empty: 1, blocked: 2, pending: 3, removed: 4 };

  const SORT_KEYS = {
    name: (r) => `${r.firstName || ''} ${r.lastName || ''}`.trim().toLowerCase(),
    connected: (r) => r.connectedAt || 0,
    email: (r) => (r.email || '').toLowerCase(),
    phone: (r) => (r.phone || '').replace(/[^\d+]/g, ''),
    // Facebook hands over real numbers; LinkedIn only ever renders a date as
    // text. One key reads both so the table needs no per-platform sorting.
    birthday: (r) => {
      const b = birthdayOf(r);
      return b ? b.month * 100 + b.day : 0;
    },
    age: (r) => Number(fbAge(r)) || 0,
    mutual: (r) => Number(fbMutual(r)) || 0,
    status: (r) => STATUS_RANK[r.source === 'facebook' ? fbStatus(r) : rowStatus(r)] ?? 9,
  };

  function sortComparator(key, dir, locale = 'en') {
    const value = SORT_KEYS[key] || SORT_KEYS.name;
    // Status is a rank, so "blank" is not a thing and 0 is a real position.
    const blank = (v) => v === '' || v === null || v === undefined || (key !== 'status' && v === 0);
    return (a, b) => {
      const va = value(a);
      const vb = value(b);
      if (blank(va) !== blank(vb)) return blank(va) ? 1 : -1;
      if (blank(va)) return 0;
      const cmp = typeof va === 'number' ? va - vb : va.localeCompare(vb, locale);
      return cmp * dir;
    };
  }

  // --- Automatic recovery -------------------------------------------------
  // Whether a silent worker should be restarted without asking. Pure on purpose:
  // getting this wrong means hammering an account LinkedIn has already
  // rate-limited, which is how a warning becomes a suspension.

  const AUTO_RETRY = { staleMs: 30000, maxAttempts: 5, minGapMs: 15000 };

  function shouldAutoRetry(meta, ctx) {
    const { now, attempts, lastAttemptAt } = ctx;
    const { staleMs, maxAttempts, minGapMs } = { ...AUTO_RETRY, ...ctx };

    // Every fatal stop (rate limit, checkpoint, no session) and every user pause
    // clears `running`. Only a worker that still claims to be working, yet has
    // gone quiet, is a candidate.
    if (!meta || !meta.running) return false;
    if (meta.phase === 'error' || meta.phase === 'paused') return false;
    if (now - (meta.lastActivity || 0) <= staleMs) return false;
    if (attempts >= maxAttempts) return false;
    if (now - (lastAttemptAt || 0) < minGapMs) return false;
    return true;
  }

  // --- Pacing --------------------------------------------------------------
  // Named paces instead of a raw millisecond box: nobody knows what 4000 means,
  // everybody understands "about two hours left".

  const PACE_PRESETS = [
    { key: 'cautious', delayMs: 7000 },
    { key: 'balanced', delayMs: 4000 },
    { key: 'fast', delayMs: 2000 },
  ];

  const paceKey = (delayMs) =>
    (PACE_PRESETS.find((p) => p.delayMs === delayMs) || { key: 'custom' }).key;

  // LinkedIn does not ask politely before it acts: a 429 is the last warning,
  // not the first. Retries are the earlier signal, so the pace stretches on them
  // and creeps back only once requests land cleanly again.
  const PRESSURE = { step: 1.7, max: 5, decay: 0.8 };

  function nextPressure(current, ok, opts = {}) {
    const { step, max, decay } = { ...PRESSURE, ...opts };
    const base = Number.isFinite(current) && current >= 1 ? current : 1;
    return ok ? Math.max(1, base * decay) : Math.min(base * step, max);
  }

  const effectiveDelay = (delayMs, pressure) =>
    Math.round((delayMs || 4000) * (Number.isFinite(pressure) && pressure >= 1 ? pressure : 1));

  globalThis.LIB = {
    flightLeaves, parseContact, parseProfile, parseAbout, acceptable, fieldValue, photoUrl, splitHeadline, parseBirthday,
    csvCell, toCSV, icsEscape, toICS, toRow, rowStatus, bdayCells,
    diffRecord, mergeRecord, DIFF_FIELDS, sortComparator, SORT_KEYS,
    shouldAutoRetry, AUTO_RETRY,
    PACE_PRESETS, paceKey, nextPressure, effectiveDelay, PRESSURE,
    COLUMNS, CONTACT_LABELS,
    fbJsonLines, fbPeople, fbPageInfo, fbRecord, fbSynthBody, fbRemovals, fbAge, fbProfileUrl,
    birthdayOf, fbMutual,
    toRowFb, fbStatus, fbDiffRecord, splitName, FB_COLUMNS, FB_DIFF_FIELDS,
    PLATFORMS, PLATFORM_KEYS, photosHeld,
    PROBES, PROBE_KEYS, noteProbe, probeVerdict, brokenProbes, diagnostic,
  };
})();
