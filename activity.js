/**
* @description MeshCentral-ConnectionStats: active time from input heartbeats
* @license Apache-2.0
*
* The relay carries no idle signal, so the browser sends a heartbeat whenever the admin gives
* input to the Desktop, Terminal or Files view, throttled to one per beatSeconds. Active time is
* the union of the windows [beat, beat + idle] clipped to the session. Nothing is trimmed from
* the session itself; active time sits next to connected time.
*/

"use strict";

// beats: array of ms timestamps (any order). idleSeconds: how long one beat counts for.
// start/end: session bounds in ms (end may be null for an open session: use now).
// Returns whole seconds.
function unionActive(beats, idleSeconds, start, end) {
    if (!Array.isArray(beats) || beats.length == 0) return 0;
    var idle = Math.max(1, Number(idleSeconds) || 300) * 1000;
    var lo = Number(start) || 0, hi = (end == null) ? Date.now() : Number(end);
    if (hi <= lo) return 0;
    var b = beats.map(Number).filter(function (t) { return isFinite(t); }).sort(function (x, y) { return x - y; });
    var total = 0, curS = null, curE = null;
    for (var i = 0; i < b.length; i++) {
        if (b[i] < lo || b[i] > hi) continue;   // a beat outside the session is not this session's
        var s = b[i], e = Math.min(b[i] + idle, hi);
        if (e <= s) continue;
        if (curE == null || s > curE) { if (curE != null) total += curE - curS; curS = s; curE = e; }
        else if (e > curE) curE = e;
    }
    if (curE != null) total += curE - curS;
    return Math.round(total / 1000);
}

// Keeps beats for open sessions in memory. Beats are not persisted one by one: the plugin folds
// them into the session's active field on a timer and when the session closes, so a crash costs
// at most one flush interval.
function Tracker(idleSeconds) {
    var self = this;
    self.idleSeconds = idleSeconds || 300;
    self.beats = {};      // session id -> [ms]
    self.dirty = {};      // session id -> true since last flush

    self.beat = function (sid, t) {
        if (sid == null) return;
        t = (t == null) ? Date.now() : Number(t);
        var list = self.beats[sid];
        if (list == null) list = self.beats[sid] = [];
        // one beat per second is more than enough; drop bursts
        if (list.length && t - list[list.length - 1] < 1000) return;
        list.push(t);
        if (list.length > 50000) list.splice(0, list.length - 50000);
        self.dirty[sid] = true;
    };
    self.activeFor = function (sid, start, end) { return unionActive(self.beats[sid], self.idleSeconds, start, end); };
    self.lastBeat = function (sid) { var l = self.beats[sid]; return (l && l.length) ? l[l.length - 1] : null; };
    self.has = function (sid) { return self.beats[sid] != null; };
    self.forget = function (sid) { delete self.beats[sid]; delete self.dirty[sid]; };
    self.takeDirty = function () { var d = Object.keys(self.dirty); self.dirty = {}; return d; };
}

module.exports = { unionActive: unionActive, Tracker: Tracker };
