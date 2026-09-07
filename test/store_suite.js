"use strict";
// The store contract every backend has to meet, run by the NeDB, SQLite and live-server tests.
// `db` is the object CreateDB built; `label` names the backend in assertion messages.
const assert = require('node:assert/strict');

function doc(id, start, end, extra) {
    return Object.assign({ _id: 's_' + id, domain: '', nodeid: 'n1', meshid: 'm1', userid: 'u1', username: 'admin', type: 'desktop', protocol: 2, start: start, end: end, seconds: end ? (end - start) / 1000 : 0 }, extra || {});
}

async function storeSuite(db, label) {
    const T = Math.floor(Date.now() / 1000) * 1000 - 86400000; // yesterday, so the "old" record is really old
    const m = (s) => label + ': ' + s;

    await db.upsertSession(doc('a', T, T + 60000, { bytesin: 12345678901, extras: 'kept in doc' }));
    await db.upsertSession(doc('b', T + 100000, null));                                                 // open
    await db.upsertSession(doc('c', T - 10 * 86400000, T - 10 * 86400000 + 5000, { truncated: true })); // old
    await db.upsertSession(doc('g', T, T + 1000, { guest: 'Visitor' }));
    await db.upsertSession(doc('o', T, T + 1000, { domain: 'other' }));
    await db.upsertSession(doc('u', T, T + 2000, { nodename: 'Zürich-PC', meshname: 'Büro 🙂', username: 'jörg' }));

    // big numbers survive the round trip, unknown keys are dropped on upsert (normDoc whitelist),
    // a second upsert replaces the document
    let a = await db.getSession('s_a');
    assert.equal(a.bytesin, 12345678901, m('bigint bytes'));
    assert.equal(a.extras, undefined, m('unknown key dropped on upsert'));
    await db.upsertSession(doc('a', T, T + 60000, { bytesin: 5 }));
    a = await db.getSession('s_a');
    assert.equal(a.bytesin, 5, m('upsert replaces'));
    assert.equal(a.end, T + 60000);
    assert.equal(a.start, T);
    assert.equal(a.seconds, 60);
    assert.equal(!!a.truncated, false, m('truncated default'));
    assert.equal((await db.getSession('s_c')).truncated, true, m('truncated stored'));
    const u = await db.getSession('s_u');
    assert.equal(u.nodename, 'Zürich-PC', m('utf8 node name'));
    assert.equal(u.meshname, 'Büro 🙂', m('utf8 outside the BMP'));
    assert.equal(u.username, 'jörg');
    assert.equal(await db.getSession('missing'), null);

    // overlap semantics: a window starting after a's end excludes a, the open session b is included
    let rows = await db.findSessions({ domain: '', start: T + 70000, end: T + 200000 });
    assert.deepEqual(rows.map(r => r._id), ['s_b'], m('overlap'));
    rows = await db.findSessions({ domain: '', start: T, end: T + 200000 });
    assert.deepEqual(rows.map(r => r._id).sort(), ['s_a', 's_b', 's_u'], m('guests and other domains excluded'));
    rows = await db.findSessions({ domain: '', start: T, end: T + 200000, includeGuests: true, nodeids: ['n1', 'zzz'] });
    assert.deepEqual(rows.map(r => r._id).sort(), ['s_a', 's_b', 's_g', 's_u'], m('nodeids IN list'));
    rows = await db.findSessions({ domain: '', start: T, end: T + 200000, nodeids: ['nope'] });
    assert.equal(rows.length, 0, m('nodeids miss'));
    rows = await db.findSessions({ domain: '', start: T, end: T + 200000, meshids: ['m1'], userids: ['u1'], types: ['desktop'] });
    assert.deepEqual(rows.map(r => r._id).sort(), ['s_a', 's_b', 's_u'], m('mesh/user/type lists'));
    rows = await db.findSessions({ domain: '', start: T, end: T + 200000, types: ['files'] });
    assert.equal(rows.length, 0, m('type miss'));
    rows = await db.findSessions({ domain: 'other', start: T, end: T + 200000 });
    assert.deepEqual(rows.map(r => r._id), ['s_o'], m('other domain'));

    // open sessions, column-level patches
    assert.deepEqual((await db.getOpenSessions()).map(r => r._id), ['s_b'], m('open'));
    await db.updateSession('s_b', { lastbeat: T + 150000, note: 'in doc' });
    const b = await db.getSession('s_b');
    assert.equal(b.lastbeat, T + 150000, m('patch column'));
    assert.equal(b.note, 'in doc', m('patch extra key'));
    assert.equal(b.userid, 'u1', m('patch did not clobber'));
    assert.equal(b.end, null, m('still open'));
    await db.updateSession('s_b', { end: T + 200000, seconds: 100, active: 42, truncated: true });
    const b2 = await db.getSession('s_b');
    assert.equal(b2.truncated, true); assert.equal(b2.active, 42); assert.equal(b2.seconds, 100); assert.equal(b2.end, T + 200000);
    assert.equal(b2.note, 'in doc', m('second patch kept the extra key'));
    assert.equal((await db.getOpenSessions()).length, 0);

    // paging, newest first
    const page = await db.listSessions({ domain: '', start: T - 20 * 86400000, end: T + 300000 }, { limit: 2, skip: 1 });
    assert.equal(page.total, 4, m('page total'));
    assert.deepEqual(page.rows.map(r => r._id).sort(), ['s_a', 's_u'], m('page rows (a and u share a start)'));
    const all = await db.listSessions({ domain: '', start: T - 20 * 86400000, end: T + 300000 }, { limit: 10, skip: 0 });
    assert.equal(all.rows[0]._id, 's_b', m('newest first'));
    assert.equal(all.rows[3]._id, 's_c', m('oldest last'));
    const first = await db.firstSession({ domain: '', start: 0, end: T + 300000 });
    assert.equal(first._id, 's_c', m('firstSession is the oldest'));
    assert.equal(await db.firstSession({ domain: 'nope', start: 0, end: T + 300000 }), null, m('firstSession with no match'));

    // retention keeps recent and open sessions
    await db.upsertSession(doc('open-old', T - 30 * 86400000, null));
    assert.equal(await db.sweepRetention(5), 1, m('sweep count'));
    assert.equal(await db.getSession('s_c'), null, m('old closed removed'));
    assert.notEqual(await db.getSession('s_open-old'), null, m('open never removed'));
    assert.notEqual(await db.getSession('s_a'), null);
    await db.removeSession('s_open-old');

    // settings and version
    await db.setSetting('settings', { retentionDays: 30, nested: { a: 1 }, text: 'Grüezi' });
    assert.deepEqual(await db.getSetting('settings'), { retentionDays: 30, nested: { a: 1 }, text: 'Grüezi' }, m('settings'));
    await db.setSetting('settings', { retentionDays: 7 });
    assert.deepEqual(await db.getSetting('settings'), { retentionDays: 7 }, m('settings replaced'));
    assert.equal(await db.getSetting('missing'), null);
    assert.equal(await db.getDBVersion(), 1, m('version'));
    await db.updateDBVersion(3);
    assert.equal(await db.getDBVersion(), 3);

    assert.equal(await db.removeSession('s_a'), 1, m('remove'));
    assert.equal(await db.getSession('s_a'), null);
    assert.equal(await db.removeSession('s_a'), 0, m('remove missing'));
}

module.exports = { storeSuite, doc };
