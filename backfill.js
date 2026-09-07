/**
* @description MeshCentral-ConnectionStats: one-time import of past sessions from MeshCentral's events
* @license Apache-2.0
*
* MeshCentral retains relay events according to its database expiration settings. On first
* install (and on request) the plugin reads all retained events or a requested day range
* and pairs them with the same code the live capture uses, so a fresh install shows history right
* away. Events that are already in the store are skipped, so running it twice is harmless.
*/

"use strict";

const WINDOW_MS = 7 * 86400000;
const MAX_DAYS = 36500;

// Pair raw relay events (any order) and store every closed session the store does not have yet.
// Updates st.found / st.imported / st.skipped. Backup records also fill missing names
// on existing sessions (st.updated), preserving their timing and activity data.
function importEvents(ctx, all, st, source, records) {
    all.sort(function (a, b) { return (+new Date(a.time)) - (+new Date(b.time)); });
    var pairer = new ctx.events.Pairer(), closed = [];
    all.forEach(function (ev) {
        var c = ctx.events.classify(ev);
        if (c == null) return;
        if (c.kind == 'start') pairer.onStart(c);
        else { var d = pairer.onEnd(c); if (d != null) closed.push(d); }
    });
    st.found = closed.length;
    var work = Promise.resolve();
    closed.forEach(function (doc) {
        work = work.then(function () {
            return ctx.db.getSession(doc._id).then(function (existing) {
                if (existing != null) {
                    st.skipped++;
                    if (!records || existing.nodeid != doc.nodeid) return null;
                    doc = Object.assign({}, existing);
                }
                if (!existing) doc.source = source;
                return new Promise(function (resolve) {
                    ctx.resolveNames(doc.nodeid, function (names) {
                        var node = records && records[doc.nodeid];
                        var meshid = doc.meshid || names.meshid || (node && node.meshid) || null;
                        var mesh = records && records[meshid];
                        doc.nodename = doc.nodename || names.nodename || (node && node.name) || null;
                        doc.meshname = doc.meshname || (meshid == names.meshid && names.meshname) || (mesh && mesh.name) || null;
                        doc.meshid = meshid;
                        if (existing && doc.nodename == existing.nodename && doc.meshname == existing.meshname && doc.meshid == existing.meshid) { resolve(); return; }
                        ctx.db.upsertSession(doc).then(function () { if (!existing) st.imported++; else st.updated = (st.updated || 0) + 1; resolve(); }, function () { resolve(); });
                    });
                });
            });
        });
    });
    return work;
}

// Import from a backup file (zip, NeDB events file, database dump; see restore.js). Same
// status shape as run(); `label` names the source for the status page.
function runFile(ctx, file, opts) {
    var st = { running: true, source: 'backup', label: (opts && opts.label) || file, file: null, files: 0, startedAt: Date.now(), finishedAt: null, scanned: 0, relay: 0, found: 0, imported: 0, skipped: 0, error: null };
    var msgids = ctx.events.START_MSGIDS.concat(ctx.events.END_MSGIDS);
    var all = [], records = Object.create(null);
    st.promise = require(__dirname + '/restore.js').readFile(file, msgids, function (ev) { all.push(ev); st.relay++; }, st, function (d) {
        if (d && (d.type == 'node' || d.type == 'mesh') && typeof d._id == 'string' && d._id.indexOf(d.type + '/') == 0) {
            records[d._id] = { name: typeof d.name == 'string' ? d.name : null, meshid: typeof d.meshid == 'string' ? d.meshid : null };
        }
    })
    .then(function () { st.phase = 'importing'; return importEvents(ctx, all, st, 'backup', records); })
    .then(function () { st.running = false; st.finishedAt = Date.now(); ctx.log('backup import ' + st.label + ': read ' + st.scanned + ' records, ' + st.relay + ' relay events, ' + st.found + ' sessions, imported ' + st.imported + ', skipped ' + st.skipped); return st; })
    .catch(function (e) { st.running = false; st.finishedAt = Date.now(); st.error = (e && e.message) || String(e); ctx.log('backup import error: ' + st.error); return st; })
    .finally(function () { if (opts && opts.cleanup) { try { require('fs').unlinkSync(file); } catch (e) { } } });
    return st;
}

// ctx: { meshServer, db, events, resolveNames(nodeid, cb), log }. opts: { days }
// Returns the status object, which is updated in place while the import runs.
function run(ctx, opts) {
    var st = { running: true, startedAt: Date.now(), finishedAt: null, scanned: 0, found: 0, imported: 0, skipped: 0, windowFrom: null, error: null };
    var msgids = ctx.events.START_MSGIDS.concat(ctx.events.END_MSGIDS);
    var days = Math.min(MAX_DAYS, Math.max(0, Math.floor(Number(opts && opts.days) || 0)));
    var domains = Object.keys((ctx.meshServer.config && ctx.meshServer.config.domains) || { '': {} });
    var now = Date.now(), floor = now - days * 86400000;
    var all = [];

    function readWindow(domain, start, end) {
        return new Promise(function (resolve, reject) {
            try {
                ctx.meshServer.db.GetEventsTimeRange(['*'], domain, msgids, new Date(start), new Date(end - 1), function (err, docs) {
                    if (err || !Array.isArray(docs)) { reject(err || new Error('Invalid event query response')); return; }
                    // SQL backends ignore the msgid filter, so filter here as well
                    resolve(docs.filter(function (e) { return e && e.etype == 'relay' && e.action == 'relaylog' && msgids.indexOf(Number(e.msgid)) >= 0; }).map(function (e) { return Object.assign({}, e, { domain: domain }); }));
                });
            } catch (e) { reject(e); }
        });
    }

    function walkDomain(domain) {
        var end = now;
        var step = function () {
            if (end <= floor) return Promise.resolve();
            var start = Math.max(floor, end - WINDOW_MS);
            st.windowFrom = start;
            return readWindow(domain, start, end).then(function (docs) {
                st.scanned += docs.length;
                docs.forEach(function (d) { all.push(d); });
                end = start;
                return step();
            });
        };
        return step();
    }

    function importAll() { return importEvents(ctx, all, st, 'backfill'); }

    function readAll() {
        st.phase = 'reading all retained events';
        return new Promise(function (resolve, reject) {
            try {
                ctx.meshServer.db.GetAllEvents(function (err, docs) {
                    if (err || !Array.isArray(docs)) { reject(err || new Error('Invalid event query response')); return; }
                    st.scanned = docs.length;
                    all = docs.filter(function (e) { return e && e.etype == 'relay' && e.action == 'relaylog' && msgids.indexOf(Number(e.msgid)) >= 0; });
                    resolve();
                });
            } catch (e) { reject(e); }
        });
    }

    st.promise = days == 0 ? readAll() : domains.reduce(function (p, d) { return p.then(function () { return walkDomain(d); }); }, Promise.resolve());
    st.promise = st.promise.then(function () { st.phase = 'importing'; return importAll(); })
    .then(function () { st.running = false; st.finishedAt = Date.now(); ctx.log('backfill: scanned ' + st.scanned + ' events, ' + st.found + ' sessions, imported ' + st.imported + ', skipped ' + st.skipped); return st; })
    .catch(function (e) { st.running = false; st.finishedAt = Date.now(); st.error = (e && e.message) || String(e); ctx.log('backfill error: ' + st.error); return st; });
    return st;
}

module.exports = { run: run, runFile: runFile, importEvents: importEvents, WINDOW_MS: WINDOW_MS };
