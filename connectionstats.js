/**
* @description MeshCentral Connection Stats plugin
* @license Apache-2.0
*
* Records how long each admin was remote-connected to each device, by connection type, and shows
* it per device, per device group and server-wide, with export. Sessions are captured from the
* server event bus (every relay start/end is dispatched there) and kept in the plugin's own store,
* because MeshCentral's own events can expire according to its retention settings.
*/

"use strict";

module.exports.connectionstats = function (parent) {
    var obj = {};
    obj.parent = parent;                 // pluginHandler
    obj.meshServer = parent.parent;      // meshcentral
    obj.db = null;                       // plugin store, see db.js
    obj.settings = null;
    obj.pairer = null;
    obj.events = require(__dirname + '/events.js');
    obj.aggregate = require(__dirname + '/aggregate.js');
    obj.activity = require(__dirname + '/activity.js');
    obj.exporter = require(__dirname + '/export.js');
    obj.backfill = require(__dirname + '/backfill.js');
    obj.backfillStatus = null;
    obj.tracker = new obj.activity.Tracker(300);
    obj.perms = new (require(__dirname + '/permissions.js').Permissions)(obj.meshServer);

    var PLUGIN_VERSION = (function () { try { return require(__dirname + '/config.json').version; } catch (e) { return '0.0.0'; } })();

    // ------------------------------------------------------------------
    //  Client side. Every function listed here is serialised with
    //  .toString() and runs in the browser. They must be self-contained and
    //  reach each other only through pluginHandler.connectionstats.<name>.
    // ------------------------------------------------------------------
    obj.exports = [
        'onWebUIStartupEnd',
        'onDeviceRefreshEnd',
        'csNight',
        'csTabUrl',
        'csEnsureTab',
        'csOnMessage',
        'csActivityInit',
        'csKindOf',
        'csBeat',
        'csObserve'
    ];

    // Runs once when the web UI has loaded: keep embedded pages in step with night mode and
    // listen for their size reports.
    obj.onWebUIStartupEnd = function () {
        try {
            if (window.__csStarted) return; window.__csStarted = true;
            window.addEventListener('message', function (ev) { pluginHandler.connectionstats.csOnMessage(ev); });
            var mo = new MutationObserver(function () {
                var f = document.getElementById('csDeviceFrame');
                if (f && f.contentWindow) { try { f.contentWindow.postMessage({ cs: 'night', night: pluginHandler.connectionstats.csNight() }, '*'); } catch (e) { } }
            });
            mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
            pluginHandler.connectionstats.csActivityInit();
        } catch (e) { }
    };

    // ---- active time: input in the Desktop, Terminal and Files views becomes heartbeats ----
    // Which view an input event belongs to, by the element it landed on. Null for anything else.
    obj.csKindOf = function (el) {
        try {
            while (el != null && el.nodeType == 1) {
                var id = el.id || '';
                if (id == 'Desk' || id == 'DeskParent' || id == 'deskarea3x') return 'desktop';
                if (id == 'termTable' || id == 'termarea3xdiv' || id == 'termarea3x' || (el.classList && el.classList.contains('xterm'))) return 'terminal';
                if (id == 'p13filetable' || id == 'p13' || id == 'p5filetable') return 'files';
                el = el.parentNode;
            }
        } catch (e) { }
        return null;
    };

    // Only "still active" leaves the browser: the node and the kind of view, never the input.
    obj.csBeat = function (kind) {
        try {
            if (typeof currentNode == 'undefined' || currentNode == null || typeof meshserver == 'undefined') return;
            var st = window.__csAct; if (st == null) st = window.__csAct = { last: {}, seen: {} };
            var now = Date.now(), key = currentNode._id + '|' + kind;
            if (st.last[key] != null && now - st.last[key] < 30000) return;
            st.last[key] = now; st.seen[key] = now;
            meshserver.send({ action: 'plugin', plugin: 'connectionstats', pluginaction: 'beat', nodeid: currentNode._id, kind: kind });
        } catch (e) { }
    };

    // A connected view with no input yet is "observed": its session gets 0 active seconds instead
    // of "no data". Polled, because the UI has no hook for the terminal or files connecting.
    obj.csObserve = function () {
        try {
            if (typeof currentNode == 'undefined' || currentNode == null || typeof meshserver == 'undefined') return;
            var st = window.__csAct; if (st == null) st = window.__csAct = { last: {}, seen: {} };
            var kinds = [];
            if (typeof desktop != 'undefined' && desktop != null && desktop.State == 3) kinds.push('desktop');
            if (typeof terminal != 'undefined' && terminal != null && terminal.State == 3) kinds.push('terminal');
            if (typeof files != 'undefined' && files != null && files.State == 3) kinds.push('files');
            kinds.forEach(function (kind) {
                var key = currentNode._id + '|' + kind;
                if (st.seen[key] != null && Date.now() - st.seen[key] < 120000) return;
                st.seen[key] = Date.now();
                meshserver.send({ action: 'plugin', plugin: 'connectionstats', pluginaction: 'observe', nodeid: currentNode._id, kind: kind });
            });
        } catch (e) { }
    };

    obj.csActivityInit = function () {
        try {
            if (window.__csActInit) return; window.__csActInit = true;
            var handler = function (ev) { var k = pluginHandler.connectionstats.csKindOf(ev.target); if (k != null) pluginHandler.connectionstats.csBeat(k); };
            ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'].forEach(function (n) { document.addEventListener(n, handler, { capture: true, passive: true }); });
            setInterval(function () { pluginHandler.connectionstats.csObserve(); }, 5000);
        } catch (e) { }
    };

    obj.csNight = function () { return document.body.classList.contains('night'); };

    obj.csTabUrl = function (nodeid) {
        var base = (typeof domainUrl == 'string') ? domainUrl : '/';
        return base + 'pluginadmin.ashx?pin=connectionstats&view=device&nodeid=' + encodeURIComponent(nodeid) + '&night=' + (pluginHandler.connectionstats.csNight() ? '1' : '0');
    };

    // The embedded page reports its height so the tab never shows a scrollbar inside a scrollbar.
    obj.csOnMessage = function (ev) {
        var d = ev.data;
        if (d == null || d.cs != 'height') return;
        var f = document.getElementById('csDeviceFrame');
        if (f && f.contentWindow === ev.source) f.style.height = Math.max(300, Math.min(6000, Number(d.h))) + 'px';
    };

    // MeshCentral wipes the plugin tab area before every device refresh, so the tab is registered
    // each time; the iframe is only recreated when the device changes, not on every refresh.
    obj.csEnsureTab = function (nodeid) {
        var host = document.getElementById('pluginConnectionStats');
        if (host == null) return;
        var f = document.getElementById('csDeviceFrame');
        if (f != null && f.getAttribute('data-nodeid') == nodeid) return;
        host.innerHTML = '<iframe id="csDeviceFrame" data-nodeid="' + nodeid.replace(/"/g, '') + '" src="' + pluginHandler.connectionstats.csTabUrl(nodeid) + '" style="width:100%;height:900px;border:0;background:transparent" title="Connection Stats"></iframe>';
    };

    obj.onDeviceRefreshEnd = function (nodeid, panel, refresh, event) {
        try {
            if (typeof currentNode == 'undefined' || currentNode == null) return;
            pluginHandler.registerPluginTab({ tabId: 'pluginConnectionStats', tabTitle: 'Connection Stats' });
            pluginHandler.connectionstats.csEnsureTab(currentNode._id);
        } catch (e) { }
    };

    // ------------------------------------------------------------------
    //  Settings
    // ------------------------------------------------------------------
    obj.defaultSettings = function () {
        return {
            retentionDays: 0,
            minSeconds: 0,
            recordTypes: obj.events.TYPES.slice(),
            activity: { enabled: true, idleMinutes: 5, beatSeconds: 30 },
            tz: ''
        };
    };

    obj.sanitizeSettings = function (input) {
        var d = obj.defaultSettings();
        if (input == null || typeof input != 'object') return d;
        var num = function (v, dflt, min, max) { var n = Number(v); if (!isFinite(n)) return dflt; return Math.min(Math.max(n, min), max); };
        d.retentionDays = Math.round(num(input.retentionDays, d.retentionDays, 0, 3650));
        d.minSeconds = Math.round(num(input.minSeconds, d.minSeconds, 0, 3600));
        if (Array.isArray(input.recordTypes)) {
            var rt = input.recordTypes.filter(function (t) { return obj.events.TYPES.indexOf(t) >= 0; });
            d.recordTypes = rt;
        }
        if (input.activity != null && typeof input.activity == 'object') {
            d.activity.enabled = (input.activity.enabled !== false);
            d.activity.idleMinutes = num(input.activity.idleMinutes, d.activity.idleMinutes, 1, 120);
            d.activity.beatSeconds = Math.round(num(input.activity.beatSeconds, d.activity.beatSeconds, 10, 300));
        }
        if (typeof input.tz == 'string' && input.tz.length < 64) d.tz = input.tz;
        return d;
    };

    obj.loadSettings = function () {
        return obj.db.getSetting('settings').then(function (s) {
            obj.settings = obj.sanitizeSettings(s);
            obj.db.setRetentionDays(obj.settings.retentionDays);
            obj.tracker.idleSeconds = obj.settings.activity.idleMinutes * 60;
            return obj.settings;
        }).catch(function (e) {
            console.log('CONNSTATS: could not read settings: ' + (e.message || e));
            obj.settings = obj.defaultSettings();
            return obj.settings;
        });
    };

    obj.saveSettings = function (input) {
        obj.settings = obj.sanitizeSettings(input);
        obj.db.setRetentionDays(obj.settings.retentionDays);
        obj.tracker.idleSeconds = obj.settings.activity.idleMinutes * 60;
        return obj.db.setSetting('settings', obj.settings).then(function () { return obj.settings; });
    };

    // ------------------------------------------------------------------
    //  Startup
    // ------------------------------------------------------------------
    obj.server_startup = function () {
        obj.meshServer.pluginHandler.connectionstats_db = require(__dirname + '/db.js').CreateDB(obj.meshServer);
        obj.db = obj.meshServer.pluginHandler.connectionstats_db;
        obj.pairer = new obj.events.Pairer();

        // A reload (plugin install, upgrade) calls server_startup again on a new object; the old
        // one must stop receiving events or every session would be recorded twice.
        try {
            var prevSub = obj.meshServer.pluginHandler.connectionstats_sub;
            if (prevSub != null) obj.meshServer.RemoveEventDispatch(['*'], prevSub);
        } catch (e) { }
        obj.meshServer.pluginHandler.connectionstats_sub = obj;
        obj.meshServer.AddEventDispatch(['*'], obj);

        // exposed as obj.ready so tests and other code can wait for the store and settings
        obj.ready = obj.loadSettings().then(function () { return obj.retypeOnce(); }).then(function () { return obj.restoreOpenSessions(); }).then(function () { return obj.maybeAutoBackfill(); }).catch(function (e) {
            console.log('CONNSTATS: startup error: ' + (e.message || e));
        });
        return obj.ready;
        // heartbeats reach the store once a minute, so a crash loses at most a minute of active time
        if (obj.meshServer.pluginHandler.connectionstats_flush != null) { try { clearInterval(obj.meshServer.pluginHandler.connectionstats_flush); } catch (e) { } }
        var flush = setInterval(function () { obj.flushActivity(); }, 60000);
        try { flush.unref(); } catch (e) { }
        obj.meshServer.pluginHandler.connectionstats_flush = flush;
        console.log('CONNSTATS: plugin ' + PLUGIN_VERSION + ' started');
    };

    // 0.2.2 split "Other" into port tunnels (no protocol) and plugin tunnels (protocol 7). Records
    // written before that are re-typed once, and the two new types start out recorded when
    // "Other" was.
    obj.retypeOnce = function () {
        return obj.db.getSetting('retype_v3').then(function (done) {
            if (done != null) return null;
            var work = Promise.resolve();
            if (obj.settings.recordTypes.indexOf('other') >= 0) {
                var rt = obj.settings.recordTypes.slice();
                ['tunnel', 'plugin', 'registry'].forEach(function (t) { if (rt.indexOf(t) < 0) rt.push(t); });
                work = obj.saveSettings(Object.assign({}, obj.settings, { recordTypes: rt }));
            }
            // collect first, update after: an updated row leaves the "other" filter and would shift the paging
            var todo = [], page = 500, domains = Object.keys((obj.meshServer.config && obj.meshServer.config.domains) || { '': {} });
            var collect = function (domain, skip) {
                return obj.db.listSessions({ domain: domain, start: 0, end: Date.now() + 366 * 86400000, types: ['other'], includeGuests: true }, { skip: skip, limit: page }).then(function (l) {
                    l.rows.forEach(function (d) {
                        var t = obj.events.typeOf(d.protocol == null ? 0 : d.protocol);
                        if (t != 'other') todo.push({ id: d._id, type: t });
                    });
                    return (l.rows.length < page) ? null : collect(domain, skip + page);
                });
            };
            domains.forEach(function (dom) { work = work.then(function () { return collect(dom, 0); }); });
            var n = 0;
            return work.then(function () {
                var w = Promise.resolve();
                todo.forEach(function (x) { w = w.then(function () { n++; return obj.db.updateSession(x.id, { type: x.type }); }); });
                return w;
            }).then(function () {
                if (n) console.log('CONNSTATS: re-typed ' + n + ' "Other" sessions as tunnel, plugin or registry');
                obj.seq++;
                return obj.db.setSetting('retype_v3', { at: Date.now(), count: n });
            });
        }).catch(function (e) { console.log('CONNSTATS: retype error: ' + (e.message || e)); });
    };

    // Sessions that were open when the server last stopped can never receive their end event.
    // Close them at the last heartbeat (or their start) and flag them, so totals stay honest.
    obj.restoreOpenSessions = function () {
        return obj.db.getOpenSessions().then(function (docs) {
            var work = Promise.resolve(), closed = 0;
            (docs || []).forEach(function (d) {
                var end = (d.lastbeat != null) ? d.lastbeat : d.start;
                var patch = { end: end, seconds: Math.max(0, Math.round((end - d.start) / 1000)), truncated: true };
                closed++;
                work = work.then(function () { return obj.db.updateSession(d._id, patch); });
            });
            return work.then(function () { if (closed > 0) console.log('CONNSTATS: closed ' + closed + ' session(s) left open by the previous run'); });
        });
    };

    // ------------------------------------------------------------------
    //  Backfill from MeshCentral's own events (first start, or on request)
    // ------------------------------------------------------------------
    obj.startBackfill = function (days) {
        if (obj.backfillStatus != null && obj.backfillStatus.running) return obj.backfillStatus;
        obj.backfillStatus = obj.backfill.run({
            meshServer: obj.meshServer, db: obj.db, events: obj.events, resolveNames: obj.resolveNames,
            log: function (m) { console.log('CONNSTATS: ' + m); }
        }, { days: days == null ? 0 : days });
        obj.backfillStatus.promise.then(function (st) { if (st.error) return; obj.db.setSetting('backfill', { done: Date.now() }).catch(function () { }); });
        return obj.backfillStatus;
    };
    // A fresh install imports what MeshCentral still has (20 days by default) so the dashboard is
    // not empty on day one. Runs once; the settings page can run it again.
    obj.maybeAutoBackfill = function () {
        return obj.db.getSetting('backfill').then(function (b) {
            if (b != null && b.done != null) return null;
            return obj.db.listSessions({ domain: '', start: 0, end: Date.now() + 86400000, includeGuests: true }, { limit: 1 }).then(function (l) {
                if (l.total > 0) return obj.db.setSetting('backfill', { done: Date.now(), skipped: true });
                var t = setTimeout(function () { try { obj.startBackfill(); } catch (e) { } }, 15000);   // after the server has settled
                try { t.unref(); } catch (e) { }
                return null;
            });
        }).catch(function () { return null; });
    };
    obj.backfillInfo = function () {
        var st = obj.backfillStatus;
        if (st == null) return { running: false };
        return { running: st.running, startedAt: st.startedAt, finishedAt: st.finishedAt, scanned: st.scanned, found: st.found, imported: st.imported, skipped: st.skipped, windowFrom: st.windowFrom, error: st.error };
    };

    // ------------------------------------------------------------------
    //  Import from a backup: MeshCentral's backups keep the events it has already expired
    // ------------------------------------------------------------------
    obj.restoreStatus = null;
    var RESTORE_EXT = /\.(zip|db|db3|sqlite|archive|gz|sql|json|jsonl)$/i;
    obj.backupFolder = function () {
        var p = obj.meshServer.backuppath;
        if (typeof p != 'string' || p == '') return null;
        return require('path').resolve(p);
    };
    // Copies often share a new filesystem timestamp. Prefer the date embedded in
    // MeshCentral backup/dump names, including the older prefix without a dash.
    function backupTime(name) {
        var m = /(?:^|[^0-9])(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})(?:-(\d{2}))?(?=\.|$)/.exec(name);
        if (!m) return null;
        var y = +m[1], month = +m[2] - 1, day = +m[3], hour = +m[4], minute = +m[5], second = +(m[6] || 0);
        var d = new Date(y, month, day, hour, minute, second);
        if (d.getFullYear() != y || d.getMonth() != month || d.getDate() != day || d.getHours() != hour || d.getMinutes() != minute || d.getSeconds() != second) return null;
        return d.getTime();
    }
    // Files in MeshCentral's backup folder that the importer can read, newest first.
    obj.listBackups = function () {
        var dir = obj.backupFolder();
        return new Promise(function (resolve) {
            if (dir == null) { resolve({ folder: null, files: [] }); return; }
            var fs = require('fs');
            fs.readdir(dir, function (err, names) {
                if (err) { resolve({ folder: dir, files: [], error: (err.code == 'ENOENT') ? 'The backup folder does not exist yet.' : err.message }); return; }
                var files = [];
                names.forEach(function (n) {
                    if (!RESTORE_EXT.test(n)) return;
                    try { var stt = fs.statSync(require('path').join(dir, n)); if (stt.isFile()) files.push({ name: n, size: stt.size, mtime: stt.mtimeMs, backupTime: backupTime(n) }); } catch (e) { }
                });
                files.sort(function (a, b) { var at = a.backupTime == null ? a.mtime : a.backupTime, bt = b.backupTime == null ? b.mtime : b.backupTime; return bt - at || a.name.localeCompare(b.name); });
                resolve({ folder: dir, files: files });
            });
        });
    };
    obj.startRestore = function (file, label, cleanup) {
        if (obj.restoreStatus != null && obj.restoreStatus.running) return obj.restoreStatus;
        obj.restoreStatus = obj.backfill.runFile({
            meshServer: obj.meshServer, db: obj.db, events: obj.events, resolveNames: obj.resolveNames,
            log: function (m) { console.log('CONNSTATS: ' + m); }
        }, file, { label: label, cleanup: cleanup });
        return obj.restoreStatus;
    };
    obj.restoreInfo = function () {
        var st = obj.restoreStatus;
        if (st == null) return { running: false };
        return { running: st.running, label: st.label, file: st.file, files: st.files, phase: st.phase, startedAt: st.startedAt, finishedAt: st.finishedAt, scanned: st.scanned, relay: st.relay, found: st.found, imported: st.imported, skipped: st.skipped, updated: st.updated || 0, error: st.error };
    };
    // A file uploaded from the settings page, parsed with the multiparty module MeshCentral uses
    // for its own uploads, written to a temp file and removed after the import.
    obj.handleUpload = function (req, res) {
        var multiparty = null;
        try { multiparty = require('multiparty'); } catch (e) { try { multiparty = require.main.require('multiparty'); } catch (e2) { } }
        if (multiparty == null) { res.status(500).json({ ok: false, error: 'Uploads need the multiparty module, which MeshCentral normally ships' }); return; }
        if (obj.restoreStatus != null && obj.restoreStatus.running) { res.status(409).json({ ok: false, error: 'An import is already running' }); return; }
        var form = new multiparty.Form({ uploadDir: require('os').tmpdir(), maxFilesSize: 8 * 1024 * 1024 * 1024 });
        form.parse(req, function (err, fields, files) {
            if (err) { res.status(400).json({ ok: false, error: 'Upload failed: ' + err.message }); return; }
            var f = (files && files.file && files.file[0]) || null;
            if (f == null) { res.status(400).json({ ok: false, error: 'No file received' }); return; }
            obj.startRestore(f.path, f.originalFilename || 'uploaded file', true);
            res.json({ ok: true, restore: obj.restoreInfo() });
        });
    };

    // ------------------------------------------------------------------
    //  Capture: every event MeshCentral dispatches lands here
    // ------------------------------------------------------------------
    // bumps whenever a session is written, so the page can notice changes cheaply (api=seq)
    obj.seq = 0;
    function wrote(p) { return p.then(function (r) { obj.seq++; return r; }); }

    obj.HandleEvent = function (source, event, ids, id) {
        try {
            if (obj.db == null || obj.settings == null) return;
            var c = obj.events.classify(event);
            if (c == null) return;
            if (c.kind == 'start') {
                if (obj.settings.recordTypes.indexOf(c.type) < 0) return;
                var doc = obj.pairer.onStart(c);
                if (doc == null) return;
                obj.resolveNames(doc.nodeid, function (names) {
                    doc.meshid = names.meshid; doc.nodename = names.nodename; doc.meshname = names.meshname;
                    wrote(obj.db.upsertSession(doc)).catch(function (e) { console.log('CONNSTATS: write error: ' + (e.message || e)); });
                });
            } else {
                var done = obj.pairer.onEnd(c);
                if (done == null) return;
                if (obj.settings.recordTypes.indexOf(done.type) < 0) return;
                if (done.seconds < obj.settings.minSeconds) {
                    // too short to be a session (a misclick): drop the open record if one was written
                    wrote(obj.db.removeSession(done._id)).catch(function () { });
                    return;
                }
                obj.finalizeActive(done);
                if (done.truncated && done.nodename == null) {
                    obj.resolveNames(done.nodeid, function (names) {
                        done.meshid = names.meshid; done.nodename = names.nodename; done.meshname = names.meshname;
                        wrote(obj.db.upsertSession(done)).catch(function (e) { console.log('CONNSTATS: write error: ' + (e.message || e)); });
                    });
                } else {
                    wrote(obj.db.upsertSession(done)).catch(function (e) { console.log('CONNSTATS: write error: ' + (e.message || e)); });
                }
            }
        } catch (e) { console.log('CONNSTATS: event error: ' + (e.message || e)); }
    };

    // Active time is folded into the document when a session closes; sessions never observed
    // by a browser with the plugin keep active = null ("no data").
    obj.finalizeActive = function (doc) {
        if (!obj.tracker.has(doc._id)) return;
        doc.active = obj.tracker.activeFor(doc._id, doc.start, doc.end);
        doc.lastbeat = obj.tracker.lastBeat(doc._id);
        obj.tracker.forget(doc._id);
    };

    obj.flushActivity = function () {
        try {
            obj.tracker.takeDirty().forEach(function (sid) {
                var open = obj.pairer.open[sid.substring(2)];
                if (open == null) { obj.tracker.forget(sid); return; }
                var patch = { active: obj.tracker.activeFor(sid, open.start, null), lastbeat: obj.tracker.lastBeat(sid) };
                open.active = patch.active; open.lastbeat = patch.lastbeat;
                wrote(obj.db.updateSession(sid, patch)).catch(function () { });
            });
        } catch (e) { console.log('CONNSTATS: flush error: ' + (e.message || e)); }
    };

    // node and group names are stored with the session so history survives device deletion
    obj._nameCache = {};
    obj.resolveNames = function (nodeid, func) {
        var out = { meshid: null, nodename: null, meshname: null };
        if (nodeid == null) { func(out); return; }
        var hit = obj._nameCache[nodeid];
        if (hit != null && (Date.now() - hit.t) < 600000) { func(hit.v); return; }
        try {
            obj.meshServer.db.Get(nodeid, function (err, docs) {
                try {
                    if ((err == null) && Array.isArray(docs) && docs.length > 0 && docs[0] != null) {
                        out.nodename = docs[0].name || null;
                        out.meshid = docs[0].meshid || null;
                        var meshes = obj.meshServer.webserver.meshes;
                        if (out.meshid != null && meshes != null && meshes[out.meshid] != null) out.meshname = meshes[out.meshid].name || null;
                    }
                } catch (e) { }
                obj._nameCache[nodeid] = { t: Date.now(), v: out };
                func(out);
            });
        } catch (e) { func(out); }
    };

    // ------------------------------------------------------------------
    //  Messages from the web UI (action: 'plugin', plugin: 'connectionstats')
    // ------------------------------------------------------------------
    obj.serveraction = function (command, myparent, grandparent) {
        var user = myparent.user;
        if (user == null || obj.settings == null) return;
        switch (command.pluginaction) {
            case 'beat':
            case 'observe': {
                if (!obj.settings.activity.enabled) break;
                if (typeof command.nodeid != 'string' || command.nodeid.length > 300) break;
                var kind = (['desktop', 'terminal', 'files'].indexOf(command.kind) >= 0) ? command.kind : null;
                if (kind == null) break;
                // the session belongs to this user on this node: no rights check needed beyond that
                var open = obj.pairer.findOpen(user._id, command.nodeid, kind);
                if (open == null) break;
                if (command.pluginaction == 'beat') obj.tracker.beat(open._id, Date.now());
                else if (!obj.tracker.has(open._id)) { obj.tracker.beats[open._id] = []; obj.tracker.dirty[open._id] = true; }
                break;
            }
            default: break;
        }
    };

    obj.isAdmin = function (user) { return (user != null) && (user.siteadmin == 0xFFFFFFFF); };

    // ------------------------------------------------------------------
    //  JSON API used by the dashboard page: GET /pluginadmin.ashx?pin=connectionstats&api=...
    //  Authentication is done by MeshCentral before handleAdminReq is called; the scope of
    //  every query is intersected with what the user may see (permissions.js).
    // ------------------------------------------------------------------
    var csv = function (v, max) { if (typeof v != 'string' || v == '') return null; return v.split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x != ''; }).slice(0, max || 50); };
    var intq = function (v, dflt) { var n = Math.floor(Number(v)); return isFinite(n) ? n : dflt; };

    // request -> { start, end, bucket, tz, scope, types, userids, includeGuests, compare }
    obj.parseQuery = function (q) {
        var now = Date.now();
        var maxT = now + 366 * 86400000;   // nothing beyond a year ahead: a garbage timestamp would make Intl throw
        var end = Math.min(Math.max(intq(q.end, now), 0), maxT), start = Math.min(Math.max(intq(q.start, end - 7 * 86400000), 0), maxT);
        if (end - start > 10 * 366 * 86400000) start = end - 10 * 366 * 86400000;   // ten years at most per query
        if (end < start) { var t = start; start = end; end = t; }
        var tz = (typeof q.tz == 'string' && q.tz.length < 64) ? q.tz : 'UTC';
        var bucket = (obj.aggregate.BUCKETS.indexOf(q.bucket) >= 0) ? q.bucket : obj.aggregate.autoBucket(start, end);
        // a year of hour buckets would be 8760 bars: refuse silly combinations
        var edges = obj.aggregate.bucketEdges(start, end, bucket, tz).length;
        if (edges > 800) bucket = obj.aggregate.autoBucket(start, end);
        return {
            start: start, end: end, bucket: bucket, tz: tz,
            scope: (typeof q.scope == 'string' && q.scope.length < 300) ? q.scope : 'all',
            types: csv(q.types, 10), userids: csv(q.users, 200),
            includeGuests: (q.guests == '1'), compare: (q.compare == '1')
        };
    };

    // the oldest session the user may see under the current scope, types and users: the "All"
    // preset starts there
    obj.apiRange = function (user, q) {
        var p = obj.parseQuery(q);
        p.start = 0; p.end = Date.now();
        return obj.perms.filterFor(user, p).then(function (f) {
            if (f == null) return { error: 'Not allowed to see this scope', status: 403 };
            return obj.db.firstSession(f).then(function (row) { return { oldest: row ? row.start : null }; });
        });
    };

    obj.apiQuery = function (user, q) {
        var p = obj.parseQuery(q);
        return obj.perms.filterFor(user, p).then(function (f) {
            if (f == null) return { error: 'Not allowed to see this scope', status: 403 };
            var work = [obj.db.findSessions(f)];
            var prevRange = null;
            if (p.compare) {
                prevRange = obj.aggregate.previousRange(p.start, p.end, p.bucket, p.tz);
                work.push(obj.db.findSessions(Object.assign({}, f, { start: prevRange.start, end: prevRange.end })));
            }
            work.push(obj.db.listSessions(f, { skip: 0, limit: Math.min(Math.max(intq(q.limit, 25), 1), 500) }));
            return Promise.all(work).then(function (r) {
                var out = { query: p, filter: { scope: p.scope, userids: f.userids || null }, aggregate: obj.aggregate.aggregate(r[0], { start: p.start, end: p.end, bucket: p.bucket, tz: p.tz }) };
                if (p.compare) out.previous = obj.aggregate.aggregate(r[1], { start: prevRange.start, end: prevRange.end, bucket: p.bucket, tz: p.tz });
                var list = r[r.length - 1];
                out.sessions = { rows: list.rows.map(obj.sessionRow), total: list.total };
                return out;
            });
        });
    };

    obj.apiSessions = function (user, q) {
        var p = obj.parseQuery(q);
        return obj.perms.filterFor(user, p).then(function (f) {
            if (f == null) return { error: 'Not allowed to see this scope', status: 403 };
            var skip = intq(q.skip, 0), limit = Math.min(Math.max(intq(q.limit, 50), 1), 500);
            if (q.wd != null || q.hour != null) {
                // a punchcard cell: sessions that start on that weekday and hour (local to tz). The
                // store cannot filter by that, so page in memory over the range.
                var wd = intq(q.wd, -1), hour = intq(q.hour, -1);
                return obj.db.findSessions(f).then(function (rows) {
                    rows = rows.filter(function (d) { var c = obj.aggregate.startCell(d, p.start, p.tz); return (wd < 0 || c.wd == wd) && (hour < 0 || c.h == hour); });
                    rows.sort(function (a, b) { return b.start - a.start; });
                    return { rows: rows.slice(skip, skip + limit).map(obj.sessionRow), total: rows.length, skip: skip };
                });
            }
            return obj.db.listSessions(f, { skip: skip, limit: limit }).then(function (list) {
                return { rows: list.rows.map(obj.sessionRow), total: list.total, skip: skip };
            });
        });
    };

    // the fields the page needs, nothing more
    obj.sessionRow = function (d) {
        return {
            id: d._id, nodeid: d.nodeid, node: d.nodename || d.nodeid, meshid: d.meshid, group: d.meshname || null,
            user: d.username || d.userid, userid: d.userid, guest: d.guest || null, type: d.type, protocol: d.protocol,
            start: d.start, end: d.end, seconds: d.seconds, active: d.active, bytesin: d.bytesin, bytesout: d.bytesout,
            ip: d.ip || null, truncated: !!d.truncated, source: d.source
        };
    };

    // groups, devices and admins the user may pick from
    obj.apiMeta = function (user) {
        return obj.perms.visibleScope(user).then(function (vis) {
            var meshes = obj.meshServer.webserver.meshes || {}, groups = [], devices = [], users = [];
            var domain = user.domain || '';
            return new Promise(function (resolve) {
                obj.meshServer.db.GetAllTypeNoTypeField('node', domain, function (err, nodes) {
                    var allowed = {};
                    (nodes || []).forEach(function (n) {
                        if (n == null || typeof n._id != 'string') return;
                        if (!vis.all && vis.nodeids.indexOf(n._id) < 0) return;
                        if (devices.length < 5000) devices.push({ id: n._id, name: n.name || n._id, meshid: n.meshid || null });
                        if (n.meshid) allowed[n.meshid] = 1;
                    });
                    for (var mid in meshes) {
                        var m = meshes[mid];
                        if (m == null || m.deleted != null || (m.domain || '') != domain) continue;
                        if (!vis.all && vis.meshids.indexOf(mid) < 0 && !allowed[mid]) continue;
                        groups.push({ id: mid, name: m.name || mid });
                    }
                    if (vis.userids == 'all') {
                        var all = obj.meshServer.webserver.users || {};
                        for (var uid in all) { var u = all[uid]; if (u && (u.domain || '') == domain) users.push({ id: uid, name: u.name || uid }); }
                    } else {
                        users.push({ id: user._id, name: user.name || user._id });
                    }
                    groups.sort(function (a, b) { return a.name.localeCompare(b.name); });
                    devices.sort(function (a, b) { return a.name.localeCompare(b.name); });
                    users.sort(function (a, b) { return a.name.localeCompare(b.name); });
                    resolve({
                        groups: groups, devices: devices, users: users, canSeeUsers: (vis.userids == 'all'), isAdmin: obj.isAdmin(user),
                        me: { id: user._id, name: user.name || user._id }, types: obj.events.TYPES,
                        settings: { activity: obj.settings ? obj.settings.activity : null, tz: obj.settings ? obj.settings.tz : '' },
                        version: PLUGIN_VERSION
                    });
                });
            });
        });
    };

    // Streams the filtered sessions (or the bucket totals) as CSV or JSON under the same
    // permission check as the page. Sessions are read in pages of 500 so a year never sits in memory.
    obj.apiExport = function (req, res, user) {
        var q = req.query, p = obj.parseQuery(q);
        var format = (q.format == 'json') ? 'json' : 'csv', what = (q.what == 'buckets') ? 'buckets' : 'sessions';
        var meta = { scope: p.scope, scopeName: (typeof q.scopename == 'string') ? q.scopename.substring(0, 60) : null, start: p.start, end: p.end, bucket: p.bucket, tz: p.tz, user: user.name || user._id, version: PLUGIN_VERSION, types: p.types, users: p.userids, guests: p.includeGuests, now: Date.now() };
        return obj.perms.filterFor(user, p).then(function (f) {
            if (f == null) { res.status(403).json({ error: 'Not allowed to see this scope' }); return; }
            var name = obj.exporter.fileName(meta, what, format);
            res.set('Content-Disposition', 'attachment; filename="' + name + '"');
            res.set('Cache-Control', 'no-store');
            if (what == 'buckets') {
                return obj.db.findSessions(f).then(function (rows) {
                    var agg = obj.aggregate.aggregate(rows, { start: p.start, end: p.end, bucket: p.bucket, tz: p.tz });
                    var recs = obj.exporter.bucketRecords(agg, p.tz);
                    if (format == 'json') { res.set('Content-Type', 'application/json; charset=utf-8'); res.send(JSON.stringify({ meta: meta, buckets: recs }, null, 1)); return; }
                    res.set('Content-Type', 'text/csv; charset=utf-8');
                    var out = '\ufeff' + obj.exporter.headerLine(meta) + obj.exporter.csvRow(obj.exporter.BUCKET_COLUMNS);
                    recs.forEach(function (r) { out += obj.exporter.csvRow(obj.exporter.BUCKET_COLUMNS.map(function (c) { return r[c]; })); });
                    res.send(out);
                });
            }
            var now = Date.now(), first = true, page = 500;
            if (format == 'json') { res.set('Content-Type', 'application/json; charset=utf-8'); res.write('{"meta":' + JSON.stringify(meta) + ',"sessions":['); }
            else { res.set('Content-Type', 'text/csv; charset=utf-8'); res.write('\ufeff' + obj.exporter.headerLine(meta) + obj.exporter.csvRow(obj.exporter.SESSION_COLUMNS)); }
            var step = function (skip) {
                return obj.db.listSessions(f, { skip: skip, limit: page }).then(function (list) {
                    var chunk = '';
                    list.rows.forEach(function (d) {
                        if (format == 'json') { chunk += (first ? '' : ',') + '\n' + JSON.stringify(obj.exporter.sessionRecord(d, p.tz, now)); first = false; }
                        else chunk += obj.exporter.sessionCsvRow(d, p.tz, now);
                    });
                    if (chunk) res.write(chunk);
                    if (list.rows.length < page || skip + page >= 200000) return null;
                    return step(skip + page);
                });
            };
            return step(0).then(function () { res.end(format == 'json' ? '\n]}' : ''); });
        }).catch(function (e) { console.log('CONNSTATS: export error: ' + (e && e.stack ? e.stack : e)); try { res.end(); } catch (e2) { } });
    };

    obj.handleApi = function (req, res, user) {
        var api = String(req.query.api);
        if (api == 'export') { obj.apiExport(req, res, user); return; }
        var work;
        if (api == 'query') work = obj.apiQuery(user, req.query);
        else if (api == 'settings') work = Promise.resolve(obj.isAdmin(user) ? { settings: obj.settings, backfill: obj.backfillInfo(), types: obj.events.TYPES, version: PLUGIN_VERSION } : { error: 'Site administrators only', status: 403 });
        else if (api == 'backfill') work = Promise.resolve(obj.isAdmin(user) ? obj.backfillInfo() : { error: 'Site administrators only', status: 403 });
        else if (api == 'restore') work = Promise.resolve(obj.isAdmin(user) ? obj.restoreInfo() : { error: 'Site administrators only', status: 403 });
        else if (api == 'backups') work = obj.isAdmin(user) ? obj.listBackups() : Promise.resolve({ error: 'Site administrators only', status: 403 });
        else if (api == 'sessions') work = obj.apiSessions(user, req.query);
        else if (api == 'seq') work = Promise.resolve({ seq: obj.seq });
        else if (api == 'meta') work = obj.apiMeta(user);
        else if (api == 'range') work = obj.apiRange(user, req.query);
        else { res.status(404).json({ error: 'unknown api' }); return; }
        work.then(function (r) {
            if (r != null && r.error != null) { res.status(r.status || 400).json({ error: r.error }); return; }
            res.set('Cache-Control', 'no-store');
            res.json(r);
        }).catch(function (e) {
            console.log('CONNSTATS: api error: ' + (e && e.stack ? e.stack : e));
            res.status(500).json({ error: 'internal error' });
        });
    };

    // Static files of the page. There is no static-file plumbing for plugins in MeshCentral, so
    // the page fetches them from this same authenticated URL. Strict whitelist.
    var FILES = { 'dashboard.js': 'application/javascript; charset=utf-8', 'connectionstats.css': 'text/css; charset=utf-8', 'export.js': 'application/javascript; charset=utf-8' };
    obj.serveFile = function (req, res) {
        var name = String(req.query.file);
        if (FILES[name] == null) { res.sendStatus(404); return; }
        var fs = require('fs'), path = require('path');
        fs.readFile(path.join(__dirname, 'public', name), function (err, data) {
            if (err) { res.sendStatus(404); return; }
            res.set('Content-Type', FILES[name]);
            res.set('Cache-Control', 'private, max-age=300');
            res.send(data);
        });
    };

    // Admin page: My Server > Plugins > Connection Stats (GET /pluginadmin.ashx?pin=connectionstats)
    // Also the device tab (view=device&nodeid=...) which embeds the same page in an iframe.
    // Rendered by string replacement rather than res.render: MeshCentral points the shared Express
    // 'views' directory at the plugin of the CURRENT request, so a concurrent request from another
    // plugin could swap the template underneath an async render.
    var pageCache = null;
    obj.handleAdminReq = function (req, res, user) {
        if (obj.db == null) { res.status(503).send('Connection Stats is still starting'); return; }
        if (req.query.api != null) { obj.handleApi(req, res, user); return; }
        if (req.query.file != null) { obj.serveFile(req, res); return; }
        var boot = { view: 'full', night: (req.query.night == '1'), version: PLUGIN_VERSION, user: user._id, isAdmin: obj.isAdmin(user) };
        if (req.query.view == 'device' && typeof req.query.nodeid == 'string' && req.query.nodeid.length < 300) {
            boot.view = 'device'; boot.scope = 'node:' + req.query.nodeid;
        } else if (typeof req.query.scope == 'string' && req.query.scope.length < 300) {
            boot.scope = req.query.scope;
        }
        if (req.query.view == 'settings') boot.view = 'settings';
        try {
            if (pageCache == null || obj.meshServer.args.debug) pageCache = require('fs').readFileSync(require('path').join(__dirname, 'views', 'admin.handlebars')).toString();
            var html = pageCache.replace('{{{bootJson}}}', JSON.stringify(boot).replace(/</g, '\\u003c'));
            res.set('Content-Type', 'text/html; charset=utf-8');
            res.set('Cache-Control', 'no-store');
            res.send(html);
        } catch (e) { res.status(500).send('Connection Stats page could not be rendered'); }
    };

    // Settings and backfill changes come as form posts from the settings page. Site admins only.
    obj.handleAdminPostReq = function (req, res, user) {
        if (!obj.isAdmin(user)) { res.sendStatus(401); return; }
        if (obj.db == null) { res.status(503).json({ ok: false, error: 'Connection Stats is still starting' }); return; }
        if (/^multipart\/form-data/i.test(String(req.headers['content-type'] || ''))) { obj.handleUpload(req, res); return; }
        if (req.body == null) { res.status(400).json({ ok: false, error: 'No form data' }); return; }
        var action = String(req.body.action || '');
        if (action == 'settings') {
            var parsed = null;
            try { parsed = JSON.parse(String(req.body.settings || '')); } catch (e) { res.status(400).json({ ok: false, error: 'The settings are not valid JSON.' }); return; }
            obj.saveSettings(parsed).then(function (st) { res.json({ ok: true, settings: st }); }, function (e) { res.status(500).json({ ok: false, error: 'Could not save: ' + (e.message || e) }); });
            return;
        }
        if (action == 'backfill') {
            var days = Math.min(36500, Math.max(0, Math.floor(Number(req.body.days)) || 0));
            obj.startBackfill(days);
            res.json({ ok: true, backfill: obj.backfillInfo() });
            return;
        }
        if (action == 'restore') {
            // a file from MeshCentral's backup folder, by name only (no path separators)
            var name = String(req.body.file || ''), dir = obj.backupFolder();
            if (dir == null) { res.status(400).json({ ok: false, error: 'MeshCentral has no backup folder configured' }); return; }
            if (name == '' || name != require('path').basename(name) || !RESTORE_EXT.test(name)) { res.status(400).json({ ok: false, error: 'Not a backup file name' }); return; }
            if (obj.restoreStatus != null && obj.restoreStatus.running) { res.status(409).json({ ok: false, error: 'An import is already running' }); return; }
            var full = require('path').join(dir, name);
            if (!require('fs').existsSync(full)) { res.status(404).json({ ok: false, error: 'No such file in the backup folder' }); return; }
            obj.startRestore(full, name, false);
            res.json({ ok: true, restore: obj.restoreInfo() });
            return;
        }
        if (action == 'sweep') {
            obj.db.sweepRetention(obj.settings.retentionDays).then(function (n) { res.json({ ok: true, removed: n }); }, function (e) { res.status(500).json({ ok: false, error: e.message || String(e) }); });
            return;
        }
        res.status(400).json({ ok: false, error: 'Unknown action' });
    };

    return obj;
};
