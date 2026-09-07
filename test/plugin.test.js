"use strict";
// The plugin entry wired to a fake pluginHandler / meshserver and fed synthetic relay events,
// the way MeshCentral's DispatchEvent would. Needs @seald-io/nedb resolvable; skipped otherwise.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

let nedbAvailable = true;
try { require('@seald-io/nedb'); } catch (e) { nedbAvailable = false; }

function fakeMeshServer(dir) {
    const nodes = { 'node//abc': { _id: 'node//abc', name: 'SRV-HV01', meshid: 'mesh//servers' } };
    const ms = {
        args: {},
        db: { databaseType: 1, Get: function (id, cb) { cb(null, nodes[id] ? [nodes[id]] : []); } },
        webserver: { meshes: { 'mesh//servers': { name: 'Servers' } } },
        pluginHandler: {},
        getConfigFilePath: function (f) { return path.join(dir, f); },
        dispatch: [],
        AddEventDispatch: function (ids, target) { ms.dispatch.push(target); },
        RemoveEventDispatch: function (ids, target) { ms.dispatch = ms.dispatch.filter(t => t !== target); }
    };
    ms.pluginHandler.parent = ms;
    return ms;
}
function relay(msgid, protocol, args, extra) {
    return Object.assign({ etype: 'relay', action: 'relaylog', domain: '', userid: 'user//admin', username: 'admin', msgid: msgid, msgArgs: args, protocol: protocol, nodeid: 'node//abc', time: new Date() }, extra || {});
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('plugin records a desktop session end to end', { skip: !nedbAvailable && 'nedb not resolvable' }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-plugin-'));
    process.env.CONNECTIONSTATS_STORAGE = 'nedb';
    const ms = fakeMeshServer(dir);
    const plugin = require('../connectionstats.js').connectionstats(ms.pluginHandler);
    try {
        plugin.server_startup();
        assert.equal(ms.dispatch.length, 1);
        await sleep(50); // settings load
        assert.equal(plugin.settings.retentionDays, 365);

        const t0 = Date.now() - 5000;
        plugin.HandleEvent(null, relay(15, '2', ['r1', '203.0.113.7', '10.0.0.5'], { time: new Date(t0) }), ['*'], null);
        await sleep(50);
        let open = await plugin.db.getOpenSessions();
        assert.equal(open.length, 1);
        assert.equal(open[0].nodename, 'SRV-HV01'); assert.equal(open[0].meshname, 'Servers'); assert.equal(open[0].meshid, 'mesh//servers');

        plugin.HandleEvent(null, relay(11, '2', ['r1', '10.0.0.5', '203.0.113.7', 5], { bytesin: 100, bytesout: 50, time: new Date(t0 + 5000) }), ['*'], null);
        await sleep(50);
        const d = await plugin.db.getSession('s_r1');
        assert.equal(d.seconds, 5); assert.equal(d.end, t0 + 5000); assert.equal(d.bytesin, 100); assert.equal(d.nodename, 'SRV-HV01');
        assert.equal((await plugin.db.getOpenSessions()).length, 0);

        // a second startup (plugin reload) closes what was left open and re-subscribes once
        plugin.HandleEvent(null, relay(14, '1', ['r2', 'a', 'b']), ['*'], null);
        await sleep(50);
        const plugin2 = require('../connectionstats.js').connectionstats(ms.pluginHandler);
        plugin2.server_startup();
        await sleep(100);
        assert.equal(ms.dispatch.length, 1);
        assert.equal(ms.dispatch[0], plugin2);
        const r2 = await plugin2.db.getSession('s_r2');
        assert.equal(r2.truncated, true); assert.notEqual(r2.end, null);
        plugin2.db.close();
    } finally {
        try { plugin.db.close(); } catch (e) { }
        delete process.env.CONNECTIONSTATS_STORAGE;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('sessions shorter than minSeconds are dropped', { skip: !nedbAvailable && 'nedb not resolvable' }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-plugin-'));
    process.env.CONNECTIONSTATS_STORAGE = 'nedb';
    const ms = fakeMeshServer(dir);
    const plugin = require('../connectionstats.js').connectionstats(ms.pluginHandler);
    try {
        plugin.server_startup();
        await sleep(50);
        await plugin.saveSettings({ minSeconds: 10 });
        const t0 = Date.now() - 3000;
        plugin.HandleEvent(null, relay(16, '5', ['f1', 'a', 'b'], { time: new Date(t0) }), ['*'], null);
        await sleep(50);
        plugin.HandleEvent(null, relay(12, '5', ['f1', 'a', 'b', 3], { time: new Date(t0 + 3000) }), ['*'], null);
        await sleep(50);
        assert.equal(await plugin.db.getSession('s_f1'), null);
    } finally {
        plugin.db.close();
        delete process.env.CONNECTIONSTATS_STORAGE;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
