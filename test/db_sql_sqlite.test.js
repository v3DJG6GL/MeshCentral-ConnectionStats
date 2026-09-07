"use strict";
// Runs the SQL backend against a real SQLite database: Node's built-in node:sqlite wrapped in the
// { all(sql, params, cb), run(sql, params, cb) } shape of the sqlite3 handle MeshCentral exposes as
// db.file. Skipped on Node versions without node:sqlite.
const test = require('node:test');
const assert = require('node:assert/strict');

let DatabaseSync = null;
try { DatabaseSync = require('node:sqlite').DatabaseSync; } catch (e) { }

function sqlite3Shim(db) {
    return {
        all: function (sql, params, cb) {
            try { cb(null, db.prepare(sql).all(...params)); } catch (e) { cb(e); }
        },
        run: function (sql, params, cb) {
            try { const r = db.prepare(sql).run(...params); cb.call({ changes: Number(r.changes), lastID: Number(r.lastInsertRowid) }, null); } catch (e) { cb.call({}, e); }
        }
    };
}

function fakeServer(handle) {
    return { args: {}, db: { databaseType: 8, file: handle }, pluginHandler: {}, getConfigFilePath: f => f };
}

function doc(id, start, end, extra) {
    return Object.assign({ _id: 's_' + id, domain: '', nodeid: 'n1', meshid: 'm1', userid: 'u1', username: 'admin', type: 'desktop', protocol: 2, start: start, end: end, seconds: end ? (end - start) / 1000 : 0 }, extra || {});
}

test('sqlite backend round trip', { skip: !DatabaseSync && 'node:sqlite not available' }, async () => {
    const raw = new DatabaseSync(':memory:');
    const db = require('../db.js').CreateDB(fakeServer(sqlite3Shim(raw)));
    try {
        await db.ready();
        const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'plugin_connectionstats%' ORDER BY name").all().map(r => r.name);
        assert.deepEqual(tables, ['plugin_connectionstats_sessions', 'plugin_connectionstats_settings']);

        const T = Math.floor(Date.now() / 1000) * 1000 - 86400000;
        await db.upsertSession(doc('a', T, T + 60000, { bytesin: 12345678901, extras: 'kept in doc' }));
        await db.upsertSession(doc('b', T + 100000, null));
        await db.upsertSession(doc('c', T - 10 * 86400000, T - 10 * 86400000 + 5000, { truncated: true }));
        await db.upsertSession(doc('g', T, T + 1000, { guest: 'Visitor' }));
        await db.upsertSession(doc('a', T, T + 60000, { bytesin: 5 }));   // second upsert replaces

        const a = await db.getSession('s_a');
        assert.equal(a.bytesin, 5); assert.equal(a.end, T + 60000); assert.equal(a.truncated, false);
        assert.equal(a.extras, undefined);   // replaced document no longer carries the extra key
        const c = await db.getSession('s_c');
        assert.equal(c.truncated, true);

        let rows = await db.findSessions({ domain: '', start: T + 70000, end: T + 200000 });
        assert.deepEqual(rows.map(r => r._id), ['s_b']);
        rows = await db.findSessions({ domain: '', start: T, end: T + 200000, includeGuests: true, nodeids: ['n1', 'zzz'] });
        assert.deepEqual(rows.map(r => r._id).sort(), ['s_a', 's_b', 's_g']);
        rows = await db.findSessions({ domain: '', start: T, end: T + 200000, nodeids: ['nope'] });
        assert.equal(rows.length, 0);

        assert.deepEqual((await db.getOpenSessions()).map(r => r._id), ['s_b']);
        await db.updateSession('s_b', { lastbeat: T + 150000, note: 'in doc' });
        const b = await db.getSession('s_b');
        assert.equal(b.lastbeat, T + 150000); assert.equal(b.note, 'in doc'); assert.equal(b.userid, 'u1');
        await db.updateSession('s_b', { end: T + 200000, seconds: 100, truncated: true });
        assert.equal((await db.getSession('s_b')).truncated, true);
        assert.equal((await db.getOpenSessions()).length, 0);

        const page = await db.listSessions({ domain: '', start: T - 20 * 86400000, end: T + 300000 }, { limit: 2, skip: 1 });
        assert.equal(page.total, 3);
        assert.deepEqual(page.rows.map(r => r._id), ['s_a', 's_c']);

        assert.equal(await db.sweepRetention(5), 1);
        assert.equal(await db.getSession('s_c'), null);

        await db.setSetting('settings', { retentionDays: 30, nested: { a: 1 } });
        assert.deepEqual(await db.getSetting('settings'), { retentionDays: 30, nested: { a: 1 } });
        assert.equal(await db.getDBVersion(), 1);
        assert.equal(await db.removeSession('s_a'), 1);
    } finally {
        db.close();
        raw.close();
    }
});

test('sqlite backend: a failing schema is retried, not cached', { skip: !DatabaseSync && 'node:sqlite not available' }, async () => {
    let fail = true;
    const raw = new DatabaseSync(':memory:');
    const good = sqlite3Shim(raw);
    const flaky = { all: good.all, run: function (sql, params, cb) { if (fail) { cb.call({}, new Error('down')); return; } good.run(sql, params, cb); } };
    const db = require('../db.js').CreateDB(fakeServer(flaky));
    try {
        await db.ready();                       // resolves (to null) after logging the failure
        await assert.rejects(db.getSession('x'));
        fail = false;
        assert.equal(await db.getSession('x'), null);   // next call re-runs the schema and succeeds
    } finally {
        db.close();
        raw.close();
    }
});
