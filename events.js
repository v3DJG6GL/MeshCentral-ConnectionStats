/**
* @description MeshCentral-ConnectionStats: relay event classification and start/end pairing
* @license Apache-2.0
*
* Pure module, no MeshCentral objects. MeshCentral dispatches one event when a remote session
* starts and one when it ends (etype 'relay', action 'relaylog'). Which pair it is depends on the
* msgid, the join key sits in a different place per family, and the duration is only on the end
* event. This module turns those into one session document per session.
*/

"use strict";

// msgid -> which family and which half of the pair. See DESIGN.md section 4.
//   relay      13/9   generic agent relay (Router tunnels, AMT redirection with protocol 100/101,
//                     and the inner relay web apps open with protocol 10-14)
//   terminal   14/10  desktop 15/11  files 16/12  messenger 162/112
//   local      120/121  local relay without an agent (protocol 10-14, bytes in 'in'/'out')
//   mux        143/144  desktop multiplex viewer join/leave (145/147 carry no user: ignored)
//   webapp     148-150 / 123-125  Web-SSH, Web-SFTP, Web-RDP (id in msgArgs[0] on start, sessionid on end)
const START = { 13: 'relay', 14: 'relay', 15: 'relay', 16: 'relay', 162: 'relay', 120: 'local', 143: 'mux', 148: 'webapp', 149: 'webapp', 150: 'webapp' };
const END = { 9: 'relay', 10: 'relay', 11: 'relay', 12: 'relay', 112: 'relay', 121: 'local', 144: 'mux', 123: 'webapp', 124: 'webapp', 125: 'webapp' };

const START_MSGIDS = Object.keys(START).map(Number);
const END_MSGIDS = Object.keys(END).map(Number);

const TYPES = ['desktop', 'terminal', 'files', 'webapp', 'messenger', 'amt', 'other'];

function typeOf(protocol) {
    if ([1, 6, 8, 9].indexOf(protocol) >= 0) return 'terminal';
    if (protocol == 2) return 'desktop';
    if (protocol == 5) return 'files';
    if (protocol == 200) return 'messenger';
    if (protocol >= 201 && protocol <= 203) return 'webapp';
    if (protocol == 100 || protocol == 101) return 'amt';
    return 'other';
}

function num(v, dflt) { var n = Number(v); return isFinite(n) ? n : dflt; }
function str(v) { return (v == null) ? null : String(v); }
function timeOf(event) {
    var t = (event.time != null) ? +new Date(event.time) : NaN;
    return isFinite(t) ? t : Date.now();
}

// Returns null for anything that is not a session start or end. Otherwise:
// { kind:'start'|'end', key, type, protocol, family, inner, time, domain, nodeid, userid, username,
//   guest, ip, seconds, bytesin, bytesout }
function classify(event) {
    if (event == null || event.etype != 'relay' || event.action != 'relaylog') return null;
    var msgid = num(event.msgid, -1);
    var family = START[msgid] || END[msgid];
    if (family == null) return null;
    var kind = (START[msgid] != null) ? 'start' : 'end';
    var args = Array.isArray(event.msgArgs) ? event.msgArgs : [];
    var protocol = num(event.protocol, 0);
    var c = {
        kind: kind, family: family, msgid: msgid, protocol: protocol, type: typeOf(protocol),
        inner: (family == 'relay' && protocol >= 10 && protocol <= 14),
        time: timeOf(event),
        domain: (event.domain == null) ? '' : String(event.domain),
        nodeid: str(event.nodeid), userid: str(event.userid), username: str(event.username),
        guest: (event.guestname != null && event.guestname !== '') ? String(event.guestname) : null,
        ip: null, seconds: 0, bytesin: 0, bytesout: 0
    };
    // join key
    var key = null;
    if (family == 'webapp') key = (kind == 'end') ? (event.sessionid || args[1]) : args[0];
    else key = args[0];
    if (key == null || key === '') return null;
    key = String(key);
    // every viewer of a multiplexed desktop shares the multiplex id, so the user is part of the key
    if (family == 'mux') key += ':' + (c.userid || c.guest || '');
    c.key = key;
    if (kind == 'start') {
        // relay starts carry [id, peer ip, own ip]; the event is raised by the side that connects
        // second, normally the agent, so the peer is the person's browser
        if (family == 'relay' && args.length >= 2) c.ip = str(args[1]);
        return c;
    }
    // end: where the seconds live differs per family
    if (family == 'mux') c.seconds = num(args[1], 0);
    else if (family == 'webapp') c.seconds = num(args[0], 0);
    else if (family == 'local') c.seconds = num(args[3], 0);
    else c.seconds = num(args[args.length - 1], 0);
    if (c.seconds < 0) c.seconds = 0;
    if (family == 'local') { c.bytesin = num(event.in, 0); c.bytesout = num(event.out, 0); }
    else { c.bytesin = num(event.bytesin, 0); c.bytesout = num(event.bytesout, 0); }
    return c;
}

