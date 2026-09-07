/**
* @description MeshCentral-ConnectionStats: time-zone aware bucketing and totals
* @license Apache-2.0
*
* Pure module. Sessions are stored as UTC epochs; everything here converts to the viewer's time
* zone with Intl so a bucket is a real local day or month (23 or 25 hours on a DST change), and a
* session that crosses a bucket edge gives each side its share.
*/

"use strict";

const BUCKETS = ['hour', 'day', 'week', 'month'];
const DAY = 86400000;

// ---- time zone helpers -----------------------------------------------------
var fmtCache = {};
function formatter(tz) {
    var f = fmtCache[tz];
    if (f == null) {
        try {
            f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' });
        } catch (e) {
            f = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' });
        }
        fmtCache[tz] = f;
    }
    return f;
}
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// local wall-clock parts of an instant: { y, m (0-11), d, h, mi, s, wd (0 = Sunday) }
function partsIn(ms, tz) {
    var out = {};
    formatter(tz).formatToParts(new Date(ms)).forEach(function (p) {
        if (p.type == 'year') out.y = Number(p.value);
        else if (p.type == 'month') out.m = Number(p.value) - 1;
        else if (p.type == 'day') out.d = Number(p.value);
        else if (p.type == 'hour') out.h = Number(p.value) % 24;
        else if (p.type == 'minute') out.mi = Number(p.value);
        else if (p.type == 'second') out.s = Number(p.value);
        else if (p.type == 'weekday') out.wd = WD[p.value];
    });
    return out;
}

// instant for a local wall-clock time; overflowing fields (d = 32, h = 25) roll over like Date.UTC
function fromLocal(y, m, d, h, mi, tz) {
    var want = Date.UTC(y, m, d, h || 0, mi || 0);
    var guess = want;
    for (var i = 0; i < 3; i++) {
        var p = partsIn(guess, tz);
        var asUtc = Date.UTC(p.y, p.m, p.d, p.h, p.mi);
        var diff = want - asUtc;
        if (diff == 0) break;
        guess += diff;
    }
    return guess;
}

