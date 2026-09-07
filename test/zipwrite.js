"use strict";
// Minimal zip writer (stored entries only) for the restore tests; yauzl only reads.
const zlib = require('zlib');
let crc32 = zlib.crc32;
if (typeof crc32 != 'function') {
    const T = new Int32Array(256);
    for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); T[i] = c; }
    crc32 = function (buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = T[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
}
// entries: [{ name, data: Buffer|string, encrypted?: bool }] -> Buffer
function zip(entries) {
    const locals = [], centrals = []; let off = 0;
    entries.forEach(e => {
        const plain = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
        // an "encrypted" entry (flag bit 0) carries a 12 byte header before the data; the bytes
        // themselves do not matter here, the reader must refuse it before looking at them
        const data = e.encrypted ? Buffer.concat([Buffer.alloc(12), plain]) : plain;
        const name = Buffer.from(e.name, 'utf8'), crc = crc32(plain) >>> 0, flags = e.encrypted ? 1 : 0;
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(0, 8);
        lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(plain.length, 22);
        lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(0, 10);
        ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(plain.length, 24);
        ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(off, 42);
        locals.push(lh, name, data); centrals.push(ch, name);
        off += lh.length + name.length + data.length;
    });
    const cd = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16); end.writeUInt16LE(0, 20);
    return Buffer.concat([...locals, cd, end]);
}
module.exports = { zip };
