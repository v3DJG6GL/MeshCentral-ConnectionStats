"use strict";
// Reading relay events out of every file a MeshCentral backup can contain, from synthetic samples.
// The live dump tests (dumps_live.test.js) cover the real tools.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');
const R = require('../restore.js');
const events = require('../events.js');
const { zip } = require('./zipwrite.js');

const T0 = Date.UTC(2026, 0, 15, 9, 0, 0);
const WANT = events.START_MSGIDS.concat(events.END_MSGIDS);
function ev(msgid, args, timeMs, extra) {
    return Object.assign({ etype: 'relay', action: 'relaylog', domain: '', userid: 'user//admin', username: 'admin', msgid, msgArgs: args, protocol: '2', nodeid: 'node//abc', msg: 'x', ids: ['*'], _id: 'id' + msgid + timeMs }, extra || {}, { time: timeMs });
}
// a desktop session of 5 minutes, one unrelated event, one login event
const RAW = [
    ev(15, ['rly1', '1.2.3.4', '5.6.7.8'], T0),
    { etype: 'user', action: 'login', msgid: 107, time: T0 + 1000, _id: 'l1' },
    ev(11, ['rly1', '5.6.7.8', '1.2.3.4', 300], T0 + 300000, { bytesin: 10, bytesout: 20 }),
    ev(145, ['x'], T0 + 400000)    // msgid the plugin ignores
];
function collect(promiseFactory) {
    const out = [];
    return promiseFactory(d => { const e = R.relayEvent(d, WANT); if (e) out.push(e); }).then(() => out);
}
function checkPair(out) {
    assert.equal(out.length, 2);
    assert.ok(out[0].time instanceof Date);
    assert.equal(+out[0].time, T0);
    const p = new events.Pairer(); let closed = null;
    out.forEach(e => { const c = events.classify(e); if (c.kind == 'start') p.onStart(c); else closed = p.onEnd(c); });
    assert.equal(closed._id, 's_rly1'); assert.equal(closed.seconds, 300); assert.equal(closed.bytesin, 10);
}
function tmp(name, data) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-restore-')); const f = path.join(d, name); fs.writeFileSync(f, data); return f; }

test('normTime accepts every timestamp shape', () => {
    assert.equal(+R.normTime({ $$date: T0 }), T0);
    assert.equal(+R.normTime({ $date: '2026-01-15T09:00:00.000Z' }), T0);
    assert.equal(+R.normTime({ $date: { $numberLong: String(T0) } }), T0);
    assert.equal(+R.normTime('2026-01-15 09:00:00Z'), T0);
    assert.equal(+R.normTime(new Date(T0)), T0);
    assert.equal(R.normTime('garbage'), null);
    assert.equal(R.normTime(null), null);
});

test('sniff recognises the formats by content', () => {
    assert.equal(R.sniff(Buffer.from('PK\x03\x04....')), 'zip');
    assert.equal(R.sniff(Buffer.from([0x1f, 0x8b, 8, 0])), 'gzip');
    const m = Buffer.alloc(8); m.writeUInt32LE(0x8199e26d, 0); assert.equal(R.sniff(m), 'mongodump');
    assert.equal(R.sniff(Buffer.from('SQLite format 3\0abc')), 'sqlite');
    assert.equal(R.sniff(Buffer.from('{"etype":"relay"}\n')), 'jsonl');
    assert.equal(R.sniff(Buffer.from('[{"a":1}]')), 'jsonarray');
    assert.equal(R.sniff(Buffer.from('-- MariaDB dump 10.19\n-- Host: localhost')), 'mysqldump');
    assert.equal(R.sniff(Buffer.from('--\n-- PostgreSQL database dump\n--')), 'pgdump');
    assert.equal(R.sniff(Buffer.from('hello')), 'unknown');
    assert.ok(R.zipEntryWanted('meshcentral-data/meshcentral-events.db'));
    assert.ok(R.zipEntryWanted('meshcentral-mongodump-2026-01-01-03-00.archive'));
    assert.ok(R.zipEntryWanted('mongodump-2023-11-14-20-32.archive'));   // naming before MeshCentral 1.1.34
    assert.ok(R.zipEntryWanted('meshcentral-mongodump-2026-01-01-03-00.archive.gz'));
    assert.ok(!R.zipEntryWanted('notmongodump-2026.archive'));
    assert.ok(R.zipEntryWanted('mysqldump-2026-01-01-03-00.sql'));
    assert.ok(R.zipEntryWanted('pgdump-2026-01-01-03-00.sql'));
    assert.ok(R.zipEntryWanted('meshcentral-sqlitedump-2026-01-01-03-00.db3'));
    assert.ok(!R.zipEntryWanted('meshcentral-data/meshcentral.db'));
});

