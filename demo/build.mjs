// Generates demo/index.html from dist/panel.html so the screenshots always show
// the real interface. Nothing is duplicated: the markup and CSS are the shipped
// ones, with mock.js slipped in ahead of panel.js to stand in for chrome.*.
//
// Usage: node demo/build.mjs

import { readFile, writeFile } from 'node:fs/promises';

const here = new URL('./', import.meta.url);
const html = await readFile(new URL('../dist/panel.html', here), 'utf8');

const out = html
  // point every asset back at dist/
  .replace(/(<script src=")([^"]+)(")/g, '$1../dist/$2$3')
  .replace(/(<link rel="icon" href=")([^"]+)(")/g, '$1../dist/$2$3')
  // mock.js must run after photos.js defines PHOTOS and before panel.js reads it
  .replace('<script src="../dist/panel.js"></script>', '<script src="mock.js"></script>\n    <script src="../dist/panel.js"></script>')
  .replace('<title>ExportIn</title>', '<title>ExportIn (demo data)</title>');

if (!out.includes('mock.js')) throw new Error('could not insert mock.js: panel.js script tag not found');

await writeFile(new URL('index.html', here), out);
console.log('wrote demo/index.html');
