// node test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

new Function(await readFile(new URL('./dist/lib.js', import.meta.url), 'utf8'))();
new Function(await readFile(new URL('./dist/i18n.js', import.meta.url), 'utf8'))();
// icons.js builds real SVG nodes; a stub document is enough to read its map.
globalThis.document = { createElementNS: () => ({ setAttribute() {}, append() {}, classList: { add() {} } }) };
new Function(await readFile(new URL('./dist/icons.js', import.meta.url), 'utf8'))();
new Function(await readFile(new URL('./dist/zip.js', import.meta.url), 'utf8'))();
const panelSrc = await readFile(new URL('./dist/panel.js', import.meta.url), 'utf8');
const panelHtml = await readFile(new URL('./dist/panel.html', import.meta.url), 'utf8');
const mockSrc = await readFile(new URL('./demo/mock.js', import.meta.url), 'utf8');
const hookSrc = await readFile(new URL('./dist/fb-hook.js', import.meta.url), 'utf8');
const fbWorkerSrc = await readFile(new URL('./dist/content-facebook.js', import.meta.url), 'utf8');
const { flightLeaves, parseContact, parseProfile, parseAbout, photoUrl, splitHeadline, parseBirthday, csvCell, toCSV, toICS, toRow, rowStatus,
        diffRecord, mergeRecord, sortComparator, SORT_KEYS, acceptable, fieldValue,
        shouldAutoRetry, nextPressure, effectiveDelay, paceKey, PACE_PRESETS, COLUMNS,
        fbJsonLines, fbPeople, fbPageInfo, fbRecord, fbAge, fbProfileUrl,
        toRowFb, fbStatus, fbDiffRecord, splitName, FB_COLUMNS, PLATFORMS, photosHeld,
        bdayCells, PROBES, noteProbe, probeVerdict, brokenProbes, diagnostic } = globalThis.LIB;
const { STRINGS, LANGS, detect, COLUMN_SLUGS } = globalThis.I18N;
const { crc32, zipStore, safeName } = globalThis.ZIP;
const enc = (s) => new TextEncoder().encode(s);

let passed = 0;
const t = (name, fn) => {
  try { fn(); passed++; }
  catch (e) { console.error(`FAIL ${name}\n  ${e.message}`); process.exitCode = 1; }
};

// Trimmed from a real ProfileContactDetailsOverlay response. The email sits in a
// nested link node while "Connected since" is a plain string, so both shapes are
// exercised. Birthday and Phone rows are appended in the same shape LinkedIn uses.
const FLIGHT = `
["$","$L3",null,{"titleText":"Contact info","renderedTitle":["Contact info"]}],
["$","div",null,{"className":"e12345 _1957d19a","children":[["$","p",null,{"className":"d89a6b59","children":["Email"]}],["$","$L11",null,{"textProps":{"fontWeight":"bold","children":[["$","$L12","text-attr-0",{"action":{"actions":[{"$type":"proto.sdui.actions.core.Navigate","value":{"content":{"$case":"url","url":{"urlValue":{"$case":"url","url":"mailto:jo.doe@example.com"},"openInNewTab":true}}}}]},"children":["jo.doe@example.com"]}]]}}]]}],
["$","div",null,{"className":"e12345","children":[["$","p",null,{"className":"d89a6b59","children":["Phone"]}],["$","$L11",null,{"textProps":{"children":["+33 6 12 34 56 78"]}}]]}],
["$","div",null,{"className":"e12345","children":[["$","p",null,{"className":"d89a6b59","children":["Birthday"]}],["$","$L11",null,{"textProps":{"children":["June 15"]}}]]}],
["$","div",null,{"className":"e12345","children":[["$","p",null,{"className":"d89a6b59","children":["Connected since"]}],["$","$L11",null,{"textProps":{"children":["Sep 17, 2026"]}}]]}]
`;

t('parseContact reads every labelled row', () => {
  const c = parseContact(FLIGHT);
  assert.equal(c.email, 'jo.doe@example.com');
  assert.equal(c.phone, '+33 6 12 34 56 78');
  assert.equal(c.birthday, 'June 15');
  assert.equal(c.connectedSince, 'Sep 17, 2026');
});

t('parseContact skips rows a profile has not filled in', () => {
  const only = FLIGHT.split('\n').filter((l) => !/Birthday|Phone/.test(l)).join('\n');
  const c = parseContact(only);
  assert.equal(c.birthday, undefined);
  assert.equal(c.phone, undefined);
  assert.equal(c.email, 'jo.doe@example.com');
});

t('flightLeaves sees the three shapes LinkedIn actually emits', () => {
  // Captured from a live profile response. Only the first was handled at first,
  // which made every multi-line value invisible, the About section included.
  const plain = '"children":["Email"]';
  const first = '"children":[null,"Born in Morocco, I started programming."]';
  const cont = '"children":[["$","br",null,{}],"At the age of 15, I launched it."]';
  assert.deepEqual(flightLeaves(plain), ['Email']);
  assert.deepEqual(flightLeaves(first), ['Born in Morocco, I started programming.']);
  assert.deepEqual(flightLeaves(cont), ['At the age of 15, I launched it.']);
  assert.deepEqual(flightLeaves(plain + ',' + first), ['Email', 'Born in Morocco, I started programming.']);
});

t('an empty <br> segment does not swallow the value after a label', () => {
  // A <br> emits an empty string. Pairing naively on the next leaf would store
  // "" and lose the real value that follows.
  const flight =
    '["$","p",null,{"children":["Phone"]}],' +
    '["$","x",null,{"children":[["$","br",null,{}],""]}],' +
    '["$","$L11",null,{"children":[null,"+33 6 11 22 33 44"]}]';
  assert.equal(parseContact(flight).phone, '+33 6 11 22 33 44');
});

t('skipping blanks still cannot reach past the next label', () => {
  const flight =
    '["$","p",null,{"children":["Address"]}],' +
    '["$","x",null,{"children":[["$","br",null,{}],""]}],' +
    '["$","p",null,{"children":["Connected since"]}],' +
    '["$","$L11",null,{"children":["Sep 17, 2026"]}]';
  const c = parseContact(flight);
  assert.equal(c.address, undefined, 'the next label is still not a value');
  assert.equal(c.connectedSince, 'Sep 17, 2026');
});

t('parseContact refuses an identifier sitting where a value should be', () => {
  // Seen in the wild: a member URN landed in the Email column because the parser
  // took whatever followed the label without looking at it.
  const flight = '["$","p",null,{"children":["Email"]}],["$","$L11",null,{"children":["urn:li:member:000000000"]}]';
  assert.equal(parseContact(flight).email, undefined, 'a URN is not an email address');

  const profileLink = '["$","p",null,{"children":["Email"]}],["$","$L11",null,{"children":["https://www.linkedin.com/in/someone"]}]';
  assert.equal(parseContact(profileLink).email, undefined);
});

// The real leaf order from a profile screen, with invented values in place of
// the person's own. The top card always ends the same way.
const leaf = (v) => `"children":["${v}"]`;
const PROFILE = [
  leaf('Follow'), leaf('Block someone'), leaf('About this member'), leaf('· 1st'),
  leaf('Ingénieur logiciel | Systèmes embarqués | ACME'),
  leaf('ACME SCHOOL'),
  leaf('Moissy-Cramayel, Île-de-France, France'),
  leaf('·'), leaf('Contact info'), leaf('$L69'),
  leaf('ACME SCHOOL'), leaf('117 connections'),
].join(',');

// The shape the About component returns: a label, then paragraphs separated by
// the empty segments a <br> emits. Content invented.
const aboutLeaf = (v) => `"children":[null,"${v}"]`;
const ABOUT_CARD = [
  aboutLeaf('Past 7 days'), aboutLeaf('36 search appearances'),
  aboutLeaf('About'),
  aboutLeaf('Builder of small, sharp tools.'), aboutLeaf(''),
  aboutLeaf('I have spent twelve years shipping software for small teams, mostly in logistics.'), aboutLeaf(''),
  aboutLeaf('These days I work on scheduling systems and write about the trade.'),
  aboutLeaf('Experience'), aboutLeaf('Head of Platform at ACME'),
].join(',');

t('parseAbout keeps the paragraphs and stops at the next section', () => {
  const about = parseAbout(ABOUT_CARD);
  assert.ok(about.startsWith('Builder of small, sharp tools.'));
  assert.ok(about.includes('twelve years'));
  assert.ok(about.endsWith('write about the trade.'));
  assert.equal(about.split('\n\n').length, 3, 'blank <br> halves separate, they do not appear');
  assert.ok(!about.includes('Head of Platform'), 'the next section must not bleed in');
});

