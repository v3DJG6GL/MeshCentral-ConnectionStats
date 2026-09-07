/**
* Connection Stats export menu. Loaded after dashboard.js; adds the data exports to the menu.
* CSV and JSON come from the server (streamed, same filters, same permissions); the PNG is made
* in the browser from the chart that is on screen.
*/
(function () {
    'use strict';
    var CS = window.CS;
    if (CS == null) return;

    function serverUrl(what, format) {
        var p = CS.queryParams();
        p.what = what; p.format = format; p.scopename = CS.scopeName();
        if (CS.data() && CS.data().aggregate) p.bucket = CS.data().aggregate.bucket;
        return CS.api + '&api=export&' + CS.qs(p);
    }
    function download(url, name) {
        var a = document.createElement('a'); a.href = url; if (name) a.download = name; a.style.display = 'none';
        document.body.appendChild(a); a.click(); setTimeout(function () { document.body.removeChild(a); }, 1000);
    }
    // the chart is inline SVG with CSS variables: resolve them, then rasterise at 2x
    function chartPng() {
        var card = document.querySelector('.cs-card svg[aria-label^="Connected time"]');
        if (card == null) { alert('There is no chart on screen to export.'); return; }
        var svg = card.cloneNode(true), cs = getComputedStyle(document.documentElement);
        var vars = ['--hi', '--nav', '--r2', '--axis', '--grid', '--t', '--p'];
        var resolve = function (str) { vars.forEach(function (v) { str = str.split('var(' + v + ')').join(cs.getPropertyValue(v).trim()); }); return str; };
        svg.querySelectorAll('*').forEach(function (el) {
            ['fill', 'stroke'].forEach(function (a) { var v = el.getAttribute(a); if (v && v.indexOf('var(') >= 0) el.setAttribute(a, resolve(v)); });
            if (el.classList.contains('ax')) { el.setAttribute('fill', cs.getPropertyValue('--axis').trim()); el.setAttribute('font-size', '10'); el.setAttribute('font-family', 'Arial, sans-serif'); }
            if (el.classList.contains('gl')) { el.setAttribute('stroke', cs.getPropertyValue('--grid').trim()); }
            if (el.classList.contains('prev')) { el.setAttribute('fill', 'none'); el.setAttribute('stroke', cs.getPropertyValue('--axis').trim()); el.setAttribute('stroke-width', '1.5'); el.setAttribute('stroke-dasharray', '3 3'); }
            if (el.classList.contains('dim')) el.setAttribute('opacity', '.3');
        });
        var vb = svg.getAttribute('viewBox').split(' ').map(Number), w = vb[2], h = vb[3];
        svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg'); svg.setAttribute('width', w); svg.setAttribute('height', h);
        var bg = cs.getPropertyValue('--p').trim();
        var xml = new XMLSerializer().serializeToString(svg);
        var img = new Image();
        img.onload = function () {
            var c = document.createElement('canvas'); c.width = w * 2; c.height = h * 2;
            var ctx = c.getContext('2d'); ctx.fillStyle = bg || '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.scale(2, 2); ctx.drawImage(img, 0, 0);
            var name = 'meshcentral-connectionstats_' + CS.scopeName().toLowerCase().replace(/[^a-z0-9]+/g, '-') + '_' + CS.isoDay(CS.state.start) + '_' + CS.isoDay(CS.state.end - 1) + '_chart.png';
            if (c.toBlob) c.toBlob(function (b) { download(URL.createObjectURL(b), name); }, 'image/png');
            else download(c.toDataURL('image/png'), name);
        };
        img.onerror = function () { alert('The chart could not be rendered to an image.'); };
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
    }

    window.CS_EXPORT_ITEMS = function () {
        var d = CS.data(), n = d && d.sessions ? d.sessions.total : 0, b = d && d.aggregate ? d.aggregate.bucket : 'day';
        return '<button role="menuitem" data-act="xsessions">Sessions as CSV<small>One row per session, ' + n + ' rows, current filters</small></button>' +
            '<button role="menuitem" data-act="xbuckets">Totals per ' + b + ' as CSV<small>One row per bucket and type</small></button>' +
            '<button role="menuitem" data-act="xjson">Sessions as JSON<small>Same records, lossless</small></button><hr>' +
            '<button role="menuitem" data-act="xpng">Chart as PNG<small>Current time chart, 2x resolution</small></button>';
    };
    window.CS_EXPORT = {
        xsessions: function () { download(serverUrl('sessions', 'csv')); },
        xbuckets: function () { download(serverUrl('buckets', 'csv')); },
        xjson: function () { download(serverUrl('sessions', 'json')); },
        xpng: chartPng
    };
})();
