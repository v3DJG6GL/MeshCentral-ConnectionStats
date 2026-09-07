"use strict";
// The store contract against real database servers, the way a MeshCentral installation on
// PostgreSQL, MariaDB, MySQL or MongoDB would drive it. Each backend runs only when its
// connection URL is set (see test/docker-compose.yml and test/live.sh):
//   CS_TEST_POSTGRES=postgres://meshcentral:meshcentral@127.0.0.1:55432/meshcentral
//   CS_TEST_MARIADB=mariadb://meshcentral:meshcentral@127.0.0.1:33306/meshcentral
//   CS_TEST_MYSQL=mysql://meshcentral:meshcentral@127.0.0.1:33307/meshcentral
//   CS_TEST_MONGODB=mongodb://127.0.0.1:37017/meshcentral
// The tables and collections are emptied before each run.
const test = require('node:test');
const assert = require('node:assert/strict');
const { storeSuite, doc } = require('./store_suite.js');

const T_SES = 'plugin_connectionstats_sessions', T_SET = 'plugin_connectionstats_settings';

// meshserver.args the way MeshCentral fills it from config.json: postgres is an object,
// mariadb/mysql accept a URL string, mongodb is a URL plus mongodbname.
function fakeServer(kind, url) {
    const s = { args: {}, db: {}, pluginHandler: {}, getConfigFilePath: f => f };
    if (kind == 'postgres') {
        const u = new URL(url);
        s.args.postgres = { host: u.hostname, port: Number(u.port || 5432), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: u.pathname.replace(/^\//, '') || 'meshcentral' };
        s.db.databaseType = 6;
    } else if (kind == 'mariadb') { s.args.mariadb = url; s.db.databaseType = 4; }
    else if (kind == 'mysql') { s.args.mysql = url; s.db.databaseType = 5; }
    else if (kind == 'mongodb') {
        const u = new URL(url);
        s.args.mongodb = url; s.args.mongodbname = u.pathname.replace(/^\//, '') || 'meshcentral'; s.db.databaseType = 3;
    }
    return s;
}

async function wipe(db, kind) {
    await db.ready();
    if (kind == 'mongodb') {
        await db.sessionsFile.deleteMany({});
        await db.settingsFile.deleteMany({});
    } else {
        await db.__q('DELETE FROM ' + T_SES);
        await db.__q('DELETE FROM ' + T_SET);
    }
}

const relayEvent = (msgid, protocol, args, extra) => Object.assign({ etype: 'relay', action: 'relaylog', domain: '', userid: 'user//admin', username: 'admin', msgid, msgArgs: args, protocol, nodeid: 'node//abc', time: new Date() }, extra || {});
const sleep = ms => new Promise(r => setTimeout(r, ms));

for (const kind of ['postgres', 'mariadb', 'mysql', 'mongodb']) {
    const url = process.env['CS_TEST_' + kind.toUpperCase()];
    const skip = !url && ('CS_TEST_' + kind.toUpperCase() + ' not set');

    test(kind + ': store contract', { skip }, async () => {
        const db = require('../db.js').CreateDB(fakeServer(kind, url));
        try {
            await wipe(db, kind);
            await storeSuite(db, kind);
        } finally { db.close(); }
    });

    test(kind + ': schema creation is idempotent and a second instance sees the first one\'s data', { skip }, async () => {
        const db1 = require('../db.js').CreateDB(fakeServer(kind, url));
        let db2 = null;
        try {
            await wipe(db1, kind);
            const T = Date.now() - 3600000;
            await db1.upsertSession(doc('shared', T, T + 1000));
            db2 = require('../db.js').CreateDB(fakeServer(kind, url));   // runs CREATE ... IF NOT EXISTS / createIndex again
            await db2.ready();
            assert.equal((await db2.getSession('s_shared')).seconds, 1);
            // a large IN list (chunked/array bound per dialect) still matches
            const ids = []; for (let i = 0; i < 3000; i++) ids.push('n' + i);
            ids.push('n1');
            const rows = await db2.findSessions({ domain: '', start: T - 10, end: T + 5000, nodeids: ids });
            assert.deepEqual(rows.map(r => r._id), ['s_shared']);
        } finally { db1.close(); if (db2) db2.close(); }
    });

    test(kind + ': retention sweep removes old closed sessions in chunks', { skip }, async () => {
        const db = require('../db.js').CreateDB(fakeServer(kind, url));
        try {
            await wipe(db, kind);
            const old = Date.now() - 400 * 86400000;
            const writes = [];
            for (let i = 0; i < 120; i++) writes.push(db.upsertSession(doc('old' + i, old + i * 1000, old + i * 1000 + 500)));
            writes.push(db.upsertSession(doc('open', old, null)));
            writes.push(db.upsertSession(doc('new', Date.now() - 1000, Date.now())));
            await Promise.all(writes);
            assert.equal(await db.sweepRetention(365), 120);
            assert.equal(await db.sweepRetention(365), 0);
            assert.notEqual(await db.getSession('s_open'), null);
            assert.notEqual(await db.getSession('s_new'), null);
        } finally { db.close(); }
    });

    test(kind + ': plugin records a relay session end to end', { skip }, async () => {
        const ms = fakeServer(kind, url);
        ms.db.Get = (id, cb) => cb(null, id == 'node//abc' ? [{ _id: 'node//abc', name: 'SRV-HV01', meshid: 'mesh//servers' }] : []);
        ms.webserver = { meshes: { 'mesh//servers': { name: 'Servers' } } };
        ms.dispatch = [];
        ms.AddEventDispatch = (ids, t) => ms.dispatch.push(t);
        ms.RemoveEventDispatch = (ids, t) => { ms.dispatch = ms.dispatch.filter(x => x !== t); };
        ms.pluginHandler.parent = ms;
        const plugin = require('../connectionstats.js').connectionstats(ms.pluginHandler);
        try {
            plugin.server_startup();
            await wipe(plugin.db, kind);
            await sleep(300);
            const t0 = Date.now() - 5000;
            plugin.HandleEvent(null, relayEvent(15, '2', ['live1', '203.0.113.7', '10.0.0.5'], { time: new Date(t0) }), ['*'], null);
            await sleep(400);
            const open = await plugin.db.getOpenSessions();
            assert.equal(open.length, 1);
            assert.equal(open[0].nodename, 'SRV-HV01'); assert.equal(open[0].meshname, 'Servers');
            plugin.HandleEvent(null, relayEvent(11, '2', ['live1', '10.0.0.5', '203.0.113.7', 5], { bytesin: 100, bytesout: 50, time: new Date(t0 + 5000) }), ['*'], null);
            await sleep(400);
            const d = await plugin.db.getSession('s_live1');
            assert.equal(d.seconds, 5); assert.equal(d.end, t0 + 5000); assert.equal(d.bytesin, 100); assert.equal(d.type, 'desktop');
            assert.equal((await plugin.db.getOpenSessions()).length, 0);
        } finally { plugin.db.close(); }
    });
}
