/**
* @description MeshCentral-ConnectionStats database module (NeDB files, MongoDB, or the SQL backend in db_sql.js)
* @license Apache-2.0
*
* Storage follows MeshCentral's own database: PostgreSQL, MariaDB, MySQL and SQLite go through
* db_sql.js into MeshCentral's database, MongoDB gets its own collections, everything else gets
* plugin-private NeDB files next to meshcentral-data. Every backend implements the same promise
* API so nothing above this file branches on the backend:
*
*   upsertSession(doc)            full replace or insert of one session document
*   updateSession(id, patch)      column-level partial update (concurrent patches do not clobber)
*   getSession(id) / removeSession(id)
*   getOpenSessions([domain])     documents whose end is null
*   findSessions(filter)          every document overlapping [filter.start, filter.end)
*   listSessions(filter, page)    { rows, total } newest first, page = { skip, limit }
*   sweepRetention(days)          chunked delete of CLOSED sessions older than N days
*   getSetting(id) / setSetting(id, obj)
*   getDBVersion() / updateDBVersion(v)
*   close()
*/

"use strict";
var Datastore = null;

// ---- tunables ------------------------------------------------------------
const DEFAULT_RETENTION_DAYS = 365;
const RETENTION_SWEEP_MS = 24 * 60 * 60 * 1000;
const NEDB_DELETE_CHUNK = 250;              // see removeInChunks()
// MeshCentral uses this same value for every one of its own NeDB stores. Compaction rewrites the
// WHOLE datafile synchronously on the event loop, so a short interval stalls every relay on the
// server once the store is large.
const COMPACTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_LIST_IDS = 5000;

const TYPES = ['desktop', 'terminal', 'files', 'webapp', 'messenger', 'amt', 'tunnel', 'plugin', 'registry', 'other'];

