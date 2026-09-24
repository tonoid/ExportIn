// Lucide icons, inlined. https://lucide.dev - ISC License.
//
// Inlined rather than pulled from a CDN because MV3's content security policy
// blocks remote scripts, and because a dozen path strings is not worth a
// dependency. Each entry is a list of [tag, attributes] drawn on Lucide's
// 24x24 grid with its standard stroke settings.

(() => {
  'use strict';

  const ICONS = {
    play: [['polygon', { points: '6 3 20 12 6 21 6 3' }]],
    pause: [
      ['rect', { x: 14, y: 4, width: 4, height: 16, rx: 1 }],
      ['rect', { x: 6, y: 4, width: 4, height: 16, rx: 1 }],
    ],
    'refresh-cw': [
      ['path', { d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' }],
      ['path', { d: 'M21 3v5h-5' }],
      ['path', { d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' }],
      ['path', { d: 'M8 16H3v5' }],
    ],
    'rotate-ccw': [
      ['path', { d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' }],
      ['path', { d: 'M3 3v5h5' }],
    ],
    download: [
      ['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }],
      ['polyline', { points: '7 10 12 15 17 10' }],
      ['line', { x1: 12, x2: 12, y1: 15, y2: 3 }],
    ],
    'chevron-down': [['path', { d: 'm6 9 6 6 6-6' }]],
    'chevron-left': [['path', { d: 'm15 18-6-6 6-6' }]],
    'chevron-right': [['path', { d: 'm9 18 6-6-6-6' }]],
    'arrow-up': [['path', { d: 'm5 12 7-7 7 7' }], ['path', { d: 'M12 19V5' }]],
    'arrow-down': [['path', { d: 'M12 5v14' }], ['path', { d: 'm19 12-7 7-7-7' }]],
    'chevrons-up-down': [['path', { d: 'm7 15 5 5 5-5' }], ['path', { d: 'm7 9 5-5 5 5' }]],
    table: [
      ['rect', { x: 3, y: 3, width: 18, height: 18, rx: 2 }],
      ['path', { d: 'M3 9h18' }],
      ['path', { d: 'M3 15h18' }],
      ['path', { d: 'M12 3v18' }],
    ],
    cake: [
      ['path', { d: 'M20 21v-8a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8' }],
      ['path', { d: 'M4 16s.5-1 2-1 2.5 2 4 2 2.5-2 4-2 2.5 2 4 2 2-1 2-1' }],
      ['path', { d: 'M2 21h20' }],
      ['path', { d: 'M7 8v3' }],
      ['path', { d: 'M12 8v3' }],
      ['path', { d: 'M17 8v3' }],
    ],
    braces: [
      ['path', { d: 'M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1' }],
      ['path', { d: 'M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1' }],
    ],
    image: [
      ['rect', { x: 3, y: 3, width: 18, height: 18, rx: 2 }],
      ['circle', { cx: 9, cy: 9, r: 2 }],
      ['path', { d: 'm21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21' }],
    ],
    archive: [
      ['rect', { x: 2, y: 3, width: 20, height: 5, rx: 1 }],
      ['path', { d: 'M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8' }],
      ['path', { d: 'M10 12h4' }],
    ],
    'trash-2': [
      ['path', { d: 'M3 6h18' }],
      ['path', { d: 'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6' }],
      ['path', { d: 'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2' }],
      ['line', { x1: 10, x2: 10, y1: 11, y2: 17 }],
      ['line', { x1: 14, x2: 14, y1: 11, y2: 17 }],
    ],
    'triangle-alert': [
      ['path', { d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3' }],
      ['path', { d: 'M12 9v4' }],
      ['path', { d: 'M12 17h.01' }],
    ],
    'loader-circle': [['path', { d: 'M21 12a9 9 0 1 1-6.219-8.56' }]],
  };

  const NS = 'http://www.w3.org/2000/svg';

  function icon(name, size = 16) {
    const spec = ICONS[name];
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('lucide');
    if (!spec) return svg; // unknown name renders nothing rather than throwing
    for (const [tag, attrs] of spec) {
      const el = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      svg.append(el);
    }
    return svg;
  }

  // Puts an icon in front of a button's existing label.
  function prefix(el, name, size = 16) {
    if (!el) return;
    el.querySelector('svg.lucide')?.remove();
    el.prepend(icon(name, size));
  }

  globalThis.ICONS = { ICONS, icon, prefix, NAMES: Object.keys(ICONS) };
})();