t('parseAbout is not fooled by the About link in the page footer', () => {
  // LinkedIn's own footer has an "About" link followed by Accessibility and
  // Careers. Anchoring on the first match would export the menu as a biography.
  const footer = [
    aboutLeaf('About'), aboutLeaf('Accessibility'), aboutLeaf('Talent Solutions'), aboutLeaf('Careers'),
  ].join(',');
  assert.equal(parseAbout(footer), '');
  // And with both present, the real one still wins.
  assert.ok(parseAbout(footer + ',' + ABOUT_CARD).startsWith('Builder of small'));
});

t('parseAbout returns nothing rather than a fragment', () => {
  assert.equal(parseAbout(''), '');
  assert.equal(parseAbout('no anchor here'), '');
  assert.equal(parseAbout(aboutLeaf('About') + ',' + aboutLeaf('Hi')), '', 'two words is not a biography');
});

t('parseAbout caps a runaway biography', () => {
  const long = [aboutLeaf('About'), aboutLeaf('x'.repeat(9000))].join(',');
  assert.equal(parseAbout(long).length, 5000);
});

t('parseProfile reads the top card by anchoring on the contact label', () => {
  const p = parseProfile(PROFILE);
  assert.equal(p.location, 'Moissy-Cramayel, Île-de-France, France');
  assert.equal(p.company, 'ACME SCHOOL');
  assert.equal(p.connections, '117 connections');
});

t('parseProfile refuses to pass a headline off as a location', () => {
  // A headline carries pipes and is the leaf two before the location, so an
  // off-by-one would quietly fill the column with job descriptions.
  const shifted = [
    leaf('Ingénieur logiciel | Systèmes embarqués | ACME'), leaf('·'), leaf('Contact info'),
  ].join(',');
  assert.equal(parseProfile(shifted).location, undefined);
});

t('parseProfile returns nothing rather than guessing', () => {
  assert.deepEqual(parseProfile('no anchor anywhere'), {});
  assert.deepEqual(parseProfile(''), {});
});

t('a real location beats the headline guess for company', () => {
  const row = toRow({
    publicId: 'a', headline: 'Designer at Wrongco | freelance',
    company: 'ACME SCHOOL', location: 'Paris, France',
  });
  assert.equal(row.company, 'ACME SCHOOL', 'pass C knows, splitHeadline only guesses');
  assert.equal(row.location, 'Paris, France');
  assert.equal(toRow({ publicId: 'b', headline: 'Designer at Wrongco' }).company, 'Wrongco');
});

t('a label cannot slip into the location column either', () => {
  assert.equal(toRow({ publicId: 'a', location: 'Contact info' }).location, '');
});

t('a label is never stored as the value of the label before it', () => {
  // Straight from a real export: the address column held "Connected since" and
  // "Email". An empty row is not rendered at all, so the leaf after a label can
  // be the next label rather than a value.
  const flight =
    '["$","p",null,{"children":["Address"]}],' +
    '["$","p",null,{"children":["Connected since"]}],' +
    '["$","$L11",null,{"children":["Sep 17, 2026"]}]';
  const c = parseContact(flight);
  assert.equal(c.address, undefined, 'a label is not an address');
  assert.equal(c.connectedSince, 'Sep 17, 2026');
});

t('no field will swallow a label, in any supported language', () => {
  for (const label of ['Email', 'Connected since', 'Birthday', 'Contact info', 'Téléphone', 'Cumpleaños']) {
    assert.ok(!acceptable('address', label), `"${label}" must not pass as an address`);
    assert.ok(!acceptable('twitter', label), `"${label}" must not pass as a handle`);
  }
});

t('the overlay is read in French and Spanish too', () => {
  const fr =
    '["$","p",null,{"children":["Téléphone"]}],["$","$L11",null,{"children":["+33 6 11 22 33 44"]}],' +
    '["$","p",null,{"children":["Anniversaire"]}],["$","$L11",null,{"children":["27 septembre"]}]';
  const parsedFr = parseContact(fr);
  assert.equal(parsedFr.phone, '+33 6 11 22 33 44');
  assert.deepEqual(parseBirthday(parsedFr.birthday), { month: 9, day: 27 });

  const es =
    '["$","p",null,{"children":["Cumpleaños"]}],["$","$L11",null,{"children":["3 de enero"]}]';
  assert.deepEqual(parseBirthday(parseContact(es).birthday), { month: 1, day: 3 });
});

t('parseBirthday tells juin from juillet', () => {
  // Both start with "jui", which a three-letter prefix would confuse.
  assert.deepEqual(parseBirthday('14 juin'), { month: 6, day: 14 });
  assert.deepEqual(parseBirthday('14 juillet'), { month: 7, day: 14 });
  assert.deepEqual(parseBirthday('1 décembre'), { month: 12, day: 1 });
  assert.deepEqual(parseBirthday('9 août'), { month: 8, day: 9 });
  assert.deepEqual(parseBirthday('5 de agosto'), { month: 8, day: 5 });
  assert.deepEqual(parseBirthday('2 de febrero'), { month: 2, day: 2 });
});

t('parseContact only accepts values shaped like their field', () => {
  assert.ok(acceptable('email', 'jane@example.com'));
  assert.ok(!acceptable('email', 'Jane Doe'));
  assert.ok(!acceptable('email', 'urn:li:member:42'));
  assert.ok(acceptable('phone', '+33 6 12 34 56 78'));
  assert.ok(!acceptable('phone', 'Mobile'), 'a label is not a number');
  assert.ok(acceptable('website', 'acme.com'));
  assert.ok(!acceptable('website', 'Company website'));
  assert.ok(!acceptable('birthday', 'x'.repeat(50)));
});

t('parseContact still reads a well-formed overlay', () => {
  const c = parseContact(FLIGHT);
  assert.equal(c.email, 'jo.doe@example.com');
  assert.equal(c.phone, '+33 6 12 34 56 78');
});

t('parseContact falls back to the mailto link if the label changes', () => {
  const c = parseContact('{"url":"mailto:fallback@example.com"}');
  assert.equal(c.email, 'fallback@example.com');
});

t('parseContact returns empty rather than throwing on junk', () => {
  assert.deepEqual(parseContact('not a flight stream at all'), {});
});

// Shape copied from a real ConnectionListWithProfile response.
const PIC = {
  profilePicture: {
    displayImageReference: {
      vectorImage: {
        rootUrl: 'https://media.licdn.com/dms/image/v2/EXAMPLEMEDIAID/profile-displayphoto-shrink_',
        artifacts: [
          { width: 400, fileIdentifyingUrlPathSegment: '400_400/x?e=1&v=beta&t=c' },
          { width: 100, fileIdentifyingUrlPathSegment: '100_100/x?e=1&v=beta&t=a' },
          { width: 200, fileIdentifyingUrlPathSegment: '200_200/x?e=1&v=beta&t=b' },
        ],
      },
    },
  },
};

t('photoUrl picks the smallest artifact at or above the requested width', () => {
  assert.equal(photoUrl(PIC), 'https://media.licdn.com/dms/image/v2/EXAMPLEMEDIAID/profile-displayphoto-shrink_100_100/x?e=1&v=beta&t=a');
  assert.ok(photoUrl(PIC, 200).endsWith('200_200/x?e=1&v=beta&t=b'));
  assert.ok(photoUrl(PIC, 9999).endsWith('400_400/x?e=1&v=beta&t=c'), 'falls back to the largest');
});

t('photoUrl returns empty for members without a picture', () => {
  assert.equal(photoUrl({}), '');
  assert.equal(photoUrl({ profilePicture: null }), '');
  assert.equal(photoUrl(undefined), '');
  assert.equal(photoUrl({ profilePicture: { displayImageReference: { vectorImage: { rootUrl: 'https://x/', artifacts: [] } } } }), '');
});

t('photoUrl refuses a non-https root', () => {
  const evil = { profilePicture: { displayImageReference: { vectorImage: {
    rootUrl: 'javascript:alert(1)//', artifacts: [{ width: 100, fileIdentifyingUrlPathSegment: 'x' }] } } } };
  assert.equal(photoUrl(evil), '');
});

t('rowStatus separates pending, found, empty and blocked', () => {
  assert.equal(rowStatus({}), 'pending');
  assert.equal(rowStatus({ contactDone: true, email: 'someone@example.com' }), 'found');
  assert.equal(rowStatus({ contactDone: true, birthday: 'June 15' }), 'found');
  assert.equal(rowStatus({ contactDone: true }), 'empty');
  assert.equal(rowStatus({ contactDone: true, contactError: 'no access (HTTP 403)' }), 'blocked');
});

