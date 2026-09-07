/**
* Connection Stats dashboard. Plain browser JavaScript, no build step. Served by the plugin at
* pluginadmin.ashx?pin=connectionstats&file=dashboard.js and booted from window.CS_BOOT.
* Data comes from the JSON API on the same URL (api=meta | query | sessions); every request is
* scoped on the server to what the logged-in user may see.
*/
(function () {
    'use strict';
    var BOOT = window.CS_BOOT || {};
    var API = 'pluginadmin.ashx?pin=connectionstats';
    var COMPACT = (BOOT.view == 'device');
    var TYPES = [
        { k: 'desktop', n: 'Desktop', c: '#4477AA' },
        { k: 'terminal', n: 'Terminal', c: '#228833' },
        { k: 'files', n: 'Files', c: '#CCBB44' },
        { k: 'webapp', n: 'Web RDP/SSH', c: '#66CCEE' },
        { k: 'messenger', n: 'Messenger', c: '#AA3377' },
        { k: 'amt', n: 'Intel AMT', c: '#EE6677' },
        { k: 'other', n: 'Other', c: '#BBBBBB' }
    ];
    var TYPE = {}; TYPES.forEach(function (t) { TYPE[t.k] = t; });
    // MeshCentral's relay protocol numbers. Anything that is not one of the named types lands in
    // "Other"; the number tells what it was. 0 means the relay was opened without a protocol,
    // which is what MeshCentral Router and other port tunnels do.
    var PROTO = { 0: 'Router or port tunnel', 1: 'Terminal', 2: 'Desktop', 5: 'Files', 6: 'PowerShell', 7: 'Plugin', 8: 'Root shell', 9: 'Root PowerShell', 10: 'RDP relay', 11: 'SSH relay', 12: 'VNC relay', 13: 'SFTP relay', 14: 'Web-TCP relay', 100: 'Intel AMT', 101: 'Intel AMT', 200: 'Messenger', 201: 'Web RDP', 202: 'Web SSH', 203: 'Web SFTP' };
    function protoName(p) { p = Number(p) || 0; return PROTO[p] || ('protocol ' + p); }
    var DAY = 86400000;
    var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var TZ = 'UTC';
    try { TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { }

    // ---------- helpers ----------
    function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    function fmtDur(sec) {
        sec = Math.round(sec || 0);
        if (sec < 60) return sec + 's';
        var m = Math.round(sec / 60); if (m < 60) return m + 'm';
        var h = Math.floor(m / 60); m = m % 60; if (h < 24) return h + 'h ' + p2(m) + 'm';
        var d = Math.floor(h / 24); return d + 'd ' + (h % 24) + 'h';
    }
    function fmtBytes(b) { b = b || 0; if (b < 1024) return b + ' B'; if (b < 1048576) return (b / 1024).toFixed(0) + ' KB'; if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB'; return (b / 1073741824).toFixed(2) + ' GB'; }
    function fmtDate(t) { var d = new Date(t); return d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear(); }
    function fmtDT(t) { var d = new Date(t); return DOW[d.getDay()] + ' ' + d.getDate() + ' ' + MON[d.getMonth()] + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()); }
    function isoDay(t) { var d = new Date(t); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
    function sod(t) { var d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
    function label(b, bucket) { var d = new Date(b.s); if (bucket == 'hour') return p2(d.getHours()) + ':00'; if (bucket == 'day') return DOW[d.getDay()] + ' ' + d.getDate(); if (bucket == 'week') return d.getDate() + ' ' + MON[d.getMonth()]; return MON[d.getMonth()] + (d.getMonth() == 0 ? ' ' + d.getFullYear() : ''); }
    function longLabel(b, bucket) {
        var d = new Date(b.s);
        if (bucket == 'hour') return DOW[d.getDay()] + ' ' + d.getDate() + ' ' + MON[d.getMonth()] + ', ' + p2(d.getHours()) + ':00 to ' + p2(new Date(b.e).getHours()) + ':00';
        if (bucket == 'day') return DOW[d.getDay()] + ' ' + d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear();
        if (bucket == 'week') return 'Week of ' + fmtDate(b.s);
        return MON[d.getMonth()] + ' ' + d.getFullYear();
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
        { k: 'custom', n: 'Custom', range: null }
    ];
    var PRESET = {}; PRESETS.forEach(function (p) { PRESET[p.k] = p; });
    var MAIN_PRESETS = COMPACT ? ['today', 'week', 'month', 'year', 'custom'] : ['today', 'week', 'month', 'thismonth', 'year', 'custom'];

    // ---------- state ----------
    var S = {
        scope: BOOT.scope || 'all', types: {}, users: [], preset: 'week', start: 0, end: 0, bucket: 'auto',
        compare: true, guests: false, sel: null, pc: null, skip: 0, limit: COMPACT ? 8 : 12
    };
    TYPES.forEach(function (t) { S.types[t.k] = true; });
    var META = null, DATA = null, LIST = null, DAYLIST = null, ERR = null, LOADING = false, MENU = false;
    var root = document.getElementById('cs-root');

    function applyPreset() { var p = PRESET[S.preset]; if (p && p.range) { var r = p.range(); S.start = r[0]; S.end = r[1]; } }
    function readHash() {
        var h = location.hash.replace(/^#/, ''); if (!h) return;
        var o = {}; h.split('&').forEach(function (kv) { var i = kv.indexOf('='); if (i > 0) o[decodeURIComponent(kv.substring(0, i))] = decodeURIComponent(kv.substring(i + 1)); });
        if (o.scope && !COMPACT) S.scope = o.scope;
        if (o.preset && PRESET[o.preset]) S.preset = o.preset;
        if (o.start && o.end) { S.start = Number(o.start); S.end = Number(o.end); S.preset = 'custom'; }
        if (o.types) { TYPES.forEach(function (t) { S.types[t.k] = false; }); o.types.split(',').forEach(function (k) { if (TYPE[k]) S.types[k] = true; }); }
        if (o.users) S.users = o.users.split(',');
        if (o.bucket) S.bucket = o.bucket;
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
        if (location.hash != h) { try { history.replaceState(null, '', h); } catch (e) { location.hash = h; } }
    }
    function activeTypes() { return TYPES.filter(function (t) { return S.types[t.k]; }).map(function (t) { return t.k; }); }
    function queryParams() {
        return { start: S.start, end: S.end, tz: TZ, scope: S.scope, types: (activeTypes().length == TYPES.length) ? null : activeTypes().join(','), users: S.users.join(',') || null, bucket: S.bucket == 'auto' ? null : S.bucket, compare: S.compare ? '1' : '0', guests: S.guests ? '1' : '0' };
    }

    // ---------- data ----------
    function load() {
        writeHash();
        LOADING = true; ERR = null; render();
        var qp = queryParams(); qp.limit = S.limit;
        var work = [get(API + '&api=query&' + qs(qp))];
        get(API + '&api=query&' + qs(qp)).then(function (d) {
            DATA = d; LIST = d.sessions; S.skip = 0; S.sel = null; S.pc = null; DAYLIST = null;
            if (d.aggregate.bucket == 'hour') {
                var lp = queryParams(); lp.limit = 500;
                return get(API + '&api=sessions&' + qs(lp)).then(function (l) { DAYLIST = l.rows; });
            }
        }).then(function () { LOADING = false; render(); }).catch(function (e) { LOADING = false; ERR = e.message || String(e); render(); });
    }
    function loadList(skip) {
        var qp = queryParams(); qp.skip = skip; qp.limit = S.limit;
        if (S.sel) { var b = DATA.aggregate.buckets[S.sel.i]; qp.start = b.s; qp.end = b.e; qp.types = S.sel.t; }
        if (S.pc) { qp.wd = S.pc.wd; qp.hour = S.pc.h; }
        get(API + '&api=sessions&' + qs(qp)).then(function (l) { LIST = l; S.skip = skip; render(); }).catch(function (e) { ERR = e.message; render(); });
    }

    // ---------- charts (inline SVG) ----------
    function niceMax(v) { if (v <= 0) return 1; var e = Math.pow(10, Math.floor(Math.log(v) / Math.LN10)); var m = v / e; var n = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10; return n * e; }
    function stackedBars(a, prev, sel) {
        var W = 760, H = 250, L = 38, R = 8, T = 12, B = 26, bk = a.buckets, n = bk.length, bucket = a.bucket;
        if (!n) return '';
        var maxv = 0; bk.forEach(function (b) { maxv = Math.max(maxv, b.tot); }); if (prev) prev.buckets.forEach(function (b) { maxv = Math.max(maxv, b.tot); });
        var unit = maxv > 3600 ? 3600 : maxv > 60 ? 60 : 1, maxU = niceMax(maxv / unit), ticks = [0, .25, .5, .75, 1].map(function (x) { return x * maxU; });
        var tick = function (t) { var v = Number.isInteger(t) ? t : Number(t.toFixed(1)); return v + (unit == 3600 ? 'h' : unit == 60 ? 'm' : 's'); };
        var iw = (W - L - R) / n, bw = Math.max(2, iw * (n > 31 ? .7 : .62));
        var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Connected time per ' + bucket + ' by connection type">';
        ticks.forEach(function (t) { var y = T + (H - T - B) * (1 - t / maxU); s += '<line class="gl" x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '"/><text class="ax" x="' + (L - 5) + '" y="' + (y + 3.5) + '" text-anchor="end">' + tick(t) + '</text>'; });
        var every = n > 31 ? Math.ceil(n / 12) : n > 14 ? Math.ceil(n / 10) : 1;
        bk.forEach(function (b, i) {
            var x = L + iw * i + (iw - bw) / 2, y = H - B, d = new Date(b.s);
            var weekend = bucket == 'day' && (d.getDay() == 0 || d.getDay() == 6);
            if (weekend) s += '<rect x="' + (L + iw * i) + '" y="' + T + '" width="' + iw + '" height="' + (H - T - B) + '" fill="var(--hi)" opacity=".6"/>';
            TYPES.forEach(function (t) {
                var v = b.by[t.k] || 0; if (!v) return; var h = (H - T - B) * (v / unit) / maxU; y -= h;
                var dim = sel && !(sel.i == i && sel.t == t.k);
                s += '<rect class="bar' + (dim ? ' dim' : '') + '" data-i="' + i + '" data-t="' + t.k + '" tabindex="0" role="button" aria-label="' + esc(longLabel(b, bucket)) + ', ' + t.n + ', ' + fmtDur(v) + '" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(h, 0.5).toFixed(1) + '" fill="' + t.c + '"><title>' + esc(longLabel(b, bucket)) + ', ' + t.n + ', ' + fmtDur(v) + '</title></rect>';
            });
            if (i % every == 0) s += '<text class="ax" x="' + (L + iw * i + iw / 2) + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(label(b, bucket)) + '</text>';
        });
        if (prev && prev.buckets.length) {
            var pts = prev.buckets.map(function (b, i) { if (i >= n) return null; var y = T + (H - T - B) * (1 - (b.tot / unit) / maxU); return (L + iw * i + iw / 2).toFixed(1) + ',' + y.toFixed(1); }).filter(Boolean);
            s += '<polyline class="prev" points="' + pts.join(' ') + '"><title>Previous period total</title></polyline>';
        }
        return s + '</svg>';
    }
    function donut(a) {
        var tot = a.totals.seconds || 1, r = 40, c = 2 * Math.PI * r, off = 0, items = [];
        var s = '<svg viewBox="0 0 96 96" role="img" aria-label="Share by type"><circle cx="48" cy="48" r="' + r + '" fill="none" stroke="var(--r2)" stroke-width="12"/>';
        TYPES.forEach(function (t) { var v = a.byType[t.k] || 0; if (!v) return; var f = v / tot; s += '<circle cx="48" cy="48" r="' + r + '" fill="none" stroke="' + t.c + '" stroke-width="12" stroke-dasharray="' + (f * c).toFixed(2) + ' ' + c.toFixed(2) + '" stroke-dashoffset="' + (-off * c).toFixed(2) + '" transform="rotate(-90 48 48)"><title>' + t.n + ' ' + Math.round(f * 100) + '%</title></circle>'; off += f; items.push({ t: t, v: v, f: f }); });
        s += '</svg>'; items.sort(function (x, y) { return y.v - x.v; });
        var otherParts = Object.keys(a.byProtocol || {}).filter(function (k) { return k.indexOf('other:') == 0 && a.byProtocol[k]; })
            .sort(function (x, y) { return a.byProtocol[y] - a.byProtocol[x]; })
            .map(function (k) { return '<span>' + esc(protoName(k.substring(6))) + ' ' + fmtDur(a.byProtocol[k]) + '</span>'; });
        return '<div class="cs-donut">' + s + '<ul>' + items.map(function (it) {
            var sub = (it.t.k == 'other' && otherParts.length) ? '<div class="sub">' + otherParts.join(', ') + '</div>' : '';
            return '<li><i style="background:' + it.t.c + '"></i>' + it.t.n + '<b>' + fmtDur(it.v) + ' <small>' + Math.round(it.f * 100) + '%</small></b>' + sub + '</li>';
        }).join('') + '</ul></div>';
    }
    function hbars(list, kind) {
        var max = list.length ? list[0].seconds : 1, s = '<div class="cs-hbars">';
        list.slice(0, 8).forEach(function (it) {
            var bar = ''; TYPES.forEach(function (t) { if (it.by[t.k]) bar += '<i style="width:' + (it.by[t.k] / max * 100) + '%;background:' + t.c + '" title="' + t.n + ' ' + fmtDur(it.by[t.k]) + '"></i>'; });
            var link = (kind == 'group' && it.id != '?') ? 'mesh:' + it.id : (kind == 'device' && it.id != '?') ? 'node:' + it.id : null;
            var name = (link && !COMPACT) ? '<a href="#" data-scope-to="' + esc(link) + '" title="Show only ' + esc(it.name) + '">' + esc(it.name) + '</a>' : esc(it.name);
            s += '<div class="n">' + name + '</div><div class="b">' + bar + '</div><div class="v">' + fmtDur(it.seconds) + '</div>';
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
        var W = 760, H = 150, L = 30, T = 16, cw = (W - L) / 24, rh = (H - T) / 7;
        var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Connected time by weekday and hour of start">';
        for (var h = 0; h < 24; h += 3) s += '<text class="ax" x="' + (L + cw * h + cw / 2) + '" y="10" text-anchor="middle">' + p2(h) + '</text>';
        [1, 2, 3, 4, 5, 6, 0].forEach(function (dw, ri) {
            s += '<text class="ax" x="' + (L - 6) + '" y="' + (T + rh * ri + rh / 2 + 3.5) + '" text-anchor="end">' + DOW[dw] + '</text>';
            for (var hh = 0; hh < 24; hh++) {
                var c = pc[dw][hh]; if (!c.tot) continue;
                var r = 2 + Math.sqrt(c.tot / max) * (rh / 2 - 1.5), cx = +(L + cw * hh + cw / 2).toFixed(1), cy = +(T + rh * ri + rh / 2).toFixed(1);
                var dim = sel && !(sel.wd == dw && sel.h == hh);
                var tip = cellLabel(dw, hh) + ', ' + fmtDur(c.tot) + ': ' + TYPES.filter(function (t) { return c.by[t.k]; }).map(function (t) { return t.n + ' ' + fmtDur(c.by[t.k]); }).join(', ');
                s += '<g class="pc' + (dim ? ' dim' : '') + '" data-pc="1" data-wd="' + dw + '" data-h="' + hh + '" tabindex="0" role="button" aria-label="' + esc(tip) + '"><title>' + esc(tip) + '</title>' + pie(cx, cy, +r.toFixed(1), c.by, c.tot) + '</g>';
            }
        });
        return s + '</svg>';
    }
    function calendar(daily, start, end) {
        var max = 0; daily.forEach(function (d) { max = Math.max(max, d.tot); }); max = max || 1;
        var fd = new Date(daily.length ? daily[0].s : start), startCol = new Date(fd.getFullYear(), fd.getMonth(), fd.getDate() - ((fd.getDay() + 6) % 7)).getTime();
        var byDay = {}; daily.forEach(function (d) { byDay[isoDay(d.s)] = d; });
        var weeks = Math.ceil((end - startCol) / (7 * DAY)) + 1, cs = 12, gap = 2, W = 30 + weeks * (cs + gap), H = 20 + 7 * (cs + gap);
        var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="min-width:' + Math.min(W, 1400) + 'px;max-width:' + W + 'px" role="img" aria-label="Connected time per day">', lastM = -1;
        for (var w = 0; w < weeks; w++) for (var d = 0; d < 7; d++) {
            var dt = new Date(startCol); dt.setDate(dt.getDate() + w * 7 + d); var t = dt.getTime();
            if (t < start || t >= end) continue;
            var rec = byDay[isoDay(t)], v = rec ? rec.tot : 0;
            if (dt.getMonth() != lastM && d == 0) { lastM = dt.getMonth(); s += '<text class="ax" x="' + (30 + w * (cs + gap)) + '" y="10">' + MON[lastM] + '</text>'; }
            var op = v ? .2 + .8 * Math.sqrt(v / max) : 0;
            s += '<rect x="' + (30 + w * (cs + gap)) + '" y="' + (18 + d * (cs + gap)) + '" width="' + cs + '" height="' + cs + '" rx="2" fill="' + (v ? 'var(--nav)' : 'var(--r2)') + '" opacity="' + (v ? op.toFixed(2) : 1) + '"><title>' + fmtDate(t) + ', ' + (v ? fmtDur(v) : 'no sessions') + '</title></rect>';
        }
        ['Mon', 'Wed', 'Fri', 'Sun'].forEach(function (n, i) { s += '<text class="ax" x="0" y="' + (18 + [0, 2, 4, 6][i] * (cs + gap) + 9) + '">' + n + '</text>'; });
        return s + '</svg>';
    }
    function timeline(rows, start, end) {
        var devs = {}; rows.forEach(function (x) { devs[x.node] = (devs[x.node] || 0) + ((x.end || Date.now()) - x.start); });
        var keys = Object.keys(devs).sort(function (a, b) { return devs[b] - devs[a]; }).slice(0, 10);
        if (!keys.length) return '<div class="cs-note">No sessions on this day.</div>';
        var s = '<div class="cs-tl"><div class="hrs"><div></div><div>' + [0, 3, 6, 9, 12, 15, 18, 21, 24].map(function (h) { return '<span>' + p2(h % 24) + ':00</span>'; }).join('') + '</div></div>';
        keys.forEach(function (k) {
            s += '<div class="row"><div class="n" title="' + esc(k) + '">' + esc(k) + '</div><div class="tr">';
            rows.forEach(function (x) { if (x.node != k) return; var e = x.end == null ? Date.now() : x.end, a = Math.max(x.start, start), z = Math.min(e, end); if (z <= a) return; var l = (a - start) / (end - start) * 100, w = (z - a) / (end - start) * 100; s += '<i class="' + (x.end == null ? 'live' : '') + '" style="left:' + l.toFixed(2) + '%;width:' + w.toFixed(2) + '%;background:' + TYPE[x.type].c + '" title="' + TYPE[x.type].n + ', ' + fmtDT(x.start) + ', ' + fmtDur((z - a) / 1000) + '"></i>'; });
            s += '</div></div>';
        });
        return s + '</div>';
    }
    function table(list) {
        var rows = list.rows || [], n = list.total || 0, s = '<div class="cs-tscroll"><table class="cs-table"><thead><tr><th>Start</th><th>Type</th><th>Device</th>' + (COMPACT ? '' : '<th>Group</th>') + '<th>Admin</th><th class="num">Duration</th><th class="num">Active</th><th class="num">Received</th><th class="num">Sent</th><th>From</th></tr></thead><tbody>';
        rows.forEach(function (x) {
            var e = x.end == null ? Date.now() : x.end, t = TYPE[x.type] || TYPE.other;
            s += '<tr' + (x.end == null ? ' class="hl"' : '') + '><td>' + fmtDT(x.start) + '</td><td><span class="ty" title="' + esc(protoName(x.protocol)) + '"><i style="background:' + t.c + '"></i>' + t.n + (x.type == 'other' ? ' <small class="dim">' + esc(protoName(x.protocol)) + '</small>' : '') + '</span></td><td>' + esc(x.node) + '</td>' + (COMPACT ? '' : '<td>' + esc(x.group || '') + '</td>') + '<td>' + (x.guest ? 'Guest: ' + esc(x.guest) : esc(x.user)) + '</td><td class="num">' + fmtDur((e - x.start) / 1000) + (x.end == null ? ', ongoing' : x.truncated ? ' <span title="The start or end of this session was not observed">*</span>' : '') + '</td><td class="num' + (x.active == null ? ' dim' : '') + '">' + (x.active == null ? 'no data' : fmtDur(x.active)) + '</td><td class="num">' + fmtBytes(x.bytesin) + '</td><td class="num">' + fmtBytes(x.bytesout) + '</td><td>' + esc(x.ip || '') + '</td></tr>';
        });
        if (!rows.length) s += '<tr><td colspan="10" class="dim">No sessions match.</td></tr>';
        s += '</tbody></table></div>';
        var pages = Math.max(1, Math.ceil(n / S.limit)), page = Math.floor(S.skip / S.limit) + 1;
        var selTxt = S.sel ? 'Showing ' + TYPE[S.sel.t].n + ' sessions in ' + esc(longLabel(DATA.aggregate.buckets[S.sel.i], DATA.aggregate.bucket)) + ', ' + n + ' of ' + DATA.sessions.total + '. <a href="#" data-act="clear">Clear</a> <a href="#" data-act="zoom">Zoom in</a>'
            : S.pc ? 'Showing sessions that started ' + cellLabel(S.pc.wd, S.pc.h) + ', ' + n + ' of ' + DATA.sessions.total + '. <a href="#" data-act="clear">Clear</a>'
            : 'Showing ' + Math.min(S.skip + rows.length, n) + ' of ' + n + ' sessions';
        s += '<div class="cs-foot"><span>' + selTxt + '</span><span class="pg"><button class="cs-btn" data-act="prev" ' + (page <= 1 ? 'disabled' : '') + '>&#8249;</button> Page ' + page + ' of ' + pages + ' <button class="cs-btn" data-act="next" ' + (page >= pages ? 'disabled' : '') + '>&#8250;</button></span></div>';
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
        if (S.preset == 'custom') h += '<span class="cs-custom"><input class="cs-in" type="date" data-date="start" value="' + isoDay(S.start) + '" aria-label="From"> to <input class="cs-in" type="date" data-date="end" value="' + isoDay(S.end - 1) + '" aria-label="To"></span>';
        h += '<select class="cs-sel" data-pick="bucket" aria-label="Granularity"><option value="auto"' + (S.bucket == 'auto' ? ' selected' : '') + '>Auto</option>' + ['hour', 'day', 'week', 'month'].map(function (b) { return '<option value="' + b + '"' + (S.bucket == b ? ' selected' : '') + '>By ' + b + '</option>'; }).join('') + '</select>';
        h += '<button class="cs-btn' + (S.compare ? ' on' : '') + '" data-compare aria-pressed="' + S.compare + '">Compare</button>';
        h += '<span class="cs-menu-wrap"><button class="cs-btn primary" data-act="menu" aria-haspopup="true" aria-expanded="' + MENU + '">Export</button>' + (MENU ? exportMenu() : '') + '</span>';
        if (BOOT.isAdmin && !COMPACT) h += '<a class="cs-btn" href="' + API + '&view=settings" title="Retention, recorded types, active time, import">Settings</a>';
        h += '</span></div>';
        return h;
    }

    // ---------- settings page (site admins) ----------
    var SET = null, SETMSG = '', BF = null, bfTimer = null, BK = null, RS = null, RSMSG = '', rsTimer = null, rsSel = '';
    function settingsPage() {
        var h = '<div class="cs-bar"><b>Connection Stats settings</b><span class="cs-right"><a class="cs-btn" href="' + API + '">Back to the dashboard</a></span></div>';
        if (ERR) return h + '<div class="cs-empty"><b>Could not load</b><span class="cs-err">' + esc(ERR) + '</span></div>';
        if (!SET) return h + '<div class="cs-empty"><b>Loading</b></div>';
        var st = SET.settings, a = st.activity || {};
        var row = function (label, control, note) { return '<div class="cs-set"><label>' + label + '</label><div>' + control + (note ? '<div class="cs-note">' + note + '</div>' : '') + '</div></div>'; };
        h += '<form id="cs-settings" class="cs-form">';
        h += row('Keep sessions for', '<input class="cs-in" type="number" min="1" max="3650" name="retentionDays" value="' + esc(st.retentionDays) + '"> days', 'Closed sessions older than this are removed daily. Open sessions are never removed.');
        h += row('Ignore sessions shorter than', '<input class="cs-in" type="number" min="0" max="3600" name="minSeconds" value="' + esc(st.minSeconds) + '"> seconds', 'Drops accidental clicks. 0 records everything.');
        h += row('Record these types', '<span class="cs-chips">' + TYPES.map(function (t) { return '<label class="cs-chip' + (st.recordTypes.indexOf(t.k) >= 0 ? '' : ' off') + '" style="--c:' + t.c + '"><input type="checkbox" name="type" value="' + t.k + '"' + (st.recordTypes.indexOf(t.k) >= 0 ? ' checked' : '') + ' style="display:none"><i></i>' + t.n + '</label>'; }).join('') + '</span>', 'Sessions of a type that is off are not recorded at all.');
        h += row('Active time', '<label><input type="checkbox" name="activityEnabled"' + (a.enabled !== false ? ' checked' : '') + '> Measure input in the Desktop, Terminal and Files views</label>', 'Only "still active" heartbeats leave the browser, never the input itself.');
        h += row('Idle threshold', '<input class="cs-in" type="number" min="1" max="120" step="0.5" name="idleMinutes" value="' + esc(a.idleMinutes) + '"> minutes', 'Each heartbeat counts as this much active time. Overlaps merge.');
        h += row('Heartbeat interval', '<input class="cs-in" type="number" min="10" max="300" name="beatSeconds" value="' + esc(a.beatSeconds) + '"> seconds', 'How often the browser reports input at most.');
        h += row('Export time zone', '<input class="cs-in" type="text" name="tz" value="' + esc(st.tz || '') + '" placeholder="browser zone"> ', 'Optional IANA zone such as Europe/Zurich. Empty uses the viewer\'s browser zone.');
        h += '<div class="cs-set"><label></label><div><button class="cs-btn primary" type="submit">Save settings</button> <span class="cs-note">' + esc(SETMSG) + '</span></div></div></form>';
        var bf = BF || SET.backfill || { running: false };
        var bfText = bf.running ? 'Importing: ' + (bf.scanned || 0) + ' events read, ' + (bf.found || 0) + ' sessions found, ' + (bf.imported || 0) + ' imported so far' + (bf.windowFrom ? ', reading back to ' + fmtDate(bf.windowFrom) : '') + '.' : bf.finishedAt ? 'Last import ' + fmtDT(bf.finishedAt) + ': ' + bf.scanned + ' events read, ' + bf.found + ' sessions found, ' + bf.imported + ' imported, ' + bf.skipped + ' already known.' + (bf.error ? ' Error: ' + bf.error : '') : 'Not run in this server session.';
        h += '<div class="cs-card"><h5>Import past sessions from MeshCentral\'s event log</h5><p class="cs-note" style="margin:0">MeshCentral keeps relay events for 20 days by default. Importing reads them and adds any session this plugin does not have yet. Running it again is harmless.</p><div class="cs-bar"><input class="cs-in" type="number" min="1" max="400" id="cs-bfdays" value="' + esc(Math.min(400, st.retentionDays)) + '" style="width:80px"> days back <button class="cs-btn" data-act="backfill"' + (bf.running ? ' disabled' : '') + '>Import now</button><span class="cs-note">' + esc(bfText) + '</span></div></div>';
        h += restoreCard();
        h += '<div class="cs-card"><h5>Retention</h5><div class="cs-bar"><button class="cs-btn" data-act="sweep">Remove sessions older than ' + esc(st.retentionDays) + ' days now</button><span class="cs-note">Runs automatically every day.</span></div></div>';
        h += '<div class="cs-note">Connection Stats ' + esc(SET.version) + '</div>';
        return h;
    }
    function restoreCard() {
        var rs = RS || { running: false }, busy = !!rs.running;
        var text;
        if (busy) text = 'Importing ' + (rs.label || '') + (rs.file && rs.file != rs.label ? ' (' + rs.file + ')' : '') + ': ' + (rs.scanned || 0) + ' records read, ' + (rs.relay || 0) + ' relay events' + (rs.phase == 'importing' ? ', ' + (rs.found || 0) + ' sessions found, ' + (rs.imported || 0) + ' imported so far' : '') + '.';
        else if (rs.finishedAt) text = 'Last import ' + fmtDT(rs.finishedAt) + ' from ' + (rs.label || 'file') + ': ' + (rs.error ? 'failed. ' + rs.error : (rs.scanned || 0) + ' records read, ' + (rs.relay || 0) + ' relay events, ' + (rs.found || 0) + ' sessions found, ' + (rs.imported || 0) + ' imported, ' + (rs.skipped || 0) + ' already known.');
        else text = RSMSG || '';
        var h = '<div class="cs-card"><h5>Import from a backup</h5>';
        h += '<p class="cs-note" style="margin:0">Relay events older than MeshCentral\'s limit are gone from its database, but its backups still hold them. The plugin reads the events file or database dump inside a backup (meshcentral-events.db, a mongodump archive, a mysqldump or pg_dump file, a SQLite copy) and adds the sessions it does not have yet. Go through your backups oldest first; running one twice is harmless. A password-protected backup has to be unzipped first, then import the file from inside it.</p>';
        var opts = '';
        if (BK && BK.files && BK.files.length) opts = BK.files.map(function (f) { return '<option value="' + esc(f.name) + '"' + (f.name == rsSel ? ' selected' : '') + '>' + esc(f.name) + ' (' + fmtBytes(f.size) + ', ' + fmtDate(f.mtime) + ')</option>'; }).join('');
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
        return '<div class="cs-menu" role="menu">' + (window.CS_EXPORT_ITEMS ? window.CS_EXPORT_ITEMS() : '') +
            '<button role="menuitem" data-act="print">Print or save as PDF<small>Whole page, print layout</small></button>' +
            '<hr><button role="menuitem" data-act="copylink">Copy link to this view</button></div>';
    }
    function render() {
        if (BOOT.view == 'settings') { root.className = 'cs'; root.innerHTML = settingsPage(); return; }
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
            h += '<div class="cs-card"><h5>Sessions' + (t.ongoing ? '<span class="cs-live">' + t.ongoing + ' ongoing, counted up to now</span>' : '') + '</h5>' + table(LIST || { rows: [], total: 0 }) + '</div>';
            h += '<div class="cs-note">* start or end not observed (server restart). Active time is measured from your input in the Desktop, Terminal and Files views; sessions from other clients show no data.</div>';
        }
        root.className = 'cs' + (LOADING ? ' cs-loading' : '');
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

    // ---------- events ----------
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
        else if (t.dataset.date) {
            var v = t.value.split('-').map(Number); if (v.length != 3 || !v[0]) return;
            var d = new Date(v[0], v[1] - 1, v[2]).getTime();
            if (t.dataset.date == 'start') S.start = d; else S.end = d + DAY;
            if (S.end <= S.start) S.end = S.start + DAY;
            S.preset = 'custom'; load();
        }
    });
    root.addEventListener('keydown', function (ev) {
        if (ev.key == 'Escape') { if (MENU) { MENU = false; render(); } else if (S.sel || S.pc) { S.sel = null; S.pc = null; loadList(0); } }
        if ((ev.key == 'Enter' || ev.key == ' ') && ev.target.classList && (ev.target.classList.contains('bar') || ev.target.classList.contains('pc'))) { ev.preventDefault(); ev.target.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
    });
    window.addEventListener('hashchange', function () { readHash(); if (S.preset != 'custom') applyPreset(); load(); });

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

    // expose a little for the export module
    window.CS = { state: S, data: function () { return DATA; }, meta: function () { return META; }, api: API, qs: qs, queryParams: queryParams, tz: TZ, fmtDur: fmtDur, scopeName: scopeName, isoDay: isoDay, render: render, load: load, get: get };

    // ---------- boot ----------
    if (BOOT.view == 'settings') { render(); loadSettings(); pollBackfill(); loadBackups(); pollRestore(); return; }
    readHash();
    if (S.preset != 'custom' || !S.start) applyPreset();
    get(API + '&api=meta').then(function (m) { META = m; }).catch(function (e) { ERR = e.message; }).then(function () { load(); });
})();
