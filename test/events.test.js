"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const ev = require('../events.js');

const T0 = Date.UTC(2026, 8, 7, 8, 14, 7); // 2026-09-07T08:14:07Z

function relay(msgid, protocol, args, extra) {
    return Object.assign({ etype: 'relay', action: 'relaylog', domain: '', userid: 'user//admin', username: 'admin', msgid: msgid, msgArgs: args, protocol: protocol, nodeid: 'node//abc', time: new Date(T0) }, extra || {});
}

test('classify ignores non-relay events and unknown msgids', () => {
    assert.equal(ev.classify({ etype: 'user', action: 'login' }), null);
    assert.equal(ev.classify(relay(5, 2, ['x'])), null);
    assert.equal(ev.classify(relay(145, 2, ['mux1'])), null);
    assert.equal(ev.classify(relay(147, 2, ['mux1', 10])), null);
});

test('desktop start and end pair by relay id, seconds from last msgArgs, bytes from bytesin/out', () => {
    const s = ev.classify(relay(15, '2', ['r1', '203.0.113.7', '10.0.0.5']));
    assert.equal(s.kind, 'start'); assert.equal(s.type, 'desktop'); assert.equal(s.key, 'r1'); assert.equal(s.protocol, 2); assert.equal(s.ip, '203.0.113.7');
    const e = ev.classify(relay(11, '2', ['r1', '10.0.0.5', '203.0.113.7', 4332], { bytesin: 100, bytesout: 200, time: new Date(T0 + 4332000) }));
    assert.equal(e.kind, 'end'); assert.equal(e.seconds, 4332); assert.equal(e.bytesin, 100); assert.equal(e.bytesout, 200);
    const p = new ev.Pairer();
    const open = p.onStart(s);
    assert.equal(open._id, 's_r1'); assert.equal(open.end, null); assert.equal(open.start, T0);
    const done = p.onEnd(e);
    assert.equal(done._id, 's_r1'); assert.equal(done.end, T0 + 4332000); assert.equal(done.seconds, 4332); assert.equal(done.truncated, false);
    assert.equal(done.bytesin, 100);
    assert.equal(p.count(), 0);
});

test('terminal protocols 1/6/8/9 map to terminal, files 5, messenger 200, amt 100/101', () => {
    for (const pr of [1, 6, 8, 9]) assert.equal(ev.typeOf(pr), 'terminal');
    assert.equal(ev.typeOf(5), 'files');
    assert.equal(ev.typeOf(200), 'messenger');
    assert.equal(ev.typeOf(100), 'amt'); assert.equal(ev.typeOf(101), 'amt');
    assert.equal(ev.typeOf(202), 'webapp');
    assert.equal(ev.typeOf(undefined), 'other'); assert.equal(ev.typeOf(0), 'tunnel'); assert.equal(ev.typeOf(7), 'plugin'); assert.equal(ev.typeOf(4), 'other');
});

test('web app sessions: id in msgArgs[0] on start, sessionid on end, seconds in msgArgs[0]', () => {
    const s = ev.classify(relay(148, 202, ['ws1']));
    assert.equal(s.key, 'ws1'); assert.equal(s.type, 'webapp');
    const e = ev.classify(relay(123, 202, [502, 'ws1'], { sessionid: 'ws1', bytesin: 1, bytesout: 2 }));
    assert.equal(e.key, 'ws1'); assert.equal(e.seconds, 502);
});

test('inner relay of an open web app session is ignored on start and on end', () => {
    const p = new ev.Pairer();
    assert.ok(p.onStart(ev.classify(relay(148, 202, ['ws1']))));
    const inner = ev.classify(relay(13, 11, ['in1', '1.1.1.1', '2.2.2.2']));
    assert.equal(inner.inner, true);
    assert.equal(p.onStart(inner), null);
    assert.equal(p.onEnd(ev.classify(relay(9, 11, ['in1', '1.1.1.1', '2.2.2.2', 500]))), null);
    // the web app end still closes normally
    const done = p.onEnd(ev.classify(relay(123, 202, [500, 'ws1'], { sessionid: 'ws1' })));
    assert.equal(done.type, 'webapp'); assert.equal(done.seconds, 500);
});

