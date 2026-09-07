/**
* @description MeshCentral-ConnectionStats: import of relay events from MeshCentral backups
* @license Apache-2.0
*
* MeshCentral removes events after 20 days, but its automatic backups keep them: every backup zip
* holds the NeDB events file (meshcentral-data/meshcentral-events.db) or, for the other databases,
* a dump at the root of the zip (mongodump archive, mysqldump or pg_dump SQL, SQLite copy). This
* module reads any of those, plus the same files outside a zip and mongoexport JSON, and hands the
* relay events it finds to the caller. Files are recognised by content, never by name alone.
*/

"use strict";

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');

const ARCHIVE_MAGIC = 0x8199e26d;   // mongodump archive, little endian
const TERMINATOR = 0xffffffff;

// Resolve a module from the plugin folder first, then from MeshCentral's own tree.
function loadModule(names) {
    var lastErr = null;
    for (var i in names) {
        try { return require(names[i]); } catch (e) { lastErr = e; }
        try { if (require.main && typeof require.main.require == 'function') return require.main.require(names[i]); } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('Module not found: ' + names.join(', '));
}

// ---- event normalisation --------------------------------------------------

// Time comes in every shape the sources use: a Date (mongodump), {$$date: ms} (NeDB file),
// {$date: iso|ms|{$numberLong}} (mongoexport), an ISO string (SQL dumps) or a number.
function normTime(t) {
    if (t == null) return null;
    if (t instanceof Date) return t;
    if (typeof t == 'number') return new Date(t);
    if (typeof t == 'string') { var d = new Date(t); return isNaN(d) ? null : d; }
    if (typeof t == 'object') {
        if (t.$$date != null) return normTime(t.$$date);
        if (t.$date != null) {
            if (typeof t.$date == 'object' && t.$date.$numberLong != null) return new Date(Number(t.$date.$numberLong));
            return normTime(t.$date);
        }
    }
    return null;
}

// Keep only relay log events, with a usable time. `want` is the set of msgids the caller cares about.
function relayEvent(doc, want) {
    if (doc == null || typeof doc != 'object' || doc.etype != 'relay' || doc.action != 'relaylog') return null;
    if (want != null && want.indexOf(Number(doc.msgid)) < 0) return null;
    var t = normTime(doc.time);
    if (t == null) return null;
    var e = Object.assign({}, doc);
    e.time = t;
    return e;
}

// ---- format detection -----------------------------------------------------

// What a buffer holding the first bytes of a file looks like.
function sniff(head) {
    if (head.length >= 4 && head[0] == 0x50 && head[1] == 0x4b && head[2] == 0x03 && head[3] == 0x04) return 'zip';
    if (head.length >= 2 && head[0] == 0x1f && head[1] == 0x8b) return 'gzip';
    if (head.length >= 4 && head.readUInt32LE(0) == ARCHIVE_MAGIC) return 'mongodump';
    if (head.length >= 16 && head.toString('latin1', 0, 15) == 'SQLite format 3') return 'sqlite';
    var text = head.toString('utf8', 0, Math.min(head.length, 4096)).replace(/^﻿/, '');
    var first = text.replace(/^\s+/, '');
    if (first[0] == '{') return 'jsonl';
    if (first[0] == '[') return 'jsonarray';
    if (/^--\s*MySQL dump|^-- MariaDB dump|^\/\*!40|^-- Dump completed|INSERT INTO `?events`?/i.test(text) || /^-- Host: /m.test(text)) return 'mysqldump';
    if (/^--\s*PostgreSQL database dump|^COPY /m.test(text) || /^SET statement_timeout/m.test(text)) return 'pgdump';
    if (/^-- /.test(first) || /^\/\*/.test(first)) return 'sql';   // some SQL dump, decided while reading
    return 'unknown';
}

// ---- readers: each calls onEvent(doc) for every raw event document and resolves when done ----

function readLines(stream, onLine) {
    return new Promise(function (resolve, reject) {
        var rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        var failed = false;
        rl.on('line', function (l) { if (failed) return; try { onLine(l); } catch (e) { failed = true; reject(e); rl.close(); } });
        rl.on('close', function () { if (!failed) resolve(); });
        stream.on('error', function (e) { failed = true; reject(e); });
    });
}

// NeDB datafile (one JSON document per line, later lines override earlier ones) and mongoexport
// JSON lines. Events are only ever inserted, so a plain pass is enough; NeDB bookkeeping lines
// ($$indexCreated, $$deleted) are skipped.
function readJsonLines(stream, onDoc) {
    return readLines(stream, function (line) {
        line = line.trim();
        if (line == '' || line[0] != '{') return;
        var d;
        try { d = JSON.parse(line); } catch (e) { return; }   // a torn last line of a live datafile
        if (d.$$indexCreated != null || d.$$deleted != null) return;
        onDoc(d);
    });
}

// mongoexport --jsonArray: the whole file is one array. Read it in full.
function readJsonArray(stream, onDoc) {
    return new Promise(function (resolve, reject) {
        var chunks = [];
        stream.on('data', function (c) { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c), 'utf8')); });
        stream.on('error', reject);
        stream.on('end', function () {
            var arr;
            try { arr = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '')); } catch (e) { reject(new Error('The JSON file could not be parsed: ' + e.message)); return; }
            if (!Array.isArray(arr)) { reject(new Error('The JSON file is not an array of events')); return; }
            try { arr.forEach(onDoc); } catch (e) { reject(e); return; }
            resolve();
        });
    });
}

