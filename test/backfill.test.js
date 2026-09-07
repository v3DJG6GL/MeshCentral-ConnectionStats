"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const backfill = require('../backfill.js');
const events = require('../events.js');

function relay(msgid, protocol, args, extra) {
    return Object.assign({ etype: 'relay', action: 'relaylog', domain: '', userid: 'user//admin', username: 'admin', msgid: msgid, msgArgs: args, protocol: protocol, nodeid: 'node//abc' }, extra || {});
}

test('backfill pairs stored events, skips known sessions and scans through empty windows', async () => {
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
    assert.equal(st.scanned, 6); // includes the non-relay event returned by the database
    assert.equal(st.found, 2);
    assert.equal(st.imported, 1);
    assert.equal(st.skipped, 1);
    assert.deepEqual(calls[0][0], ['*']);
    assert.equal(store['s_old1'].source, 'backfill');
    assert.equal(store['s_old1'].seconds, 600);
    assert.equal(store['s_old1'].nodename, 'PC');
    // Every requested window is read, even when several weeks have no events.
    assert.equal(calls.length, 9);
});

test('all-history import reads the live database beyond 400 days, preserves domains and skips duplicates', async () => {
    const start = Date.UTC(2024, 0, 1);
    const old = [relay(15, 2, ['ancient', 'a', 'b'], { time: new Date(start), domain: 'office' }),
        relay(11, 2, ['ancient', 'a', 'b', 60], { time: new Date(start + 60000), domain: 'office' })];
    const store = new Map(); let reads = 0;
    const ctx = { events, log() {}, resolveNames: (_, cb) => cb({ nodename: 'PC' }),
        meshServer: { db: { GetAllEvents: cb => { reads++; cb(null, [...old, { action: 'login' }]); } } },
        db: { getSession: async id => store.get(id), upsertSession: async d => store.set(d._id, d) } };
    const first = backfill.run(ctx, { days: 0 }); await first.promise;
    assert.equal(first.error, null); assert.equal(first.scanned, 3); assert.equal(first.imported, 1);
    const session = [...store.values()][0];
    assert.equal(session.domain, 'office'); assert.equal(session.start, start);
    const second = backfill.run(ctx, {}); await second.promise;
    assert.equal(second.imported, 0); assert.equal(second.skipped, 1); assert.equal(reads, 2);
});

test('bounded import reaches old events after long gaps and restores the projected domain', async () => {
    const start = Date.now() - 600 * 86400000;
    const old = [relay(15, 2, ['old', 'a', 'b'], { time: new Date(start) }), relay(11, 2, ['old', 'a', 'b', 60], { time: new Date(start + 60000) })];
    let session;
    const ctx = { events, log() {}, resolveNames: (_, cb) => cb({}),
        meshServer: { config: { domains: { office: {} } }, db: {
            GetEventsTimeRange: (_, domain, ids, from, to, cb) => cb(null, old.filter(e => e.time >= from && e.time <= to).map(e => { const copy = { ...e }; delete copy.domain; return copy; }))
        } }, db: { getSession: async () => null, upsertSession: async d => { session = d; } } };
    const st = backfill.run(ctx, { days: 700 }); await st.promise;
    assert.equal(st.error, null); assert.equal(st.imported, 1); assert.equal(session.domain, 'office');
});

test('database read failures are reported instead of treated as empty history', async () => {
    for (const days of [0, 30]) {
        const fail = (...args) => args[args.length - 1](new Error('database unavailable'));
        const ctx = { events, log() {}, meshServer: { db: { GetAllEvents: fail, GetEventsTimeRange: fail } } };
        const st = backfill.run(ctx, { days }); await st.promise;
        assert.match(st.error, /database unavailable/); assert.equal(st.running, false);
    }
});

test('coverage distinguishes missing history, unsupported relay events and existing sessions', async () => {
    const t = Date.UTC(2026, 8, 1), logs = [];
    const docs = [
        { time: new Date(Date.UTC(2026, 1, 1)), action: 'login' },
        relay(9999, 2, ['unknown'], { time: new Date(Date.UTC(2026, 2, 1)) }),
        relay(15, 2, ['recent', 'a', 'b'], { time: new Date(t) }),
        relay(11, 2, ['recent', 'a', 'b', 60], { time: new Date(t + 60000) })
    ];
    const ctx = { events, log: line => logs.push(line), meshServer: { db: { GetAllEvents: cb => cb(null, docs) } },
        db: { getSession: async () => ({ _id: 's_recent' }) } };
    const st = backfill.run(ctx, { days: 0 }); await st.promise;
    assert.equal(st.error, null); assert.equal(st.imported, 0); assert.equal(st.skipped, 1);
    assert.equal(st.coverage.events.count, 4);
    assert.equal(st.coverage.events.first, Date.UTC(2026, 1, 1));
    assert.equal(st.coverage.relay.count, 3);
    assert.equal(st.coverage.relay.months['2026-02'], undefined);
    assert.equal(st.coverage.relay.months['2026-03'], 1);
    assert.equal(st.coverage.supportedRelay.months['2026-03'], undefined);
    assert.equal(st.coverage.supportedRelay.months['2026-09'], 2);
    assert.equal(st.coverage.sessions.months['2026-09'], 1);
    assert.ok(logs.some(line => line.includes('all history via GetAllEvents')));
    assert.ok(logs.every(line => !line.includes('user//admin') && !line.includes('node//abc')));
});