// UTC offset of an instant in minutes (east positive), for ISO 8601 output
function offsetMinutes(ms, tz) {
    var p = partsIn(ms, tz);
    return Math.round((Date.UTC(p.y, p.m, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000) / 60000);
}

function isoLocal(ms, tz) {
    var p = partsIn(ms, tz), off = offsetMinutes(ms, tz);
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    var sign = off < 0 ? '-' : '+'; off = Math.abs(off);
    return p.y + '-' + pad(p.m + 1) + '-' + pad(p.d) + 'T' + pad(p.h) + ':' + pad(p.mi) + ':' + pad(p.s) + sign + pad(Math.floor(off / 60)) + ':' + pad(off % 60);
}

// ---- buckets ---------------------------------------------------------------
function floorTo(ms, bucket, tz) {
    var p = partsIn(ms, tz);
    if (bucket == 'hour') return fromLocal(p.y, p.m, p.d, p.h, 0, tz);
    if (bucket == 'day') return fromLocal(p.y, p.m, p.d, 0, 0, tz);
    if (bucket == 'week') return fromLocal(p.y, p.m, p.d - ((p.wd + 6) % 7), 0, 0, tz);   // Monday
    return fromLocal(p.y, p.m, 1, 0, 0, tz);
}
function nextEdge(ms, bucket, tz) {
    if (bucket == 'hour') return ms + 3600000;   // by instant: the repeated 02:00 of a fall-back day is its own bucket
    var p = partsIn(ms, tz);
    if (bucket == 'day') return fromLocal(p.y, p.m, p.d + 1, 0, 0, tz);
    if (bucket == 'week') return fromLocal(p.y, p.m, p.d + 7, 0, 0, tz);
    return fromLocal(p.y, p.m + 1, 1, 0, 0, tz);
}

// [{ s, e }] local-aligned buckets covering [start, end)
function bucketEdges(start, end, bucket, tz) {
    if (BUCKETS.indexOf(bucket) < 0) bucket = 'day';
    var out = [], t = floorTo(start, bucket, tz), guard = 0;
    while (t < end && guard++ < 20000) {
        var n = nextEdge(t, bucket, tz);
        if (n <= t) n = t + 3600000;   // never loop on a broken zone
        out.push({ s: t, e: n });
        t = n;
    }
    return out;
}

function autoBucket(start, end) {
    var days = (end - start) / DAY;
    if (days <= 2) return 'hour';
    if (days <= 31) return 'day';
    if (days <= 182) return 'week';
    return 'month';
}

// the period of equal length before the range; month buckets compare with the same months a year earlier
function previousRange(start, end, bucket, tz) {
    if (bucket == 'month') {
        var a = partsIn(start, tz), b = partsIn(end, tz);
        return { start: fromLocal(a.y - 1, a.m, a.d, a.h, a.mi, tz), end: fromLocal(b.y - 1, b.m, b.d, b.h, b.mi, tz) };
    }
    var len = end - start;
    return { start: start - len, end: end - len };
}

// weekday (0 = Sunday) and hour of a session's start inside the range, the punchcard's rule
function startCell(session, start, tz) {
    var p = partsIn(Math.max(session.start, start), tz);
    return { wd: p.wd, h: p.h };
}

// ---- aggregation -----------------------------------------------------------
// sessions: stored documents. opts: { start, end, bucket, tz, now }
function aggregate(sessions, opts) {
    var start = opts.start, end = opts.end, tz = opts.tz || 'UTC', now = opts.now || Date.now();
    var bucket = (BUCKETS.indexOf(opts.bucket) >= 0) ? opts.bucket : autoBucket(start, end);
    var buckets = bucketEdges(start, end, bucket, tz).map(function (b) { return { s: b.s, e: b.e, by: {}, tot: 0 }; });
    // per-day totals feed the calendar view when the main buckets are coarser than a day
    var daily = (bucket == 'week' || bucket == 'month') ? bucketEdges(start, end, 'day', tz).map(function (b) { return { s: b.s, e: b.e, tot: 0 }; }) : null;
    var byType = {}, byProtocol = {}, byDevice = {}, byGroup = {}, pc = [], durs = [], devices = {}, users = {};
    var total = 0, active = 0, seen = 0, count = 0, longest = 0, ongoing = 0;
    // punchcard: weekday x hour of (clipped) start, each cell split by type so the page can colour it
    for (var i = 0; i < 7; i++) { pc.push([]); for (var j = 0; j < 24; j++) pc[i].push({ tot: 0, by: {} }); }
    var bi = 0;
    (sessions || []).forEach(function (s) {
        var e = (s.end == null) ? now : s.end;
        var cs = Math.max(s.start, start), ce = Math.min(e, end);
        if (!(ce > cs)) return;
        var sec = (ce - cs) / 1000;
        total += sec; count++; durs.push(sec);
        if (sec > longest) longest = sec;
        if (s.end == null) ongoing++;
        if (s.nodeid) devices[s.nodeid] = 1;
        if (s.userid) users[s.userid] = 1;
        byType[s.type] = (byType[s.type] || 0) + sec;
        var pk = s.type + ':' + ((s.protocol == null) ? 0 : s.protocol);
        byProtocol[pk] = (byProtocol[pk] || 0) + sec;
        var dk = s.nodeid || '?';
        if (byDevice[dk] == null) byDevice[dk] = { id: dk, name: s.nodename || dk, meshid: s.meshid || null, seconds: 0, by: {}, sessions: 0 };
        byDevice[dk].seconds += sec; byDevice[dk].by[s.type] = (byDevice[dk].by[s.type] || 0) + sec; byDevice[dk].sessions++;
        var gk = s.meshid || '?';
        if (byGroup[gk] == null) byGroup[gk] = { id: gk, name: s.meshname || (s.meshid ? s.meshid : 'No group'), seconds: 0, by: {}, sessions: 0 };
        byGroup[gk].seconds += sec; byGroup[gk].by[s.type] = (byGroup[gk].by[s.type] || 0) + sec; byGroup[gk].sessions++;
        if (s.active != null) {
            var full = (e - s.start) / 1000;
            active += (full > 0) ? s.active * (sec / full) : 0;
            seen += sec;
        }
        // buckets are sorted and sessions are not, so walk from the first overlapping one each time
        for (var k = 0; k < buckets.length; k++) {
            var b = buckets[k];
            if (b.e <= cs) continue;
            if (b.s >= ce) break;
            var v = (Math.min(ce, b.e) - Math.max(cs, b.s)) / 1000;
            b.by[s.type] = (b.by[s.type] || 0) + v; b.tot += v;
        }
        if (daily != null) {
            for (var q = 0; q < daily.length; q++) {
                var db = daily[q];
                if (db.e <= cs) continue;
                if (db.s >= ce) break;
                db.tot += (Math.min(ce, db.e) - Math.max(cs, db.s)) / 1000;
            }
        }
        var p = partsIn(cs, tz), cell = pc[p.wd][p.h];
        cell.tot += sec; cell.by[s.type] = (cell.by[s.type] || 0) + sec;
    });
    pc.forEach(function (row) { row.forEach(function (c) { c.tot = Math.round(c.tot); for (var t in c.by) c.by[t] = Math.round(c.by[t]); }); });
    if (daily != null) daily.forEach(function (d) { d.tot = Math.round(d.tot); });
    durs.sort(function (a, b) { return a - b; });
    var median = durs.length ? durs[Math.floor(durs.length / 2)] : 0;
    var round = function (n) { return Math.round(n); };
    var top = function (m) {
        return Object.keys(m).map(function (k) { var v = m[k]; v.seconds = round(v.seconds); for (var t in v.by) v.by[t] = round(v.by[t]); return v; })
        .sort(function (a, b) { return b.seconds - a.seconds; }).slice(0, 50);
    };
    buckets.forEach(function (b) { b.tot = round(b.tot); for (var t in b.by) b.by[t] = round(b.by[t]); });
    for (var t in byType) byType[t] = round(byType[t]);
    for (var pt in byProtocol) byProtocol[pt] = round(byProtocol[pt]);
    return {
        bucket: bucket, tz: tz, start: start, end: end,
        buckets: buckets, daily: daily, byType: byType, byProtocol: byProtocol, byDevice: top(byDevice), byGroup: top(byGroup), punchcard: pc,
        totals: {
            seconds: round(total), active: round(active), seenSeconds: round(seen), count: count, ongoing: ongoing,
            median: round(median), longest: round(longest), devices: Object.keys(devices).length, users: Object.keys(users).length
        }
    };
}

module.exports = { aggregate: aggregate, startCell: startCell, bucketEdges: bucketEdges, autoBucket: autoBucket, previousRange: previousRange, partsIn: partsIn, fromLocal: fromLocal, isoLocal: isoLocal, offsetMinutes: offsetMinutes, BUCKETS: BUCKETS };
