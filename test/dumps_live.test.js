"use strict";
// The real dump tools against the live containers: MeshCentral's own events table/collection is
// created with the driver, filled with relay events, dumped with mongodump / mariadb-dump /
// mysqldump / pg_dump inside the container (docker exec), and read back through restore.js.
// Needs CS_TEST_* URLs (see db_live.test.js) plus the container names:
//   CS_DOCKER_POSTGRES=test-postgres-1 CS_DOCKER_MARIADB=test-mariadb-1 CS_DOCKER_MYSQL=test-mysql-1 CS_DOCKER_MONGODB=test-mongodb-1
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const R = require('../restore.js');
const events = require('../events.js');

const T0 = Date.UTC(2026, 0, 15, 9, 0, 0);
const WANT = events.START_MSGIDS.concat(events.END_MSGIDS);
function ev(msgid, args, timeMs, extra) {
    return Object.assign({ etype: 'relay', action: 'relaylog', domain: '', userid: 'user//admin', username: 'admin', msgid, msgArgs: args, protocol: '2', nodeid: 'node//abc', msg: "Grüezi 'quoted' \"json\" \\ back\nslash", ids: ['*'] }, extra || {}, { time: new Date(timeMs) });
}
const RAW = [
    ev(15, ['rly1', '1.2.3.4', '5.6.7.8'], T0),
    { etype: 'user', action: 'login', msgid: 107, time: new Date(T0 + 1000), ids: ['*'] },
    ev(11, ['rly1', '5.6.7.8', '1.2.3.4', 300], T0 + 300000, { bytesin: 10, bytesout: 20 })
];
function dockerExec(container, args, outFile) {
    return new Promise((resolve, reject) => {
        execFile('docker', ['exec', container].concat(args), { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) { reject(new Error('docker exec failed: ' + err.message + ' ' + String(stderr))); return; }
            fs.writeFileSync(outFile, stdout); resolve(outFile);
        });
    });
}
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cs-dumps-')); }
async function check(file) {
    const out = [], st = {};
    await R.readFile(file, WANT, e => out.push(e), st);
    assert.equal(out.length, 2, 'two relay events from ' + path.basename(file));
    assert.equal(+out[0].time, T0);
    assert.equal(out[0].msg, RAW[0].msg, 'text survived the dump');
    const p = new events.Pairer(); let closed = null;
    out.forEach(e => { const c = events.classify(e); if (c.kind == 'start') p.onStart(c); else closed = p.onEnd(c); });
    assert.equal(closed._id, 's_rly1'); assert.equal(closed.seconds, 300); assert.equal(closed.bytesout, 20);
}
const url = k => process.env['CS_TEST_' + k], ctr = k => process.env['CS_DOCKER_' + k];
const skipFor = k => (!url(k) || !ctr(k)) && ('CS_TEST_' + k + ' or CS_DOCKER_' + k + ' not set');
// MeshCentral's SQL insert: JSON.stringify(event) into doc, plus the columns it indexes
const cols = d => [d.time, d.domain || '', d.action, d.nodeid || null, d.userid || null, JSON.stringify(d)];

test('pg_dump of MeshCentral\'s events table', { skip: skipFor('POSTGRES') }, async () => {
    const { Client } = require('pg');
    const c = new Client({ connectionString: url('POSTGRES') });
    await c.connect();
    try {
        await c.query('DROP TABLE IF EXISTS events');
        await c.query('CREATE TABLE events(id SERIAL PRIMARY KEY, time TIMESTAMP, domain CHAR(64), action CHAR(255), nodeid CHAR(255), userid CHAR(255), doc JSON)');
        for (const d of RAW) await c.query('INSERT INTO events (time, domain, action, nodeid, userid, doc) VALUES ($1, $2, $3, $4, $5, $6)', cols(d));
    } finally { await c.end(); }
    const f = await dockerExec(ctr('POSTGRES'), ['pg_dump', '-U', 'meshcentral', 'meshcentral'], path.join(tmpDir(), 'pgdump-2026-01-15-09-00.sql'));
    assert.equal(R.sniff(fs.readFileSync(f).subarray(0, 4096)), 'pgdump');
    await check(f);
});

for (const [k, tool] of [['MARIADB', 'mariadb-dump'], ['MYSQL', 'mysqldump']]) {
    test(tool + ' of MeshCentral\'s events table', { skip: skipFor(k) }, async () => {
        const mysql = require('mysql2/promise');
        const c = await mysql.createConnection(url(k));
        try {
            await c.query('DROP TABLE IF EXISTS events');
            await c.query('CREATE TABLE events (id INT NOT NULL AUTO_INCREMENT, time DATETIME, domain CHAR(64), action CHAR(255), nodeid CHAR(255), userid CHAR(255), doc JSON, PRIMARY KEY(id))');
            for (const d of RAW) await c.query('INSERT INTO events (time, domain, action, nodeid, userid, doc) VALUES (?, ?, ?, ?, ?, ?)', cols(d));
        } finally { await c.end(); }
        const f = await dockerExec(ctr(k), [tool, '-umeshcentral', '-pmeshcentral', 'meshcentral'], path.join(tmpDir(), 'mysqldump-2026-01-15-09-00.sql'));
        assert.equal(R.sniff(fs.readFileSync(f).subarray(0, 4096)), 'mysqldump');
        await check(f);
    });
}

test('mongodump archive of MeshCentral\'s database, plain and --gzip', { skip: skipFor('MONGODB') }, async () => {
    const { MongoClient } = require('mongodb');
    const c = await MongoClient.connect(url('MONGODB'));
    try {
        const db = c.db('meshcentral');
        await db.collection('events').deleteMany({});
        await db.collection('events').insertMany(RAW.map(d => Object.assign({}, d)));
        await db.collection('main').deleteMany({});
        await db.collection('main').insertOne({ _id: 'node//abc', type: 'node', name: 'PC' });
    } finally { await c.close(); }
    const dir = tmpDir();
    const f = await dockerExec(ctr('MONGODB'), ['mongodump', '--db=meshcentral', '--archive'], path.join(dir, 'meshcentral-mongodump-2026-01-15-09-00.archive'));
    assert.equal(R.sniff(fs.readFileSync(f).subarray(0, 16)), 'mongodump');
    await check(f);
    const g = await dockerExec(ctr('MONGODB'), ['mongodump', '--db=meshcentral', '--archive', '--gzip'], path.join(dir, 'meshcentral-mongodump-2026-01-15-09-00.archive.gz'));
    assert.equal(R.sniff(fs.readFileSync(g).subarray(0, 16)), 'gzip');
    await check(g);
});
