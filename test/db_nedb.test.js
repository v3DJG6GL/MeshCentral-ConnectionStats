"use strict";
// Round trip through the NeDB backend. Needs @seald-io/nedb resolvable from the plugin folder
// (in development: a node_modules symlink to a MeshCentral checkout); skipped otherwise.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

let nedbAvailable = true;
try { require('@seald-io/nedb'); } catch (e) { nedbAvailable = false; }

function fakeServer(dir) {
    return {
        args: {},
        db: { databaseType: 1 },
        pluginHandler: {},
        getConfigFilePath: function (f) { return path.join(dir, f); }
    };
}

function doc(id, start, end, extra) {
    return Object.assign({ _id: 's_' + id, domain: '', nodeid: 'n1', meshid: 'm1', userid: 'u1', username: 'admin', type: 'desktop', protocol: 2, start: start, end: end, seconds: end ? (end - start) / 1000 : 0 }, extra || {});
}

test('nedb backend round trip', { skip: !nedbAvailable && 'nedb not resolvable' }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-nedb-'));
    process.env.CONNECTIONSTATS_STORAGE = 'nedb';
    const db = require('../db.js').CreateDB(fakeServer(dir));
    try {
        const T = Math.floor(Date.now() / 1000) * 1000 - 86400000; // yesterday, so the "old" record is really old
        await db.upsertSession(doc('a', T, T + 60000));
        await db.upsertSession(doc('b', T + 100000, null));                 // open
        await db.upsertSession(doc('c', T - 10 * 86400000, T - 10 * 86400000 + 5000)); // old
        await db.upsertSession(doc('g', T, T + 1000, { guest: 'Visitor' }));
        await db.upsertSession(doc('o', T, T + 1000, { domain: 'other' }));

        // overlap semantics: window starting after a's end excludes a, open b is included
        let rows = await db.findSessions({ domain: '', start: T + 70000, end: T + 200000 });
        assert.deepEqual(rows.map(r => r._id).sort(), ['s_b']);
        rows = await db.findSessions({ domain: '', start: T, end: T + 200000 });
        assert.deepEqual(rows.map(r => r._id).sort(), ['s_a', 's_b']);
        rows = await db.findSessions({ domain: '', start: T, end: T + 200000, includeGuests: true });
        assert.deepEqual(rows.map(r => r._id).sort(), ['s_a', 's_b', 's_g']);

        const open = await db.getOpenSessions();
        assert.deepEqual(open.map(r => r._id), ['s_b']);

        await db.updateSession('s_b', { lastbeat: T + 150000 });
        assert.equal((await db.getSession('s_b')).lastbeat, T + 150000);
        assert.equal((await db.getSession('s_b')).userid, 'u1'); // patch did not clobber

        const page = await db.listSessions({ domain: '', start: T - 20 * 86400000, end: T + 200000 }, { limit: 2, skip: 0 });
        assert.equal(page.total, 3);
        assert.equal(page.rows.length, 2);
        assert.equal(page.rows[0]._id, 's_b'); // newest first

        // retention keeps open sessions and recent ones
        const removed = await db.sweepRetention(5);
        assert.equal(removed, 1);
        assert.equal(await db.getSession('s_c'), null);
        assert.notEqual(await db.getSession('s_b'), null);

        await db.setSetting('settings', { retentionDays: 30, nested: { a: 1 } });
        assert.deepEqual(await db.getSetting('settings'), { retentionDays: 30, nested: { a: 1 } });
        assert.equal(await db.getSetting('missing'), null);
        assert.equal(await db.getDBVersion(), 1);
        await db.updateDBVersion(3);
        assert.equal(await db.getDBVersion(), 3);

        assert.equal(await db.removeSession('s_a'), 1);
        assert.equal(await db.getSession('s_a'), null);
    } finally {
        db.close();
        delete process.env.CONNECTIONSTATS_STORAGE;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