test('NeDB events file: $$date times, bookkeeping lines and a torn last line', async () => {
    const lines = RAW.map(d => JSON.stringify(Object.assign({}, d, { time: { $$date: d.time } })));
    lines.splice(1, 0, '{"$$indexCreated":{"fieldName":"time","unique":false}}');
    const text = lines.join('\n') + '\n{"etype":"relay","acti';
    const out = await collect(on => R.readers.jsonLines(Readable.from([text]), on));
    checkPair(out);
});

test('mongoexport: JSON lines with $date and a --jsonArray file', async () => {
    const docs = RAW.map(d => Object.assign({}, d, { time: { $date: new Date(d.time).toISOString() } }));
    checkPair(await collect(on => R.readers.jsonLines(Readable.from([docs.map(d => JSON.stringify(d)).join('\n')]), on)));
    checkPair(await collect(on => R.readers.jsonArray(Readable.from([JSON.stringify(docs)]), on)));
});

test('mysqldump: escaped JSON in an extended INSERT, time from the column when the doc has none', async () => {
    const esc = s => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '\\n');
    const row = (d, i) => `(${i},'${new Date(d.time).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')}','','${d.action}','${d.nodeid || ''}','${d.userid || ''}','${esc(JSON.stringify(Object.assign({}, d, { time: undefined, msg: "it's \"quoted\"\n" })))}')`;
    const sql = "-- MariaDB dump 10.19  Distrib 11.4.2-MariaDB\n--\n-- Host: localhost    Database: meshcentral\n" +
        "CREATE TABLE `events` (`id` int(11) NOT NULL AUTO_INCREMENT, `time` datetime, `doc` longtext);\n" +
        "INSERT INTO `events` VALUES " + RAW.map(row).join(',') + ";\n" +
        "INSERT INTO `main` VALUES (1,'{\"x\":1}');\n";
    const out = await collect(on => R.readers.mysqlDump(Readable.from([sql]), on));
    checkPair(out);
    assert.equal(out[0].msg, "it's \"quoted\"\n");
});

test('pg_dump: COPY block with tab/backslash escapes and \\N', async () => {
    const esc = s => s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n');
    const row = (d, i) => [i, new Date(d.time).toISOString().replace('T', ' ').replace('Z', ''), '', d.action, d.nodeid || '\\N', d.userid || '\\N', esc(JSON.stringify(Object.assign({}, d, { time: undefined, msg: 'tab\there' })))].join('\t');
    const sql = "--\n-- PostgreSQL database dump\n--\nSET statement_timeout = 0;\n" +
        "COPY public.events (id, \"time\", domain, action, nodeid, userid, doc) FROM stdin;\n" + RAW.map(row).join('\n') + "\n\\.\n" +
        "COPY public.main (id, doc) FROM stdin;\n1\t{\"x\":1}\n\\.\n";
    const out = await collect(on => R.readers.pgDump(Readable.from([sql]), on));
    checkPair(out);
    assert.equal(out[0].msg, 'tab\there');
});

let bson = null;
try { bson = require('bson'); } catch (e) { try { bson = require('mongodb').BSON; } catch (e2) { } }
function archive(docsByNs) {
    const magic = Buffer.alloc(4); magic.writeUInt32LE(0x8199e26d, 0);
    const term = Buffer.from([0xff, 0xff, 0xff, 0xff]);
    const parts = [magic, bson.serialize({ concurrent_collections: 1, version: '0.1', server_version: '6.0.0', tool_version: '100.9.4' })];
    Object.keys(docsByNs).forEach(c => parts.push(bson.serialize({ db: 'meshcentral', collection: c, metadata: '{}', size: 0, type: 'collection' })));
    parts.push(term);
    Object.keys(docsByNs).forEach(c => {
        parts.push(bson.serialize({ db: 'meshcentral', collection: c, EOF: false, CRC: bson.Long ? bson.Long.fromNumber(0) : 0 }));
        docsByNs[c].forEach(d => parts.push(bson.serialize(d)));
        parts.push(term);
        parts.push(bson.serialize({ db: 'meshcentral', collection: c, EOF: true, CRC: bson.Long ? bson.Long.fromNumber(0) : 0 }));
        parts.push(term);
    });
    return Buffer.concat(parts);
}

