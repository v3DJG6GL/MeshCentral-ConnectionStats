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

    var PLUGIN_VERSION = (function () { try { return require(__dirname + '/config.json').version; } catch (e) { return '0.0.0'; } })();

    // ------------------------------------------------------------------
    //  Client side. Every function listed here is serialised with
    //  .toString() and runs in the browser. They must be self-contained and
    //  reach each other only through pluginHandler.connectionstats.<name>.
    // ------------------------------------------------------------------
    obj.exports = [];

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

    // Admin page: My Server > Plugins > Connection Stats (GET /pluginadmin.ashx?pin=connectionstats)
    obj.handleAdminReq = function (req, res, user) {
        res.set('Content-Type', 'text/html; charset=utf-8');
        res.send('<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;padding:20px">Connection Stats ' + PLUGIN_VERSION + ' is recording sessions. The dashboard arrives with the next build step.</body></html>');
    };

    obj.handleAdminPostReq = function (req, res, user) {
        res.sendStatus(401);
    };

    return obj;
};
