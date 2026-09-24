// Minimal ZIP writer, stored entries only (no deflate).
//
// JPEGs and PNGs are already compressed, so deflating them buys nothing, and
// "stored" mode is the part of the format that fits in a page of code. That is
// cheaper than vendoring a zip library, which MV3's CSP would stop us loading
// from a CDN anyway.
//
// No ZIP64: entries and archives stay under 4 GB, which a few thousand avatars
// and a CSV comfortably do.

(() => {
  'use strict';

  let TABLE = null;
  function crcTable() {
    if (TABLE) return TABLE;
    TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TABLE[n] = c >>> 0;
    }
    return TABLE;
  }

  function crc32(bytes) {
    const table = crcTable();
    let crc = -1;
    for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ table[(crc ^ bytes[i]) & 0xff];
    return (crc ^ -1) >>> 0;
  }

  // ZIP stores timestamps in the 1980-based MS-DOS format, two seconds apart.
  function dosStamp(date) {
    const year = Math.max(1980, date.getFullYear());
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
      date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    };
  }

  const utf8 = (s) => new TextEncoder().encode(s);

  function block(size) {
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    let at = 0;
    return {
      bytes,
      u16(v) { view.setUint16(at, v, true); at += 2; },
      u32(v) { view.setUint32(at, v >>> 0, true); at += 4; },
      raw(b) { bytes.set(b, at); at += b.length; },
    };
  }

  /**
   * @param {{name: string, data: Uint8Array}[]} entries
   * @returns {Uint8Array} the complete archive
   */
  function zipStore(entries, now = new Date()) {
    const { time, date } = dosStamp(now);
    const UTF8_FLAG = 0x0800; // names are UTF-8, not the legacy code page
    const parts = [];
    const central = [];
    let offset = 0;

    for (const entry of entries) {
      const name = utf8(entry.name);
      const data = entry.data;
      const crc = crc32(data);

      const local = block(30 + name.length);
      local.u32(0x04034b50);
      local.u16(20);          // version needed
      local.u16(UTF8_FLAG);
      local.u16(0);           // method: stored
      local.u16(time);
      local.u16(date);
      local.u32(crc);
      local.u32(data.length); // compressed
      local.u32(data.length); // uncompressed
      local.u16(name.length);
      local.u16(0);           // extra length
      local.raw(name);

      parts.push(local.bytes, data);

      const dir = block(46 + name.length);
      dir.u32(0x02014b50);
      dir.u16(20);            // version made by
      dir.u16(20);            // version needed
      dir.u16(UTF8_FLAG);
      dir.u16(0);
      dir.u16(time);
      dir.u16(date);
      dir.u32(crc);
      dir.u32(data.length);
      dir.u32(data.length);
      dir.u16(name.length);
      dir.u16(0);             // extra
      dir.u16(0);             // comment
      dir.u16(0);             // disk number
      dir.u16(0);             // internal attrs
      dir.u32(0);             // external attrs
      dir.u32(offset);        // offset of local header
      dir.raw(name);
      central.push(dir.bytes);

      offset += local.bytes.length + data.length;
    }

    const centralSize = central.reduce((n, b) => n + b.length, 0);
    const end = block(22);
    end.u32(0x06054b50);
    end.u16(0);               // this disk
    end.u16(0);               // disk with central directory
    end.u16(entries.length);
    end.u16(entries.length);
    end.u32(centralSize);
    end.u32(offset);
    end.u16(0);               // comment length

    const all = [...parts, ...central, end.bytes];
    const out = new Uint8Array(all.reduce((n, b) => n + b.length, 0));
    let at = 0;
    for (const b of all) { out.set(b, at); at += b.length; }
    return out;
  }

  // Keeps archive paths predictable across operating systems.
  function safeName(name) {
    return String(name).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'file';
  }

  globalThis.ZIP = { crc32, zipStore, safeName, dosStamp };
})();