// mysqldump / mariadb-dump: "INSERT INTO `events` VALUES (..),(..);" with the doc column last.
// The value list is tokenised properly (quotes, backslash escapes, NULL), one statement per line.
function mysqlValues(s, pos, out) {
    // parse one parenthesised tuple starting at s[pos] == '(' ; returns the position after ')'
    var vals = [], i = pos + 1, n = s.length;
    while (i < n) {
        var ch = s[i];
        if (ch == ' ' || ch == ',') { i++; continue; }
        if (ch == ')') { out.push(vals); return i + 1; }
        if (ch == "'" || ch == '"') {
            var q = ch, buf = ''; i++;
            while (i < n) {
                var c = s[i];
                if (c == '\\' && i + 1 < n) {
                    var e = s[i + 1];
                    buf += (e == 'n') ? '\n' : (e == 'r') ? '\r' : (e == 't') ? '\t' : (e == '0') ? '\0' : (e == 'b') ? '\b' : (e == 'Z') ? '\x1a' : e;
                    i += 2; continue;
                }
                if (c == q) { if (s[i + 1] == q) { buf += q; i += 2; continue; } i++; break; }
                buf += c; i++;
            }
            vals.push(buf);
            continue;
        }
        var j = i;
        while (j < n && s[j] != ',' && s[j] != ')') j++;
        var tok = s.substring(i, j).trim();
        vals.push(tok == 'NULL' ? null : tok);
        i = j;
    }
    return i;
}
function readMysqlDump(stream, onDoc) {
    // mysqldump puts all tuples on the INSERT line; mariadb-dump puts one tuple per following line
    var re = /^INSERT\s+INTO\s+`?events`?\s+(?:\([^)]*\)\s+)?VALUES\s*/i;
    var inInsert = false;
    function tuples(line, from) {
        var rows = [], i = from;
        while (i < line.length) {
            var k = line.indexOf('(', i);
            if (k < 0) break;
            i = mysqlValues(line, k, rows);
        }
        rows.forEach(function (r) {
            var docCol = r[r.length - 1];   // doc JSON is the last column in MeshCentral's schema
            if (typeof docCol != 'string') return;
            var d; try { d = JSON.parse(docCol); } catch (e) { return; }
            if (d && d.time == null && typeof r[1] == 'string') d.time = r[1].replace(' ', 'T') + (/Z$|[+-]\d\d:?\d\d$/.test(r[1]) ? '' : 'Z');   // time column as UTC; normally the doc carries its own ISO time
            onDoc(d);
        });
    }
    return readLines(stream, function (line) {
        var m = re.exec(line);
        if (m != null) {
            tuples(line, m[0].length);
            inInsert = !/;\s*$/.test(line);
            return;
        }
        if (!inInsert) return;
        if (line[0] == '(') tuples(line, 0);
        if (/;\s*$/.test(line) || /^(--|\/\*|INSERT|CREATE|LOCK|UNLOCK|ALTER)/.test(line)) inInsert = false;
    });
}