test('mongodump archive: prelude, namespace slices, other collections ignored, gzip variant', { skip: !bson && 'bson not resolvable' }, async () => {
    const docs = RAW.map(d => Object.assign({}, d, { time: new Date(d.time) }));
    const buf = archive({ main: [{ _id: 'node//abc', type: 'node' }], events: docs, power: [{ time: new Date(T0), nodeid: 'x' }] });
    // fed in awkward chunks to exercise buffering
    const chunks = []; for (let i = 0; i < buf.length; i += 7) chunks.push(buf.subarray(i, Math.min(buf.length, i + 7)));
    checkPair(await collect(on => R.readers.mongoArchive(Readable.from(chunks), on, bson)));
    // whole-archive gzip, through the top-level reader
    const f = tmp('meshcentral-mongodump-2026.archive', zlib.gzipSync(buf));
    const st = {};
    checkPair(await collect(on => R.readFile(f, WANT, on, st)));
    assert.equal(st.scanned, 5);   // events plus device metadata
});

let DatabaseSync = null;
try { DatabaseSync = require('node:sqlite').DatabaseSync; } catch (e) { }
test('sqlite copy of the database', { skip: !DatabaseSync && 'node:sqlite not available' }, async () => {
    const f = tmp('meshcentral-sqlitedump-2026.db3', '');
    fs.unlinkSync(f);
    const db = new DatabaseSync(f);
    db.exec('CREATE TABLE events(id INTEGER PRIMARY KEY, time TIMESTAMP, domain CHAR(64), action CHAR(255), nodeid CHAR(255), userid CHAR(255), doc JSON)');
    const ins = db.prepare('INSERT INTO events (time, domain, action, nodeid, userid, doc) VALUES (?, ?, ?, ?, ?, ?)');
    RAW.forEach(d => ins.run(new Date(d.time).toISOString(), '', d.action, d.nodeid || null, d.userid || null, JSON.stringify(d)));
    db.close();
    checkPair(await collect(on => R.readFile(f, WANT, on, {})));
});

let yauzl = null;
try { yauzl = require('yauzl'); } catch (e) { }
test('backup zip: the events file inside meshcentral-data plus a dump at the root; encrypted and empty zips are explained', { skip: !yauzl && 'yauzl not resolvable' }, async () => {
    const nedb = RAW.slice(0, 2).map(d => JSON.stringify(Object.assign({}, d, { time: { $$date: d.time } }))).join('\n');
    const nedb2 = RAW.slice(2).map(d => JSON.stringify(Object.assign({}, d, { time: { $$date: d.time } }))).join('\n');
    const z = zip([
        { name: 'meshcentral-data/config.json', data: '{}' },
        { name: 'meshcentral-data/meshcentral-events.db', data: nedb },
        { name: 'meshcentral-data/meshcentral.db', data: '{"junk":1}' },
        { name: 'pgdump-2026-01-01-03-00.sql', data: "-- PostgreSQL database dump\nCOPY public.events (id, time, domain, action, nodeid, userid, doc) FROM stdin;\n" + RAW.slice(2).map((d, i) => [i, '2026-01-15 09:05:00', '', d.action, d.nodeid, d.userid, JSON.stringify(d).replace(/\\/g, '\\\\')].join('\t')).join('\n') + "\n\\.\n" }
    ]);
    const f = tmp('backup.zip', z);
    const st = {};
    const out = await collect(on => R.readFile(f, WANT, on, st));
    assert.equal(st.files, 2);
    checkPair(out);
    // a 2023 backup: MeshCentral before 1.1.34 named the dump without the database prefix
    if (bson) {
        const old = zip([
            { name: 'meshcentral-data/config.json', data: '{}' },
            { name: 'mongodump-2023-11-14-20-32.archive', data: archive({ events: RAW.map(d => Object.assign({}, d, { time: new Date(d.time) })) }) }
        ]);
        const st2 = {};
        const out2 = await collect(on => R.readFile(tmp('meshcentral-autobackup-2023-11-14-20-32.zip', old), WANT, on, st2));
        assert.equal(st2.files, 1); checkPair(out2); assert.equal(st2.file, 'mongodump-2023-11-14-20-32.archive');
    }
    await assert.rejects(() => R.readFile(tmp('empty.zip', zip([{ name: 'meshcentral-data/config.json', data: '{}' }])), WANT, () => { }, {}), /No events file or database dump/);
    await assert.rejects(() => R.readFile(tmp('enc.zip', zip([{ name: 'meshcentral-data/meshcentral-events.db', data: nedb2, encrypted: true }])), WANT, () => { }, {}), /password protected/);
});

