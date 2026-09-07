"use strict";
// Runs the SQL backend against a real SQLite database: Node's built-in node:sqlite wrapped in the
// { all(sql, params, cb), run(sql, params, cb) } shape of the sqlite3 handle MeshCentral exposes as
// db.file. Skipped on Node versions without node:sqlite.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { storeSuite } = require('./store_suite.js');

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


test('sqlite backend round trip', { skip: !DatabaseSync && 'node:sqlite not available' }, async () => {
    const raw = new DatabaseSync(':memory:');
    const db = require('../db.js').CreateDB(fakeServer(sqlite3Shim(raw)));
    try {
        await db.ready();
        const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'plugin_connectionstats%' ORDER BY name").all().map(r => r.name);
        assert.deepEqual(tables, ['plugin_connectionstats_sessions', 'plugin_connectionstats_settings']);
        await storeSuite(db, 'sqlite (node:sqlite)');
    } finally {
        db.close();
        raw.close();
    }
});

// The real driver MeshCentral uses (sqlite3@5.1.7, exposed as meshserver.db.file), when installed.
let sqlite3 = null;
try { sqlite3 = require('sqlite3'); } catch (e) { }

test('sqlite backend round trip on the sqlite3 driver', { skip: !sqlite3 && 'sqlite3 driver not installed' }, async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sqlite3-')), 'meshcentral.sqlite');
    const raw = await new Promise((res, rej) => { const d = new sqlite3.Database(file, e => e ? rej(e) : res(d)); });
    const db = require('../db.js').CreateDB(fakeServer(raw));
    try {
        await storeSuite(db, 'sqlite3');
    } finally {
        db.close();
        await new Promise(r => raw.close(r));
        fs.rmSync(path.dirname(file), { recursive: true, force: true });
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