test('an inner relay without an open web app is a normal "other" session', () => {
    const p = new ev.Pairer();
    const open = p.onStart(ev.classify(relay(13, 11, ['in1', '1.1.1.1', '2.2.2.2'])));
    assert.equal(open.type, 'other');
});

test('multiplex viewers share the multiplex id, so the key includes the user', () => {
    const a = ev.classify(relay(143, 2, ['mux1']));
    const b = ev.classify(relay(143, 2, ['mux1'], { userid: 'user//helpdesk', username: 'helpdesk' }));
    assert.notEqual(a.key, b.key);
    const p = new ev.Pairer();
    p.onStart(a); p.onStart(b);
    assert.equal(p.count(), 2);
    const ea = ev.classify(relay(144, 2, ['mux1', 90], { bytesin: 5, bytesout: 6, time: new Date(T0 + 90000) }));
    const da = p.onEnd(ea);
    assert.equal(da.userid, 'user//admin'); assert.equal(da.seconds, 90);
    assert.equal(p.count(), 1);
});

test('local relay: seconds in msgArgs[3], bytes in in/out', () => {
    const e = ev.classify(relay(121, 10, ['lr1', 'RDP', '10.0.0.9', 77], { in: 11, out: 22 }));
    assert.equal(e.seconds, 77); assert.equal(e.bytesin, 11); assert.equal(e.bytesout, 22); assert.equal(e.type, 'other');
});

test('AMT KVM: generic relay msgids with protocol 101, seconds only', () => {
    const p = new ev.Pairer();
    p.onStart(ev.classify(relay(13, 101, ['amt1', '1.1.1.1', '2.2.2.2'])));
    const d = p.onEnd(ev.classify(relay(9, 101, ['amt1', '1.1.1.1', '2.2.2.2', 300], { time: new Date(T0 + 300000) })));
    assert.equal(d.type, 'amt'); assert.equal(d.seconds, 300); assert.equal(d.bytesin, 0);
});

test('an end without a start becomes a truncated session of the reported length', () => {
    const p = new ev.Pairer();
    const d = p.onEnd(ev.classify(relay(10, 1, ['orphan', '1.1.1.1', '2.2.2.2', 600], { time: new Date(T0) })));
    assert.equal(d.truncated, true); assert.equal(d.start, T0 - 600000); assert.equal(d.end, T0); assert.equal(d.seconds, 600);
});

test('guest sessions carry the guest name', () => {
    const p = new ev.Pairer();
    const open = p.onStart(ev.classify(relay(15, 2, ['g1', '1.1.1.1', '2.2.2.2'], { guestname: 'Visitor' })));
    assert.equal(open.guest, 'Visitor');
});

test('restore reloads open documents so a later end closes them', () => {
    const p = new ev.Pairer();
    p.restore([{ _id: 's_r9', userid: 'user//admin', nodeid: 'node//abc', type: 'desktop', start: T0, end: null }]);
    assert.equal(p.findOpen('user//admin', 'node//abc', 'desktop')._id, 's_r9');
    const d = p.onEnd(ev.classify(relay(11, 2, ['r9', 'a', 'b', 60], { time: new Date(T0 + 60000) })));
    assert.equal(d._id, 's_r9'); assert.equal(d.seconds, 60);
});

test('when the reported length disagrees with the start by more than two minutes, the start moves', () => {
    const p = new ev.Pairer();
    p.onStart(ev.classify(relay(15, 2, ['r2', 'a', 'b'], { time: new Date(T0) })));
    const d = p.onEnd(ev.classify(relay(11, 2, ['r2', 'a', 'b', 1000], { time: new Date(T0 + 4000000) })));
    assert.equal(d.seconds, 1000); assert.equal(d.start, T0 + 4000000 - 1000000);
});
