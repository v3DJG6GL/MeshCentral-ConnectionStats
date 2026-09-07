/**
* @description MeshCentral-ConnectionStats SQL storage backend (PostgreSQL / MariaDB / MySQL / SQLite)
* @license Apache-2.0
*
* MeshCentral keeps its own connection for these engines private (only SQLite exposes db.file), so
* pg / MariaDB / MySQL get a small pool of their own built from the same meshcentral config, while
* SQLite shares MeshCentral's handle - opening a second handle on the same file would fight it for
* the write lock and miss its PRAGMA setup. Either way the tables live in MeshCentral's own
* database, so whatever backs it up covers them too.
*/

"use strict";

const T_SES = 'plugin_connectionstats_sessions';
const T_SET = 'plugin_connectionstats_settings';
// 'end' is reserved in PostgreSQL, so the two timestamps are start_ms / end_ms in the table and
// start / end in the documents. 'doc' keeps any key that has no column of its own.
const SESCOLS = ['id', 'domain', 'nodeid', 'meshid', 'userid', 'username', 'guest', 'type', 'protocol', 'start_ms', 'end_ms',
    'seconds', 'active', 'lastbeat', 'bytesin', 'bytesout', 'ip', 'source', 'truncated', 'nodename', 'meshname', 'doc'];
const COLOF = { start: 'start_ms', end: 'end_ms' };   // document key -> column when they differ
const SWEEP_CHUNK = 5000;