t('splitHeadline pulls title and company out of common shapes', () => {
  assert.deepEqual(splitHeadline('CTO at Acme Corp'), { title: 'CTO', company: 'Acme Corp' });
  assert.deepEqual(splitHeadline('Designer @ Figma | ex-Stripe'), { title: 'Designer', company: 'Figma' });
  assert.deepEqual(splitHeadline('Chercheur en IA'), { title: 'Chercheur en IA', company: '' });
  assert.deepEqual(splitHeadline(''), { title: '', company: '' });
});

t('parseBirthday handles both locale orders', () => {
  assert.deepEqual(parseBirthday('June 15'), { month: 6, day: 15 });
  assert.deepEqual(parseBirthday('15 June'), { month: 6, day: 15 });
  assert.deepEqual(parseBirthday('March 5'), { month: 3, day: 5 });
  assert.deepEqual(parseBirthday('May 1'), { month: 5, day: 1 });
  assert.equal(parseBirthday('sometime soon'), null);
  assert.equal(parseBirthday('June 99'), null);
  assert.equal(parseBirthday(''), null);
});

t('csvCell neutralises formulas and escapes separators', () => {
  assert.equal(csvCell('=SUM(A1:A9)'), "'=SUM(A1:A9)");
  assert.equal(csvCell('+1 555 0100'), "'+1 555 0100");
  assert.equal(csvCell('-lead'), "'-lead");
  assert.equal(csvCell('Doe, Jane'), '"Doe, Jane"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('two\nlines'), '"two\nlines"');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell('plain'), 'plain');
});

t('toCSV writes a BOM, CRLF rows and the given columns', () => {
  const csv = toCSV([{ a: 1, b: 'x,y' }], ['a', 'b']);
  assert.ok(csv.startsWith('﻿a,b\r\n'));
  assert.equal(csv.split('\r\n')[1], '1,"x,y"');
});

t('toRow shapes a stored record into export columns', () => {
  const row = toRow({
    publicId: 'jane-doe', firstName: 'Jane', lastName: 'Doe',
    headline: 'CTO at Acme Corp', connectedAt: 1789603185000, birthday: 'June 15',
  });
  assert.equal(row.title, 'CTO');
  assert.equal(row.company, 'Acme Corp');
  assert.equal(row.profileUrl, 'https://www.linkedin.com/in/jane-doe/');
  assert.equal(row.connectedOn, '2026-09-16');
  assert.equal(row.monthBday, 6);
  assert.equal(row.dayBday, 15);
  assert.equal(row.dateBday, '06-15');
  assert.equal(row.photoUrl, '');
  assert.ok(COLUMNS.every((c) => c in row));
});

t('toICS emits one yearly all-day event per birthday', () => {
  const ics = toICS(
    [
      { publicId: 'jane-doe', firstName: 'Jane', lastName: 'Doe', birthday: 'June 15', headline: 'CTO at Acme; Inc' },
      { publicId: 'no-bday', firstName: 'Sam', lastName: 'Bee', birthday: '' },
    ],
    new Date('2026-09-22T10:00:00Z'),
  );
  assert.equal(ics.match(/BEGIN:VEVENT/g).length, 1);
  assert.ok(ics.includes('DTSTART;VALUE=DATE:20260615'));
  assert.ok(ics.includes('RRULE:FREQ=YEARLY'));
  assert.ok(ics.includes('UID:jane-doe-birthday@exportin'));
  assert.ok(ics.includes('SUMMARY:Birthday: Jane Doe'));
  assert.ok(ics.includes('Acme\\; Inc'), 'semicolons must be escaped in ICS text');
  assert.ok(ics.endsWith('END:VCALENDAR'));
});

t('diffRecord spots new, reconnected, changed and unchanged people', () => {
  const stored = { publicId: 'a', firstName: 'Jane', lastName: 'Doe', headline: 'CTO at Acme' };
  const same = { ...stored };
  assert.equal(diffRecord(undefined, same), 'added');
  assert.equal(diffRecord({ ...stored, removed: true }, same), 'added', 'a reconnect counts as new');
  assert.equal(diffRecord(stored, same), 'same');
  assert.equal(diffRecord(stored, { ...same, headline: 'CTO at Globex' }), 'updated');
  assert.equal(diffRecord(stored, { ...same, lastName: 'Doe-Smith' }), 'updated');
});

t('diffRecord ignores re-signed photo URLs', () => {
  // These carry an expiry and signature that LinkedIn rotates, so diffing them
  // would mark every connection as changed on each rescan.
  const stored = { publicId: 'a', firstName: 'Jane', lastName: 'Doe', headline: 'CTO', photoUrl: 'https://cdn/x?e=1&t=aaa' };
  const fresh = { ...stored, photoUrl: 'https://cdn/x?e=2&t=bbb' };
  assert.equal(diffRecord(stored, fresh), 'same');
});

t('mergeRecord keeps contact data and lets the list win on list fields', () => {
  const stored = {
    publicId: 'a', firstName: 'Jane', lastName: 'Doe', headline: 'CTO at Acme',
    email: 'jane@example.com', birthday: 'June 15', contactDone: true, firstSeen: 100,
  };
  const fresh = { publicId: 'a', firstName: 'Jane', lastName: 'Doe', headline: 'CTO at Globex' };
  const merged = mergeRecord(stored, fresh, 500);
  assert.equal(merged.email, 'jane@example.com', 'contact data must survive a list refresh');
  assert.equal(merged.contactDone, true, 'an enriched record must not be re-queued');
  assert.equal(merged.headline, 'CTO at Globex', 'the fresh headline must win');
  assert.equal(merged.prevHeadline, 'CTO at Acme');
  assert.equal(merged.headlineChangedAt, 500);
  assert.equal(merged.firstSeen, 100, 'firstSeen is set once');
  assert.equal(merged.lastSeen, 500);
});

t('mergeRecord revives someone who reconnected', () => {
  const stored = { publicId: 'a', headline: 'x', removed: true, removedAt: 200, email: 'someone@example.com' };
  const merged = mergeRecord(stored, { publicId: 'a', headline: 'x' }, 500);
  assert.ok(!('removed' in merged));
  assert.ok(!('removedAt' in merged));
  assert.equal(merged.email, 'someone@example.com');
});

t('junk already on disk is filtered on read, not left to reach the CSV', () => {
  // Records saved before parseContact validated its values still hold a URN in
  // the email field. Nothing should have to be migrated for them to come out clean.
  const poisoned = { publicId: 'a', firstName: 'Jane', lastName: 'Doe', email: 'urn:li:member:000000000', contactDone: true };
  assert.equal(fieldValue(poisoned, 'email'), '');
  assert.equal(toRow(poisoned).email, '');
  assert.equal(rowStatus(poisoned), 'empty', 'a URN is not a contact detail worth calling found');

  const good = { publicId: 'b', email: 'jane@example.com', contactDone: true };
  assert.equal(toRow(good).email, 'jane@example.com');
  assert.equal(rowStatus(good), 'found');
});

t('rowStatus reports removed ahead of everything else', () => {
  assert.equal(rowStatus({ removed: true, contactDone: true, email: 'someone@example.com' }), 'removed');
});

t('every locale defines exactly the same keys as English', () => {
  const base = Object.keys(STRINGS.en).sort();
  assert.deepEqual(LANGS.sort(), ['en', 'es', 'fr']);
  for (const lang of LANGS) {
    assert.deepEqual(Object.keys(STRINGS[lang]).sort(), base, `${lang} key set differs from en`);
  }
});

t('no locale leaves a string empty', () => {
  for (const lang of LANGS) {
    for (const [key, value] of Object.entries(STRINGS[lang])) {
      assert.ok(typeof value === 'string' && value.trim(), `${lang}.${key} is empty`);
    }
  }
});

t('every key the panel builds at runtime exists', () => {
  // These are assembled as t('st_' + state) and friends, so a missing one shows
  // up as a raw key in the UI rather than a crash. Pin them here instead.
  const dynamic = [
    ...['pending', 'found', 'empty', 'blocked', 'removed'].map((k) => 'st_' + k),
    ...['idle', 'list', 'contact', 'paused', 'done', 'scan', 'error'].map((k) => 'phase_' + k),
    ...['noSession', 'rateLimited', 'checkpoint', 'listFailed', 'unreachable', 'unknown'].map((k) => 'err_' + k),
    'diffNew', 'diffUpdated', 'diffRemoved', 'u_s', 'u_m', 'u_h',
  ];
  for (const key of dynamic) {
    if (key === 'phase_error') continue; // rendered from err_* instead
    assert.ok(STRINGS.en[key], `en is missing ${key}`);
  }
});

t('detect falls back to English for regions and unknown tags', () => {
  assert.equal(detect('fr-CA'), 'fr');
  assert.equal(detect('es-419'), 'es');
  assert.equal(detect('EN-GB'), 'en');
  assert.equal(detect('de'), 'en');
  assert.equal(detect(undefined), 'en');
});

const people = [
  { publicId: 'c', firstName: 'Ana', lastName: 'Ruiz', connectedAt: 300, email: 'ana@zz.example.com', birthday: 'March 2', contactDone: true },
  { publicId: 'a', firstName: 'Bob', lastName: 'Smith', connectedAt: 100, email: '', birthday: 'January 9', contactDone: true },
  { publicId: 'b', firstName: 'Cleo', lastName: 'Nunes', connectedAt: 200, email: 'cleo@aa.example.com', birthday: '', contactDone: true },
];
const order = (key, dir) => [...people].sort(sortComparator(key, dir)).map((r) => r.publicId).join('');

t('sortComparator flips between A-Z and Z-A', () => {
  assert.equal(order('name', 1), 'cab', 'Ana, Bob, Cleo');
  assert.equal(order('name', -1), 'bac', 'Cleo, Bob, Ana');
});

t('sortComparator orders dates and birthdays numerically', () => {
  assert.equal(order('connected', -1), 'cba', 'newest first');
  assert.equal(order('connected', 1), 'abc', 'oldest first');
  assert.equal(order('birthday', 1), 'acb', 'Jan 9, Mar 2, then the blank');
});

t('blank cells sink to the bottom whichever way the column points', () => {
  // Flipping a column should never fill the first page with empty rows.
  assert.equal(order('email', 1).at(-1), 'a');
  assert.equal(order('email', -1).at(-1), 'a');
  assert.equal(order('birthday', -1).at(-1), 'b');
});

t('sortComparator ranks statuses by usefulness, not alphabetically', () => {
  const mixed = [
    { publicId: 'p' },
    { publicId: 'f', contactDone: true, email: 'someone@example.com' },
    { publicId: 'r', removed: true },
    { publicId: 'e', contactDone: true },
  ];
  assert.equal([...mixed].sort(sortComparator('status', 1)).map((r) => r.publicId).join(''), 'fepr');
});

t('every sortable column maps to a real sort key', () => {
  // An unknown key silently falls back to sorting by name, so a typo in the
  // markup would look like a working column that ignores you.
  // Three header rows, one per network.
  const columns = [...panelHtml.matchAll(/data-sort="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(columns.length, 15, 'six LinkedIn columns, four Facebook ones, five Instagram ones');
  assert.equal(new Set(columns).size, 8, 'name, email, phone, birthday and status are shared');
  for (const key of columns) assert.ok(SORT_KEYS[key], `lib.js has no sort key "${key}"`);
});

t('every status the filter offers is one rowStatus can return', () => {
  const block = panelHtml.split('<select id="statusFilter">')[1].split('</select>')[0];
  const offered = [...block.matchAll(/<option value="([a-z]+)"/g)].map((m) => m[1]);
  const real = ['found', 'pending', 'empty', 'blocked', 'removed'];
  assert.deepEqual(offered.sort(), [...real].sort());
});

const NOW = 1_800_000_000_000;
const dead = { running: true, phase: 'contact', lastActivity: NOW - 120_000, contactDone: 10 };
const fresh = { now: NOW, attempts: 0, lastAttemptAt: 0 };

t('a silent worker is restarted without asking', () => {
  assert.equal(shouldAutoRetry(dead, fresh), true);
});

t('auto-retry NEVER fires after a rate limit or a checkpoint', () => {
  // Retrying a 429 is how a warning turns into a suspension. Every fatal stop
  // clears `running`, and the phase check is the second lock on the same door.
  assert.equal(shouldAutoRetry({ ...dead, running: false, phase: 'error' }, fresh), false);
  assert.equal(shouldAutoRetry({ ...dead, phase: 'error' }, fresh), false);
});

t('auto-retry leaves a deliberate pause alone', () => {
  assert.equal(shouldAutoRetry({ ...dead, running: false, phase: 'paused' }, fresh), false);
  assert.equal(shouldAutoRetry({ ...dead, phase: 'paused' }, fresh), false);
});

t('a worker that is merely between requests is not touched', () => {
  assert.equal(shouldAutoRetry({ ...dead, lastActivity: NOW - 4000 }, fresh), false);
});

t('auto-retry gives up rather than looping all night', () => {
  assert.equal(shouldAutoRetry(dead, { ...fresh, attempts: 4 }), true);
  assert.equal(shouldAutoRetry(dead, { ...fresh, attempts: 5 }), false);
});

t('auto-retry waits between attempts', () => {
  assert.equal(shouldAutoRetry(dead, { ...fresh, attempts: 1, lastAttemptAt: NOW - 3000 }), false);
  assert.equal(shouldAutoRetry(dead, { ...fresh, attempts: 1, lastAttemptAt: NOW - 20000 }), true);
});

t('auto-retry copes with a missing or empty meta', () => {
  assert.equal(shouldAutoRetry(undefined, fresh), false);
  assert.equal(shouldAutoRetry({}, fresh), false);
  assert.equal(shouldAutoRetry({ running: true, phase: 'contact' }, fresh), true, 'never heartbeated counts as stale');
});

t('the pace stretches on trouble and creeps back on success', () => {
  // A 429 is LinkedIn's last warning, not its first, so retries are the signal
  // worth reacting to while there is still room to react.
  let p = 1;
  p = nextPressure(p, false);
  assert.ok(p > 1, 'a failed profile must slow the run down');
  const strained = p;
  p = nextPressure(p, true);
  assert.ok(p < strained, 'a clean request must relax it again');
});

t('pressure never runs away and never speeds past the chosen pace', () => {
  let p = 1;
  for (let i = 0; i < 50; i++) p = nextPressure(p, false);
  assert.ok(p <= 5, `capped, got ${p}`);
  for (let i = 0; i < 50; i++) p = nextPressure(p, true);
  assert.equal(p, 1, 'relaxing stops at the configured delay, it never goes below');
});

t('pressure copes with a missing or corrupt stored value', () => {
  assert.equal(nextPressure(undefined, true), 1);
  assert.equal(nextPressure(NaN, true), 1);
  assert.equal(nextPressure(0.2, true), 1, 'a value below 1 would speed the run up');
});

t('effectiveDelay applies the multiplier and survives junk', () => {
  assert.equal(effectiveDelay(4000, 1), 4000);
  assert.equal(effectiveDelay(4000, 2), 8000);
  assert.equal(effectiveDelay(4000, undefined), 4000);
  assert.equal(effectiveDelay(undefined, undefined), 4000);
  assert.equal(effectiveDelay(4000, 0.1), 4000, 'never faster than asked');
});

t('every pace button maps to a named preset', () => {
  const offered = [...panelHtml.matchAll(/data-delay="(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(offered.sort((a, b) => a - b), PACE_PRESETS.map((p) => p.delayMs).sort((a, b) => a - b));
  for (const ms of offered) assert.notEqual(paceKey(ms), 'custom', `${ms} has no preset`);
  assert.equal(paceKey(3333), 'custom');
});

t('nothing reaches the network before the disclaimer is accepted', () => {
  // This gate is the whole point of the risk notice, and it is one line in each
  // caller, so it is exactly the kind of thing a refactor drops without noticing.
  assert.ok(/function allowed\(\)/.test(panelSrc), 'the allowed() gate is gone');
  assert.ok(
    /async function command\(cmd\) \{\s*if \(!allowed\(\)\) return;/.test(panelSrc),
    'command() no longer checks the disclaimer',
  );
  assert.ok(
    /async function savePhotos\(\) \{\s*if \(photoBusy \|\| !allowed\(\)\) return;/.test(panelSrc),
    'savePhotos() no longer checks the disclaimer',
  );
  for (const key of ['disclaimerTitle', 'disclaimerP1', 'disclaimerP2', 'disclaimerP3', 'disclaimerAccept']) {
    assert.ok(panelHtml.includes(`data-i18n="${key}"`), `the dialog is missing ${key}`);
  }
});

t('every icon the panel asks for exists in the Lucide map', () => {
  const asked = new Set([
    ...[...panelSrc.matchAll(/\bicon\('([a-z-]+)'/g)].map((m) => m[1]),
    ...[...panelSrc.matchAll(/\bprefix\(.*?,\s*'([a-z-]+)'\s*\)/g)].map((m) => m[1]),
    // Picked through ternaries, so no literal call site to scrape.
    'play', 'refresh-cw', 'loader-circle', 'arrow-up', 'arrow-down', 'chevrons-up-down',
  ]);
  assert.ok(asked.size >= 14, `expected to scrape the icon names, found ${asked.size}`);
  for (const name of asked) {
    assert.ok(globalThis.ICONS.ICONS[name], `icons.js is missing "${name}"`);
  }
});

t('crc32 matches the standard check value', () => {
  // The canonical CRC-32 test vector: "123456789" is 0xCBF43926.
  assert.equal(crc32(enc('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

t('zipStore writes a well-formed archive', () => {
  const zip = zipStore(
    [
      { name: 'connections.csv', data: enc('a,b\r\n1,2') },
      { name: 'photos/jane-doe.jpg', data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) },
    ],
    new Date('2026-09-22T10:20:30'),
  );
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  assert.equal(dv.getUint32(0, true), 0x04034b50, 'local file header signature');

  const eocd = zip.length - 22; // no archive comment, so it is the last 22 bytes
  assert.equal(dv.getUint32(eocd, true), 0x06054b50, 'end of central directory');
  assert.equal(dv.getUint16(eocd + 10, true), 2, 'entry count');

  const cd = dv.getUint32(eocd + 16, true);
  assert.equal(dv.getUint32(cd, true), 0x02014b50, 'central directory signature');
  assert.equal(dv.getUint32(eocd + 12, true), zip.length - 22 - cd, 'central directory size');
});

t('safeName cannot escape the archive', () => {
  // Zip-slip: a name with path traversal must not survive into the archive.
  assert.ok(!safeName('../../etc/passwd').includes('/'));
  assert.equal(safeName('jean-luc.picard'), 'jean-luc.picard');
  assert.equal(safeName(''), 'file');
  assert.ok(safeName('x'.repeat(200)).length <= 80);
});


// --- Facebook ------------------------------------------------------------
// Shaped like a real BirthdayCometMonthlyBirthdaysRefetchQuery answer: one JSON
// object per line, the first payload then a streamed delta, with the people
// buried at different depths in each. Every name and id below is invented.

const FB_BIRTHDAYS = [
  JSON.stringify({
    data: { viewer: { all_friends_by_birthday_month: {
      edges: [
        { node: { __typename: 'User', id: '100000000000001', name: 'Amelie Roussel',
                  profile_url: 'https://www.facebook.com/amelie.roussel?ref=bd',
                  profile_picture: { uri: 'https://scontent.fbcdn.net/a.jpg', width: 60 },
                  birthdate: { day: 14, month: 3, year: 1988 }, gender: 'FEMALE' },
          cursor: 'c1' },
        { node: { __typename: 'User', id: '100000000000002', name: 'Tomas Iglesias',
                  profile_picture: { uri: 'https://scontent.fbcdn.net/b.jpg' },
                  birthdate: { day: 3, month: 6, year: null } },
          cursor: 'c2' },
      ],
      page_info: { has_next_page: true, end_cursor: '4' },
    } } },
  }),
  JSON.stringify({
    fulfilled_payloads: [{ path: ['viewer'], data: { nodes: [
      { __typename: 'User', id: '100000000000003', name: 'Priya Raghunathan',
        profile_picture: { uri: 'https://scontent.fbcdn.net/c.jpg' },
        birthdate: { day: 27, month: 9, year: 1979 },
        // A nested connection with its own page_info, deeper than the real one.
        friends: { page_info: { has_next_page: false, end_cursor: 'nested' } } },
    ] } }],
  }),
].join('\n');

t('fbPeople finds people in the first payload and in the streamed delta', () => {
  const people = fbPeople(FB_BIRTHDAYS);
  assert.equal(people.length, 3);
  const amelie = people.find((p) => p.publicId === '100000000000001');
  assert.equal(amelie.name, 'Amelie Roussel');
  assert.equal(amelie.firstName, 'Amelie');
  assert.equal(amelie.lastName, 'Roussel');
  assert.equal(amelie.birthMonth, 3);
  assert.equal(amelie.birthDay, 14);
  assert.equal(amelie.birthYear, 1988);
  assert.equal(amelie.gender, 'female');
  // The query string is stripped, because it changes on every render.
  assert.equal(amelie.profileUrl, 'https://www.facebook.com/amelie.roussel');
});

t('fbRecord keeps a missing birth year out rather than storing null', () => {
  const people = fbPeople(FB_BIRTHDAYS);
  const tomas = people.find((p) => p.publicId === '100000000000002');
  assert.equal(tomas.birthMonth, 6);
  assert.equal(tomas.birthDay, 3);
  assert.ok(!('birthYear' in tomas), 'an unshared year must be absent, not null');
});

t('fbPageInfo takes the connection being paged, not one nested in a person', () => {
  // The nested page_info says has_next_page:false and sits deeper. Reading it
  // would stop the walk after the first page and silently lose everyone else.
  const info = fbPageInfo(FB_BIRTHDAYS);
  assert.equal(info.hasNext, true);
  assert.equal(info.cursor, '4');
});

t('fbRecord rejects ids that are not profiles', () => {
  assert.equal(fbRecord({ id: 'QXV0aDoxMjM=', name: 'Some Page', profile_picture: { uri: 'x' } }), null);
  assert.equal(fbRecord({ id: '123', name: 'Short', profile_picture: { uri: 'x' } }), null);
  assert.equal(fbRecord({ id: '100000000000009', name: '   ', profile_picture: { uri: 'x' } }), null);
});

t('fbRecord refuses a photo URL that is not https', () => {
  const rec = fbRecord({ id: '100000000000009', name: 'Nina Halvorsen',
                         profile_picture: { uri: 'javascript:alert(1)' } });
  assert.ok(!rec.photoUrl, 'a non-https photo URL must not be stored');
});

t('a friend-list sweep never blanks a birthday found by a month sweep', () => {
  // The two phases return different fields for the same person. fbRecord only
  // sets what it actually found, so the spread in the worker cannot erase.
  const fromMonths = fbPeople(FB_BIRTHDAYS).find((p) => p.publicId === '100000000000001');
  const fromList = fbRecord({ id: '100000000000001', name: 'Amelie Roussel',
                              profile_picture: { uri: 'https://scontent.fbcdn.net/new.jpg' },
                              social_context: { text: '12 mutual friends' } });
  const merged = { ...fromMonths, ...fromList };
  assert.equal(merged.birthMonth, 3, 'birthday survives the list sweep');
  assert.equal(merged.birthYear, 1988);
  assert.equal(merged.mutual, '12 mutual friends');
  assert.equal(merged.photoUrl, 'https://scontent.fbcdn.net/new.jpg', 'fresh photo wins');
});

t('fbDiffRecord ignores fields a sweep did not carry', () => {
  const existing = { name: 'Amelie Roussel', birthMonth: 3, birthDay: 14, birthYear: 1988 };
  assert.equal(fbDiffRecord(existing, { name: 'Amelie Roussel' }), 'same');
  assert.equal(fbDiffRecord(existing, { name: 'Amelie Perrin' }), 'updated');
  assert.equal(fbDiffRecord(undefined, { name: 'Amelie Roussel' }), 'added');
  assert.equal(fbDiffRecord({ ...existing, removed: true }, { name: 'Amelie Roussel' }), 'added');
});

t('splitName keeps a single-word name whole', () => {
  assert.deepEqual(splitName('Cher'), { firstName: 'Cher', lastName: '' });
  assert.deepEqual(splitName('Jean Luc Picard'), { firstName: 'Jean', lastName: 'Luc Picard' });
  assert.deepEqual(splitName('  '), { firstName: '', lastName: '' });
});

t('fbAge counts the birthday that has not happened yet as one year less', () => {
  const rec = { birthYear: 1988, birthMonth: 6, birthDay: 15 };
  assert.equal(fbAge(rec, new Date('2026-06-15T12:00:00Z')), 38, 'on the day');
  assert.equal(fbAge(rec, new Date('2026-06-14T12:00:00Z')), 37, 'the day before');
  assert.equal(fbAge({ birthMonth: 6, birthDay: 15 }, new Date('2026-06-15')), '', 'no year, no age');
});

t('toRowFb fills every Facebook column', () => {
  const rec = fbPeople(FB_BIRTHDAYS).find((p) => p.publicId === '100000000000001');
  const row = toRowFb({ ...rec, firstSeen: Date.parse('2026-01-02') },
                      new Date('2026-09-22'));
  for (const column of FB_COLUMNS) assert.ok(column in row, `missing column ${column}`);
  assert.equal(row.dateBday, '1988-03-14');
  assert.equal(row.yearBday, 1988);
  assert.equal(row.age, 38);
  assert.equal(row.facebookId, '100000000000001');
  assert.equal(row.firstSeen, '2026-01-02');
});

t('a Facebook CSV round-trips through the same writer as LinkedIn', () => {
  const rows = fbPeople(FB_BIRTHDAYS).map((r) => toRowFb(r, new Date('2026-09-22')));
  const csv = toCSV(rows, FB_COLUMNS);
  const lines = csv.replace(/^﻿/, '').split('\r\n');
  assert.equal(lines[0], FB_COLUMNS.join(','));
  assert.equal(lines.length, 4);
});

t('toICS starts a Facebook birthday on the real birth year', () => {
  const rows = fbPeople(FB_BIRTHDAYS).map((r) => toRowFb(r, new Date('2026-09-22')));
  const ics = toICS(rows, new Date('2026-09-22T10:00:00Z'));
  assert.ok(ics.includes('DTSTART;VALUE=DATE:19880314'), 'known year is used');
  assert.ok(ics.includes('DTSTART;VALUE=DATE:20260603'), 'unknown year falls back to this year');
  assert.ok(ics.includes('https://www.facebook.com/amelie.roussel'));
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 3);
});

t('fbStatus never reports pending, because a record only exists once stored', () => {
  assert.equal(fbStatus({ birthMonth: 3 }), 'found');
  assert.equal(fbStatus({}), 'empty');
  assert.equal(fbStatus({ removed: true, birthMonth: 3 }), 'removed');
});

t('fbJsonLines survives a truncated frame', () => {
  const docs = fbJsonLines('{"a":1}\n{"b":  \nnot json\n{"c":3}');
  assert.deepEqual(docs, [{ a: 1 }, { c: 3 }]);
});

t('fbProfileUrl falls back to the numeric id', () => {
  assert.equal(fbProfileUrl({ publicId: '100000000000001' }), 'https://www.facebook.com/100000000000001');
  assert.equal(fbProfileUrl({ publicId: '1', profileUrl: 'https://www.facebook.com/nina' }),
               'https://www.facebook.com/nina');
});

t('the two platforms cannot write over each other', () => {
  const keys = Object.values(PLATFORMS).map((p) => p.prefix);
  assert.equal(new Set(keys).size, keys.length, 'storage prefixes must be distinct');
  const metas = Object.values(PLATFORMS).map((p) => p.metaKey);
  assert.equal(new Set(metas).size, metas.length, 'meta keys must be distinct');
  // The same numeric string could in principle be a LinkedIn vanity name and a
  // Facebook id, and both would land on the same photo record.
  const photo = Object.values(PLATFORMS).map((p) => p.photoKey('12345'));
  assert.equal(new Set(photo).size, photo.length, 'photo keys must be distinct');
  assert.equal(PLATFORMS.linkedin.photoKey('abc'), 'abc', 'existing photos must not move');
});

t('sorting reads a birthday from either network', () => {
  const fb = { birthMonth: 3, birthDay: 14 };
  const li = { birthday: 'June 15' };
  assert.equal(SORT_KEYS.birthday(fb), 314);
  assert.equal(SORT_KEYS.birthday(li), 615);
  assert.equal(SORT_KEYS.birthday({}), 0);
  assert.equal(SORT_KEYS.mutual({ mutual: '12 amis en commun' }), 12);
  assert.equal(SORT_KEYS.mutual({}), 0);
});

t('the mutual-friends column exports a number, whatever the account language', () => {
  const { fbMutual, birthdayOf } = globalThis.LIB;
  assert.equal(fbMutual({ mutual: '12 mutual friends' }), 12);
  assert.equal(fbMutual({ mutual: '1\u202f204 amis en commun' }), 1204);
  assert.equal(fbMutual({ mutual: 'Works at Vermillon Studio' }), '');
  assert.equal(toRowFb({ mutual: '7 amigos en común' }).mutualFriends, 7);
  // Both tabs read one birthday, so both display it the same way.
  assert.deepEqual(birthdayOf({ birthday: '14 mars' }), { month: 3, day: 14 });
  assert.deepEqual(birthdayOf({ birthMonth: 3, birthDay: 14 }), { month: 3, day: 14 });
  assert.equal(birthdayOf({}), null);
  assert.ok(!/fieldValue\(rec, 'birthday'\), 'c-bday'/.test(panelSrc), 'LinkedIn rows must go through birthdayText');
});

t('the status column ranks Facebook records through fbStatus', () => {
  const rows = [{ source: 'facebook' }, { source: 'facebook', birthMonth: 3 }];
  rows.sort(sortComparator('status', 1, 'en'));
  assert.equal(rows[0].birthMonth, 3, 'found sorts above empty');
});

t('the demo accepts the disclaimer version the panel actually asks for', () => {
  // Bumping DISCLAIMER_VERSION re-prompts everyone, which is the point. It also
  // silently puts a modal in the middle of every screenshot.
  const wanted = panelSrc.match(/const DISCLAIMER_VERSION = (\d+);/)[1];
  const mocked = mockSrc.match(/store\.disclaimer = (\d+);/)[1];
  assert.equal(mocked, wanted, 'demo/mock.js is behind panel.js');
});

t('the photo count belongs to the tab on screen', () => {
  // Both networks share one IndexedDB. Counting the whole store reported
  // LinkedIn's 40 avatars on a Facebook tab holding none.
  const li = [{ publicId: 'ada-lovelace' }, { publicId: 'alan-turing' }];
  const fb = [{ publicId: '100000000000001' }, { publicId: '100000000000002' }];
  const have = new Set(['ada-lovelace', 'alan-turing', 'fb:100000000000001']);

  assert.equal(photosHeld(li, have, 'linkedin'), 2);
  assert.equal(photosHeld(fb, have, 'facebook'), 1);
  assert.equal(photosHeld([], have, 'facebook'), 0, 'an empty tab holds nothing');
  // The collision the namespace exists to prevent: the same string as a
  // LinkedIn vanity name and as a Facebook id.
  assert.equal(photosHeld([{ publicId: '100000000000001' }], have, 'linkedin'), 0);
});

t('the hook sends again what the page asked before the worker listened', () => {
  // A reload is how a background tab learns a query, and the page sends it
  // before the isolated script exists. Without the replay, it is simply lost.
  const listeners = [];
  const posted = [];
  const fakeWindow = {
    addEventListener: (type, fn) => listeners.push(fn),
    postMessage: (data) => posted.push(data),
    fetch: () => Promise.resolve(),
  };
  class FakeXHR { open() {} send() {} }
  const run = new Function('window', 'location', 'XMLHttpRequest', hookSrc);
  run(fakeWindow, { origin: 'https://www.facebook.com' }, FakeXHR);
  const body = (name) => `fb_api_req_friendly_name=${name}&variables=%7B%7D`;
  fakeWindow.fetch('/api/graphql/', { body: body('A') });
  fakeWindow.fetch('/api/graphql/', { body: body('B') });
  fakeWindow.fetch('/api/graphql/', { body: body('A') + '&v=2' });
  fakeWindow.fetch('/ajax/other', { body: body('C') });
  posted.length = 0;
  const ask = (data) => listeners.forEach((fn) => fn({ source: fakeWindow, origin: 'https://www.facebook.com', data }));
  ask({ __exportin: 'replay' });
  assert.deepEqual(posted.map((m) => m.body), [body('B'), body('A') + '&v=2'], 'the latest body per query, GraphQL only');
  posted.length = 0;
  ask({ __exportin: 'arm', on: false });
  fakeWindow.fetch('/api/graphql/', { body: body('D') });
  assert.equal(posted.length, 0, 'disarmed forwards nothing');
  ask({ __exportin: 'replay' });
  assert.ok(posted.some((m) => m.body === body('D')), 'but still keeps it for a replay');
});

t('a query the page never sent is built from one it did', () => {
  // Measured in a background tab: 12 GraphQL calls, none of them the birthday
  // query, and its doc_id sitting in the page's module registry all along.
  const { fbSynthBody } = globalThis.LIB;
  const envelope = 'av=1&__user=1&fb_dtsg=TOKEN&lsd=L&fb_api_caller_class=RelayModern'
    + '&fb_api_req_friendly_name=SomethingElseQuery&fb_api_analytics_tags=%5B%5D'
    + '&variables=%7B%22x%22%3A1%7D&server_timestamps=true&doc_id=111111';
  const body = new URLSearchParams(fbSynthBody(envelope, 'BirthdayCometMonthlyBirthdaysRefetchQuery',
    '36534121496201683', { stream_birthday_months: false }));
  assert.equal(body.get('fb_api_req_friendly_name'), 'BirthdayCometMonthlyBirthdaysRefetchQuery');
  assert.equal(body.get('doc_id'), '36534121496201683');
  assert.deepEqual(JSON.parse(body.get('variables')), { stream_birthday_months: false }, 'no variable leaks from the other query');
  assert.equal(body.get('fb_dtsg'), 'TOKEN', 'the envelope is kept');
  assert.equal(body.get('server_timestamps'), 'true');
  assert.equal(body.get('fb_api_analytics_tags'), null);
  assert.equal(fbSynthBody('av=1', 'Q', '36534121496201683', {}), null, 'no token, no request');
  assert.equal(fbSynthBody(envelope, 'Q', 'undefined', {}), null, 'a missing doc_id is not one');
});

t('the hook reads a doc_id from the page and answers only for plain names', () => {
  const listeners = [];
  const posted = [];
  const fakeWindow = {
    addEventListener: (type, fn) => listeners.push(fn),
    postMessage: (data) => posted.push(data),
    fetch: () => Promise.resolve(),
    require: (m) => {
      if (m === 'BirthdayCometMonthlyBirthdaysRefetchQuery_facebookRelayOperation') return '36534121496201683';
      throw new Error(`Requiring unknown module "${m}"`);
    },
  };
  class FakeXHR { open() {} send() {} }
  new Function('window', 'location', 'XMLHttpRequest', hookSrc)(fakeWindow, { origin: 'https://www.facebook.com' }, FakeXHR);
  const ask = (name) => listeners.forEach((fn) => fn({ source: fakeWindow, origin: 'https://www.facebook.com', data: { __exportin: 'docIdAsk', name } }));
  ask('BirthdayCometMonthlyBirthdaysRefetchQuery');
  ask('FriendingCometFriendsListPaginationQuery');
  ask('x"); alert(1); ("');
  assert.deepEqual(posted, [
    { __exportin: 'docId', name: 'BirthdayCometMonthlyBirthdaysRefetchQuery', id: '36534121496201683' },
    { __exportin: 'docId', name: 'FriendingCometFriendsListPaginationQuery', id: null },
  ]);
});

t('a friend the birthday sweep just saw is never marked removed', () => {
  // Seen on a real account: the friend list skipped a friend whose birthday the
  // same sync had just returned, and she was exported as removed.
  const { fbRemovals } = globalThis.LIB;
  const start = 1000;
  const records = [
    { publicId: 'listed', lastSeen: 1500 },
    { publicId: 'birthdayOnly', lastSeen: 1200 },
    { publicId: 'gone', lastSeen: 500 },
    { publicId: 'alreadyGone', lastSeen: 100, removed: true },
  ];
  // A walk that skipped nobody the birthday sweep confirmed is trusted.
  assert.deepEqual(fbRemovals(records, new Set(['listed', 'birthdayOnly']), start).remove, ['gone']);
  // One that skipped a confirmed friend proves nothing about friends without a
  // birthday, and withdraws the flags such a walk put on them before.
  const lossy = [
    { publicId: 'confirmed', birthMonth: 1, lastSeen: 1200 },
    { publicId: 'noBirthday', lastSeen: 500 },
    { publicId: 'flaggedEarlier', lastSeen: 400, removed: true },
    { publicId: 'birthdayGone', birthMonth: 5, lastSeen: 500 },
  ];
  const v = fbRemovals(lossy, new Set(), start);
  assert.equal(v.skipped, 1);
  assert.deepEqual(v.remove, ['birthdayGone'], 'absent from both sweeps is still a removal');
  assert.deepEqual(v.restore, ['flaggedEarlier']);
});

t('every Facebook wait beats faster than the panel declares a worker dead', () => {
  // settled() once waited 20s silently; with the steps around it the panel saw
  // 30s without a heartbeat, reloaded the tab mid-learning, and looped forever.
  const src = fbWorkerSrc;
  for (const name of ['settled', 'nudge', 'reach']) {
    const start = src.indexOf(`async function ${name}(`);
    assert.ok(start > 0, `${name} not found`);
    const body = src.slice(start, src.indexOf('\n  }\n', start));
    assert.ok(body.includes('beat()'), `${name} waits without a heartbeat`);
  }
});

// --- breakage detection --------------------------------------------------

const fill = (key, n, yields) => {
  let health = {};
  for (let i = 0; i < n; i++) health = noteProbe(health, key, i < yields);
  return health;
};

t('a run of empty answers is only a breakage once there are enough of them', () => {
  // One private profile is not a bug. The whole point is not to cry wolf.
  assert.equal(probeVerdict(fill('contact', 39, 0), 'contact'), 'unknown');
  assert.equal(probeVerdict(fill('contact', 40, 0), 'contact'), 'broken');
});

t('genuinely private people never read as a breakage', () => {
  // Most people share no contact field at all. Three in sixty is real data.
  assert.equal(probeVerdict(fill('contact', 60, 3), 'contact'), 'ok');
  assert.equal(probeVerdict(fill('contact', 500, 1), 'contact'), 'ok');
});

t('a list page that parses nothing is caught immediately', () => {
  // Unlike contact details, a list page should nearly always yield records, so
  // waiting for forty samples would waste forty requests.
  assert.equal(probeVerdict(fill('list', 2, 0), 'list'), 'broken');
  assert.equal(probeVerdict(fill('birthdays', 2, 0), 'birthdays'), 'broken');
  assert.equal(probeVerdict(fill('list', 2, 2), 'list'), 'ok');
});

t('brokenProbes names only what is actually broken', () => {
  const health = { ...fill('contact', 40, 0), ...fill('list', 5, 5), ...fill('about', 3, 0) };
  assert.deepEqual(brokenProbes(health), ['contact'], 'about has too few samples to judge');
  assert.deepEqual(brokenProbes({}), []);
});

t('an unknown probe key is ignored rather than counted', () => {
  assert.deepEqual(noteProbe({}, 'nonsense', true), {});
  assert.equal(probeVerdict({ nonsense: [99, 0] }, 'nonsense'), 'unknown');
});

t('the diagnostic carries counters and nothing that identifies anyone', () => {
  // This is the guarantee that matters: nobody audits a bug report before
  // sending it, so the function is given no records to leak in the first place.
  const report = diagnostic({
    version: '1.0.0',
    platform: 'linkedin',
    phase: 'contact',
    errorKey: 'broken',
    // Hostile input standing in for whatever an error message might carry.
    errorInfo: 'contact <script>alert(1)</script> jane@example.com "quoted"',
    lang: 'fr',
    health: { ...fill('contact', 40, 0), ...fill('list', 6, 6) },
    learnt: ['BirthdayCometMonthlyBirthdaysRefetchQuery'],
    now: new Date('2026-09-23T10:00:00Z'),
  });

  assert.ok(report.includes('contact'), 'the broken probe is named');
  assert.ok(report.includes('broken'));
  assert.ok(report.includes('2026-09-23'));
  assert.ok(/contact\s+40\s+0\s+broken/.test(report), 'counters are present');

  assert.ok(!report.includes('@'), 'an address cannot survive the filter');
  assert.ok(!report.includes('<'), 'nor can markup');
  assert.ok(!report.includes('"'), 'nor quotes');
  assert.ok(report.length < 1200, 'a report stays small enough for a URL');
});

t('the diagnostic survives being handed nothing at all', () => {
  const report = diagnostic();
  assert.ok(report.includes('ExportIn'));
  assert.ok(!report.includes('undefined'));
});

t('every probe the workers report has a translated name', () => {
  // A missing name would render the raw key in the notice, which reads like a
  // crash rather than an explanation.
  for (const key of Object.keys(PROBES)) {
    for (const locale of LANGS) {
      assert.ok(STRINGS[locale]['probe_' + key], `${locale} has no probe_${key}`);
    }
  }
});

t('both exports carry the same four birthday columns', () => {
  // One CRM mapping has to import either file, so the shape matches even though
  // LinkedIn can never fill the year.
  const bday = ['dateBday', 'dayBday', 'monthBday', 'yearBday'];
  for (const column of bday) {
    assert.ok(COLUMNS.includes(column), `LinkedIn is missing ${column}`);
    assert.ok(FB_COLUMNS.includes(column), `Facebook is missing ${column}`);
  }
  const li = toRow({ publicId: 'x', firstName: 'A', birthday: 'June 15' });
  assert.equal(li.dateBday, '06-15', 'no year known, so no year in the date');
  assert.equal(li.yearBday, '');
  assert.equal(li.dayBday, 15);
});

t('a birthday date is ISO so nobody has to guess the order', () => {
  // 14/03 and 03/14 are the same string to two people in two countries.
  const withYear = bdayCells(3, 14, 1988);
  assert.equal(withYear.dateBday, '1988-03-14');
  assert.equal(bdayCells(3, 14, 0).dateBday, '03-14');
  assert.deepEqual(bdayCells(0, 0, 1988),
    { dateBday: '', dayBday: '', monthBday: '', yearBday: '' }, 'a year alone is not a birthday');
});

t('translated headers rename the header row and nothing else', () => {
  const rows = [toRowFb({ publicId: '1', name: 'A B', birthMonth: 3, birthDay: 14 }, new Date())];
  const fr = toCSV(rows, FB_COLUMNS, COLUMN_SLUGS.fr).replace(/^﻿/, '').split('\r\n');
  const en = toCSV(rows, FB_COLUMNS).replace(/^﻿/, '').split('\r\n');
  assert.ok(fr[0].startsWith('prenom,nom,nom_complet,date_anniv'));
  assert.equal(fr[1], en[1], 'only the header differs, never a value');
  assert.equal(fr[0].split(',').length, en[0].split(',').length);
});

t('every exported column has a slug in every translated locale', () => {
  // A missing slug silently falls back to the English key, which produces a CSV
  // with a French header row and one English column in the middle of it.
  const all = new Set([...COLUMNS, ...FB_COLUMNS, ...globalThis.LIB.IG_COLUMNS]);
  for (const locale of Object.keys(COLUMN_SLUGS)) {
    for (const column of all) {
      assert.ok(COLUMN_SLUGS[locale][column], `${locale} has no slug for ${column}`);
    }
    for (const slug of Object.values(COLUMN_SLUGS[locale])) {
      assert.match(slug, /^[a-z][a-z0-9_]*$/, `${slug} is not import-safe`);
    }
  }
});

t('the panel checks for birthdays using a column that exists', () => {
  // A rename once left this guard reading a field no row carried, so the
  // calendar export refused every time while claiming there were no birthdays.
  const guard = panelSrc.match(/rows\.some\(\(r\) => r\.(\w+)\)/);
  assert.ok(guard, 'the birthday guard has moved');
  assert.ok(COLUMNS.includes(guard[1]) && FB_COLUMNS.includes(guard[1]),
    `panel.js checks r.${guard[1]}, which is not an export column on both sides`);
});

t('fbRecord keeps the delivered photo width', () => {
  const rec = fbRecord({ id: '100000000000009', name: 'Nina Halvorsen',
                         profile_picture: { uri: 'https://scontent.fbcdn.net/a.jpg', width: 160 } });
  assert.equal(rec.photoW, 160);
  const noWidth = fbRecord({ id: '100000000000009', name: 'Nina Halvorsen',
                             profile_picture: { uri: 'https://scontent.fbcdn.net/a.jpg' } });
  assert.ok(!('photoW' in noWidth), 'an absent width is absent, not zero');
});

// --- Instagram -------------------------------------------------------------

{
  const { igList, igProfile, igBlock, igMutuals, toRowIg, IG_COLUMNS } = globalThis.LIB;

  t('igList reads a page and its cursor, and skips what is not a person', () => {
    const page = igList({
      users: [
        { pk: 123, username: 'nina.b', full_name: 'Nina Bauer', profile_pic_url: 'https://x.cdninstagram.com/a.jpg', is_private: true },
        { pk_id: '456', username: 'tom', full_name: '' },
        { username: 'no_id' },
        { pk: 789 },
      ],
      next_max_id: 'QVFE',
    });
    assert.deepEqual(page.people.map((p) => p.publicId), ['123', '456']);
    assert.equal(page.people[0].firstName, 'Nina');
    assert.equal(page.people[0].isPrivate, true);
    assert.equal(page.next, 'QVFE');
    assert.equal(page.raw, 4, 'raw counts what Instagram sent, so a broken parser shows');
    assert.equal(igList({ users: [], next_max_id: null }).next, null);
    assert.equal(igList({ users: [] , next_max_id: 50 }).next, '50', 'following sends a number');
    assert.equal(igList(null).raw, 0);
  });

  t('only people who follow you back are kept', () => {
    const following = new Map([['1', { publicId: '1' }], ['2', { publicId: '2' }], ['3', { publicId: '3' }]]);
    assert.deepEqual(igMutuals(following, new Set(['2', '3', '9'])).map((p) => p.publicId), ['2', '3']);
  });

  t('igProfile takes business contact first and a bio email as a fallback', () => {
    const biz = igProfile({ data: { user: {
      username: 'studio', biography: 'Ceramics\nhello@other.fr',
      business_email: 'shop@studio.fr', business_phone_number: '612345678', business_phone_country_code: '33',
      external_url: 'https://studio.fr', category_name: 'Artist', edge_followed_by: { count: 1200 },
    } } });
    assert.equal(biz.email, 'shop@studio.fr');
    assert.equal(biz.phone, '+33 612345678');
    assert.equal(biz.website, 'https://studio.fr');
    assert.equal(biz.category, 'Artist');
    assert.equal(biz.followers, 1200);

    const personal = igProfile({ data: { user: {
      username: 'nina', biography: 'Berlin. Write to me: nina.b@mail.de :)',
      business_email: null, external_url: null, bio_links: [{ url: 'https://linktr.ee/nina' }],
    } } });
    assert.equal(personal.email, 'nina.b@mail.de');
    assert.equal(personal.phone, '');
    assert.equal(personal.website, 'https://linktr.ee/nina');

    // users/<id>/info: flat under `user`, other field names.
    const info = igProfile({ user: {
      username: 'nina', biography: 'Berlin', public_email: 'nina@mail.de', contact_phone_number: '+49 30 1234',
      category: 'Photographer', follower_count: 310, hd_profile_pic_url_info: { url: 'https://x.cdninstagram.com/hd.jpg' },
    }, status: 'ok' });
    assert.equal(info.email, 'nina@mail.de');
    assert.equal(info.phone, '+49 30 1234');
    assert.equal(info.category, 'Photographer');
    assert.equal(info.followers, 310);
    assert.equal(info.photoUrl, 'https://x.cdninstagram.com/hd.jpg');

    // PolarisProfilePageContentQuery, the route actually used: data.user, the
    // fields the probe on a real account saw, and no business contact.
    const gql = igProfile({ data: { user: {
      username: 'manon', biography: 'Lyon · manon@atelier.fr', bio_links: [{ url: 'https://atelier.fr', title: '' }],
      external_url: null, category: 'Artist', follower_count: 2048,
    } }, extensions: {} });
    assert.equal(gql.email, 'manon@atelier.fr');
    assert.equal(gql.website, 'https://atelier.fr');
    assert.equal(gql.followers, 2048);
    assert.equal(gql.phone, '');

    assert.equal(igProfile({ data: {} }), null, 'no user means a shape change, not an empty profile');
    assert.equal(igProfile(null), null);
  });

  t('igBlock tells a rate limit, a checkpoint and a logout apart', () => {
    assert.equal(igBlock(429, '', null), 'rateLimited');
    assert.equal(igBlock(400, '', { message: 'Please wait a few minutes before you try again.' }), 'rateLimited');
    assert.equal(igBlock(400, '', { message: 'feedback_required', spam: true }), 'rateLimited');
    assert.equal(igBlock(400, '', { message: 'checkpoint_required', checkpoint_url: '/challenge/x' }), 'checkpoint');
    assert.equal(igBlock(200, 'https://www.instagram.com/accounts/login/?next=x', null), 'noSession');
    assert.equal(igBlock(401, '', { require_login: true }), 'noSession');
    assert.equal(igBlock(200, 'https://www.instagram.com/api/v1/x', { status: 'ok' }), null);
    assert.equal(igBlock(404, '', null), null, 'a missing profile is not a block');
  });

  t('an Instagram row fills every column and reuses the LinkedIn status', () => {
    const rec = { publicId: '123', username: 'nina.b', name: 'Nina Bauer', firstName: 'Nina', lastName: 'Bauer',
      email: 'nina.b@mail.de', contactDone: true, isVerified: true, followers: 0 };
    const row = toRowIg(rec);
    for (const c of IG_COLUMNS) assert.ok(c in row, `row has no ${c}`);
    assert.equal(row.profileUrl, 'https://www.instagram.com/nina.b/');
    assert.equal(row.followers, 0, 'zero followers is a number, not a blank');
    assert.equal(rowStatus(rec), 'found');
    assert.equal(rowStatus({ ...rec, email: '' }), 'empty');
    assert.equal(rowStatus({ username: 'x' }), 'pending');
    assert.equal(rowStatus({ contactDone: true, contactError: 'not found (HTTP 404)' }), 'blocked');
  });

  const src = await readFile(new URL('./dist/content-instagram.js', import.meta.url), 'utf8');
  const manifest = JSON.parse(await readFile(new URL('./dist/manifest.json', import.meta.url), 'utf8'));
  t('the Instagram worker only answers messages meant for it', () => {
    assert.ok(src.includes("msg.platform !== 'instagram'"));
    const cs = manifest.content_scripts.find((c) => c.js.includes('content-instagram.js'));
    assert.deepEqual(cs.js, ['lib.js', 'content-instagram.js'], 'lib.js must load first');
    const hook = manifest.content_scripts.find((c) => c.js.includes('fb-hook.js'));
    assert.ok(hook.matches.includes('https://www.instagram.com/*'), 'profiles are learnt through the hook');
    assert.equal(hook.world, 'MAIN');
  });
}

console.log(`${passed} checks passed${process.exitCode ? ', some failed' : ''}`);