// pg_dump plain format: "COPY public.events (id, time, domain, action, nodeid, userid, doc) FROM stdin;"
// followed by tab separated rows until "\.". Text escapes: \t \n \r \\ and \N for NULL.
function pgUnescape(f) {
    if (f == '\\N') return null;
    return f.replace(/\\(.)/g, function (_, c) { return c == 'n' ? '\n' : c == 't' ? '\t' : c == 'r' ? '\r' : c == 'b' ? '\b' : c == 'f' ? '\f' : c == 'v' ? '\v' : c; });
}
function readPgDump(stream, onDoc) {
    var inCopy = false, docIdx = -1, timeIdx = -1;
    var copyRe = /^COPY\s+(?:"?[\w]+"?\.)?"?events"?\s*\(([^)]*)\)\s+FROM\s+stdin;/i;
    return readLines(stream, function (line) {
        if (!inCopy) {
            var m = copyRe.exec(line);
            if (m == null) return;
            var cols = m[1].split(',').map(function (c) { return c.trim().replace(/"/g, '').toLowerCase(); });
            docIdx = cols.indexOf('doc'); timeIdx = cols.indexOf('time');
            inCopy = (docIdx >= 0);
            return;
        }
        if (line == '\\.') { inCopy = false; return; }
        var f = line.split('\t');
        if (f.length <= docIdx) return;
        var j = pgUnescape(f[docIdx]);
        if (j == null) return;
        var d; try { d = JSON.parse(j); } catch (e) { return; }
        if (d && d.time == null && timeIdx >= 0) { var t = pgUnescape(f[timeIdx]); if (t) d.time = t.replace(' ', 'T') + (/[+-]\d\d(:?\d\d)?$|Z$/.test(t) ? '' : 'Z'); }
        onDoc(d);
    });
}

// mongodump --archive: magic, a prelude of BSON documents (header, then one per collection),
// a terminator, then the body: slices of [namespace header doc][data docs...][terminator].
// Namespace headers carry db/collection/EOF/CRC and are told apart from data by those keys.
function readMongoArchive(stream, onDoc, bson) {
    return new Promise(function (resolve, reject) {
        var buf = Buffer.alloc(0), off = 0, magicSeen = false, prelude = true, ns = null, failed = false;
        function fail(e) { if (!failed) { failed = true; reject(e); } }
        function consume() {
            while (true) {
                if (!magicSeen) {
                    if (buf.length - off < 4) return;
                    if (buf.readUInt32LE(off) != ARCHIVE_MAGIC) { fail(new Error('Not a mongodump archive')); return; }
                    off += 4; magicSeen = true; continue;
                }
                if (buf.length - off < 4) return;
                var len = buf.readUInt32LE(off);
                if (len == TERMINATOR) { off += 4; if (prelude) prelude = false; ns = null; continue; }
                if (len < 5 || len > 64 * 1024 * 1024) { fail(new Error('Corrupt mongodump archive')); return; }
                if (buf.length - off < len) return;
                var doc;
                try { doc = bson.deserialize(buf.subarray(off, off + len)); } catch (e) { fail(new Error('Corrupt BSON in archive: ' + e.message)); return; }
                off += len;
                if (prelude) continue;   // header and collection metadata
                if (ns == null) {
                    if (doc.db != null && doc.collection != null && (doc.EOF != null || doc.CRC != null)) { ns = doc; continue; }
                    ns = { collection: '?' };   // no header (should not happen); treat as data
                }
                if (ns.collection == 'events' || doc.type == 'node' || doc.type == 'mesh') onDoc(doc);
            }
        }
        stream.on('data', function (c) {
            if (failed) return;
            buf = (off > 0) ? Buffer.concat([buf.subarray(off), c]) : Buffer.concat([buf, c]);
            off = 0;
            try { consume(); } catch (e) { fail(e); }
        });
        stream.on('error', fail);
        stream.on('end', function () { if (!failed) resolve(); });
    });
}

// SQLite copy (VACUUM INTO): open read only with MeshCentral's sqlite3 driver, or Node's own.
function readSqliteFile(file, onDoc) {
    var sqlite3 = null;
    try { sqlite3 = loadModule(['sqlite3']); } catch (e) { }
    var sql = "SELECT doc, time FROM events WHERE action = 'relaylog'";
    if (sqlite3 != null) {
        return new Promise(function (resolve, reject) {
            var db = new sqlite3.Database(file, sqlite3.OPEN_READONLY, function (err) {
                if (err) { reject(err); return; }
                db.each(sql, [], function (e, row) { if (!e && row) emit(row); }, function (e) { db.close(); if (e) reject(e); else resolve(); });
            });
        });
    }
    var ns = null;
    try { ns = require('node:sqlite'); } catch (e) { }
    if (ns == null) return Promise.reject(new Error('No SQLite driver available to read this file'));
    return new Promise(function (resolve, reject) {
        try {
            var db = new ns.DatabaseSync(file, { readOnly: true });
            var st = db.prepare(sql);
            for (var row of st.iterate()) emit(row);
            db.close(); resolve();
        } catch (e) { reject(e); }
    });
    function emit(row) {
        var d = row.doc; if (typeof d == 'string') { try { d = JSON.parse(d); } catch (e) { return; } }
        if (d && d.time == null && row.time != null) d.time = row.time;
        onDoc(d);
    }
}

// ---- top level ------------------------------------------------------------

function readHead(file, n) {
    return new Promise(function (resolve, reject) {
        fs.open(file, 'r', function (err, fd) {
            if (err) { reject(err); return; }
            var b = Buffer.alloc(n);
            fs.read(fd, b, 0, n, 0, function (err2, bytes) { fs.close(fd, function () { }); if (err2) reject(err2); else resolve(b.subarray(0, bytes)); });
        });
    });
}

// Sniff a stream by buffering its first bytes, then hand the whole stream (re-prefixed) on.
function sniffStream(stream, n) {
    return new Promise(function (resolve, reject) {
        var chunks = [], got = 0, done = false;
        function finish(ended) {
            if (done) return; done = true;
            stream.removeListener('data', onData); stream.removeListener('end', onEnd); stream.removeListener('error', onErr);
            var head = Buffer.concat(chunks);
            var { PassThrough } = require('stream');
            var out = new PassThrough();
            out.write(head);
            if (ended) { out.end(); resolve({ head: head, stream: out }); return; }   // the whole file fit into the head
            stream.on('data', function (c) { if (!out.write(c)) { stream.pause(); out.once('drain', function () { stream.resume(); }); } });
            stream.on('end', function () { out.end(); });
            stream.on('error', function (e) { out.destroy(e); });
            stream.resume();
            resolve({ head: head, stream: out });
        }
        function onData(c) { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c), 'utf8')); got += c.length; if (got >= n) { stream.pause(); finish(false); } }
        function onEnd() { finish(true); }
        function onErr(e) { if (!done) { done = true; reject(e); } }
        stream.on('data', onData); stream.on('end', onEnd); stream.on('error', onErr);
    });
}