// Connection settings, accepting both shapes MeshCentral accepts (a URL string or an object with
// an ssl block naming certificate files). MeshCentral defaults a missing database name to
// 'meshcentral' but applies it to a CLONE of the config (its db.js), so args still has no
// database - the caller must apply the same default or every query fails with "no database
// selected". Parsing never throws: this runs inside server_startup, which has no error handling.
function connConfig(raw) {
    if (raw == null) return {};
    if (typeof raw == 'string') {
        var c = {};
        try {
            var u = new URL(raw);
            c.host = decodeURIComponent(u.hostname);
            if (u.port) c.port = Number(u.port);
            if (u.username) c.user = decodeURIComponent(u.username);
            if (u.password) c.password = decodeURIComponent(u.password);
            var dbn = decodeURIComponent(String(u.pathname || '').replace(/^\//, ''));
            if (dbn != '') c.database = dbn;
        } catch (e) {
            // not a URL: fall back to how MeshCentral itself splits a connection string
            var parts = raw.split(/[:@/]+/);
            if (parts.length >= 5) { c.user = parts[1]; c.password = parts[2]; c.host = parts[3]; c.port = Number(parts[4]); if (parts[5]) c.database = parts[5]; }
            else { console.log('CONNSTATS: could not parse the database connection string'); }
        }
        return c;
    }
    var o = Object.assign({}, raw);
    if (o.ssl != null && typeof o.ssl == 'object') {
        var fs = require('fs'), ssl = {};
        try {
            if (o.ssl.cacertpath) ssl.ca = fs.readFileSync(o.ssl.cacertpath);
            if (o.ssl.clientcertpath) ssl.cert = fs.readFileSync(o.ssl.clientcertpath);
            if (o.ssl.clientkeypath) ssl.key = fs.readFileSync(o.ssl.clientkeypath);
        } catch (e) { console.log('CONNSTATS: could not read a TLS certificate file: ' + e.message); }
        if (o.ssl.dontcheckserveridentity === true) ssl.rejectUnauthorized = false;
        o.ssl = ssl;
    }
    return o;
}

function toNum(v) {
    if (v == null) return null;
    if (typeof v == 'bigint') return Number(v);          // mariadb/mysql BIGINT
    var n = Number(v);                                    // pg returns BIGINT and COUNT(*) as strings
    return isNaN(n) ? null : n;
}
function parseDoc(v) {
    if (v == null) return {};
    if (typeof v == 'string') { try { return JSON.parse(v); } catch (e) { return {}; } }
    if (Buffer.isBuffer(v)) { try { return JSON.parse(v.toString('utf8')); } catch (e) { return {}; } }
    return v;
}
function trunc(v, n) {
    if (v == null) return null;
    v = String(v);
    return (v.length > n) ? v.substring(0, n) : v;
}

// WHERE clause for findSessions / listSessions from a normalised filter. Pure: takes the dialect
// helpers as an argument so it can be unit-tested without a database.
//   D.kind: 'pg' | 'mariadb' | 'mysql' | 'sqlite'; D.ph(i): placeholder for parameter number i
function buildWhere(f, D) {
    var p = [], w = [];
    var ph = function (v) { p.push(v); return D.ph(p.length); };
    w.push('domain = ' + ph(f.domain));
    w.push('start_ms < ' + ph(f.end));
    w.push('(end_ms IS NULL OR end_ms > ' + ph(f.start) + ')');
    var inList = function (col, values) {
        if (D.kind == 'pg') return col + ' = ANY(' + ph(values) + '::text[])';                       // one array parameter
        if (D.kind == 'sqlite') return col + ' IN (SELECT value FROM json_each(' + ph(JSON.stringify(values)) + '))';  // one JSON parameter, no 999-variable limit
        return col + ' IN (' + values.map(function (v) { return ph(v); }).join(',') + ')';        // mysql / mariadb
    };
    if (f.nodeids) w.push(inList('nodeid', f.nodeids));
    if (f.meshids) w.push(inList('meshid', f.meshids));
    if (f.userids) w.push(inList('userid', f.userids));
    if (f.types) w.push(inList('type', f.types));
    if (!f.includeGuests) w.push('guest IS NULL');
    return { sql: w.join(' AND '), params: p };
}

// install the SQL implementation onto the object CreateDB built (which already carries the
// backend-independent helpers from db.js)
function install(obj, meshserver, kind, shared) {
    var pool = null, mysqlPool = null;
    var D = { kind: kind };

    // ---- dialect ---------------------------------------------------------
    if (kind == 'pg') {
        var pg = shared.loadModule(['pg']);
        var pgcfg = Object.assign({}, connConfig(meshserver.args.postgres), { max: 3 });
        if (pgcfg.database == null) pgcfg.database = 'meshcentral';
        pool = new pg.Pool(pgcfg);
        // without this an idle connection error is an unhandled 'error' event and takes the server down
        pool.on('error', function (e) { console.log('CONNSTATS: postgres pool error: ' + (e.message || e)); });
        D.query = function (sql, params) {
            return pool.query(sql, params || []).then(function (r) { return { rows: r.rows || [], affected: r.rowCount || 0 }; });
        };
        D.ph = function (i) { return '$' + i; };
        D.jsonType = 'JSON';
        D.end = function () { return pool.end(); };
    } else if (kind == 'mariadb') {
        var mariadb = shared.loadModule(['mariadb']);
        var macfg = Object.assign({}, connConfig(meshserver.args.mariadb), {
            connectionLimit: 3, bigIntAsNumber: true, insertIdAsNumber: true, decimalAsNumber: true
        });
        if (macfg.database == null) macfg.database = 'meshcentral';   // same default MeshCentral applies
        pool = mariadb.createPool(macfg);
        D.query = function (sql, params) {
            return pool.query(sql, params || []).then(function (r) {
                if (Array.isArray(r)) return { rows: r, affected: r.length };
                return { rows: [], affected: toNum(r.affectedRows) || 0 };
            });
        };
        D.ph = function () { return '?'; };
        D.jsonType = 'JSON';
        D.end = function () { return pool.end(); };
    } else if (kind == 'mysql') {
        var mysql2 = shared.loadModule(['mysql2']);
        var mycfg = Object.assign({}, connConfig(meshserver.args.mysql), { connectionLimit: 3, waitForConnections: true });
        if (mycfg.database == null) mycfg.database = 'meshcentral';   // same default MeshCentral applies
        mysqlPool = mysql2.createPool(mycfg);
        pool = mysqlPool.promise();
        D.query = function (sql, params) {
            // query(), not execute(): no prepared-statement cache to grow, and array params stay literal
            return pool.query(sql, params || []).then(function (res) {
                var r = res[0];
                if (Array.isArray(r)) return { rows: r, affected: r.length };
                return { rows: [], affected: toNum(r.affectedRows) || 0 };
            });
        };
        D.ph = function () { return '?'; };
        D.jsonType = 'JSON';
        D.end = function () { return new Promise(function (res) { mysqlPool.end(function () { res(); }); }); };
    } else { // sqlite: share MeshCentral's handle, looked up per query in case MeshCentral reopens it
        D.query = function (sql, params) {
            return new Promise(function (resolve, reject) {
                var sqlite = meshserver.db.file;
                if (sqlite == null) { reject(new Error('SQLite handle not available')); return; }
                if (/^\s*(SELECT|WITH|PRAGMA)/i.test(sql)) {
                    sqlite.all(sql, params || [], function (err, rows) {
                        if (err) reject(err); else resolve({ rows: rows || [], affected: (rows || []).length });
                    });
                } else {
                    sqlite.run(sql, params || [], function (err) {   // a function, not an arrow: this.changes
                        if (err) reject(err); else resolve({ rows: [], affected: this.changes || 0 });
                    });
                }
            });
        };
        D.ph = function () { return '?'; };
        D.jsonType = 'TEXT';
        D.end = function () { return Promise.resolve(); };   // not ours to close
    }
    var isMy = (kind == 'mysql' || kind == 'mariadb');

    // ---- schema ----------------------------------------------------------
    function ddl() {
        var stmts = [];
        if (isMy) {
            stmts.push('CREATE TABLE IF NOT EXISTS ' + T_SES + ' (' +
                'id VARCHAR(256) NOT NULL, domain VARCHAR(64) NOT NULL, nodeid VARCHAR(256), meshid VARCHAR(256), ' +
                'userid VARCHAR(256), username VARCHAR(256), guest VARCHAR(256) NULL, type VARCHAR(16) NOT NULL, protocol INT, ' +
                'start_ms BIGINT NOT NULL, end_ms BIGINT NULL, seconds INT NOT NULL DEFAULT 0, active INT NULL, lastbeat BIGINT NULL, ' +
                'bytesin BIGINT NOT NULL DEFAULT 0, bytesout BIGINT NOT NULL DEFAULT 0, ip VARCHAR(64), ' +
                "source VARCHAR(16) NOT NULL DEFAULT 'live', truncated TINYINT(1) NOT NULL DEFAULT 0, " +
                'nodename VARCHAR(256), meshname VARCHAR(256), doc JSON, PRIMARY KEY (id), ' +
                'INDEX ' + T_SES + '_dom_start (domain, start_ms), INDEX ' + T_SES + '_node_start (nodeid, start_ms), ' +
                'INDEX ' + T_SES + '_user_start (userid, start_ms), INDEX ' + T_SES + '_mesh_start (meshid, start_ms), ' +
                'INDEX ' + T_SES + '_end (end_ms)' +
                ') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
            stmts.push('CREATE TABLE IF NOT EXISTS ' + T_SET + ' (' +
                'id VARCHAR(256) NOT NULL, type VARCHAR(32) NOT NULL, extra VARCHAR(256), doc JSON, ' +
                'PRIMARY KEY (id), INDEX ' + T_SET + '_type_extra (type, extra)' +
                ') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
        } else {
            var vc = function (n) { return (kind == 'pg') ? ('VARCHAR(' + n + ')') : 'TEXT'; };
            var big = (kind == 'pg') ? 'BIGINT' : 'INTEGER';
            var bool = (kind == 'pg') ? 'BOOLEAN NOT NULL DEFAULT FALSE' : 'INTEGER NOT NULL DEFAULT 0';
            stmts.push('CREATE TABLE IF NOT EXISTS ' + T_SES + ' (' +
                'id ' + vc(256) + ' PRIMARY KEY NOT NULL, domain ' + vc(64) + ' NOT NULL, nodeid ' + vc(256) + ', meshid ' + vc(256) + ', ' +
                'userid ' + vc(256) + ', username ' + vc(256) + ', guest ' + vc(256) + ', type ' + vc(16) + ' NOT NULL, protocol INTEGER, ' +
                'start_ms ' + big + ' NOT NULL, end_ms ' + big + ', seconds INTEGER NOT NULL DEFAULT 0, active INTEGER, lastbeat ' + big + ', ' +
                'bytesin ' + big + ' NOT NULL DEFAULT 0, bytesout ' + big + ' NOT NULL DEFAULT 0, ip ' + vc(64) + ', ' +
                "source " + vc(16) + " NOT NULL DEFAULT 'live', truncated " + bool + ', ' +
                'nodename ' + vc(256) + ', meshname ' + vc(256) + ', doc ' + D.jsonType + ')');
            stmts.push('CREATE INDEX IF NOT EXISTS ' + T_SES + '_dom_start ON ' + T_SES + ' (domain, start_ms DESC)');
            stmts.push('CREATE INDEX IF NOT EXISTS ' + T_SES + '_node_start ON ' + T_SES + ' (nodeid, start_ms DESC)');
            stmts.push('CREATE INDEX IF NOT EXISTS ' + T_SES + '_user_start ON ' + T_SES + ' (userid, start_ms DESC)');
            stmts.push('CREATE INDEX IF NOT EXISTS ' + T_SES + '_mesh_start ON ' + T_SES + ' (meshid, start_ms DESC)');
            stmts.push('CREATE INDEX IF NOT EXISTS ' + T_SES + '_end ON ' + T_SES + ' (end_ms)');
            stmts.push('CREATE TABLE IF NOT EXISTS ' + T_SET + ' (' +
                'id ' + vc(256) + ' PRIMARY KEY NOT NULL, type ' + vc(32) + ' NOT NULL, extra ' + vc(256) + ', doc ' + D.jsonType + ')');
            stmts.push('CREATE INDEX IF NOT EXISTS ' + T_SET + '_type_extra ON ' + T_SET + ' (type, extra)');
        }
        return stmts.reduce(function (p, s) { return p.then(function () { return D.query(s, []); }); }, Promise.resolve());
    }

    // ---- init / ready ----------------------------------------------------
    // Every public call goes through ready(). A failed init is retried rather than cached, and the
    // plugin never quietly falls back to its own files. The steps that follow the schema go through
    // the public API, so they run after ready() resolves, not inside it.
    function ready() {
        if (obj._ready != null) return obj._ready;
        obj._ready = ddl()
        .catch(function (e) {
            obj._ready = null;   // not cached: the retry below (or the next call) tries again
            obj._retry = Math.min((obj._retry || 30000) * 2, 900000);
            console.log('CONNSTATS: ' + kind + ' initialisation failed, retrying in ' + Math.round(obj._retry / 1000) + 's: ' + (e.message || e));
            // one pending retry at a time, so a long outage cannot pile up dead handles
            if (obj._retryTimer != null) { try { clearTimeout(obj._retryTimer); } catch (e3) { } }
            obj._retryTimer = setTimeout(function () { obj._retryTimer = null; bootstrap(); }, obj._retry);
            try { obj._retryTimer.unref(); } catch (e2) { }
            throw e;
        });
        return obj._ready;
    }

    function bootstrap() {
        obj.initialized = ready()
        .then(function () { return obj.applyRetention(); })
        .then(function () { return obj.getDBVersion(); })
        .then(function (v) { if (v < obj.dbVersion) return obj.updateDBVersion(obj.dbVersion); return null; })
        .then(function () {
            obj._retry = null;   // a later outage starts from the short backoff again
            obj.startMaintenance();
            console.log('CONNSTATS: ' + kind + ' storage ready');
        })
        .catch(function () { return null; });   // already logged; the retry timer takes it from here
        return obj.initialized;
    }
    // resolves when the backend is fully usable (schema, retention setting)
    obj.ready = function () { return obj.initialized; };

    // ---- generic document helpers (settings table) -----------------------
    function putDoc(id, type, extra, doc) {
        var body = JSON.stringify(doc || {});   // always a string: pg would read a raw array as an array literal
        var p = [id, type, extra, body];
        var sql;
        if (isMy) {
            sql = 'INSERT INTO ' + T_SET + ' (id,type,extra,doc) VALUES (?,?,?,?) ' +
                  'ON DUPLICATE KEY UPDATE type=VALUES(type), extra=VALUES(extra), doc=VALUES(doc)';
        } else {
            sql = 'INSERT INTO ' + T_SET + ' (id,type,extra,doc) VALUES (' + D.ph(1) + ',' + D.ph(2) + ',' + D.ph(3) + ',' + D.ph(4) + ') ' +
                  'ON CONFLICT (id) DO UPDATE SET type=EXCLUDED.type, extra=EXCLUDED.extra, doc=EXCLUDED.doc';
        }
        return D.query(sql, p);
    }
    function getDoc(id) {
        return D.query('SELECT id, doc FROM ' + T_SET + ' WHERE id = ' + D.ph(1), [id])
        .then(function (r) { return r.rows[0] ? parseDoc(r.rows[0].doc) : null; });
    }

    // ---- sessions --------------------------------------------------------
    var boolOut = function (v) { return (kind == 'pg') ? !!v : (v ? 1 : 0); };
    function docToRow(d) {
        d = shared.normDoc(d);
        var extra = {};
        for (var k in d) { if (SESCOLS.indexOf(COLOF[k] || k) < 0 && k != '_id') extra[k] = d[k]; }
        return {
            id: d._id, domain: d.domain, nodeid: d.nodeid, meshid: d.meshid, userid: d.userid, username: d.username, guest: d.guest,
            type: d.type, protocol: d.protocol, start_ms: d.start, end_ms: d.end, seconds: d.seconds, active: d.active, lastbeat: d.lastbeat,
            bytesin: d.bytesin, bytesout: d.bytesout, ip: d.ip, source: d.source, truncated: boolOut(d.truncated),
            nodename: d.nodename, meshname: d.meshname, doc: JSON.stringify(extra)
        };
    }
    function rowToSession(r) {
        var d = parseDoc(r.doc);
        d._id = r.id; d.domain = r.domain; d.nodeid = r.nodeid; d.meshid = r.meshid; d.userid = r.userid; d.username = r.username;
        d.guest = (r.guest == null) ? null : r.guest; d.type = r.type; d.protocol = toNum(r.protocol);
        d.start = toNum(r.start_ms); d.end = (r.end_ms == null) ? null : toNum(r.end_ms);
        d.seconds = toNum(r.seconds) || 0; d.active = (r.active == null) ? null : toNum(r.active); d.lastbeat = (r.lastbeat == null) ? null : toNum(r.lastbeat);
        d.bytesin = toNum(r.bytesin) || 0; d.bytesout = toNum(r.bytesout) || 0; d.ip = r.ip; d.source = r.source;
        d.truncated = !!toNum(r.truncated); d.nodename = r.nodename; d.meshname = r.meshname;
        return d;
    }

    obj.upsertSession = function (doc) {
        var row = docToRow(doc);
        var params = SESCOLS.map(function (c) { return row[c]; });
        var sql;
        if (isMy) {
            sql = 'INSERT INTO ' + T_SES + ' (' + SESCOLS.join(',') + ') VALUES (' + SESCOLS.map(function () { return '?'; }).join(',') + ') ' +
                  'ON DUPLICATE KEY UPDATE ' + SESCOLS.slice(1).map(function (c) { return c + '=VALUES(' + c + ')'; }).join(', ');
        } else {
            sql = 'INSERT INTO ' + T_SES + ' (' + SESCOLS.join(',') + ') VALUES (' + SESCOLS.map(function (c, i) { return D.ph(i + 1); }).join(',') + ') ' +
                  'ON CONFLICT (id) DO UPDATE SET ' + SESCOLS.slice(1).map(function (c) { return c + '=EXCLUDED.' + c; }).join(', ');
        }
        return ready().then(function () { return D.query(sql, params); }).then(function () { return doc; });
    };

    // column-level update: concurrent patches (a heartbeat and the end event) never clobber each
    // other. Keys without a column go into doc via read-merge-write.
    obj.updateSession = function (id, patch) {
        var sets = [], p = [], extra = null;
        for (var k in patch) {
            var col = COLOF[k] || k;
            if (k == '_id' || k == 'id') continue;
            if (SESCOLS.indexOf(col) >= 0 && col != 'doc') {
                var v = patch[k];
                if (col == 'truncated') v = boolOut(v);
                p.push(v); sets.push(col + ' = ' + D.ph(p.length));
            } else { if (extra == null) extra = {}; extra[k] = patch[k]; }
        }
        return ready().then(function () {
            var work = Promise.resolve(0);
            if (sets.length) {
                p.push(id);
                work = D.query('UPDATE ' + T_SES + ' SET ' + sets.join(', ') + ' WHERE id = ' + D.ph(p.length), p).then(function (r) { return r.affected; });
            }
            if (extra == null) return work;
            return work.then(function (n) {
                return D.query('SELECT doc FROM ' + T_SES + ' WHERE id = ' + D.ph(1), [id]).then(function (r) {
                    if (!r.rows[0]) return n;
                    var d = Object.assign(parseDoc(r.rows[0].doc), extra);
                    return D.query('UPDATE ' + T_SES + ' SET doc = ' + D.ph(1) + ' WHERE id = ' + D.ph(2), [JSON.stringify(d), id]).then(function () { return n || 1; });
                });
            });
        });
    };
    obj.getSession = function (id) {
        return ready().then(function () { return D.query('SELECT * FROM ' + T_SES + ' WHERE id = ' + D.ph(1), [id]); })
        .then(function (r) { return r.rows[0] ? rowToSession(r.rows[0]) : null; });
    };
    obj.removeSession = function (id) {
        return ready().then(function () { return D.query('DELETE FROM ' + T_SES + ' WHERE id = ' + D.ph(1), [id]); })
        .then(function (r) { return r.affected; });
    };
    obj.getOpenSessions = function (domain) {
        var sql = 'SELECT * FROM ' + T_SES + ' WHERE end_ms IS NULL', p = [];
        if (domain != null) { sql += ' AND domain = ' + D.ph(1); p.push(domain); }
        sql += ' ORDER BY start_ms';
        return ready().then(function () { return D.query(sql, p); }).then(function (r) { return r.rows.map(rowToSession); });
    };
    obj.findSessions = function (filter) {
        var w = buildWhere(shared.normFilter(filter), D);
        return ready().then(function () { return D.query('SELECT * FROM ' + T_SES + ' WHERE ' + w.sql + ' ORDER BY start_ms DESC', w.params); })
        .then(function (r) { return r.rows.map(rowToSession); });
    };
    obj.firstSession = function (filter) {
        var w = buildWhere(shared.normFilter(filter), D);
        return ready().then(function () { return D.query('SELECT * FROM ' + T_SES + ' WHERE ' + w.sql + ' ORDER BY start_ms ASC LIMIT 1', w.params); })
        .then(function (r) { return r.rows.length ? rowToSession(r.rows[0]) : null; });
    };
    obj.listSessions = function (filter, page) {
        var w = buildWhere(shared.normFilter(filter), D), pg = shared.normPage(page);
        return ready().then(function () {
            return D.query('SELECT COUNT(*) AS n FROM ' + T_SES + ' WHERE ' + w.sql, w.params)
            .then(function (cr) {
                var total = toNum(cr.rows[0] && cr.rows[0].n) || 0;
                // limit/offset are inlined: normPage already clamps them to 1..1000 / >=0
                return D.query('SELECT * FROM ' + T_SES + ' WHERE ' + w.sql + ' ORDER BY start_ms DESC, id DESC LIMIT ' + pg.limit + ' OFFSET ' + pg.skip, w.params)
                .then(function (r) { return { rows: r.rows.map(rowToSession), total: total }; });
            });
        });
    };

    // Chunked so a first sweep over a large table does not hold row locks for minutes. Open
    // sessions (end_ms IS NULL) are never touched.
    obj.sweepRetention = function (days) {
        if (obj._sweeping) return Promise.resolve(0);
        obj._sweeping = true;
        var cutoff = Date.now() - (Number(days) || shared.DEFAULT_RETENTION_DAYS) * 86400000;
        var removed = 0;
        var step = function () {
            if (obj._closed) return Promise.resolve();
            var sql;
            if (isMy) sql = 'DELETE FROM ' + T_SES + ' WHERE end_ms IS NOT NULL AND end_ms < ? ORDER BY end_ms LIMIT ' + SWEEP_CHUNK;
            else sql = 'DELETE FROM ' + T_SES + ' WHERE id IN (SELECT id FROM ' + T_SES + ' WHERE end_ms IS NOT NULL AND end_ms < ' + D.ph(1) + ' ORDER BY end_ms LIMIT ' + SWEEP_CHUNK + ')';
            return D.query(sql, [cutoff]).then(function (r) {
                removed += r.affected;
                if (r.affected < SWEEP_CHUNK) return null;
                return new Promise(function (res) { var t = setTimeout(res, 250); try { t.unref(); } catch (e) { } }).then(step);   // let other queries through
            });
        };
        return ready().then(step)
        .then(function () {
            obj._sweeping = false;
            if (removed > 0) console.log('CONNSTATS: retention removed ' + removed + ' sessions older than ' + new Date(cutoff).toISOString());
            return removed;
        }, function (e) { obj._sweeping = false; throw e; });
    };

    // ---- settings / version ---------------------------------------------
    obj.getSetting = function (id) {
        return ready().then(function () { return getDoc(id); });
    };
    obj.setSetting = function (id, value) {
        var doc = Object.assign({}, value || {}); delete doc._id;
        return ready().then(function () { return putDoc(id, 'setting', null, doc); }).then(function () { return value; });
    };
    obj.updateDBVersion = function (v) { return obj.setSetting('db_version', { version: v }); };
    obj.getDBVersion = function () {
        return obj.getSetting('db_version').then(function (d) { return (d && d.version != null) ? d.version : 1; }).catch(function () { return 1; });
    };

    // internal escape hatch (diagnostics / tests): run a statement on this backend
    obj.__q = function (sql, params) { return ready().then(function () { return D.query(sql, params || []); }); };

    obj._backendClose = function () {
        if (obj._retryTimer != null) { try { clearTimeout(obj._retryTimer); } catch (e) { } obj._retryTimer = null; }
        try { D.end(); } catch (e) { }
    };

    bootstrap();
    return obj;
}

module.exports = { install: install, buildWhere: buildWhere, connConfig: connConfig, toNum: toNum, SESCOLS: SESCOLS };