// Keeps the open sessions in memory and turns start/end pairs into documents.
//   onStart(c)  -> new open document, or null when the event is to be ignored
//   onEnd(c)    -> the closed document (a fresh one flagged truncated when the start was never seen), or null
//   findOpen(userid, nodeid, type) -> open document for heartbeats, or null
//   restore(docs) -> load open documents read back from the store after a restart
function Pairer() {
    var self = this;
    self.open = {};        // key -> doc
    self.ignored = {};     // key -> true, inner relays swallowed on start so their end is swallowed too

    function hasOpenWebapp(userid, nodeid) {
        for (var k in self.open) {
            var d = self.open[k];
            if (d.type == 'webapp' && d.userid == userid && d.nodeid == nodeid) return true;
        }
        return false;
    }

    self.onStart = function (c) {
        if (c == null || c.kind != 'start') return null;
        // a Web-RDP/SSH/SFTP session opens an inner relay (protocol 10-14) that logs on its own:
        // counting it would double the time
        if (c.inner && hasOpenWebapp(c.userid, c.nodeid)) { self.ignored[c.key] = true; return null; }
        if (self.open[c.key] != null) return self.open[c.key]; // duplicate start (peer server echo)
        var doc = {
            _id: 's_' + c.key, domain: c.domain, nodeid: c.nodeid, meshid: null,
            userid: c.userid, username: c.username, guest: c.guest,
            type: c.type, protocol: c.protocol, start: c.time, end: null, seconds: 0,
            active: null, lastbeat: null, bytesin: 0, bytesout: 0, ip: c.ip,
            source: 'live', truncated: false, nodename: null, meshname: null
        };
        self.open[c.key] = doc;
        return doc;
    };

    self.onEnd = function (c) {
        if (c == null || c.kind != 'end') return null;
        if (self.ignored[c.key]) { delete self.ignored[c.key]; return null; }
        var doc = self.open[c.key];
        if (doc != null) {
            delete self.open[c.key];
            doc.end = c.time;
            doc.seconds = (c.seconds > 0) ? c.seconds : Math.max(0, Math.round((c.time - doc.start) / 1000));
            if (c.seconds > 0 && Math.abs((c.time - doc.start) / 1000 - c.seconds) > 120) {
                // the reported length is authoritative (the start event may have been queued)
                doc.start = c.time - c.seconds * 1000;
            }
        } else {
            // the start was never seen (server restart, plugin installed mid-session): keep the
            // reported length, but flag it
            if (c.inner) return null;
            doc = {
                _id: 's_' + c.key, domain: c.domain, nodeid: c.nodeid, meshid: null,
                userid: c.userid, username: c.username, guest: c.guest,
                type: c.type, protocol: c.protocol, start: c.time - c.seconds * 1000, end: c.time, seconds: c.seconds,
                active: null, lastbeat: null, bytesin: 0, bytesout: 0, ip: null,
                source: 'live', truncated: true, nodename: null, meshname: null
            };
        }
        doc.bytesin = c.bytesin;
        doc.bytesout = c.bytesout;
        if (doc.guest == null && c.guest != null) doc.guest = c.guest;
        return doc;
    };

    self.findOpen = function (userid, nodeid, type) {
        var best = null;
        for (var k in self.open) {
            var d = self.open[k];
            if (d.userid == userid && d.nodeid == nodeid && (type == null || d.type == type)) {
                if (best == null || d.start > best.start) best = d;
            }
        }
        return best;
    };

    self.restore = function (docs) {
        (docs || []).forEach(function (d) {
            if (d == null || typeof d._id != 'string' || d._id.indexOf('s_') != 0) return;
            self.open[d._id.substring(2)] = d;
        });
    };

    self.count = function () { return Object.keys(self.open).length; };
}

module.exports = { classify: classify, typeOf: typeOf, Pairer: Pairer, TYPES: TYPES, START_MSGIDS: START_MSGIDS, END_MSGIDS: END_MSGIDS };
