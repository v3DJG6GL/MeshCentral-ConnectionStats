/**
* @description MeshCentral Connection Stats plugin
* @license Apache-2.0
*
* Records how long each admin was remote-connected to each device, by connection type, and shows
* it per device, per device group and server-wide, with export. Sessions are captured from the
* server event bus (every relay start/end is dispatched there) and kept in the plugin's own store,
* because MeshCentral's own events expire after 20 days.
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
        'csOnMessage'
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
            retentionDays: 365,
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
        d.retentionDays = Math.round(num(input.retentionDays, d.retentionDays, 1, 3650));
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

        obj.loadSettings().then(function () { return obj.restoreOpenSessions(); }).catch(function (e) {
            console.log('CONNSTATS: startup error: ' + (e.message || e));
        });
        console.log('CONNSTATS: plugin ' + PLUGIN_VERSION + ' started');
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
    //  Capture: every event MeshCentral dispatches lands here
    // ------------------------------------------------------------------
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
                    obj.db.upsertSession(doc).catch(function (e) { console.log('CONNSTATS: write error: ' + (e.message || e)); });
                });
            } else {
                var done = obj.pairer.onEnd(c);
                if (done == null) return;
                if (obj.settings.recordTypes.indexOf(done.type) < 0) return;
                if (done.seconds < obj.settings.minSeconds) {
                    // too short to be a session (a misclick): drop the open record if one was written
                    obj.db.removeSession(done._id).catch(function () { });
                    return;
                }
                obj.finalizeActive(done);
                if (done.truncated && done.nodename == null) {
                    obj.resolveNames(done.nodeid, function (names) {
                        done.meshid = names.meshid; done.nodename = names.nodename; done.meshname = names.meshname;
                        obj.db.upsertSession(done).catch(function (e) { console.log('CONNSTATS: write error: ' + (e.message || e)); });
                    });
                } else {
                    obj.db.upsertSession(done).catch(function (e) { console.log('CONNSTATS: write error: ' + (e.message || e)); });
                }
            }
        } catch (e) { console.log('CONNSTATS: event error: ' + (e.message || e)); }
    };

    // Active time is folded in when a session closes (step 5 adds the heartbeats).
    obj.finalizeActive = function (doc) { };

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
        switch (command.pluginaction) {
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
        var end = intq(q.end, now), start = intq(q.start, end - 7 * 86400000);
        if (end - start > 5 * 366 * 86400000) start = end - 5 * 366 * 86400000;   // five years at most per query
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
            work.push(obj.db.listSessions(f, { skip: 0, limit: intq(q.limit, 25) }));
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
            return obj.db.listSessions(f, { skip: intq(q.skip, 0), limit: intq(q.limit, 50) }).then(function (list) {
                return { rows: list.rows.map(obj.sessionRow), total: list.total, skip: intq(q.skip, 0) };
            });
        });
    };

    // the fields the page needs, nothing more
    obj.sessionRow = function (d) {
        return {
            id: d._id, nodeid: d.nodeid, node: d.nodename || d.nodeid, meshid: d.meshid, group: d.meshname || null,
            user: d.username || d.userid, userid: d.userid, guest: d.guest || null, type: d.type,
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

    obj.handleApi = function (req, res, user) {
        var api = String(req.query.api);
        var work;
        if (api == 'query') work = obj.apiQuery(user, req.query);
        else if (api == 'sessions') work = obj.apiSessions(user, req.query);
        else if (api == 'meta') work = obj.apiMeta(user);
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

    obj.handleAdminPostReq = function (req, res, user) {
        res.sendStatus(401);
    };

    return obj;
};
