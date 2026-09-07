/**
* @description MeshCentral-ConnectionStats: one-time import of past sessions from MeshCentral's events
* @license Apache-2.0
*
* MeshCentral keeps every relay start and end in its events collection, but only for 20 days by
* default. On first install (and on request) the plugin walks those events back in 7-day windows
* and pairs them with the same code the live capture uses, so a fresh install shows history right
* away. Events that are already in the store are skipped, so running it twice is harmless.
*/

"use strict";

const WINDOW_MS = 7 * 86400000;
const MAX_DAYS = 400;
const EMPTY_WINDOWS_TO_STOP = 4;

// ctx: { meshServer, db, events, resolveNames(nodeid, cb), log }. opts: { days }
// Returns the status object, which is updated in place while the import runs.
function run(ctx, opts) {
    var st = { running: true, startedAt: Date.now(), finishedAt: null, scanned: 0, found: 0, imported: 0, skipped: 0, windowFrom: null, error: null };
    var msgids = ctx.events.START_MSGIDS.concat(ctx.events.END_MSGIDS);
    var days = Math.min(MAX_DAYS, Math.max(1, Number(opts && opts.days) || 90));
    var domains = Object.keys((ctx.meshServer.config && ctx.meshServer.config.domains) || { '': {} });
    var now = Date.now(), floor = now - days * 86400000;
    var all = [];

    function readWindow(domain, start, end) {
        return new Promise(function (resolve) {
            try {
                ctx.meshServer.db.GetEventsTimeRange(['*'], domain, msgids, new Date(start), new Date(end), function (err, docs) {
                    if (err || !Array.isArray(docs)) { resolve([]); return; }
                    // SQL backends ignore the msgid filter, so filter here as well
                    resolve(docs.filter(function (e) { return e && e.etype == 'relay' && e.action == 'relaylog' && msgids.indexOf(Number(e.msgid)) >= 0; }));
                });
            } catch (e) { resolve([]); }
        });
    }

    function walkDomain(domain) {
        var end = now, empty = 0;
        var step = function () {
            if (end <= floor || empty >= EMPTY_WINDOWS_TO_STOP) return Promise.resolve();
            var start = Math.max(floor, end - WINDOW_MS);
            st.windowFrom = start;
            return readWindow(domain, start, end).then(function (docs) {
                st.scanned += docs.length;
                if (docs.length == 0) empty++; else empty = 0;
                docs.forEach(function (d) { all.push(d); });
                end = start;
                return step();
            });
        };
        return step();
    }

    function importAll() {
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
                    if (existing != null) { st.skipped++; return null; }
                    doc.source = 'backfill';
                    return new Promise(function (resolve) {
                        ctx.resolveNames(doc.nodeid, function (names) {
                            doc.meshid = names.meshid; doc.nodename = names.nodename; doc.meshname = names.meshname;
                            ctx.db.upsertSession(doc).then(function () { st.imported++; resolve(); }, function () { resolve(); });
                        });
                    });
                });
            });
        });
        return work;
    }

    st.promise = domains.reduce(function (p, d) { return p.then(function () { return walkDomain(d); }); }, Promise.resolve())
    .then(importAll)
    .then(function () { st.running = false; st.finishedAt = Date.now(); ctx.log('backfill: scanned ' + st.scanned + ' events, ' + st.found + ' sessions, imported ' + st.imported + ', skipped ' + st.skipped); return st; })
    .catch(function (e) { st.running = false; st.finishedAt = Date.now(); st.error = (e && e.message) || String(e); ctx.log('backfill error: ' + st.error); return st; });
    return st;
}

module.exports = { run: run, WINDOW_MS: WINDOW_MS };
