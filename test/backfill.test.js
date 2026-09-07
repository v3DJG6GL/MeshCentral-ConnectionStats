"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const backfill = require('../backfill.js');
const events = require('../events.js');

function relay(msgid, protocol, args, extra) {
    return Object.assign({ etype: 'relay', action: 'relaylog', domain: '', userid: 'user//admin', username: 'admin', msgid: msgid, msgArgs: args, protocol: protocol, nodeid: 'node//abc' }, extra || {});
}

test('backfill pairs stored events, skips known sessions and stops on empty windows', async () => {
    const now = Date.now();
    const stored = [
        relay(15, '2', ['old1', 'a', 'b'], { time: new Date(now - 10 * 86400000) }),
        relay(11, '2', ['old1', 'a', 'b', 600], { time: new Date(now - 10 * 86400000 + 600000), bytesin: 1, bytesout: 2 }),
        relay(14, '1', ['known', 'a', 'b'], { time: new Date(now - 3 * 86400000) }),
        relay(10, '1', ['known', 'a', 'b', 60], { time: new Date(now - 3 * 86400000 + 60000) }),
        { etype: 'user', action: 'login', time: new Date(now - 100000), msgid: 15 },   // not a relay event
        relay(16, '5', ['open', 'a', 'b'], { time: new Date(now - 1000) })              // no end yet: not imported
    ];
    const calls = [];
    const store = { 's_known': { _id: 's_known' } };
    const ctx = {
        meshServer: { config: { domains: { '': {} } }, db: { GetEventsTimeRange: function (ids, domain, msgids, start, end, cb) { calls.push([ids, domain, start.getTime(), end.getTime()]); cb(null, stored.filter(e => e.time >= start && e.time < end)); } } },
        db: { getSession: id => Promise.resolve(store[id] || null), upsertSession: d => { store[d._id] = d; return Promise.resolve(d); } },
        events: events,
        resolveNames: (nodeid, cb) => cb({ meshid: 'mesh//1', nodename: 'PC', meshname: 'Group' }),
        log: () => { }
    };
    const st = backfill.run(ctx, { days: 60 });
    assert.equal(st.running, true);
    await st.promise;
    assert.equal(st.running, false);
    assert.equal(st.scanned, 5);
    assert.equal(st.found, 2);
    assert.equal(st.imported, 1);
    assert.equal(st.skipped, 1);
    assert.deepEqual(calls[0][0], ['*']);
    assert.equal(store['s_old1'].source, 'backfill');
    assert.equal(store['s_old1'].seconds, 600);
    assert.equal(store['s_old1'].nodename, 'PC');
    // windows: 7-day steps, stopping after 4 empty windows past the last event (~10 days back)
    assert.ok(calls.length >= 2 && calls.length <= 7, 'windows read: ' + calls.length);
});