test('runFile pairs, skips known sessions and marks the source', async () => {
    const f = tmp('meshcentral-events.db', RAW.map(d => JSON.stringify(Object.assign({}, d, { time: { $$date: d.time } }))).join('\n'));
    const store = new Map(); store.set('s_known', { _id: 's_known' });
    const ctx = {
        db: { getSession: id => Promise.resolve(store.get(id) || null), upsertSession: d => { store.set(d._id, d); return Promise.resolve(d); } },
        events, resolveNames: (n, cb) => cb({ meshid: 'mesh//m', nodename: 'PC', meshname: 'G' }), log: () => { }
    };
    const st = require('../backfill.js').runFile(ctx, f, { label: 'test.db', cleanup: true });
    await st.promise;
    assert.equal(st.error, null); assert.equal(st.relay, 2); assert.equal(st.found, 1); assert.equal(st.imported, 1); assert.equal(st.skipped, 0);
    assert.equal(store.get('s_rly1').source, 'backup'); assert.equal(store.get('s_rly1').nodename, 'PC');
    assert.ok(!fs.existsSync(f), 'temp upload removed');
    const st2 = require('../backfill.js').runFile(ctx, tmp('nope.bin', 'hello'), {});
    await st2.promise;
    assert.match(st2.error, /Unrecognised/);
});

test('2023 MongoDB backup recovers device names and repairs an earlier import without replacing session data', { skip: (!bson || !yauzl) && 'MongoDB/zip dependencies unavailable' }, async () => {
    // Metadata follows the events, as collection slices may arrive in either order.
    const dump = archive({ events: RAW.map(d => ({ ...d, time: new Date(d.time) })), meshcentral: [
        { type: 'node', _id: 'node//abc', name: 'Old workstation', meshid: 'mesh//old', secret: 'not retained' },
        { type: 'mesh', _id: 'mesh//old', name: 'Old office' }
    ] });
    const file = tmp('meshcentral-autobackup-2023-11-14-20-32.zip', zip([
        { name: 'mongodump-2023-11-14-20-32.archive', data: dump }
    ]));
    const store = new Map();
    const ctx = { events, log() {}, resolveNames: (_, cb) => cb({}), db: {
        getSession: async id => store.get(id), upsertSession: async d => store.set(d._id, d)
    } };
    try {
        const first = require('../backfill.js').runFile(ctx, file, {});
        await first.promise;
        assert.equal(first.error, null);
        assert.equal(first.imported, 1);
        assert.equal(store.get('s_rly1').nodename, 'Old workstation');
        assert.equal(store.get('s_rly1').meshname, 'Old office');
        assert.equal(store.get('s_rly1').meshid, 'mesh//old');
        const previous = { ...store.get('s_rly1'), nodename: null, meshname: null, meshid: null, active: 42, source: 'live' };
        store.set('s_rly1', previous);
        const repair = require('../backfill.js').runFile(ctx, file, {});
        await repair.promise;
        assert.equal(repair.error, null);
        assert.equal(repair.imported, 0);
        assert.equal(repair.updated, 1);
        assert.equal(store.size, 1);
        assert.deepEqual(store.get('s_rly1'), { ...previous, nodename: 'Old workstation', meshname: 'Old office', meshid: 'mesh//old' });
        const again = require('../backfill.js').runFile(ctx, file, {});
        await again.promise;
        assert.equal(again.updated || 0, 0);
        assert.equal(again.skipped, 1);
    } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
});