// Resolve a module from the plugin folder first, then from MeshCentral's own node_modules
// (plugins live in meshcentral-data/plugins, which is not always below MeshCentral's node_modules).
function loadModule(names) {
    var lastErr = null;
    for (var i in names) {
        try { return require(names[i]); } catch (e) { lastErr = e; }
        try { if (require.main && typeof require.main.require == 'function') return require.main.require(names[i]); } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('Module not found: ' + names.join(', '));
}

// ---- shared helpers (backend independent, also used by db_sql.js) --------

// limit/skip are inlined into SQL (they cannot be parameters in every dialect), so they must come
// out of here as plain integers - not 1.5, 1e21 or Infinity, which would be a syntax error.
var intOr = function (v, dflt) { var n = Math.floor(Number(v)); return isFinite(n) ? n : dflt; };

var cleanStrList = function (v, maxItems) { // sanitize a client-supplied filter list
    if (!Array.isArray(v)) return null;
    var out = v.filter(function (x) { return typeof x == 'string' && x.length > 0 && x.length < 256; }).slice(0, maxItems || MAX_LIST_IDS);
    return out.length ? out : null;
};

var normPage = function (page) {
    page = page || {};
    return {
        limit: Math.min(Math.max(intOr(page.limit, 100) || 100, 1), 1000),
        skip: Math.min(Math.max(intOr(page.skip, 0), 0), 10000000)
    };
};

// { domain, start, end, nodeids?, meshids?, userids?, types?, includeGuests }
var normFilter = function (f) {
    f = f || {};
    var start = intOr(f.start, 0), end = intOr(f.end, Date.now());
    if (end < start) { var t = start; start = end; end = t; }
    var types = cleanStrList(f.types, 20);
    if (types) { types = types.filter(function (x) { return TYPES.indexOf(x) >= 0; }); if (!types.length) types = null; }
    return {
        domain: (f.domain == null) ? '' : String(f.domain),
        start: start, end: end,
        nodeids: cleanStrList(f.nodeids, MAX_LIST_IDS),
        meshids: cleanStrList(f.meshids, MAX_LIST_IDS),
        userids: cleanStrList(f.userids, MAX_LIST_IDS),
        types: types,
        includeGuests: (f.includeGuests === true)
    };
};

// document-store (Mongo / NeDB) query for findSessions / listSessions: everything that overlaps
// the range. { end: null } matches both null and a missing field on either store.
var buildDocQuery = function (f) {
    var q = { domain: f.domain, start: { $lt: f.end }, $or: [{ end: null }, { end: { $gt: f.start } }] };
    if (f.nodeids) q.nodeid = { $in: f.nodeids };
    if (f.meshids) q.meshid = { $in: f.meshids };
    if (f.userids) q.userid = { $in: f.userids };
    if (f.types) q.type = { $in: f.types };
    if (!f.includeGuests) q.guest = null;
    return q;
};

var strOrNull = function (v, n) { if (v == null) return null; v = String(v); return (v.length > n) ? v.substring(0, n) : v; };

// coerce a session document into the stored shape
var normDoc = function (d) {
    if (d == null || typeof d._id != 'string' || d._id.indexOf('s_') != 0 || d._id.length > 256) throw new Error('invalid session id');
    var type = TYPES.indexOf(d.type) >= 0 ? d.type : 'other';
    return {
        _id: d._id,
        domain: (d.domain == null) ? '' : String(d.domain).substring(0, 64),
        nodeid: strOrNull(d.nodeid, 256), meshid: strOrNull(d.meshid, 256),
        userid: strOrNull(d.userid, 256), username: strOrNull(d.username, 256), guest: strOrNull(d.guest, 256),
        type: type, protocol: intOr(d.protocol, 0),
        start: intOr(d.start, 0),
        end: (d.end == null) ? null : intOr(d.end, null),
        seconds: Math.max(0, intOr(d.seconds, 0)),
        active: (d.active == null) ? null : Math.max(0, intOr(d.active, 0)),
        lastbeat: (d.lastbeat == null) ? null : intOr(d.lastbeat, null),
        bytesin: Math.max(0, intOr(d.bytesin, 0)), bytesout: Math.max(0, intOr(d.bytesout, 0)),
        ip: strOrNull(d.ip, 64),
        source: (d.source == 'backfill' || d.source == 'backup') ? d.source : 'live',
        truncated: (d.truncated === true || d.truncated === 1),
        nodename: strOrNull(d.nodename, 256), meshname: strOrNull(d.meshname, 256)
    };
};

// maintenance scheduling, identical for every backend
function installShared(obj) {
    obj.retentionDays = DEFAULT_RETENTION_DAYS;
    obj.setRetentionDays = function (days) {
        var n = Number(days);
        obj.retentionDays = (isFinite(n) && n > 0) ? n : DEFAULT_RETENTION_DAYS;
    };
    obj.applyRetention = function () {
        return obj.getSetting('settings').then(function (s) {
            if (s != null && s.retentionDays != null) obj.setRetentionDays(s.retentionDays);
        }).catch(function () { });
    };
    obj.retentionSweep = function () {
        if (obj._closed) return Promise.resolve(0);
        return obj.sweepRetention(obj.retentionDays).catch(function (e) { console.log('CONNSTATS: retention sweep error: ' + (e.message || e)); return 0; });
    };
    obj.startMaintenance = function () {
        if (obj._maintStarted) return;
        obj._maintStarted = true;
        var t1 = setTimeout(function () { obj.retentionSweep(); }, 120000);          // shortly after startup
        var t2 = setInterval(function () { obj.retentionSweep(); }, RETENTION_SWEEP_MS);
        try { t1.unref(); t2.unref(); } catch (e) { }
        obj._timers.push(t1, t2);
    };
}

module.exports.CreateDB = function (meshserver) {
    // server_startup runs again when a plugin is installed or reloaded (pluginHandler.js). Without
    // this, every reload leaks another store with its own compaction / sweep timers.
    try {
        var prev = (meshserver.pluginHandler != null) ? meshserver.pluginHandler.connectionstats_db : null;
        if (prev != null && typeof prev.close == 'function') { prev.close(); console.log('CONNSTATS: closed previous database instance'); }
    } catch (e) { }

    var obj = {};
    obj.dbVersion = 1;
    obj._timers = [];
    obj._closed = false;
    installShared(obj);

    obj.close = function () {
        obj._closed = true;
        obj._timers.forEach(function (t) { try { clearInterval(t); } catch (e) { } try { clearTimeout(t); } catch (e) { } });
        obj._timers = [];
        [obj.sessionsFile, obj.settingsFile].forEach(function (f) {
            if (f == null) return;
            try {
                if (typeof f.stopAutocompaction == 'function') f.stopAutocompaction();
                else if (f.persistence != null && typeof f.persistence.stopAutocompaction == 'function') f.persistence.stopAutocompaction();
            } catch (e) { }
        });
        if (obj.mongoClient != null) { try { obj.mongoClient.close(); } catch (e) { } obj.mongoClient = null; }
        if (typeof obj._backendClose == 'function') { try { obj._backendClose(); } catch (e) { } }
    };

    // Which store do we use? databaseType comes from MeshCentral itself (db.js): 1 NeDB,
    // 2 MongoJS, 3 MongoDB, 4 MariaDB, 5 MySQL, 6 PostgreSQL, 7 AceBase, 8 SQLite.
    var sqlKind = null;
    if (String(process.env.CONNECTIONSTATS_STORAGE || '').toLowerCase() != 'nedb') {
        var dt = 0;
        try { dt = (meshserver.db != null && meshserver.db.databaseType != null) ? Number(meshserver.db.databaseType) : 0; } catch (e) { }
        if (dt == 6) sqlKind = 'pg';
        else if (dt == 4) sqlKind = 'mariadb';
        else if (dt == 5) sqlKind = 'mysql';
        else if (dt == 8) {
            // SQLite is the one engine whose handle MeshCentral exposes; sharing it avoids fighting
            // the same file for the write lock and inherits MeshCentral's PRAGMA setup.
            if (meshserver.db.file != null && typeof meshserver.db.file.all == 'function') sqlKind = 'sqlite';
            else console.log('CONNSTATS: MeshCentral is on SQLite but its database handle is not usable here - using NeDB files instead');
        }
    }
    if (sqlKind != null) {
        console.log('CONNSTATS: storage backend = ' + sqlKind + ' (MeshCentral database)');
        require(__dirname + '/db_sql.js').install(obj, meshserver, sqlKind, {
            loadModule: loadModule, normFilter: normFilter, normPage: normPage, normDoc: normDoc,
            TYPES: TYPES, DEFAULT_RETENTION_DAYS: DEFAULT_RETENTION_DAYS
        });
        return obj;
    }

    if (meshserver.args.mongodb) { // MongoDB
        console.log('CONNSTATS: storage backend = mongodb');
        // Methods are defined up front and gate on the connection promise, so a call that arrives
        // before the connection is up waits instead of throwing "not a function".
        var mdb = loadModule(['mongodb']);
        var dbname = meshserver.args.mongodbname || 'meshcentral';
        obj._ready = new Promise(function (resolve, reject) {
            mdb.MongoClient.connect(meshserver.args.mongodb, { useNewUrlParser: true, useUnifiedTopology: true }, function (err, client) {
                if (err != null) { console.log('CONNSTATS: unable to connect to MongoDB: ' + err); reject(err); return; }
                obj.mongoClient = client;
                var db = client.db(dbname);
                obj.sessionsFile = db.collection('plugin_connectionstats_sessions');
                obj.settingsFile = db.collection('plugin_connectionstats_settings');
                var idx = [
                    [{ domain: 1, start: -1 }, 'DomStart1'], [{ nodeid: 1, start: -1 }, 'NodeStart1'],
                    [{ userid: 1, start: -1 }, 'UserStart1'], [{ meshid: 1, start: -1 }, 'MeshStart1'], [{ end: 1 }, 'End1']
                ];
                // createIndex is idempotent; no TTL index on purpose (open sessions must never expire)
                Promise.all(idx.map(function (i) { return obj.sessionsFile.createIndex(i[0], { name: i[1] }); }))
                .catch(function (e) { console.log('CONNSTATS: index error: ' + (e.message || e)); })
                .then(function () { resolve(); });
            });
        });
        var ready = function () { return obj._ready; };

        obj.upsertSession = function (doc) {
            doc = normDoc(doc);
            return ready().then(function () { return obj.sessionsFile.replaceOne({ _id: doc._id }, doc, { upsert: true }); }).then(function () { return doc; });
        };
        obj.updateSession = function (id, patch) {
            return ready().then(function () { return obj.sessionsFile.updateOne({ _id: id }, { $set: patch }); }).then(function (r) { return r.matchedCount || 0; });
        };
        obj.getSession = function (id) {
            return ready().then(function () { return obj.sessionsFile.findOne({ _id: id }); });
        };
        obj.removeSession = function (id) {
            return ready().then(function () { return obj.sessionsFile.deleteOne({ _id: id }); }).then(function (r) { return (r && r.deletedCount) || 0; });
        };
        obj.getOpenSessions = function (domain) {
            var q = { end: null };
            if (domain != null) q.domain = domain;
            return ready().then(function () { return obj.sessionsFile.find(q).sort({ start: 1 }).toArray(); });
        };
        obj.findSessions = function (filter) {
            var q = buildDocQuery(normFilter(filter));
            return ready().then(function () { return obj.sessionsFile.find(q).sort({ start: -1 }).toArray(); });
        };
        // the oldest session matching the filter (range "All" on the dashboard), or null
        obj.firstSession = function (filter) {
            var q = buildDocQuery(normFilter(filter));
            return ready().then(function () { return obj.sessionsFile.find(q).sort({ start: 1 }).limit(1).toArray(); }).then(function (r) { return r[0] || null; });
        };
        obj.listSessions = function (filter, page) {
            var q = buildDocQuery(normFilter(filter)), p = normPage(page);
            return ready().then(function () { return obj.sessionsFile.countDocuments(q); })
            .then(function (total) {
                return obj.sessionsFile.find(q).sort({ start: -1, _id: -1 }).skip(p.skip).limit(p.limit).toArray()
                .then(function (rows) { return { rows: rows, total: total }; });
            });
        };
        obj.sweepRetention = function (days) {
            var cutoff = Date.now() - (Number(days) || DEFAULT_RETENTION_DAYS) * 86400000;
            return ready().then(function () { return obj.sessionsFile.deleteMany({ end: { $ne: null, $lt: cutoff } }); })
            .then(function (r) {
                var n = (r && r.deletedCount) || 0;
                if (n > 0) console.log('CONNSTATS: retention removed ' + n + ' sessions older than ' + new Date(cutoff).toISOString());
                return n;
            });
        };
        obj.getSetting = function (id) {
            return ready().then(function () { return obj.settingsFile.findOne({ _id: id }); })
            .then(function (d) { if (d == null) return null; delete d._id; return d; });
        };
        obj.setSetting = function (id, value) {
            var doc = Object.assign({}, value || {}); delete doc._id;
            return ready().then(function () { return obj.settingsFile.replaceOne({ _id: id }, doc, { upsert: true }); }).then(function () { return value; });
        };
        obj.updateDBVersion = function (v) { return obj.setSetting('db_version', { version: v }); };
        obj.getDBVersion = function () {
            return obj.getSetting('db_version').then(function (d) { return (d && d.version != null) ? d.version : 1; }).catch(function () { return 1; });
        };
        obj.ready = function () { return obj._ready; };
        obj._ready.then(function () { return obj.applyRetention(); }).then(function () { obj.startMaintenance(); }).catch(function () { });
        return obj;
    }

    // NeDB (plugin-private files)
    console.log('CONNSTATS: storage backend = nedb (plugin-private files)');
    Datastore = loadModule(['@seald-io/nedb', '@yetzt/nedb', 'nedb']); // same fallback order as MeshCentral itself
    var setCompaction = function (store) {
        if (typeof store.setAutocompactionInterval == 'function') store.setAutocompactionInterval(COMPACTION_INTERVAL_MS);
        else store.persistence.setAutocompactionInterval(COMPACTION_INTERVAL_MS);
    };
    obj.sessionsFile = new Datastore({ filename: meshserver.getConfigFilePath('plugin-connectionstats-sessions.db'), autoload: true });
    setCompaction(obj.sessionsFile);
    // all at top level: an ensureIndex issued from inside another store callback is built in
    // memory but never written to the datafile
    ['nodeid', 'meshid', 'userid', 'start', 'end'].forEach(function (f) { obj.sessionsFile.ensureIndex({ fieldName: f }); });
    obj.settingsFile = new Datastore({ filename: meshserver.getConfigFilePath('plugin-connectionstats-settings.db'), autoload: true });
    setCompaction(obj.settingsFile);

    // NeDB's classic API is callback-only and update() returns undefined, so everything is wrapped
    var cb = function (resolve, reject) { return function (err, r) { if (err) reject(err); else resolve(r); }; };

    obj.upsertSession = function (doc) {
        doc = normDoc(doc);
        return new Promise(function (resolve, reject) {
            obj.sessionsFile.update({ _id: doc._id }, doc, { upsert: true }, function (err) { if (err) reject(err); else resolve(doc); });
        });
    };
    obj.updateSession = function (id, patch) {
        return new Promise(function (resolve, reject) {
            obj.sessionsFile.update({ _id: id }, { $set: patch }, {}, cb(resolve, reject));
        });
    };
    obj.getSession = function (id) {
        return new Promise(function (resolve, reject) { obj.sessionsFile.findOne({ _id: id }, cb(resolve, reject)); });
    };
    obj.removeSession = function (id) {
        return new Promise(function (resolve, reject) { obj.sessionsFile.remove({ _id: id }, {}, cb(resolve, reject)); });
    };
    obj.getOpenSessions = function (domain) {
        var q = { end: null };
        if (domain != null) q.domain = domain;
        return new Promise(function (resolve, reject) { obj.sessionsFile.find(q).sort({ start: 1 }).exec(cb(resolve, reject)); });
    };
    obj.findSessions = function (filter) {
        var q = buildDocQuery(normFilter(filter));
        return new Promise(function (resolve, reject) { obj.sessionsFile.find(q).sort({ start: -1 }).exec(cb(resolve, reject)); });
    };
    obj.firstSession = function (filter) {
        var q = buildDocQuery(normFilter(filter));
        return new Promise(function (resolve, reject) { obj.sessionsFile.find(q).sort({ start: 1 }).limit(1).exec(cb(resolve, reject)); }).then(function (r) { return (r && r[0]) || null; });
    };
    obj.listSessions = function (filter, page) {
        var q = buildDocQuery(normFilter(filter)), p = normPage(page);
        return new Promise(function (resolve, reject) {
            obj.sessionsFile.count(q, function (err, total) {
                if (err) { reject(err); return; }
                obj.sessionsFile.find(q).sort({ start: -1, _id: -1 }).skip(p.skip).limit(p.limit).exec(function (err2, rows) {
                    if (err2) reject(err2); else resolve({ rows: rows || [], total: total || 0 });
                });
            });
        });
    };

    // Deleting a large set in one NeDB call is not an option, for two separate reasons:
    //   - remove(..., {multi:true}) resolves its candidates with validDocs.push(...docs), which
    //     throws "RangeError: Maximum call stack size exceeded" past roughly 100k documents;
    //   - removing tens of thousands of documents in one call blocks the event loop for seconds.
    // find() uses a different code path and is safe at any size, so collect the ids first and
    // delete them in bounded batches, yielding between batches.
    var removeInChunks = function (query) {
        return new Promise(function (resolve, reject) {
            var removed = 0;
            obj.sessionsFile.find(query, { _id: 1 }).exec(function (err, docs) {
                if (err) { reject(err); return; }
                if (docs == null || docs.length == 0) { resolve(0); return; }
                var ids = docs.map(function (d) { return d._id; });
                var at = 0;
                var step = function () {
                    if (obj._closed || at >= ids.length) { resolve(removed); return; }
                    var slice = ids.slice(at, at + NEDB_DELETE_CHUNK);
                    at += NEDB_DELETE_CHUNK;
                    obj.sessionsFile.remove({ _id: { $in: slice } }, { multi: true }, function (e2, n) {
                        if (e2) { reject(e2); return; }
                        removed += n;
                        setTimeout(step, 10);   // let the server serve requests between batches
                    });
                };
                step();
            });
        });
    };
    obj.sweepRetention = function (days) {
        if (obj._sweeping) return Promise.resolve(0);
        obj._sweeping = true;
        var cutoff = Date.now() - (Number(days) || DEFAULT_RETENTION_DAYS) * 86400000;
        // NeDB sorts null below numbers: a bare { end: { $lt } } would delete every open session
        return removeInChunks({ $and: [{ end: { $ne: null } }, { end: { $lt: cutoff } }] })
        .then(function (n) {
            obj._sweeping = false;
            if (n > 0) console.log('CONNSTATS: retention removed ' + n + ' sessions older than ' + new Date(cutoff).toISOString());
            return n;
        }, function (e) { obj._sweeping = false; throw e; });
    };
    obj.getSetting = function (id) {
        return new Promise(function (resolve, reject) {
            obj.settingsFile.findOne({ _id: id }, function (err, d) {
                if (err) { reject(err); return; }
                if (d == null) { resolve(null); return; }
                delete d._id; resolve(d);
            });
        });
    };
    obj.setSetting = function (id, value) {
        var doc = Object.assign({ _id: id }, value || {}); doc._id = id;
        return new Promise(function (resolve, reject) {
            obj.settingsFile.update({ _id: id }, doc, { upsert: true }, function (err) { if (err) reject(err); else resolve(value); });
        });
    };
    obj.updateDBVersion = function (v) { return obj.setSetting('db_version', { version: v }); };
    obj.getDBVersion = function () {
        return obj.getSetting('db_version').then(function (d) { return (d && d.version != null) ? d.version : 1; }).catch(function () { return 1; });
    };
    obj._ready = Promise.resolve();
    obj.ready = function () { return obj._ready; };
    obj.applyRetention().then(function () { obj.startMaintenance(); });
    return obj;
};

module.exports.helpers = { normFilter: normFilter, normPage: normPage, normDoc: normDoc, buildDocQuery: buildDocQuery, cleanStrList: cleanStrList, intOr: intOr, TYPES: TYPES, DEFAULT_RETENTION_DAYS: DEFAULT_RETENTION_DAYS };
