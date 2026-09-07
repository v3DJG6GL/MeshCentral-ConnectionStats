/**
* @description MeshCentral-ConnectionStats: what a user may see
* @license Apache-2.0
*
* Site admins see every device and every admin. Everyone else sees the device groups and devices
* they hold any right on, and only their own sessions unless they may manage users. The result
* is a store filter, so the check happens on the server for every query and export.
*/

"use strict";

const SITERIGHT_MANAGEUSERS = 0x00000002;
const CACHE_MS = 60000;

function Permissions(meshServer) {
    var self = this;
    var cache = {};   // userid -> { t, scope }

    self.isSiteAdmin = function (user) { return (user != null) && (user.siteadmin == 0xFFFFFFFF); };
    self.canSeeOtherUsers = function (user) { return self.isSiteAdmin(user) || ((user != null) && ((user.siteadmin & SITERIGHT_MANAGEUSERS) != 0)); };

    // Promise<{ all, meshids, nodeids, userids }>; nodeids is the full list of visible nodes for
    // non-admins (groups expanded), because the store filter ANDs its lists
    self.visibleScope = function (user) {
        if (self.isSiteAdmin(user)) return Promise.resolve({ all: true, meshids: null, nodeids: null, userids: 'all' });
        var hit = cache[user._id];
        if (hit != null && (Date.now() - hit.t) < CACHE_MS) return Promise.resolve(hit.scope);
        var ws = meshServer.webserver;
        var meshids = {};
        try { (ws.GetAllMeshWithRights(user) || []).forEach(function (m) { meshids[m._id] = 1; }); } catch (e) { }
        var direct = {};
        if (user.links) { for (var k in user.links) { if (k.indexOf('node/') == 0) direct[k] = 1; } }
        return new Promise(function (resolve) {
            meshServer.db.GetAllTypeNoTypeField('node', user.domain, function (err, nodes) {
                var ids = [];
                (nodes || []).forEach(function (n) { if (n && (meshids[n.meshid] || direct[n._id])) ids.push(n._id); });
                var scope = { all: false, meshids: Object.keys(meshids), nodeids: ids, userids: self.canSeeOtherUsers(user) ? 'all' : [user._id] };
                cache[user._id] = { t: Date.now(), scope: scope };
                resolve(scope);
            });
        });
    };

    // Turn a request scope ('all' | 'mesh:<id>' | 'node:<id>') plus user filters into a store
    // filter limited to what the user may see. Resolves null when the scope is not visible.
    self.filterFor = function (user, req) {
        return self.visibleScope(user).then(function (vis) {
            var f = { domain: user.domain || '', start: req.start, end: req.end, types: req.types || null, includeGuests: (req.includeGuests === true) };
            var scope = String(req.scope || 'all');
            if (scope.indexOf('node:') == 0) {
                var nid = scope.substring(5);
                if (!vis.all && vis.nodeids.indexOf(nid) < 0) return null;
                f.nodeids = [nid];
            } else if (scope.indexOf('mesh:') == 0) {
                var mid = scope.substring(5);
                if (!vis.all && vis.meshids.indexOf(mid) < 0) return null;
                f.meshids = [mid];
            } else if (!vis.all) {
                f.nodeids = vis.nodeids.length ? vis.nodeids : ['none'];
            }
            if (vis.userids == 'all') { if (Array.isArray(req.userids) && req.userids.length) f.userids = req.userids; }
            else f.userids = vis.userids;
            return f;
        });
    };

    self.invalidate = function (userid) { if (userid == null) cache = {}; else delete cache[userid]; };
}

module.exports = { Permissions: Permissions, SITERIGHT_MANAGEUSERS: SITERIGHT_MANAGEUSERS };
