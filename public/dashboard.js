/**
* Connection Stats dashboard. Plain browser JavaScript, no build step. Served by the plugin at
* pluginadmin.ashx?pin=connectionstats&file=dashboard.js and booted from window.CS_BOOT.
* Data comes from the JSON API on the same URL (api=meta | query | sessions); every request is
* scoped on the server to what the logged-in user may see.
*/
(function () {
    'use strict';
    var BOOT = window.CS_BOOT || {};
    // night mode: MeshCentral puts a 'night' class on its body. This page is embedded by the
    // same origin (My Server > Plugins iframe, device tab iframe), so read the parent's body
    // class directly and follow changes; the boot flag and a posted message are the fallbacks
    // for the cases where the parent is not reachable.
    function setNight(on) { document.documentElement.classList.toggle('night', !!on); }
    function parentBody() {
        try { if (window.parent && window.parent !== window) return window.parent.document.body; } catch (e) { }
        return null;
    }
    var pb = parentBody();
    setNight(pb ? pb.classList.contains('night') : BOOT.night);
    if (pb && typeof MutationObserver == 'function') {
        try { new MutationObserver(function () { setNight(pb.classList.contains('night')); }).observe(pb, { attributes: true, attributeFilter: ['class'] }); } catch (e) { }
    }
    window.addEventListener('message', function (ev) { var d = ev.data; if (d && d.cs == 'night') setNight(d.night); });

    // Shared with the personal Kimai preview, which does not initialize the dashboard.
    window.CS_FORMAT_DURATION = fmtDur;
    if (BOOT.view === 'kimai') return;
    var API = 'pluginadmin.ashx?pin=connectionstats';
    var COMPACT = (BOOT.view == 'device');
    var TYPES = [
        { k: 'desktop', n: 'Desktop', c: '#4477AA' },
        { k: 'terminal', n: 'Terminal', c: '#228833' },
        { k: 'files', n: 'Files', c: '#CCBB44' },
        { k: 'webapp', n: 'Web RDP/SSH', c: '#66CCEE' },
        { k: 'messenger', n: 'Messenger', c: '#AA3377' },
        { k: 'amt', n: 'Intel AMT', c: '#EE6677' },
        { k: 'tunnel', n: 'Router tunnel', c: '#9970AB' },
        { k: 'plugin', n: 'Plugin', c: '#44AA99' },
        { k: 'registry', n: 'Registry', c: '#EE8866' },
        { k: 'other', n: 'Other', c: '#BBBBBB' }
    ];
    var TYPE = {}; TYPES.forEach(function (t) { TYPE[t.k] = t; });
    // MeshCentral's relay protocol numbers. Anything that is not one of the named types lands in
    // "Other"; the number tells what it was. 0 means the relay was opened without a protocol,
    // which is what MeshCentral Router and other port tunnels do.
    var PROTO = { 0: 'Router or port tunnel', 1: 'Terminal', 2: 'Desktop', 4: 'Registry editor', 5: 'Files', 6: 'PowerShell', 7: 'Plugin data, e.g. Event Log live view', 8: 'Root shell', 9: 'Root PowerShell', 10: 'RDP relay', 11: 'SSH relay', 12: 'VNC relay', 13: 'SFTP relay', 14: 'Web-TCP relay', 100: 'Intel AMT', 101: 'Intel AMT', 200: 'Messenger', 201: 'Web RDP', 202: 'Web SSH', 203: 'Web SFTP' };
    function protoName(p) { p = Number(p) || 0; return PROTO[p] || ('protocol ' + p); }
    // only these views report input, so only they can show measured active time
    var ACTIVE_TYPES = { desktop: 1, terminal: 1, files: 1 };
    function activeCell(x) {
        if (x.active != null) return '<td class="num">' + fmtDur(x.active) + '</td>';
        return ACTIVE_TYPES[x.type] ? '<td class="num dim" title="No input was reported for this session: it was not opened in this web UI, or active time was off">no data</td>' : '<td class="num dim" title="Active time is only measured for Desktop, Terminal and Files">&ndash;</td>';
    }
    var DAY = 86400000;
    var TZ = 'UTC';
    try { TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { }
    // Dates follow the "Dates & Time" choice in MeshCentral's localization settings, which the
    // main page keeps in localStorage as "loctag" (same origin, so it is readable here); "*" or
    // nothing means the browser's own locale, exactly as MeshCentral's printDateTime does.
    var LOC;
    try { var lt = localStorage.getItem('loctag'); if (lt && lt != '*' && /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(lt)) LOC = lt; } catch (e) { }
    function dtf(opts) { try { return new Intl.DateTimeFormat(LOC, opts); } catch (e) { return new Intl.DateTimeFormat(undefined, opts); } }
    // numeric dates, as MeshCentral's toLocaleDateString gives them ("7.9.2026" for de-CH,
    // "07/09/2026" for en-GB); month names only where a chart axis needs them
    var F_DATE = dtf({ day: 'numeric', month: 'numeric', year: 'numeric' }),
        F_DT = dtf({ day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
        F_DM = dtf({ day: 'numeric', month: 'numeric' }),
        F_M = dtf({ month: 'short' }), F_MY = dtf({ month: 'short', year: 'numeric' }), F_WD = dtf({ weekday: 'short' });
    // 2023-01-01 was a Sunday; the arrays keep MeshCentral's Sunday-first weekday index
    var DOW = [0, 1, 2, 3, 4, 5, 6].map(function (i) { return F_WD.format(new Date(2023, 0, 1 + i)); });
    var MON = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(function (i) { return F_M.format(new Date(2023, i, 1)); });

    // ---------- helpers ----------
    function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    function fmtDur(sec) {
        sec = Number(sec);
        sec = isFinite(sec) ? Math.max(0, Math.round(sec)) : 0;
        return Math.floor(sec / 3600) + ':' + p2(Math.floor(sec / 60) % 60) + ':' + p2(sec % 60);
    }
    function fmtBytes(b) { b = b || 0; if (b < 1024) return b + ' B'; if (b < 1048576) return (b / 1024).toFixed(0) + ' KB'; if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB'; return (b / 1073741824).toFixed(2) + ' GB'; }
    function fmtDate(t) { return F_DATE.format(new Date(t)); }
    function fmtDT(t) { return F_DT.format(new Date(t)); }
    function isoDay(t) { var d = new Date(t); return String(d.getFullYear()).padStart(4, '0') + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
    function sod(t) { var d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
    function label(b, bucket) { var d = new Date(b.s); if (bucket == 'hour') return p2(d.getHours()) + ':00'; if (bucket == 'day' || bucket == 'week') return F_DM.format(d); return d.getMonth() == 0 ? F_MY.format(d) : F_M.format(d); }
    function longLabel(b, bucket) {
        var d = new Date(b.s);
        if (bucket == 'hour') return F_DATE.format(d) + ', ' + p2(d.getHours()) + ':00 to ' + p2(new Date(b.e).getHours()) + ':00';
        if (bucket == 'day') return F_DATE.format(d);
        if (bucket == 'week') return 'Week of ' + fmtDate(b.s);
        return F_MY.format(d);
    }
    function get(url) {
        return fetch(url, { credentials: 'same-origin' }).then(function (r) {
            if (r.status == 401) throw new Error('Your MeshCentral session has expired. Reload the page and log in again.');
            return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('Request failed (' + r.status + ')')); return j; });
        });
    }
    function qs(o) { var out = []; for (var k in o) { if (o[k] == null || o[k] === '') continue; out.push(encodeURIComponent(k) + '=' + encodeURIComponent(o[k])); } return out.join('&'); }

    // ---------- presets ----------
    var NOW = function () { return Date.now(); };
    var PRESETS = [
        { k: 'today', n: 'Today', range: function () { var a = sod(NOW()); return [a, a + DAY]; } },
        { k: 'yesterday', n: 'Yesterday', range: function () { var a = sod(NOW()); return [a - DAY, a]; } },
        { k: 'week', n: 'Last 7 days', range: function () { var b = sod(NOW()) + DAY; return [b - 7 * DAY, b]; } },
        { k: 'month', n: 'Last 30 days', range: function () { var b = sod(NOW()) + DAY; return [b - 30 * DAY, b]; } },
        { k: 'thismonth', n: 'This month', range: function () { var d = new Date(NOW()); return [new Date(d.getFullYear(), d.getMonth(), 1).getTime(), new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()]; } },
        { k: 'lastmonth', n: 'Last month', range: function () { var d = new Date(NOW()); return [new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime(), new Date(d.getFullYear(), d.getMonth(), 1).getTime()]; } },
        { k: 'ytd', n: 'Year to date', range: function () { var d = new Date(NOW()); return [new Date(d.getFullYear(), 0, 1).getTime(), new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()]; } },
        { k: 'year', n: 'Last 12 months', range: function () { var d = new Date(NOW()); return [new Date(d.getFullYear() - 1, d.getMonth() + 1, 1).getTime(), new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()]; } },
        // from the oldest recorded session (api=range, fetched by load) to the end of today
        { k: 'all', n: 'All', range: function () { var b = sod(NOW()) + DAY; return [ALL_START || sod(NOW()), b]; } },
        { k: 'custom', n: 'Custom', range: null }
    ];
    var PRESET = {}; PRESETS.forEach(function (p) { PRESET[p.k] = p; });
    var MAIN_PRESETS = COMPACT ? ['today', 'week', 'month', 'year', 'all', 'custom'] : ['today', 'week', 'month', 'thismonth', 'year', 'all', 'custom'];
    var ALL_START = 0;

    // ---------- state ----------
    var LIMITS = [10, 25, 50, 100, 250];
    var STATE_KEY = 'cs-filters:' + location.pathname + ':' + (BOOT.user || '') + ':' + (COMPACT ? 'device' : 'full');
    var S = {
        scope: BOOT.scope || 'all', types: {}, users: [], preset: 'week', start: 0, end: 0, bucket: 'auto',
        compare: true, guests: false, sel: null, pc: null, skip: 0, limit: savedLimit()
    };
    TYPES.forEach(function (t) { S.types[t.k] = true; });
    var META = null, DATA = null, LIST = null, DAYLIST = null, ERR = null, LOADING = false, MENU = false;
    var root = document.getElementById('cs-root');

    function applyPreset() { var p = PRESET[S.preset]; if (p && p.range) { var r = p.range(); S.start = r[0]; S.end = r[1]; } }
    function savedLimit() {
        var d = 10;
        try { var v = Number(localStorage.getItem('cs-limit')); return LIMITS.indexOf(v) >= 0 ? v : d; } catch (e) { return d; }
    }
    function readHash(saved) {
        var h = (saved || location.hash).replace(/^#/, ''); if (!h) return;
        var o = {}; h.split('&').forEach(function (kv) { var i = kv.indexOf('='); if (i > 0) { try { o[decodeURIComponent(kv.substring(0, i))] = decodeURIComponent(kv.substring(i + 1)); } catch (e) { } } });
        if (o.scope && !COMPACT) S.scope = o.scope;
        if (o.preset && Object.prototype.hasOwnProperty.call(PRESET, o.preset)) S.preset = o.preset;
        if (o.start && o.end && isFinite(Number(o.start)) && isFinite(Number(o.end)) && Number(o.end) > Number(o.start) && Math.abs(Number(o.start)) <= 8640000000000000 && Math.abs(Number(o.end)) <= 8640000000000000) { S.start = Number(o.start); S.end = Number(o.end); S.preset = 'custom'; }
        if (o.types) { TYPES.forEach(function (t) { S.types[t.k] = false; }); o.types.split(',').forEach(function (k) { if (TYPE[k]) S.types[k] = true; }); }
        if (o.users) S.users = o.users.split(',');
        if (['auto', 'hour', 'day', 'week', 'month'].indexOf(o.bucket) >= 0) S.bucket = o.bucket;
        if (o.compare != null) S.compare = (o.compare == '1');
        if (o.guests != null) S.guests = (o.guests == '1');
    }
    function writeHash() {
        var o = { scope: COMPACT ? null : S.scope, preset: S.preset, compare: S.compare ? '1' : '0', guests: S.guests ? '1' : null };
        if (S.preset == 'custom') { o.start = S.start; o.end = S.end; }
        var off = TYPES.filter(function (t) { return !S.types[t.k]; });
        if (off.length) o.types = TYPES.filter(function (t) { return S.types[t.k]; }).map(function (t) { return t.k; }).join(',');
        if (S.users.length) o.users = S.users.join(',');
        if (S.bucket != 'auto') o.bucket = S.bucket;
        var h = '#' + qs(o);
        try { localStorage.setItem(STATE_KEY, h); } catch (e) { }
        if (location.hash != h) { try { history.replaceState(null, '', h); } catch (e) { location.hash = h; } }
    }
    function activeTypes() { return TYPES.filter(function (t) { return S.types[t.k]; }).map(function (t) { return t.k; }); }
    function queryParams() {
        // "All" has nothing before it to compare with
        return { start: S.start, end: S.end, tz: TZ, scope: S.scope, types: (activeTypes().length == TYPES.length) ? null : activeTypes().join(','), users: S.users.join(',') || null, bucket: S.bucket == 'auto' ? null : S.bucket, compare: (S.compare && S.preset != 'all') ? '1' : '0', guests: S.guests ? '1' : '0' };
    }

    // ---------- data ----------
    function load() {
        writeHash();
        LOADING = true; ERR = null; render();
        var pre = Promise.resolve();
        if (S.preset == 'all') {
            var rp = queryParams(); delete rp.start; delete rp.end; delete rp.bucket; delete rp.compare;
            pre = get(API + '&api=range&' + qs(rp)).then(function (r) { ALL_START = r.oldest ? sod(r.oldest) : 0; applyPreset(); writeHash(); });
        }
        pre.then(function () {
            var qp = queryParams(); qp.limit = S.limit;
            return get(API + '&api=query&' + qs(qp));
        }).then(function (d) {
            DATA = d; LIST = d.sessions; S.skip = 0; S.sel = null; S.pc = null; DAYLIST = null;
            if (d.aggregate.bucket == 'hour') {
                var lp = queryParams(); lp.limit = 500;
                return get(API + '&api=sessions&' + qs(lp)).then(function (l) { DAYLIST = l.rows; });
            }
        }).then(function () { LOADING = false; render(); }).catch(function (e) { LOADING = false; ERR = e.message || String(e); render(); });
    }
    function listParams(skip) {
        var qp = queryParams(); qp.skip = skip; qp.limit = S.limit;
        if (S.sel) { var b = DATA.aggregate.buckets[S.sel.i]; qp.start = b.s; qp.end = b.e; qp.types = S.sel.t; }
        if (S.pc) { qp.wd = S.pc.wd; qp.hour = S.pc.h; }
        return qp;
    }
    function loadList(skip) {
        get(API + '&api=sessions&' + qs(listParams(skip))).then(function (l) { LIST = l; S.skip = skip; render(); }).catch(function (e) { ERR = e.message; render(); });
    }
    // live: the server counts session writes (api=seq); when the count moves, everything is
    // fetched again in place, keeping the selection, the page and the scroll position
    var SEQ = null, REFRESHING = false;
    function refresh() {
        if (REFRESHING || LOADING || !DATA) return;
        REFRESHING = true;
        if (S.preset != 'custom') applyPreset();
        var qp = queryParams(); qp.limit = S.limit;
        get(API + '&api=query&' + qs(qp)).then(function (d) {
            DATA = d;
            if (S.sel && !d.aggregate.buckets[S.sel.i]) S.sel = null;
            var more = [];
            if (d.aggregate.bucket == 'hour') { var lp = queryParams(); lp.limit = 500; more.push(get(API + '&api=sessions&' + qs(lp)).then(function (l) { DAYLIST = l.rows; })); }
            if (S.sel || S.pc || S.skip) more.push(get(API + '&api=sessions&' + qs(listParams(S.skip))).then(function (l) { LIST = l; }));
            else LIST = d.sessions;
            return Promise.all(more);
        }).then(function () { REFRESHING = false; render(); }).catch(function () { REFRESHING = false; });
    }
    function pollSeq() {
        if (document.hidden || BOOT.view == 'settings' || !DATA || LOADING) return;
        get(API + '&api=seq').then(function (r) { if (SEQ != null && r.seq != SEQ) refresh(); SEQ = r.seq; }).catch(function () { });
    }
    setInterval(pollSeq, 10000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) pollSeq(); });
    // ongoing sessions grow while you watch: redraw once a minute so their durations move
    setInterval(function () { if (!document.hidden && DATA && !LOADING && DATA.aggregate.totals.ongoing) render(); }, 60000);

    // ---------- charts (inline SVG) ----------
    // SVG charts are drawn at the pixel width they get, so text and bubbles keep their size
    // instead of scaling with the page and eating its height.
    function fullW() { return Math.max(320, (root.clientWidth || 1000) - 24 - 22); }
    function mainW() { var cw = (root.clientWidth || 1000) - 24; return cw <= 760 ? cw - 22 : Math.floor((cw - 12) * 2.2 / 3.2) - 22; }
    var lastW = 0;
    window.addEventListener('resize', function () { var w = root.clientWidth; if (w && w != lastW && DATA) { lastW = w; render(); } });
    function niceMax(v) { if (v <= 0) return 1; var e = Math.pow(10, Math.floor(Math.log(v) / Math.LN10)); var m = v / e; var n = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10; return n * e; }
    var axisMeasure;
    function axisTicks(candidates, width) {
        if (axisMeasure === undefined) {
            try { axisMeasure = document.createElement('canvas').getContext('2d'); axisMeasure.font = '10px Arial'; } catch (e) { axisMeasure = null; }
        }
        var selected = [];
        candidates.slice().sort(function (a, b) { return (b.priority || 0) - (a.priority || 0) || a.x - b.x; }).forEach(function (tick) {
            var w = axisMeasure ? axisMeasure.measureText(tick.text).width : tick.text.length * 6;
            tick.x = Math.max(w / 2, Math.min(tick.x, width - w / 2));
            if (selected.some(function (other) { return Math.abs(tick.x - other.x) < (w + other.width) / 2 + 6; })) return;
            tick.width = w; selected.push(tick);
        });
        return selected.sort(function (a, b) { return a.x - b.x; });
    }

    function yearLabels(years, width, left, y) {
        return axisTicks(Object.keys(years).sort().map(function (year) {
            return { x: (years[year].start + years[year].end) / 2, text: year };
        }), width).map(function (tick) { return '<text class="ax cs-year-tick" x="' + (left + tick.x) + '" y="' + y + '" text-anchor="middle">' + esc(tick.text) + '</text>'; }).join('');
    }
    function timeAxisLabel(t, start, end) {
        var time = label({ s: t }, 'hour');
        if (end - start > 3 * DAY) return F_DM.format(new Date(t));
        return isoDay(start) != isoDay(end - 1) ? F_DM.format(new Date(t)) + ' ' + time : time;
    }
    function stackedBars(a, prev, sel) {
        var W = mainW(), H = 200, L = 38, R = 8, T = 12, B = 26, bk = a.buckets, n = bk.length, bucket = a.bucket;
        if (!n) return '';
        if (bucket == 'month') { H += 14; B += 14; }
        var years = {};
        var maxv = 0; bk.forEach(function (b) { maxv = Math.max(maxv, b.tot); }); if (prev) prev.buckets.forEach(function (b) { maxv = Math.max(maxv, b.tot); });
        var unit = maxv > 3600 ? 3600 : maxv > 60 ? 60 : 1, maxU = niceMax(maxv / unit), ticks = [0, .25, .5, .75, 1].map(function (x) { return x * maxU; });
        var tick = function (t) { var v = Number.isInteger(t) ? t : Number(t.toFixed(1)); return v + (unit == 3600 ? 'h' : unit == 60 ? 'm' : 's'); };
        var iw = (W - L - R) / n, bw = Math.max(2, iw * (n > 31 ? .7 : .62));
        var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Connected time per ' + bucket + ' by connection type">';
        ticks.forEach(function (t) { var y = T + (H - T - B) * (1 - t / maxU); s += '<line class="gl" x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '"/><text class="ax" x="' + (L - 5) + '" y="' + (y + 3.5) + '" text-anchor="end">' + tick(t) + '</text>'; });
        var axis = [];
        var datedHours = bucket == 'hour' && a.end - a.start > 3 * DAY;
        bk.forEach(function (b, i) {
            var x = L + iw * i + (iw - bw) / 2, y = H - B, d = new Date(b.s);
            var year = d.getFullYear();
            if (!years[year]) years[year] = { start: iw * i, end: iw * (i + 1) }; else years[year].end = iw * (i + 1);
            var weekend = bucket == 'day' && (d.getDay() == 0 || d.getDay() == 6);
            if (weekend) s += '<rect x="' + (L + iw * i) + '" y="' + T + '" width="' + iw + '" height="' + (H - T - B) + '" fill="var(--hi)" opacity=".6"/>';
            s += '<rect class="cs-bucket" data-i="' + i + '" tabindex="0" role="img" aria-label="' + esc(longLabel(b, bucket) + ', ' + fmtDur(b.tot)) + '" x="' + (L + iw * i) + '" y="' + T + '" width="' + iw + '" height="' + (H - T - B) + '" fill="transparent" pointer-events="all"/>';
            TYPES.forEach(function (t) {
                var v = b.by[t.k] || 0; if (!v) return; var h = (H - T - B) * (v / unit) / maxU; y -= h;
                var dim = sel && !(sel.i == i && sel.t == t.k);
                s += '<rect class="bar' + (dim ? ' dim' : '') + '" data-i="' + i + '" data-t="' + t.k + '" tabindex="0" role="button" aria-label="' + esc(longLabel(b, bucket)) + ', ' + t.n + ', ' + fmtDur(v) + '" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(h, 0.5).toFixed(1) + '" fill="' + t.c + '"></rect>';
            });
            if (!datedHours || (d.getHours() == 0 && d.getMinutes() == 0)) axis.push({ x: iw * i + iw / 2, priority: bucket == 'month' && d.getMonth() == 0 ? 1 : 0, text: bucket == 'hour' ? timeAxisLabel(b.s, a.start, a.end) : bucket == 'month' ? F_M.format(d) : label(b, bucket) });
        });
        axisTicks(axis, W - L - R).forEach(function (tick) { s += '<text class="ax cs-time-tick" x="' + (L + tick.x) + '" y="' + (H - (bucket == 'month' ? 22 : 8)) + '" text-anchor="middle">' + esc(tick.text) + '</text>'; });
        if (bucket == 'month') s += yearLabels(years, W - L - R, L, H - 8);
        if (prev && prev.buckets.length) {
            var pts = prev.buckets.map(function (b, i) { if (i >= n) return null; var y = T + (H - T - B) * (1 - (b.tot / unit) / maxU); return (L + iw * i + iw / 2).toFixed(1) + ',' + y.toFixed(1); }).filter(Boolean);
            s += '<polyline class="prev" points="' + pts.join(' ') + '"><title>Previous period total</title></polyline>';
        }
        return s + '</svg>';
    }
    function donut(a) {
        var tot = a.totals.seconds || 1, r = 40, c = 2 * Math.PI * r, off = 0, items = [];
        var s = '<svg viewBox="0 0 96 96" role="img" aria-label="Share by type"><circle cx="48" cy="48" r="' + r + '" fill="none" stroke="var(--r2)" stroke-width="12"/>';
        TYPES.forEach(function (t) { var v = a.byType[t.k] || 0; if (!v) return; var f = v / tot; s += '<circle class="cs-share" data-share="' + t.k + '" tabindex="0" role="img" aria-label="' + t.n + ', ' + Math.round(f * 100) + '%" cx="48" cy="48" r="' + r + '" fill="none" stroke="' + t.c + '" stroke-width="12" stroke-dasharray="' + (f * c).toFixed(2) + ' ' + c.toFixed(2) + '" stroke-dashoffset="' + (-off * c).toFixed(2) + '" transform="rotate(-90 48 48)"></circle>'; off += f; items.push({ t: t, v: v, f: f }); });
        s += '</svg>'; items.sort(function (x, y) { return y.v - x.v; });
        var otherParts = Object.keys(a.byProtocol || {}).filter(function (k) { return k.indexOf('other:') == 0 && a.byProtocol[k]; })
            .sort(function (x, y) { return a.byProtocol[y] - a.byProtocol[x]; })
            .map(function (k) { return '<span>' + esc(protoName(k.substring(6))) + ' ' + fmtDur(a.byProtocol[k]) + '</span>'; });
        return '<div class="cs-donut">' + s + '<ul>' + items.map(function (it) {
            var sub = (it.t.k == 'other' && otherParts.length) ? '<div class="sub">' + otherParts.join(', ') + '</div>' : '';
            return '<li class="cs-share" data-share="' + it.t.k + '" tabindex="0"><i style="background:' + it.t.c + '"></i>' + it.t.n + '<b>' + fmtDur(it.v) + ' <small>' + Math.round(it.f * 100) + '%</small></b>' + sub + '</li>';
        }).join('') + '</ul></div>';
    }
    function hbars(list, kind) {
        var max = list.length ? list[0].seconds : 1, s = '<div class="cs-hbars">';
        list.slice(0, 8).forEach(function (it, index) {
            var bar = ''; TYPES.forEach(function (t) { if (it.by[t.k]) bar += '<i style="width:' + (it.by[t.k] / max * 100) + '%;background:' + t.c + '"></i>'; });
            var link = (kind == 'group' && it.id != '?') ? 'mesh:' + it.id : (kind == 'device' && it.id != '?') ? 'node:' + it.id : null;
            var name = (link && !COMPACT) ? '<a href="#" data-scope-to="' + esc(link) + '">' + esc(it.name) + '</a>' : esc(it.name);
            var attrs = ' data-where="' + index + '" data-kind="' + kind + '"';
            s += '<div class="n cs-where"' + attrs + '>' + name + '</div><div class="b cs-where" tabindex="0" role="img" aria-label="' + esc(it.name + ', ' + fmtDur(it.seconds)) + '"' + attrs + '>' + bar + '</div><div class="v cs-where"' + attrs + '>' + fmtDur(it.seconds) + '</div>';
        });
        return s + '</div>';
    }
    // one bubble per weekday and hour, sized by connected time and sliced by type
    function pie(cx, cy, r, by, tot) {
        var parts = TYPES.filter(function (t) { return by[t.k]; });
        if (parts.length == 1) return '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + parts[0].c + '"/>';
        var a0 = -Math.PI / 2, s = '';
        parts.forEach(function (t, i) {
            var f = by[t.k] / tot, a1 = a0 + Math.PI * 2 * f;
            if (f >= 0.9999) { s += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + t.c + '"/>'; return; }
            var x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0), x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
            s += '<path d="M' + cx + ' ' + cy + 'L' + x0.toFixed(2) + ' ' + y0.toFixed(2) + 'A' + r + ' ' + r + ' 0 ' + (f > .5 ? 1 : 0) + ' 1 ' + x1.toFixed(2) + ' ' + y1.toFixed(2) + 'Z" fill="' + t.c + '"/>';
            a0 = a1;
        });
        return s;
    }
    function cellLabel(dw, hh) { return DOW[dw] + ' ' + p2(hh) + ':00 to ' + p2((hh + 1) % 24) + ':00'; }
    function punchcard(pc, sel) {
        var max = 0; pc.forEach(function (r) { r.forEach(function (c) { max = Math.max(max, c.tot); }); }); max = max || 1;
        var W = fullW(), H = 150, L = 30, T = 16, cw = (W - L) / 24, rh = (H - T) / 7;
        var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Connected time by weekday and hour of start">';
        // Cell boundaries make the weekday/hour coordinates visible even without activity.
        for (var col = 0; col <= 24; col++) s += '<line class="gl cs-pc-grid" x1="' + (L + cw * col) + '" x2="' + (L + cw * col) + '" y1="' + T + '" y2="' + H + '"/>';
        for (var row = 0; row <= 7; row++) s += '<line class="gl cs-pc-grid" x1="' + L + '" x2="' + W + '" y1="' + (T + rh * row) + '" y2="' + (T + rh * row) + '"/>';
        for (var h = 0; h < 24; h += 3) s += '<text class="ax" x="' + (L + cw * h + cw / 2) + '" y="10" text-anchor="middle">' + p2(h) + '</text>';
        [1, 2, 3, 4, 5, 6, 0].forEach(function (dw, ri) {
            s += '<text class="ax" x="' + (L - 6) + '" y="' + (T + rh * ri + rh / 2 + 3.5) + '" text-anchor="end">' + DOW[dw] + '</text>';
            for (var hh = 0; hh < 24; hh++) {
                var c = pc[dw][hh];
                var r = 2 + Math.sqrt(c.tot / max) * (rh / 2 - 1.5), cx = +(L + cw * hh + cw / 2).toFixed(1), cy = +(T + rh * ri + rh / 2).toFixed(1);
                var dim = sel && !(sel.wd == dw && sel.h == hh);
                var tip = cellLabel(dw, hh) + ', ' + fmtDur(c.tot) + ': ' + TYPES.filter(function (t) { return c.by[t.k]; }).map(function (t) { return t.n + ' ' + fmtDur(c.by[t.k]); }).join(', ');
                s += '<g class="pc' + (dim ? ' dim' : '') + '" data-pc="1" data-wd="' + dw + '" data-h="' + hh + '" tabindex="0" role="button" aria-label="' + esc(tip) + '"><rect class="cs-pc-hit" x="' + (L + cw * hh) + '" y="' + (T + rh * ri) + '" width="' + cw + '" height="' + rh + '" fill="transparent" pointer-events="all"/>' + pie(cx, cy, +r.toFixed(1), c.by, c.tot) + '</g>';
            }
        });
        return s + '</svg>';
    }
    function calendar(daily, start, end) {
        var max = 0; daily.forEach(function (d) { max = Math.max(max, d.tot); }); max = max || 1;
        var fd = new Date(daily.length ? daily[0].s : start), startCol = new Date(fd.getFullYear(), fd.getMonth(), fd.getDate() - ((fd.getDay() + 6) % 7)).getTime();
        var byDay = {}; daily.forEach(function (d) { byDay[isoDay(d.s)] = d; });
        var weeks = Math.ceil((end - startCol) / (7 * DAY)) + 1, cs = 12, gap = 2, W = 30 + weeks * (cs + gap), H = 34 + 7 * (cs + gap), years = {};
        var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="min-width:' + Math.min(W, 1400) + 'px;max-width:' + W + 'px" role="img" aria-label="Connected time per day">', lastM = -1, lastLW = -9;
        for (var w = 0; w < weeks; w++) for (var d = 0; d < 7; d++) {
            var dt = new Date(startCol); dt.setDate(dt.getDate() + w * 7 + d); var t = dt.getTime();
            if (t < start || t >= end) continue;
            var rec = byDay[isoDay(t)], v = rec ? rec.tot : 0;
            // one label per month, skipped when the previous one is less than three columns away (a range that starts late in a month)
            if (dt.getMonth() != lastM) { lastM = dt.getMonth(); if (w - lastLW >= 3) { lastLW = w; s += '<text class="ax" x="' + (30 + w * (cs + gap)) + '" y="24">' + MON[lastM] + '</text>'; } }
            var year = dt.getFullYear(), x = w * (cs + gap);
            if (!years[year]) years[year] = { start: x, end: x + cs }; else years[year].end = x + cs;
            var op = v ? .2 + .8 * Math.sqrt(v / max) : 0;
            s += '<rect class="cs-day" data-day="' + t + '" tabindex="0" role="img" aria-label="' + esc(fmtDate(t) + ', ' + fmtDur(v)) + '" x="' + (30 + w * (cs + gap)) + '" y="' + (32 + d * (cs + gap)) + '" width="' + cs + '" height="' + cs + '" rx="2" fill="' + (v ? 'var(--nav)' : 'var(--r2)') + '" opacity="' + (v ? op.toFixed(2) : 1) + '"></rect>';
        }
        s += yearLabels(years, W - 30, 30, 10);
        ['Mon', 'Wed', 'Fri', 'Sun'].forEach(function (n, i) { s += '<text class="ax" x="0" y="' + (32 + [0, 2, 4, 6][i] * (cs + gap) + 9) + '">' + n + '</text>'; });
        return s + '</svg>';
    }
    function timeline(rows, start, end) {
        var devs = {}; rows.forEach(function (x) { devs[x.node] = (devs[x.node] || 0) + ((x.end || Date.now()) - x.start); });
        var keys = Object.keys(devs).sort(function (a, b) { return devs[b] - devs[a]; }).slice(0, 10);
        if (!keys.length) return '<div class="cs-note">No sessions in this range.</div>';
        var width = Math.max(120, fullW() - 128), candidates = [], d = new Date(start);
        var byDate = end - start > 3 * DAY;
        if (byDate) { d.setHours(0, 0, 0, 0); if (+d < start) d.setDate(d.getDate() + 1); }
        else { d.setMinutes(0, 0, 0); if (+d < start) d.setTime(+d + 3600000); }
        while (+d <= end) {
            candidates.push({ x: (+d - start) / (end - start) * width, text: timeAxisLabel(+d, start, end) });
            if (byDate) d.setDate(d.getDate() + 1); else d.setTime(+d + 3600000);
        }
        var yearTicks = [];
        for (var year = new Date(start).getFullYear(); year <= new Date(end - 1).getFullYear(); year++) {
            var from = Math.max(start, new Date(year, 0, 1).getTime()), to = Math.min(end, new Date(year + 1, 0, 1).getTime());
            yearTicks.push({ x: ((from + to) / 2 - start) / (end - start) * width, text: String(year) });
        }
        var yearHtml = axisTicks(yearTicks, width).map(function (tick) { return '<span class="cs-tl-year" style="left:' + (tick.x / width * 100) + '%">' + esc(tick.text) + '</span>'; }).join('');
        var s = '<div class="cs-tl"><div class="hrs"><div></div><div>' + yearHtml + axisTicks(candidates, width).map(function (tick) {
            return '<span style="left:' + (tick.x / width * 100) + '%">' + esc(tick.text) + '</span>';
        }).join('') + '</div></div>';
        keys.forEach(function (k) {
            s += '<div class="row"><div class="n" title="' + esc(k) + '">' + esc(k) + '</div><div class="tr cs-track" data-track="' + esc(k) + '" tabindex="0" role="img" aria-label="' + esc(k + ', ' + fmtDate(start) + ' to ' + fmtDate(end - 1)) + '">';
            rows.forEach(function (x, index) { if (x.node != k) return; var e = x.end == null ? Date.now() : x.end, a = Math.max(x.start, start), z = Math.min(e, end); if (z <= a) return; var l = (a - start) / (end - start) * 100, w = (z - a) / (end - start) * 100; s += '<i data-session="' + index + '" tabindex="0" role="img" class="cs-session ' + (x.end == null ? 'live' : '') + '" style="left:' + l.toFixed(2) + '%;width:' + w.toFixed(2) + '%;background:' + TYPE[x.type].c + '" aria-label="' + TYPE[x.type].n + ', ' + fmtDT(x.start) + ', ' + fmtDur((z - a) / 1000) + '"></i>'; });
            s += '</div></div>';
        });
        return s + '</div>';
    }
    function table(list) {
        var rows = list.rows || [], n = list.total || 0, s = '<div class="cs-tscroll"><table class="cs-table"><thead><tr><th>Start</th><th class="num">Duration</th><th class="num">Active</th><th>Type</th><th>Device</th>' + (COMPACT ? '' : '<th>Group</th>') + '<th>Admin</th><th class="num">Received</th><th class="num">Sent</th><th>From</th></tr></thead><tbody>';
        rows.forEach(function (x) {
            var e = x.end == null ? Date.now() : x.end, t = TYPE[x.type] || TYPE.other;
            s += '<tr' + (x.end == null ? ' class="hl"' : '') + '><td>' + fmtDT(x.start) + '</td><td class="num">' + fmtDur((e - x.start) / 1000) + (x.end == null ? ', ongoing' : x.truncated ? ' <span title="The start or end of this session was not observed">*</span>' : '') + '</td>' + activeCell(x) + '<td><span class="ty" title="' + esc(protoName(x.protocol)) + '"><i style="background:' + t.c + '"></i>' + t.n + (x.type == 'other' ? ' <small class="dim">' + esc(protoName(x.protocol)) + '</small>' : '') + '</span></td><td>' + esc(x.node) + '</td>' + (COMPACT ? '' : '<td>' + esc(x.group || '') + '</td>') + '<td>' + (x.guest ? 'Guest: ' + esc(x.guest) : esc(x.user)) + '</td><td class="num">' + fmtBytes(x.bytesin) + '</td><td class="num">' + fmtBytes(x.bytesout) + '</td><td>' + esc(x.ip || '') + '</td></tr>';
        });
        if (!rows.length) s += '<tr><td colspan="10" class="dim">No sessions match.</td></tr>';
        s += '</tbody></table></div>';
        var pages = Math.max(1, Math.ceil(n / S.limit)), page = Math.floor(S.skip / S.limit) + 1;
        var selTxt = S.sel ? 'Showing ' + TYPE[S.sel.t].n + ' sessions in ' + esc(longLabel(DATA.aggregate.buckets[S.sel.i], DATA.aggregate.bucket)) + ', ' + n + ' of ' + DATA.sessions.total + '. <a href="#" data-act="clear">Clear</a> <a href="#" data-act="zoom">Zoom in</a>'
            : S.pc ? 'Showing sessions that started ' + cellLabel(S.pc.wd, S.pc.h) + ', ' + n + ' of ' + DATA.sessions.total + '. <a href="#" data-act="clear">Clear</a>'
            : 'Showing ' + Math.min(S.skip + rows.length, n) + ' of ' + n + ' sessions';
        var sizes = '<label class="pp">Per page <select class="cs-sel" data-pick="limit" aria-label="Sessions per page">' + LIMITS.map(function (l) { return '<option value="' + l + '"' + (S.limit == l ? ' selected' : '') + '>' + l + '</option>'; }).join('') + '</select></label>';
        s += '<div class="cs-foot"><span>' + selTxt + '</span><span class="pg">' + sizes + '<button class="cs-btn" data-act="prev" ' + (page <= 1 ? 'disabled' : '') + '>&#8249;</button> Page ' + page + ' of ' + pages + ' <button class="cs-btn" data-act="next" ' + (page >= pages ? 'disabled' : '') + '>&#8250;</button></span></div>';
        return s;
    }
    function delta(cur, prev, label) {
        if (!prev) return '<span class="d">no previous data</span>';
        var p = (cur - prev) / prev * 100, up = p >= 0;
        return '<span class="d ' + (up ? 'up' : 'dn') + '">' + (up ? '+' : '') + Math.round(p) + '% vs previous</span>';
    }

    // ---------- page ----------
    function scopeName() {
        if (S.scope.indexOf('mesh:') == 0) { var id = S.scope.substring(5), g = META && META.groups.filter(function (x) { return x.id == id; })[0]; return g ? g.name : 'Group'; }
        if (S.scope.indexOf('node:') == 0) { var nid = S.scope.substring(5), d = META && META.devices.filter(function (x) { return x.id == nid; })[0]; return d ? d.name : (BOOT.nodename || 'Device'); }
        return 'All devices';
    }
    function toolbar() {
        var h = '<div class="cs-bar">';
        if (COMPACT) h += '<span><b>' + esc(scopeName()) + '</b> <span class="cs-note">only this device</span></span>';
        else {
            var kind = S.scope.indexOf('mesh:') == 0 ? 'group' : S.scope.indexOf('node:') == 0 ? 'device' : 'all';
            h += '<span class="cs-seg" role="group" aria-label="Scope"><button data-scope="all" class="' + (kind == 'all' ? 'on' : '') + '">All devices</button><button data-scope="group" class="' + (kind == 'group' ? 'on' : '') + '">Group</button><button data-scope="device" class="' + (kind == 'device' ? 'on' : '') + '">Device</button></span>';
            if (kind == 'group') h += '<select class="cs-sel" data-pick="mesh" aria-label="Device group">' + (META ? META.groups.map(function (g) { return '<option value="' + esc(g.id) + '"' + (S.scope == 'mesh:' + g.id ? ' selected' : '') + '>' + esc(g.name) + '</option>'; }).join('') : '') + '</select>';
            if (kind == 'device') h += '<select class="cs-sel" data-pick="node" aria-label="Device">' + (META ? META.devices.map(function (d) { return '<option value="' + esc(d.id) + '"' + (S.scope == 'node:' + d.id ? ' selected' : '') + '>' + esc(d.name) + '</option>'; }).join('') : '') + '</select>';
        }
        h += '<span class="cs-chips" role="group" aria-label="Connection types">' + TYPES.map(function (t) { return '<button class="cs-chip' + (S.types[t.k] ? '' : ' off') + '" data-type="' + t.k + '" aria-pressed="' + S.types[t.k] + '" style="--c:' + t.c + '"><i></i>' + t.n + '</button>'; }).join('') + '</span>';
        if (META && META.canSeeUsers) h += '<select class="cs-sel" data-pick="user" aria-label="Admin"><option value="">All admins</option>' + META.users.map(function (u) { return '<option value="' + esc(u.id) + '"' + (S.users.length == 1 && S.users[0] == u.id ? ' selected' : '') + '>' + esc(u.name) + '</option>'; }).join('') + '</select>';
        h += '<button class="cs-chip' + (S.guests ? '' : ' off') + '" data-guests aria-pressed="' + S.guests + '" style="--c:#888" title="Device-share guests are kept separate and off by default"><i></i>Guests</button>';
        h += '<span class="cs-right"><span class="cs-seg" role="group" aria-label="Period">' + MAIN_PRESETS.map(function (k) { return '<button data-preset="' + k + '" class="' + (S.preset == k ? 'on' : '') + '">' + PRESET[k].n + '</button>'; }).join('') + '</span>';
        if (S.preset == 'custom') h += '<span class="cs-custom"><input class="cs-in" type="date" data-date="start" value="' + isoDay(S.start) + '" aria-label="From"> to <input class="cs-in" type="date" data-date="end" value="' + isoDay(S.end - 1) + '" aria-label="To"><button class="cs-btn" data-act="apply-dates">Apply</button></span>';
        h += '<select class="cs-sel" data-pick="bucket" aria-label="Granularity"><option value="auto"' + (S.bucket == 'auto' ? ' selected' : '') + '>Auto</option>' + ['hour', 'day', 'week', 'month'].map(function (b) { return '<option value="' + b + '"' + (S.bucket == b ? ' selected' : '') + '>By ' + b + '</option>'; }).join('') + '</select>';
        var noCmp = (S.preset == 'all');
        h += '<button class="cs-btn' + (S.compare && !noCmp ? ' on' : '') + '" data-compare aria-pressed="' + (S.compare && !noCmp) + '"' + (noCmp ? ' disabled title="There is nothing before the oldest session to compare with"' : '') + '>Compare</button>';
        h += '<span class="cs-menu-wrap"><button class="cs-btn primary" data-act="menu" aria-haspopup="true" aria-expanded="' + MENU + '">Export</button>' + (MENU ? exportMenu() : '') + '</span>';
        if (!COMPACT) h += '<a class="cs-btn" href="' + API + '&view=kimai">Kimai</a>';
        if (BOOT.isAdmin && !COMPACT) h += '<a class="cs-btn" href="' + API + '&view=settings" title="Retention, recorded types, active time, import">Settings</a>';
        h += '</span></div>';
        return h;
    }

    // ---------- settings page (site admins) ----------
    var SET = null, SETMSG = '', BF = null, bfTimer = null, BK = null, RS = null, RSMSG = '', rsTimer = null, rsSel = '';
    function backfillCoverage(st) {
        var c = st.coverage;
        if (!c || st.running) return '';
        var kinds = ['events', 'relay', 'supportedRelay', 'sessions'], months = {};
        kinds.forEach(function (k) { Object.keys(c[k].months).forEach(function (m) { months[m] = true; }); });
        var keys = Object.keys(months).sort(), rows = [];
        if (keys.length) {
            var d = new Date(keys[0] + '-01T00:00:00Z'), last = keys[keys.length - 1];
            while (d.toISOString().slice(0, 7) <= last) {
                var month = d.toISOString().slice(0, 7);
                rows.push('<tr><td>' + esc(month) + '</td>' + kinds.map(function (k) { return '<td class="num">' + (c[k].months[month] || 0) + '</td>'; }).join('') + '</tr>');
                d.setUTCMonth(d.getUTCMonth() + 1);
            }
        }
        return '<details class="cs-note"><summary>Database import coverage (' + (st.days == 0 ? 'all history' : esc(st.days) + ' days') + ')</summary>'
            + '<p>Counts by UTC month. Sessions include existing sessions that were skipped. Zero relay events means the query returned no connection events for that month.</p>'
            + '<div class="cs-tscroll"><table class="cs-table"><thead><tr><th>Month (UTC)</th><th>Events returned</th><th>Relay events</th><th>Supported relay events</th><th>Sessions found</th></tr></thead><tbody>' + rows.join('') + '</tbody></table></div></details>';
    }
    function settingsPage() {
        var h = '<div class="cs-bar"><b>Connection Stats settings</b><span class="cs-right"><a class="cs-btn" href="' + API + '">Back to the dashboard</a></span></div>';
        if (ERR) return h + '<div class="cs-empty"><b>Could not load</b><span class="cs-err">' + esc(ERR) + '</span></div>';
        if (!SET) return h + '<div class="cs-empty"><b>Loading</b></div>';
        var st = SET.settings, a = st.activity || {};
        var row = function (label, control, note) { return '<div class="cs-set"><label>' + label + '</label><div>' + control + (note ? '<div class="cs-note">' + note + '</div>' : '') + '</div></div>'; };
        h += '<form id="cs-settings" class="cs-form">';
        h += row('Keep sessions for', '<input class="cs-in" type="number" min="0" max="3650" name="retentionDays" value="' + esc(st.retentionDays) + '"> days', '0 disables retention cleanup and keeps all sessions. Otherwise, closed sessions older than this are removed daily. Open sessions are never removed.');
        h += row('Ignore sessions shorter than', '<input class="cs-in" type="number" min="0" max="3600" name="minSeconds" value="' + esc(st.minSeconds) + '"> seconds', 'Drops accidental clicks. 0 records everything.');
        h += row('Record these types', '<span class="cs-chips">' + TYPES.map(function (t) { return '<label class="cs-chip' + (st.recordTypes.indexOf(t.k) >= 0 ? '' : ' off') + '" style="--c:' + t.c + '"><input type="checkbox" name="type" value="' + t.k + '"' + (st.recordTypes.indexOf(t.k) >= 0 ? ' checked' : '') + ' style="display:none"><i></i>' + t.n + '</label>'; }).join('') + '</span>', 'Sessions of a type that is off are not recorded at all.');
        h += row('Active time', '<label><input type="checkbox" name="activityEnabled"' + (a.enabled !== false ? ' checked' : '') + '> Measure input in the Desktop, Terminal and Files views</label>', 'Only "still active" heartbeats leave the browser, never the input itself.');
        h += row('Idle threshold', '<input class="cs-in" type="number" min="1" max="120" step="0.5" name="idleMinutes" value="' + esc(a.idleMinutes) + '"> minutes', 'Each heartbeat counts as this much active time. Overlaps merge.');
        h += row('Heartbeat interval', '<input class="cs-in" type="number" min="10" max="300" name="beatSeconds" value="' + esc(a.beatSeconds) + '"> seconds', 'How often the browser reports input at most.');
        h += row('Export time zone', '<input class="cs-in" type="text" name="tz" value="' + esc(st.tz || '') + '" placeholder="browser zone"> ', 'Optional IANA zone such as Europe/Zurich. Empty uses the viewer\'s browser zone.');
        h += '<div class="cs-set"><label></label><div><button class="cs-btn primary" type="submit">Save settings</button> <span class="cs-note">' + esc(SETMSG) + '</span></div></div></form>';
        var bf = BF || SET.backfill || { running: false };
        var bfText = bf.running ? 'Importing: ' + (bf.scanned || 0) + ' events read, ' + (bf.found || 0) + ' sessions found, ' + (bf.imported || 0) + ' imported so far' + (bf.windowFrom ? ', reading back to ' + fmtDate(bf.windowFrom) : '') + '.' : bf.finishedAt ? 'Last import ' + fmtDT(bf.finishedAt) + ': ' + bf.scanned + ' events read, ' + bf.found + ' sessions found, ' + bf.imported + ' imported, ' + bf.skipped + ' already known.' + (bf.error ? ' Error: ' + bf.error : '') : 'Not run in this server session.';
        h += '<div class="cs-card"><h5>Import past sessions from MeshCentral\'s event log</h5><p class="cs-note" style="margin:0">Import directly from the live database. Set days back to 0 to read all retained events, including older history still present in the database. Existing sessions are skipped.</p><div class="cs-bar"><input class="cs-in" type="number" min="0" max="36500" id="cs-bfdays" value="0" style="width:80px"> days back (0 = all history) <button class="cs-btn" data-act="backfill"' + (bf.running ? ' disabled' : '') + '>Import now</button><span class="cs-note">' + esc(bfText) + '</span></div></div>';
        h += backfillCoverage(bf);
        h += restoreCard();
        if (st.retentionDays > 0) h += '<div class="cs-card"><h5>Retention</h5><div class="cs-bar"><button class="cs-btn" data-act="sweep">Remove sessions older than ' + esc(st.retentionDays) + ' days now</button><span class="cs-note">Runs automatically every day.</span></div></div>';
        h += '<div class="cs-note">Connection Stats ' + esc(SET.version) + '</div>';
        return h;
    }
    function restoreCard() {
        var rs = RS || { running: false }, busy = !!rs.running;
        var text;
        if (busy) text = 'Importing ' + (rs.label || '') + (rs.file && rs.file != rs.label ? ' (' + rs.file + ')' : '') + ': ' + (rs.scanned || 0) + ' records read, ' + (rs.relay || 0) + ' relay events' + (rs.phase == 'importing' ? ', ' + (rs.found || 0) + ' sessions found, ' + (rs.imported || 0) + ' imported so far' : '') + '.';
        else if (rs.finishedAt) text = 'Last import ' + fmtDT(rs.finishedAt) + ' from ' + (rs.label || 'file') + ': ' + (rs.error ? 'failed. ' + rs.error : (rs.scanned || 0) + ' records read, ' + (rs.relay || 0) + ' relay events, ' + (rs.found || 0) + ' sessions found, ' + (rs.imported || 0) + ' imported, ' + (rs.skipped || 0) + ' already known' + (rs.updated ? ', ' + rs.updated + ' names repaired' : '') + '.');
        else text = RSMSG || '';
        var h = '<div class="cs-card"><h5>Import from a backup</h5>';
        h += '<p class="cs-note" style="margin:0">Relay events older than MeshCentral\'s limit are gone from its database, but its backups still hold them. The plugin reads the events file or database dump inside a backup (meshcentral-events.db, a mongodump archive, a mysqldump or pg_dump file, a SQLite copy) and adds the sessions it does not have yet. Go through your backups oldest first; running one twice is harmless. A password-protected backup has to be unzipped first, then import the file from inside it.</p>';
        var opts = '';
        if (BK && BK.files && BK.files.length) opts = BK.files.map(function (f) { return '<option value="' + esc(f.name) + '"' + (f.name == rsSel ? ' selected' : '') + '>' + esc(f.name) + ' (' + fmtBytes(f.size) + ', ' + fmtDate(f.backupTime == null ? f.mtime : f.backupTime) + ')</option>'; }).join('');
        var folderNote = BK == null ? 'Looking for backups' : BK.error ? esc(BK.error) : BK.folder == null ? 'MeshCentral has no backup folder.' : (BK.files.length ? esc(BK.folder) : 'No backups in ' + esc(BK.folder) + '.');
        h += '<div class="cs-bar"><label class="cs-note" for="cs-bkfile">From the server\'s backup folder</label><select class="cs-sel" id="cs-bkfile" style="max-width:420px"' + (opts ? '' : ' disabled') + '>' + (opts || '<option>no backups found</option>') + '</select> <button class="cs-btn" data-act="restore"' + (busy || !opts ? ' disabled' : '') + '>Import this backup</button><span class="cs-note">' + folderNote + '</span></div>';
        h += '<div class="cs-bar"><label class="cs-note" for="cs-bkupload">Or upload a file</label><input type="file" id="cs-bkupload" class="cs-in" style="max-width:none" accept=".zip,.db,.db3,.sqlite,.archive,.gz,.sql,.json,.jsonl"> <button class="cs-btn" data-act="upload"' + (busy ? ' disabled' : '') + '>Upload and import</button></div>';
        h += '<div class="cs-note">' + esc(text) + '</div></div>';
        return h;
    }
    function loadBackups() { get(API + '&api=backups').then(function (b) { BK = b; render(); }).catch(function (e) { BK = { folder: null, files: [], error: e.message }; render(); }); }
    function pollRestore() {
        if (rsTimer) clearTimeout(rsTimer);
        get(API + '&api=restore').then(function (r) { RS = r; render(); if (r.running) rsTimer = setTimeout(pollRestore, 1500); }).catch(function () { });
    }
    function uploadBackup(file) {
        var fd = new FormData(); fd.append('file', file, file.name);
        RSMSG = 'Uploading ' + file.name + ' (' + fmtBytes(file.size) + ')'; render();
        return fetch(API, { method: 'POST', credentials: 'same-origin', body: fd })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok || j.ok === false) throw new Error(j.error || ('Upload failed (' + r.status + ')')); return j; }); });
    }
    function postForm(fields) {
        return fetch(API, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: qs(fields) })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok || j.ok === false) throw new Error(j.error || ('Request failed (' + r.status + ')')); return j; }); });
    }
    function loadSettings() {
        get(API + '&api=settings').then(function (s) { SET = s; ERR = null; render(); }).catch(function (e) { ERR = e.message; render(); });
    }
    function pollBackfill() {
        if (bfTimer) clearTimeout(bfTimer);
        get(API + '&api=backfill').then(function (b) { BF = b; render(); if (b.running) bfTimer = setTimeout(pollBackfill, 2000); }).catch(function () { });
    }
    function saveSettingsForm(form) {
        var fd = new FormData(form), types = [];
        form.querySelectorAll('input[name=type]:checked').forEach(function (i) { types.push(i.value); });
        var st = { retentionDays: fd.get('retentionDays'), minSeconds: fd.get('minSeconds'), recordTypes: types, activity: { enabled: form.querySelector('input[name=activityEnabled]').checked, idleMinutes: fd.get('idleMinutes'), beatSeconds: fd.get('beatSeconds') }, tz: fd.get('tz') };
        postForm({ action: 'settings', settings: JSON.stringify(st) }).then(function (j) { SET.settings = j.settings; SETMSG = 'Saved.'; render(); }).catch(function (e) { SETMSG = e.message; render(); });
    }
    function exportMenu() {
        return '<div class="cs-menu" role="menu"><a class="cs-btn" href="' + API + '&view=kimai#' + qs(queryParams()) + '">Send to Kimai</a>' + (window.CS_EXPORT_ITEMS ? window.CS_EXPORT_ITEMS() : '') +
            '<button role="menuitem" data-act="print">Print or save as PDF<small>Whole page, print layout</small></button>' +
            '<hr><button role="menuitem" data-act="copylink">Copy link to this view</button></div>';
    }
    function render() {
        hideChartTip();
        if (BOOT.view == 'settings') { root.className = 'cs'; root.innerHTML = settingsPage(); return; }
        // Native date inputs emit change for individual year digits. Keep the focused
        // input intact during background refreshes so its editing segment is not lost.
        if (document.activeElement && document.activeElement.dataset && document.activeElement.dataset.date) return;
        var h = toolbar();
        if (ERR) h += '<div class="cs-empty"><b>Could not load</b><span class="cs-err">' + esc(ERR) + '</span></div>';
        else if (!DATA) h += '<div class="cs-empty"><b>Loading</b>Reading sessions from the server.</div>';
        else {
            var a = DATA.aggregate, prev = S.compare ? DATA.previous : null, pr = prev ? { start: prev.start, end: prev.end } : null;
            h += '<div class="cs-range"><span><b>' + esc(scopeName()) + '</b></span><span>' + esc(PRESET[S.preset].n) + ', <b>' + fmtDate(a.start) + ' to ' + fmtDate(a.end - 1) + '</b></span><span>by ' + a.bucket + '</span><span>' + esc(TZ) + '</span>' + (pr ? '<span>compared with ' + fmtDate(pr.start) + ' to ' + fmtDate(pr.end - 1) + '</span>' : '') + '</div>';
            var t = a.totals, pt = prev ? prev.totals : null;
            h += '<div class="cs-kpis">'
                + '<div class="cs-kpi"><div class="l">Connected time</div><div class="v">' + fmtDur(t.seconds) + '</div>' + (pt ? delta(t.seconds, pt.seconds) : '') + '</div>'
                + '<div class="cs-kpi"><div class="l">Active time</div><div class="v">' + (t.seenSeconds ? fmtDur(t.active) : '<small>no data</small>') + '</div><span class="d">' + (t.seenSeconds ? Math.round(t.active / t.seenSeconds * 100) + '% of the ' + fmtDur(t.seenSeconds) + ' with input data' : 'no session in this range had input data') + '</span></div>'
                + '<div class="cs-kpi"><div class="l">Sessions</div><div class="v">' + t.count + (t.ongoing ? ' <small>' + t.ongoing + ' ongoing</small>' : '') + '</div>' + (pt ? delta(t.count, pt.count) : '') + '</div>'
                + '<div class="cs-kpi"><div class="l">Median session</div><div class="v">' + fmtDur(t.median) + '</div>' + (pt ? delta(t.median, pt.median) : '') + '</div>'
                + '<div class="cs-kpi"><div class="l">Longest session</div><div class="v">' + fmtDur(t.longest) + '</div></div>'
                + (COMPACT ? '' : '<div class="cs-kpi"><div class="l">Devices touched</div><div class="v">' + t.devices + (META ? ' <small>of ' + (S.scope.indexOf('mesh:') == 0 ? META.devices.filter(function (d) { return 'mesh:' + d.meshid == S.scope; }).length : META.devices.length) + '</small>' : '') + '</div></div>')
                + '</div>';
            if (!t.count) h += '<div class="cs-empty"><b>No sessions in this range</b>Nothing was recorded for ' + esc(scopeName()) + ' between ' + fmtDate(a.start) + ' and ' + fmtDate(a.end - 1) + '. Try a longer period or other connection types.</div>';
            else {
                var main = '<div class="cs-card"><h5>Connected time per ' + a.bucket + '<span>click a segment to filter the list</span></h5>' + stackedBars(a, prev, S.sel) + '<div class="cs-legend">' + TYPES.filter(function (x) { return a.byType[x.k]; }).map(function (x) { return '<span><i style="background:' + x.c + '"></i>' + x.n + '</span>'; }).join('') + (prev ? '<span><i style="width:14px;height:0;border-top:2px dashed var(--axis)"></i>previous period</span>' : '') + '</div></div>';
                if (COMPACT) h += main + '<div class="cs-card"><h5>Share by type</h5>' + donut(a) + '</div>';
                else {
                    var byKind = S.scope == 'all' ? 'group' : 'device', list = byKind == 'group' ? a.byGroup : a.byDevice;
                    h += '<div class="cs-grid">' + main + '<div class="cs-col"><div class="cs-card"><h5>Share by type</h5>' + donut(a) + '</div><div class="cs-card"><h5>Where the time went<span>by ' + byKind + '</span></h5>' + hbars(list, byKind) + '</div></div></div>';
                }
                if (a.bucket == 'hour') h += '<div class="cs-card"><h5>Sessions in this range<span>one row per device, hatched is ongoing</span></h5>' + timeline(DAYLIST || [], a.start, a.end) + '</div>';
                else if (a.daily) h += '<div class="cs-card"><h5>Every day<span>darker is more time</span></h5><div class="cs-cal">' + calendar(a.daily, a.start, a.end) + '</div></div>';
                else if (!COMPACT) h += '<div class="cs-card"><h5>When you connect<span>by weekday and hour of start, click a bubble to filter the list</span></h5>' + punchcard(a.punchcard, S.pc) + '</div>';
            }
            h += '<div class="cs-card cs-sess"><h5>Sessions' + (t.ongoing ? '<span class="cs-live">' + t.ongoing + ' ongoing, counted up to now</span>' : '') + '</h5>' + table(LIST || { rows: [], total: 0 }) + '</div>';
            h += '<div class="cs-note">* start or end not observed (server restart). Active time is measured from your input in the Desktop, Terminal and Files views; sessions from other clients show no data.</div>';
        }
        lastW = root.clientWidth;
        root.className = 'cs' + (COMPACT ? ' cs-compact' : ' cs-full') + (LOADING ? ' cs-loading' : '');
        root.innerHTML = h;
        reportHeight();
    }
    // when embedded in the device tab, tell the parent how tall we are
    function reportHeight() {
        if (window.parent === window) return;
        // measure the content, not the viewport: the viewport is whatever height the parent gave the iframe
        try { window.parent.postMessage({ cs: 'height', h: root.offsetHeight + 16 }, '*'); } catch (e) { }
    }
    window.addEventListener('resize', reportHeight);
    // On My Server > Plugins, MeshCentral gives its plugin iframe a fixed height that leaves a
    // strip unused at the bottom. Same origin, so size the frame to what is really left.
    function fitFrame() {
        if (COMPACT || window.parent === window) return;
        try {
            var f = window.frameElement; if (!f || f.id != 'p43iframe' || !f.offsetParent) return;
            var foot = window.parent.document.getElementById('footer'), fh = (foot && foot.offsetParent) ? foot.offsetHeight : 0;
            var h = window.parent.innerHeight - f.getBoundingClientRect().top - fh - 6;
            if (h > 200) { f.style.height = h + 'px'; f.style.maxHeight = h + 'px'; }
        } catch (e) { }
    }
    try { if (!COMPACT && window.parent !== window) { fitFrame(); window.parent.addEventListener('resize', function () { setTimeout(fitFrame, 0); }); setTimeout(fitFrame, 500); } } catch (e) { }

    // ---------- events ----------
    var chartTip = null, tipBar = null;
    var CHART_TARGET = '.bar, .pc, .cs-day, .cs-session, .cs-bucket, .cs-track, .cs-share, .cs-where';
    function hideChartTip() {
        if (chartTip) chartTip.hidden = true;
        if (tipBar) tipBar.removeAttribute('aria-describedby');
        tipBar = null;
    }
    function showChartTip(ev) {
        var bar = ev.target.closest && ev.target.closest(CHART_TARGET);
        if (!bar) { hideChartTip(); return; }
        if (!chartTip) {
            chartTip = document.createElement('div'); chartTip.id = 'cs-chart-tip';
            chartTip.className = 'cs-chart-tip'; chartTip.setAttribute('role', 'tooltip');
            document.body.appendChild(chartTip);
        }
        if (tipBar && tipBar !== bar) tipBar.removeAttribute('aria-describedby');
        tipBar = bar;
        var a = DATA && DATA.aggregate, cell = null, heading = bar.getAttribute('aria-label');
        if (a && bar.dataset.share != null) {
            heading = 'Share by type'; cell = { tot: a.totals.seconds, by: a.byType };
        } else if (a && bar.dataset.where != null) {
            var items = bar.dataset.kind == 'group' ? a.byGroup : a.byDevice;
            var item = items[Number(bar.dataset.where)];
            if (item) { heading = item.name; cell = { tot: item.seconds, by: item.by }; }
        } else if (a && bar.dataset.track != null) {
            var from = a.start, to = a.end;
            if (ev.clientX != null) {
                var trackRect = bar.getBoundingClientRect();
                var position = Math.max(0, Math.min(0.999999, (ev.clientX - trackRect.left) / trackRect.width));
                var hourStart = new Date(a.start + position * (a.end - a.start)); hourStart.setMinutes(0, 0, 0);
                from = Math.max(a.start, +hourStart); to = Math.min(a.end, +hourStart + 3600000);
            }
            cell = { tot: 0, by: {} };
            (DAYLIST || []).forEach(function (s) {
                if (s.node != bar.dataset.track) return;
                var value = Math.max(0, (Math.min(s.end == null ? Date.now() : s.end, to) - Math.max(s.start, from)) / 1000);
                cell.tot += value; cell.by[s.type] = (cell.by[s.type] || 0) + value;
            });
            heading = bar.dataset.track + ': ' + fmtDT(from) + ' to ' + fmtDT(to);
        } else if (a && bar.dataset.session != null) {
            var session = DAYLIST && DAYLIST[Number(bar.dataset.session)];
            if (session) {
                var finish = session.end == null ? Date.now() : session.end;
                var seconds = Math.max(0, (Math.min(finish, a.end) - Math.max(session.start, a.start)) / 1000);
                cell = { tot: seconds, by: {} }; cell.by[session.type] = seconds;
                heading = session.node + ': ' + fmtDT(session.start) + ' to ' + (session.end == null ? 'now' : fmtDT(session.end));
            }
        } else if (a && bar.dataset.day != null) {
            var day = Number(bar.dataset.day);
            cell = (a.daily || []).find(function (d) { return isoDay(d.s) == isoDay(day); }) || { tot: 0, by: {} };
            heading = fmtDate(day);
        } else if (a && bar.dataset.pc != null) {
            var wd = Number(bar.dataset.wd), hour = Number(bar.dataset.h);
            cell = a.punchcard && a.punchcard[wd] && a.punchcard[wd][hour];
            heading = cellLabel(wd, hour);
        } else if (a) {
            cell = a.buckets[Number(bar.dataset.i)];
            if (cell) heading = longLabel(cell, a.bucket);
        }
        var html = '<div class="cs-tip-heading">' + esc(heading) + '</div>';
        if (cell) {
            html += '<div class="cs-tip-total"><span>Total</span><b>' + fmtDur(cell.tot) + '</b></div>';
            html += TYPES.filter(function (t) { return cell.by[t.k] > 0; }).map(function (t) {
                return '<div class="cs-tip-row"><i aria-hidden="true" style="background:' + t.c + '"></i><span>' + esc(t.n) + '</span><b>' + fmtDur(cell.by[t.k]) + (bar.dataset.share != null && cell.tot ? ' (' + Math.round(cell.by[t.k] / cell.tot * 100) + '%)' : '') + '</b></div>';
            }).join('');
        }
        if (cell && !cell.tot) html += '<div class="cs-tip-hint">No sessions</div>';
        if (bar.dataset.day == null && bar.dataset.session == null && bar.dataset.track == null && bar.dataset.share == null && bar.dataset.where == null && !(bar.classList && bar.classList.contains('cs-bucket'))) html += '<div class="cs-tip-hint">Click to filter sessions</div>';
        // Pointer movement only repositions the tooltip; keep its contents stable.
        if (chartTip.innerHTML != html) chartTip.innerHTML = html;
        chartTip.hidden = false; bar.setAttribute('aria-describedby', chartTip.id);
        var rect = bar.getBoundingClientRect();
        var x = ev.clientX == null ? rect.left + rect.width / 2 : ev.clientX;
        var y = ev.clientY == null ? rect.top : ev.clientY;
        chartTip.style.left = Math.max(8, Math.min(x + 12, window.innerWidth - chartTip.offsetWidth - 8)) + 'px';
        chartTip.style.top = Math.max(8, Math.min(y + 12, window.innerHeight - chartTip.offsetHeight - 8)) + 'px';
    }
    root.addEventListener('pointerover', showChartTip);
    root.addEventListener('pointermove', showChartTip);
    root.addEventListener('pointerout', function (ev) {
        var next = ev && ev.relatedTarget;
        if (next && next.closest && next.closest(CHART_TARGET) === tipBar) return;
        hideChartTip();
    });
    root.addEventListener('focusin', showChartTip);
    root.addEventListener('focusout', hideChartTip);
    window.addEventListener('scroll', hideChartTip, true);
    root.addEventListener('submit', function (ev) { if (ev.target.id == 'cs-settings') { ev.preventDefault(); saveSettingsForm(ev.target); } });
    root.addEventListener('click', function (ev) {
        var t = ev.target, el;
        if (BOOT.view == 'settings') {
            var a = (el = t.closest('[data-act]')) ? el.dataset.act : null;
            if (a == 'backfill') { var days = document.getElementById('cs-bfdays').value; postForm({ action: 'backfill', days: days }).then(function () { pollBackfill(); }).catch(function (e) { SETMSG = e.message; render(); }); }
            if (a == 'restore') { var sel = document.getElementById('cs-bkfile'); rsSel = sel.value; RSMSG = ''; postForm({ action: 'restore', file: sel.value }).then(function () { pollRestore(); }).catch(function (e) { RSMSG = e.message; render(); }); }
            if (a == 'upload') { var inp = document.getElementById('cs-bkupload'); if (!inp.files || !inp.files[0]) { RSMSG = 'Choose a file first.'; render(); } else uploadBackup(inp.files[0]).then(function () { RSMSG = ''; pollRestore(); }).catch(function (e) { RSMSG = e.message; render(); }); }
            if (a == 'sweep') { postForm({ action: 'sweep' }).then(function (j) { SETMSG = 'Removed ' + j.removed + ' session(s).'; render(); }).catch(function (e) { SETMSG = e.message; render(); }); }
            if (t.closest('label.cs-chip')) { setTimeout(function () { root.querySelectorAll('label.cs-chip').forEach(function (l) { l.classList.toggle('off', !l.querySelector('input').checked); }); }, 0); }
            return;
        }
        if ((el = t.closest('[data-preset]'))) { S.preset = el.dataset.preset; if (S.preset == 'custom') { if (!S.start) applyPreset(); } else applyPreset(); load(); return; }
        if ((el = t.closest('[data-type]'))) { S.types[el.dataset.type] = !S.types[el.dataset.type]; if (!activeTypes().length) S.types[el.dataset.type] = true; load(); return; }
        if ((el = t.closest('[data-scope]'))) { var k = el.dataset.scope; S.scope = k == 'all' ? 'all' : k == 'group' ? (META && META.groups[0] ? 'mesh:' + META.groups[0].id : 'all') : (META && META.devices[0] ? 'node:' + META.devices[0].id : 'all'); load(); return; }
        if ((el = t.closest('[data-scope-to]'))) { ev.preventDefault(); S.scope = el.dataset.scopeTo; load(); return; }
        if (t.closest('[data-compare]')) { S.compare = !S.compare; load(); return; }
        if (t.closest('[data-guests]')) { S.guests = !S.guests; load(); return; }
        if (t.classList && t.classList.contains('bar')) { var i = +t.dataset.i, ty = t.dataset.t; S.sel = (S.sel && S.sel.i == i && S.sel.t == ty) ? null : { i: i, t: ty }; S.pc = null; loadList(0); return; }
        if ((el = t.closest('[data-pc]'))) { var wd = +el.dataset.wd, hr = +el.dataset.h; S.pc = (S.pc && S.pc.wd == wd && S.pc.h == hr) ? null : { wd: wd, h: hr }; S.sel = null; loadList(0); return; }
        var act = (el = t.closest('[data-act]')) ? el.dataset.act : null;
        if (act == 'apply-dates') { applyDates(); return; }
        if (act == 'clear') { ev.preventDefault(); S.sel = null; S.pc = null; loadList(0); return; }
        if (act == 'zoom') { ev.preventDefault(); if (S.sel) { var b = DATA.aggregate.buckets[S.sel.i]; S.start = b.s; S.end = b.e; S.preset = 'custom'; S.bucket = 'auto'; load(); } return; }
        if (act == 'prev') { loadList(Math.max(0, S.skip - S.limit)); return; }
        if (act == 'next') { loadList(S.skip + S.limit); return; }
        if (act == 'menu') { MENU = !MENU; render(); return; }
        if (act == 'print') { MENU = false; render(); setTimeout(function () { window.print(); }, 50); return; }
        if (act == 'copylink') { MENU = false; render(); var url = location.href; try { navigator.clipboard.writeText(url); } catch (e) { window.prompt('Copy this link', url); } return; }
        if (act && window.CS_EXPORT && window.CS_EXPORT[act]) { MENU = false; render(); window.CS_EXPORT[act](); return; }
        if (MENU && !t.closest('.cs-menu-wrap')) { MENU = false; render(); }
    });
    root.addEventListener('change', function (ev) {
        var t = ev.target;
        if (t.dataset.pick == 'mesh') { S.scope = 'mesh:' + t.value; load(); }
        else if (t.dataset.pick == 'node') { S.scope = 'node:' + t.value; load(); }
        else if (t.dataset.pick == 'user') { S.users = t.value ? [t.value] : []; load(); }
        else if (t.dataset.pick == 'bucket') { S.bucket = t.value; load(); }
        else if (t.dataset.pick == 'limit') { S.limit = Number(t.value); try { localStorage.setItem('cs-limit', t.value); } catch (e) { } loadList(0); }
    });
    root.addEventListener('input', function (ev) {
        if (ev.target.dataset.date) root.querySelectorAll('[data-date]').forEach(function (t) { t.setCustomValidity(''); });
    });
    function applyDates() {
        var inputs = root.querySelectorAll('[data-date]'), dates = {};
        for (var i = 0; i < inputs.length; i++) {
            var t = inputs[i], v = t.value.split('-').map(Number);
            t.setCustomValidity('');
            if (!t.value || !t.checkValidity() || v.length != 3 || !v[0]) { t.setCustomValidity('Enter a complete date.'); t.reportValidity(); return; }
            // setFullYear avoids the Date constructor's special handling of years 0–99.
            var d = new Date(0); d.setHours(0, 0, 0, 0); d.setFullYear(v[0], v[1] - 1, v[2]);
            if (t.dataset.date == 'end') d.setDate(d.getDate() + 1);
            dates[t.dataset.date] = d.getTime();
        }
        if (!isFinite(dates.start) || !isFinite(dates.end)) return;
        if (dates.end <= dates.start) { inputs[1].setCustomValidity('Choose an end date on or after the start date.'); inputs[1].reportValidity(); return; }
        S.start = dates.start; S.end = dates.end; S.preset = 'custom'; load();
    }
    root.addEventListener('keydown', function (ev) {
        if (ev.key == 'Enter' && ev.target.dataset && ev.target.dataset.date) { ev.preventDefault(); ev.target.blur(); applyDates(); return; }
        if (ev.key == 'Escape') { hideChartTip(); if (MENU) { MENU = false; render(); } else if (S.sel || S.pc) { S.sel = null; S.pc = null; loadList(0); } }
        if ((ev.key == 'Enter' || ev.key == ' ') && ev.target.classList && (ev.target.classList.contains('bar') || ev.target.classList.contains('pc'))) { ev.preventDefault(); ev.target.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
    });
    window.addEventListener('hashchange', function () { readHash(); if (S.preset != 'custom') applyPreset(); load(); });

    // expose a little for the export module
    window.CS = { state: S, data: function () { return DATA; }, meta: function () { return META; }, api: API, qs: qs, queryParams: queryParams, tz: TZ, fmtDur: fmtDur, scopeName: scopeName, isoDay: isoDay, render: render, load: load, get: get };

    // ---------- boot ----------
    if (BOOT.view == 'settings') { render(); loadSettings(); pollBackfill(); loadBackups(); pollRestore(); return; }
    // Explicit shared links win over saved preferences; device views keep their boot scope.
    var saved = '';
    if (!location.hash) { try { saved = localStorage.getItem(STATE_KEY) || ''; } catch (e) { } }
    readHash(saved);
    if (!location.hash && BOOT.scope) S.scope = BOOT.scope;
    if (S.preset != 'custom' || !S.start) applyPreset();
    get(API + '&api=meta').then(function (m) { META = m; }).catch(function (e) { ERR = e.message; }).then(function () { load(); });
})();