function tempFile(suffix) {
    return path.join(os.tmpdir(), 'connstats-' + process.pid + '-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + suffix);
}

// Import one stream of a known kind. `st` gets progress; `onDoc` receives raw documents.
function importStream(kind, stream, name, onDoc, st) {
    if (kind == 'gzip') {
        // mongodump --gzip --archive compresses the whole archive; anything else gzipped is sniffed again
        var gz = zlib.createGunzip();
        var inner = stream.pipe(gz);
        return sniffStream(inner, 4096).then(function (r) {
            var k = sniff(r.head);
            if (k == 'gzip' || k == 'zip' || k == 'sqlite') throw new Error('Unsupported content inside the gzip file: ' + k);
            return importStream(k, r.stream, name, onDoc, st);
        });
    }
    if (kind == 'jsonl') return readJsonLines(stream, onDoc);
    if (kind == 'jsonarray') return readJsonArray(stream, onDoc);
    if (kind == 'mysqldump') return readMysqlDump(stream, onDoc);
    if (kind == 'pgdump') return readPgDump(stream, onDoc);
    if (kind == 'sql') {
        // decide from more content: pg_dump uses COPY, mysqldump uses INSERT
        return sniffStream(stream, 256 * 1024).then(function (r) {
            var text = r.head.toString('utf8');
            var k = /^COPY /m.test(text) || /PostgreSQL database dump/.test(text) ? 'pgdump' : 'mysqldump';
            return importStream(k, r.stream, name, onDoc, st);
        });
    }
    if (kind == 'mongodump') {
        var bson = null;
        try { bson = loadModule(['bson']); } catch (e) { }
        if (bson == null || typeof bson.deserialize != 'function') { try { var m = loadModule(['mongodb']); if (m.BSON && typeof m.BSON.deserialize == 'function') bson = m.BSON; } catch (e) { } }
        if (bson == null) return Promise.reject(new Error('Reading a mongodump archive needs the "bson" module, which comes with MeshCentral\'s MongoDB driver'));
        return readMongoArchive(stream, onDoc, bson);
    }
    if (kind == 'sqlite') {
        // needs a file on disk
        var tmp = tempFile('.sqlite');
        return new Promise(function (resolve, reject) {
            var w = fs.createWriteStream(tmp);
            stream.pipe(w);
            w.on('finish', resolve); w.on('error', reject); stream.on('error', reject);
        }).then(function () { return readSqliteFile(tmp, onDoc); })
        .finally(function () { try { fs.unlinkSync(tmp); } catch (e) { } });
    }
    if (kind == 'zip') return Promise.reject(new Error('A zip inside a zip is not supported'));
    return Promise.reject(new Error('Unrecognised file format' + (name ? ' (' + name + ')' : '')));
}

// Which entries inside a backup zip are worth reading. Names are a first filter only;
// the content is sniffed as well.
function zipEntryWanted(fileName) {
    var base = path.posix.basename(fileName).toLowerCase();
    if (base == 'meshcentral-events.db') return true;
    // MeshCentral before 1.1.34 (Nov 2024) wrote "mongodump-<date>.archive"; newer versions prefix the
    // database name ("meshcentral-mongodump-<date>.archive"). Same for the SQLite copy.
    if (/(^|-)mongodump-.*\.archive(\.gz)?$/.test(base)) return true;
    if (/(^|-)mysqldump-.*\.sql(\.gz)?$/.test(base) || /(^|-)pgdump-.*\.sql(\.gz)?$/.test(base)) return true;
    if (/(^|-)sqlitedump-.*\.db3$/.test(base)) return true;
    return false;
}

function importZip(file, onDoc, st) {
    var yauzl = loadModule(['yauzl']);
    return new Promise(function (resolve, reject) {
        yauzl.open(file, { lazyEntries: true, autoClose: true }, function (err, zip) {
            if (err) { reject(new Error('Could not open the zip file: ' + err.message)); return; }
            var used = 0, encrypted = 0;
            zip.on('error', reject);
            zip.on('end', function () {
                if (used == 0) {
                    if (encrypted > 0) reject(new Error('The backup is password protected. Unzip it with the password first, then import the events file or database dump from inside it.'));
                    else reject(new Error('No events file or database dump found in this zip (looked for meshcentral-events.db, a mongodump archive, mysqldump, pgdump or a sqlite dump).'));
                } else resolve();
            });
            zip.on('entry', function (entry) {
                if (/\/$/.test(entry.fileName) || !zipEntryWanted(entry.fileName)) { zip.readEntry(); return; }
                if (entry.isEncrypted()) { encrypted++; zip.readEntry(); return; }
                zip.openReadStream(entry, function (e2, rs) {
                    if (e2) { reject(e2); return; }
                    st.file = entry.fileName; st.files = (st.files || 0) + 1;
                    sniffStream(rs, 4096).then(function (r) {
                        var kind = sniff(r.head);
                        return importStream(kind, r.stream, entry.fileName, onDoc, st);
                    }).then(function () { used++; zip.readEntry(); }, function (e3) { reject(new Error(entry.fileName + ': ' + e3.message)); });
                });
            });
            zip.readEntry();
        });
    });
}

// Read every relay event out of `file` (any supported format). Calls onEvent(doc) with the
// normalised event and updates st.scanned / st.file. Optional onRecord receives records
// including MongoDB node/mesh metadata. Resolves when the file is fully read.
function readFile(file, want, onEvent, st, onRecord) {
    st = st || {};
    var onDoc = function (d) { if (onRecord) onRecord(d); st.scanned = (st.scanned || 0) + 1; var e = relayEvent(d, want); if (e != null) onEvent(e); };
    return readHead(file, 4096).then(function (head) {
        var kind = sniff(head);
        if (kind == 'zip') return importZip(file, onDoc, st);
        if (kind == 'sqlite') return readSqliteFile(file, onDoc);
        return importStream(kind, fs.createReadStream(file), path.basename(file), onDoc, st);
    });
}

module.exports = {
    readFile: readFile, sniff: sniff, normTime: normTime, relayEvent: relayEvent, zipEntryWanted: zipEntryWanted,
    readers: { jsonLines: readJsonLines, jsonArray: readJsonArray, mysqlDump: readMysqlDump, pgDump: readPgDump, mongoArchive: readMongoArchive, sqliteFile: readSqliteFile },
    importStream: importStream, tempFile: tempFile
};
