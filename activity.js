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
// Canonical half-open intervals. Invalid payloads remain distinguishable from measured zero.
function intervals(value, start = -Infinity, end = Infinity) {
    if (!Array.isArray(value) || value.some(x => !Array.isArray(x) || x.length !== 2 ||
        !Number.isFinite(x[0]) || !Number.isFinite(x[1]) || x[1] < x[0])) return null;
    const out = [];
    for (const x of value.map(x => [Math.max(start, x[0]), Math.min(end, x[1])]).filter(x => x[1] > x[0]).sort((a,b) => a[0]-b[0])) {
        const last = out[out.length-1];
        if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]);
        else out.push(x);
    }
    return out;
}
function seconds(value) { return Math.round((value || []).reduce((n,x) => n+x[1]-x[0],0)/1000); }
function beatIntervals(beats, idleSeconds, start, end) {
    const hi = end == null ? Date.now() : end, idle = Math.max(1, Number(idleSeconds) || 300)*1000;
    return intervals((beats || []).filter(t => Number.isFinite(t) && t >= start && t <= hi).map(t => [t,t+idle]), start, hi);
}
function unionActive(beats, idleSeconds, start, end) { return seconds(beatIntervals(beats,idleSeconds,start,end)); }

// Keeps beats for open sessions in memory. Beats are not persisted one by one: the plugin folds
// them into activeIntervals and the active total on a timer and at disconnect.
// Restarted open sessions are marked truncated and require review rather than claiming completeness.
function Tracker(idleSeconds) {
    var self = this;
    self.idleSeconds = idleSeconds || 300;
    self.beats = {};      // session id -> [ms]
    self.windows = {};
    self.dirty = {};      // session id -> true since last flush

    self.beat = function (sid, t) {
        if (sid == null) return;
        t = (t == null) ? Date.now() : Number(t);
        if (!Number.isFinite(t)) return;
        var list = self.beats[sid];
        if (list == null) list = self.beats[sid] = [];
        // one beat per second is more than enough; drop bursts
        if (list.length && t - list[list.length - 1] < 1000) return;
        list.push(t);
        self.windows[sid] = intervals((self.windows[sid] || []).concat([[t, t + Math.max(1, self.idleSeconds)*1000]]));
        if (list.length > 50000) list.splice(0,25000);
        self.dirty[sid] = true;
    };
    self.intervalsFor = function (sid, start, end) {
        return intervals(self.windows[sid] || [], start, end == null ? Date.now() : end);
    };
    self.activeFor = function (sid, start, end) { return seconds(self.intervalsFor(sid,start,end)); };
    self.lastBeat = function (sid) { var l = self.beats[sid]; return (l && l.length) ? l[l.length - 1] : null; };
    self.has = function (sid) { return self.beats[sid] != null; };
    self.forget = function (sid) { delete self.beats[sid]; delete self.windows[sid]; delete self.dirty[sid]; };
    self.takeDirty = function () { var d = Object.keys(self.dirty); self.dirty = {}; return d; };
}

module.exports = { intervals, seconds, unionActive: unionActive, Tracker: Tracker };
