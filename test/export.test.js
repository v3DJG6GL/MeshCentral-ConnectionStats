"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const ex = require('../export.js');
const ag = require('../aggregate.js');

const TZ = 'Europe/Zurich';
const L = (y, m, d, h, mi) => ag.fromLocal(y, m - 1, d, h || 0, mi || 0, TZ);

test('csv quoting follows RFC 4180 and keeps umlauts', () => {
    assert.equal(ex.csvRow(['a', 'b,c', 'say "hi"', 'line\nbreak', 'Zürich', null, true, 0]), 'a,"b,c","say ""hi""","line\nbreak",Zürich,,true,0\r\n');
    assert.equal(ex.csvField(' padded'), '" padded"');
});

test('session rows carry ISO 8601 with offset and integer seconds', () => {
    const d = { start: L(2026, 9, 2, 8, 14), end: L(2026, 9, 2, 9, 26), seconds: 4320, active: 2710, type: 'desktop', nodename: 'SRV-HV01', nodeid: 'node//1', meshname: 'Servers', meshid: 'mesh//1', username: 'admin', userid: 'user//admin', bytesin: 184223311, bytesout: 5122034, ip: '203.0.113.7', truncated: false, source: 'live' };
    const row = ex.sessionCsvRow(d, TZ);
    assert.equal(row, '2026-09-02T08:14:00+02:00,2026-09-02T09:26:00+02:00,4320,2710,desktop,SRV-HV01,node//1,Servers,mesh//1,admin,user//admin,,184223311,5122034,203.0.113.7,false,false,live\r\n');
    const open = ex.sessionRecord({ start: L(2026, 9, 2, 8, 0), end: null, seconds: 0, active: null, type: 'files', nodeid: 'n', userid: 'u', bytesin: 0, bytesout: 0 }, TZ, L(2026, 9, 2, 8, 10));
    assert.equal(open.end, null); assert.equal(open.ongoing, true); assert.equal(open.duration_seconds, 600); assert.equal(open.active_seconds, null);
    assert.equal(open.device, 'n'); assert.equal(open.admin, 'u');
});

test('header line and file name', () => {
    const meta = { scope: 'mesh:x', scopeName: 'Servers', start: L(2026, 9, 1), end: L(2026, 9, 8), bucket: 'day', tz: TZ, user: 'admin', version: '0.1.0', types: ['desktop'], guests: false, now: L(2026, 9, 8, 12) };
    const h = ex.headerLine(meta);
    assert.ok(h.startsWith('# Connection Stats export, scope=mesh:x, range=2026-09-01T00:00:00+02:00..2026-09-08T00:00:00+02:00, bucket=day, tz=Europe/Zurich, types=desktop, guests=excluded, user=admin, generated=2026-09-08T12:00:00+02:00, plugin=0.1.0'));
    assert.equal(ex.fileName(meta, 'sessions', 'csv'), 'meshcentral-connectionstats_servers_2026-09-01_2026-09-07_sessions.csv');
    assert.equal(ex.fileName(meta, 'buckets', 'csv'), 'meshcentral-connectionstats_servers_2026-09-01_2026-09-07_day.csv');
});

test('bucket rows: one per bucket and type plus a total', () => {
    const agg = { buckets: [{ s: L(2026, 9, 1), e: L(2026, 9, 2), by: { terminal: 60, desktop: 120 }, tot: 180 }] };
    const rows = ex.bucketRecords(agg, TZ);
    assert.deepEqual(rows.map(r => r.type), ['desktop', 'terminal', 'total']);
    assert.equal(rows[2].seconds, 180); assert.equal(rows[0].bucket_start, '2026-09-01T00:00:00+02:00');
});
