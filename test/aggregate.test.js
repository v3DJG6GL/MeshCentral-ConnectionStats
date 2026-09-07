"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const ag = require('../aggregate.js');

const TZ = 'Europe/Zurich';
const L = (y, m, d, h, mi) => ag.fromLocal(y, m - 1, d, h || 0, mi || 0, TZ);

test('fromLocal and partsIn round trip across the zone', () => {
    const t = L(2026, 9, 7, 16, 25);
    assert.equal(t, Date.UTC(2026, 8, 7, 14, 25)); // CEST = UTC+2
    const p = ag.partsIn(t, TZ);
    assert.deepEqual([p.y, p.m, p.d, p.h, p.mi, p.wd], [2026, 8, 7, 16, 25, 1]); // Monday
    assert.equal(ag.isoLocal(t, TZ), '2026-09-07T16:25:00+02:00');
    assert.equal(ag.isoLocal(L(2026, 1, 15, 8, 0), TZ), '2026-01-15T08:00:00+01:00');
    assert.equal(ag.isoLocal(Date.UTC(2026, 0, 1), 'UTC'), '2026-01-01T00:00:00+00:00');
});

test('day buckets are 23 and 25 hours long on the DST changes', () => {
    const fall = ag.bucketEdges(L(2026, 10, 24), L(2026, 10, 27), 'day', TZ);
    assert.equal(fall.length, 3);
    assert.equal((fall[1].e - fall[1].s) / 3600000, 25); // 25 Oct 2026
    const spring = ag.bucketEdges(L(2026, 3, 28), L(2026, 3, 31), 'day', TZ);
    assert.equal((spring[1].e - spring[1].s) / 3600000, 23); // 29 Mar 2026
    // hour buckets on the fall-back day: 25 of them
    assert.equal(ag.bucketEdges(L(2026, 10, 25), L(2026, 10, 26), 'hour', TZ).length, 25);
});

test('a session across local midnight gives each day its share, also over the DST change', () => {
    const s = { nodeid: 'n', type: 'desktop', start: L(2026, 10, 24, 23, 30), end: L(2026, 10, 25, 0, 30) };
    const r = ag.aggregate([s], { start: L(2026, 10, 24), end: L(2026, 10, 26), bucket: 'day', tz: TZ });
    assert.equal(r.buckets[0].tot, 1800);
    assert.equal(r.buckets[1].tot, 1800);
    assert.equal(r.totals.seconds, 3600);
    assert.equal(r.totals.count, 1);
});

test('proportional split of a 3 h session over hour buckets and clipping to the range', () => {
    const s = { nodeid: 'n', type: 'terminal', start: L(2026, 9, 7, 8, 30), end: L(2026, 9, 7, 11, 30) };
    const r = ag.aggregate([s], { start: L(2026, 9, 7, 9), end: L(2026, 9, 7, 11), bucket: 'hour', tz: TZ });
    assert.equal(r.buckets.length, 2);
    assert.equal(r.buckets[0].by.terminal, 3600);
    assert.equal(r.buckets[1].by.terminal, 3600);
    assert.equal(r.totals.seconds, 7200); // clipped to the two-hour range
});

test('open sessions count up to now and active time scales with the clipped share', () => {
    const now = L(2026, 9, 7, 12);
    const open = { nodeid: 'n', type: 'desktop', start: L(2026, 9, 7, 11), end: null, active: null };
    const seen = { nodeid: 'm', type: 'desktop', start: L(2026, 9, 7, 8), end: L(2026, 9, 7, 10), active: 3600 };
    const r = ag.aggregate([open, seen], { start: L(2026, 9, 7, 9), end: L(2026, 9, 7, 13), bucket: 'hour', tz: TZ, now: now });
    assert.equal(r.totals.ongoing, 1);
    assert.equal(r.totals.seconds, 3600 + 3600);
    assert.equal(r.totals.seenSeconds, 3600);      // only the hour of the observed session inside the range
    assert.equal(r.totals.active, 1800);           // half of that session's 3600 active seconds
});

test('week buckets start on Monday and month buckets on the first', () => {
    const w = ag.bucketEdges(L(2026, 9, 9), L(2026, 9, 10), 'week', TZ);
    assert.equal(ag.partsIn(w[0].s, TZ).wd, 1); assert.equal(ag.partsIn(w[0].s, TZ).d, 7);
    const m = ag.bucketEdges(L(2025, 9, 1), L(2026, 9, 1), 'month', TZ);
    assert.equal(m.length, 12);
    assert.equal(ag.partsIn(m[5].s, TZ).d, 1);
});

test('autoBucket and previousRange', () => {
    const d = 86400000;
    assert.equal(ag.autoBucket(0, d), 'hour');
    assert.equal(ag.autoBucket(0, 7 * d), 'day');
    assert.equal(ag.autoBucket(0, 90 * d), 'week');
    assert.equal(ag.autoBucket(0, 365 * d), 'month');
    const p = ag.previousRange(L(2026, 9, 1), L(2026, 9, 8), 'day', TZ);
    assert.equal(p.start, L(2026, 8, 25)); assert.equal(p.end, L(2026, 9, 1));
    const y = ag.previousRange(L(2025, 10, 1), L(2026, 10, 1), 'month', TZ);
    assert.equal(y.start, L(2024, 10, 1)); assert.equal(y.end, L(2025, 10, 1));
});

test('punchcard, devices, groups and median', () => {
    const mk = (h, sec, node, mesh) => ({ nodeid: node, nodename: node.toUpperCase(), meshid: mesh, meshname: mesh, type: 'desktop', start: L(2026, 9, 7, h), end: L(2026, 9, 7, h) + sec * 1000 });
    const r = ag.aggregate([mk(9, 600, 'a', 'g1'), mk(9, 1200, 'b', 'g1'), mk(14, 300, 'a', 'g1')], { start: L(2026, 9, 7), end: L(2026, 9, 8), bucket: 'day', tz: TZ });
    assert.equal(r.punchcard[1][9], 1800); assert.equal(r.punchcard[1][14], 300);
    assert.equal(r.byDevice[0].id, 'b'); assert.equal(r.byDevice[1].seconds, 900);
    assert.equal(r.byGroup[0].name, 'g1'); assert.equal(r.byGroup[0].sessions, 3);
    assert.equal(r.totals.median, 600); assert.equal(r.totals.devices, 2);
});

test('an unknown time zone falls back to UTC instead of throwing', () => {
    assert.equal(ag.bucketEdges(0, 86400000, 'day', 'Mars/Olympus').length, 1);
});
