"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../db.js').helpers;

test('normFilter clamps, swaps a reversed range and drops junk', () => {
    const f = h.normFilter({ domain: 'x', start: 200, end: 100, nodeids: ['a', 5, '', 'b'], types: ['desktop', 'nope'], includeGuests: 'yes' });
    assert.equal(f.start, 100); assert.equal(f.end, 200);
    assert.deepEqual(f.nodeids, ['a', 'b']);
    assert.deepEqual(f.types, ['desktop']);
    assert.equal(f.includeGuests, false);
    assert.equal(h.normFilter({ types: ['nope'] }).types, null);
    assert.equal(h.normFilter({}).domain, '');
});

test('normFilter caps id lists at 5000', () => {
    const ids = []; for (let i = 0; i < 6000; i++) ids.push('n' + i);
    assert.equal(h.normFilter({ nodeids: ids }).nodeids.length, 5000);
});

test('buildDocQuery expresses the overlap and the optional lists', () => {
    const q = h.buildDocQuery(h.normFilter({ domain: '', start: 10, end: 20 }));
    assert.deepEqual(q, { domain: '', start: { $lt: 20 }, $or: [{ end: null }, { end: { $gt: 10 } }], guest: null });
    const q2 = h.buildDocQuery(h.normFilter({ start: 10, end: 20, nodeids: ['a'], meshids: ['m'], userids: ['u'], types: ['files'], includeGuests: true }));
    assert.deepEqual(q2.nodeid, { $in: ['a'] }); assert.deepEqual(q2.meshid, { $in: ['m'] });
    assert.deepEqual(q2.userid, { $in: ['u'] }); assert.deepEqual(q2.type, { $in: ['files'] });
    assert.equal('guest' in q2, false);
});

test('normDoc coerces types and nulls', () => {
    const d = h.normDoc({ _id: 's_1', domain: '', nodeid: 'n', type: 'desktop', start: '1000', seconds: '-5', truncated: 1, bytesin: 3.7 });
    assert.equal(d.start, 1000); assert.equal(d.end, null); assert.equal(d.active, null); assert.equal(d.seconds, 0);
    assert.equal(d.truncated, true); assert.equal(d.bytesin, 3); assert.equal(d.source, 'live'); assert.equal(d.guest, null);
    assert.throws(() => h.normDoc({ _id: 'bad' }));
    assert.equal(h.normDoc({ _id: 's_2', type: 'weird' }).type, 'other');
});

test('normPage yields plain integers in range', () => {
    assert.deepEqual(h.normPage({ limit: 1.5, skip: -3 }), { limit: 1, skip: 0 });
    assert.deepEqual(h.normPage({ limit: Infinity, skip: 'abc' }), { limit: 100, skip: 0 });
    assert.deepEqual(h.normPage({ limit: 5000, skip: 10 }), { limit: 1000, skip: 10 });
    assert.deepEqual(h.normPage(), { limit: 100, skip: 0 });
});
