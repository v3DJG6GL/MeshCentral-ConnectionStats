/**
* @description MeshCentral-ConnectionStats: CSV and JSON export formatting
* @license Apache-2.0
*
* Pure module. Data files carry ISO 8601 timestamps with the viewer's offset and durations as
* integer seconds, never "1h 12m". The first line of a CSV is a comment that records the filters,
* the time zone, the user and the plugin version, so a file found months later explains itself.
*/

"use strict";

const ag = require(__dirname + '/aggregate.js');

const SESSION_COLUMNS = ['start', 'end', 'duration_seconds', 'active_seconds', 'type', 'device', 'device_id', 'group', 'group_id', 'admin', 'admin_id', 'guest', 'bytes_in', 'bytes_out', 'remote_ip', 'ongoing', 'truncated', 'source'];
const BUCKET_COLUMNS = ['bucket_start', 'bucket_end', 'type', 'seconds'];

// RFC 4180: quote when needed, double the quotes, keep newlines inside quotes
function csvField(v) {
    if (v == null) return '';
    if (typeof v == 'boolean') return v ? 'true' : 'false';
    var s = String(v);
    if (/[",\r\n]/.test(s) || /^\s|\s$/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
}
function csvRow(fields) { return fields.map(csvField).join(',') + '\r\n'; }

// meta: { scope, start, end, bucket, tz, user, version, types, users, guests }
function headerLine(meta) {
    var parts = ['Connection Stats export'];
    parts.push('scope=' + (meta.scope || 'all'));
    parts.push('range=' + ag.isoLocal(meta.start, meta.tz) + '..' + ag.isoLocal(meta.end, meta.tz));
    if (meta.bucket) parts.push('bucket=' + meta.bucket);
    parts.push('tz=' + meta.tz);
    if (meta.types) parts.push('types=' + meta.types.join('|'));
    if (meta.users) parts.push('admins=' + meta.users.join('|'));
    parts.push('guests=' + (meta.guests ? 'included' : 'excluded'));
    parts.push('user=' + (meta.user || ''));
    parts.push('generated=' + ag.isoLocal(meta.now || Date.now(), meta.tz));
    parts.push('plugin=' + (meta.version || ''));
    return '# ' + parts.join(', ') + '\r\n';
}

function sessionRecord(d, tz, now) {
    var end = (d.end == null) ? (now || Date.now()) : d.end;
    return {
        start: ag.isoLocal(d.start, tz),
        end: (d.end == null) ? null : ag.isoLocal(d.end, tz),
        duration_seconds: (d.end == null) ? Math.max(0, Math.round((end - d.start) / 1000)) : d.seconds,
        active_seconds: (d.active == null) ? null : d.active,
        type: d.type, device: d.nodename || d.nodeid, device_id: d.nodeid, group: d.meshname || null, group_id: d.meshid || null,
        admin: d.username || d.userid, admin_id: d.userid, guest: d.guest || null,
        bytes_in: d.bytesin, bytes_out: d.bytesout, remote_ip: d.ip || null,
        ongoing: (d.end == null), truncated: !!d.truncated, source: d.source || 'live'
    };
}
function sessionCsvRow(d, tz, now) { var r = sessionRecord(d, tz, now); return csvRow(SESSION_COLUMNS.map(function (c) { return r[c]; })); }

function bucketRecords(agg, tz) {
    var out = [];
    (agg.buckets || []).forEach(function (b) {
        var types = Object.keys(b.by).sort();
        types.forEach(function (t) { out.push({ bucket_start: ag.isoLocal(b.s, tz), bucket_end: ag.isoLocal(b.e, tz), type: t, seconds: b.by[t] }); });
        out.push({ bucket_start: ag.isoLocal(b.s, tz), bucket_end: ag.isoLocal(b.e, tz), type: 'total', seconds: b.tot });
    });
    return out;
}

// meshcentral-connectionstats_<scope>_<from>_<to>_<bucket>.<ext>
function fileName(meta, what, ext) {
    var day = function (ms) { var p = ag.partsIn(ms, meta.tz); var pad = function (n) { return (n < 10 ? '0' : '') + n; }; return p.y + '-' + pad(p.m + 1) + '-' + pad(p.d); };
    var scope = String(meta.scopeName || meta.scope || 'all').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').substring(0, 40) || 'all';
    return 'meshcentral-connectionstats_' + scope + '_' + day(meta.start) + '_' + day(meta.end - 1) + (what == 'buckets' ? '_' + meta.bucket : '_sessions') + '.' + ext;
}

module.exports = { csvField: csvField, csvRow: csvRow, headerLine: headerLine, sessionRecord: sessionRecord, sessionCsvRow: sessionCsvRow, bucketRecords: bucketRecords, fileName: fileName, SESSION_COLUMNS: SESSION_COLUMNS, BUCKET_COLUMNS: BUCKET_COLUMNS };
