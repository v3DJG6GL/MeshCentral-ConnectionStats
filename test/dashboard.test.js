'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../public/dashboard.js'), 'utf8');

function dashboard({ storage = new Map(), hash = '', boot = {}, width = 1000, response } = {}) {
    const handlers = {}, inputs = [], timers = [];
    const root = { innerHTML: '', clientWidth: width, addEventListener: (k, f) => { handlers[k] = f; }, querySelectorAll: () => inputs };
    const document = { getElementById: () => root, documentElement: { classList: { toggle() {} } }, addEventListener() {}, activeElement: null };
    const location = { hash, pathname: '/pluginadmin.ashx' };
    const window = { innerWidth: width, innerHeight: 800, CS_BOOT: { user: 'user//admin', ...boot }, addEventListener() {} };
    window.parent = window;
    vm.runInNewContext(source, { window, document, location, history: { replaceState: (_, __, h) => { location.hash = h; } },
        localStorage: { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v) },
        fetch: response ? url => Promise.resolve({ ok: true, json: async () => response(url) }) : () => new Promise(() => {}), setInterval() {}, setTimeout: f => timers.push(f), Intl, Date });
    return { cs: window.CS, handlers, root, document, inputs, location, storage };
}

test('year digit changes do not reload or replace the focused date field; Enter commits the completed date', () => {
    const d = dashboard({ hash: '#preset=custom&start=1788220800000&end=1788825600000' });
    d.cs.render();
    const html = d.root.innerHTML;
    const start = { dataset: { date: 'start' }, value: '0002-09-01', setCustomValidity() {}, reportValidity() {}, checkValidity: () => true, blur: () => { d.document.activeElement = null; } };
    const end = { dataset: { date: 'end' }, value: '2026-09-07', setCustomValidity() {}, reportValidity() {}, checkValidity: () => true };
    d.inputs.push(start, end);
    d.document.activeElement = start;
    const oldStart = d.cs.state.start;
    d.handlers.change({ target: start });
    assert.equal(d.cs.state.start, oldStart);
    d.cs.render();
    assert.equal(d.root.innerHTML, html);
    start.value = '2026-09-01';
    d.handlers.keydown({ key: 'Enter', target: start, preventDefault() {} });
    assert.equal(new Date(d.cs.state.start).getFullYear(), 2026);
    assert.equal(new Date(d.cs.state.end).getDate(), 8);
    assert.match(d.location.hash, /preset=custom/);
});

test('filters and page size survive iframe recreation, with user and device isolation', () => {
    const storage = new Map([['cs-limit', '50']]);
    const d = dashboard({ storage, hash: '#scope=mesh%3Amesh%2F%2Fone&preset=month&types=desktop&users=user%2F%2Fone&bucket=day&compare=0&guests=1' });
    d.cs.load();
    const restored = dashboard({ storage }).cs.state;
    for (const key of ['scope', 'preset', 'bucket', 'compare', 'guests', 'limit']) assert.equal(restored[key], d.cs.state[key], key);
    assert.deepEqual(Array.from(restored.users), ['user//one']);
    assert.equal(restored.types.terminal, false);
    assert.equal(restored.limit, 50);
    assert.equal(dashboard({ storage, boot: { user: 'user//other' } }).cs.state.preset, 'week');
    const device = dashboard({ storage, boot: { view: 'device', scope: 'node:node//one' } });
    assert.equal(device.cs.state.scope, 'node:node//one');
    assert.equal(device.cs.state.preset, 'week');
    assert.equal(dashboard({ storage, hash: '#preset=today' }).cs.state.preset, 'today');
});

test('custom dates round trip and malformed saved data does not break boot', () => {
    const d = dashboard({ hash: '#start=1788220800000&end=1788825600000' });
    d.cs.load();
    const restored = dashboard({ storage: d.storage });
    assert.equal(restored.cs.state.start, d.cs.state.start);
    assert.equal(restored.cs.state.end, d.cs.state.end);
    const bad = dashboard({ hash: '#preset=toString&start=NaN&end=Infinity&bucket=bad&users=%ZZ' });
    assert.equal(bad.cs.state.preset, 'week');
    assert.equal(bad.cs.state.bucket, 'auto');
});

test('chart hover and keyboard focus show an immediate tooltip and clear it on exit', () => {
    const d = dashboard();
    const attrs = { 'aria-label': '7 September 2026, Desktop, 5m' };
    const bar = { dataset: { i: '0' }, closest: () => bar, getAttribute: k => attrs[k],
        setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: k => { delete attrs[k]; },
        getBoundingClientRect: () => ({ left: 10, top: 20, width: 30 }) };
    let tip;
    d.document.createElement = () => ({ style: {}, setAttribute() {}, offsetWidth: 180, offsetHeight: 60 });
    d.document.body = { appendChild: el => { tip = el; } };
    d.handlers.pointerover({ target: bar, clientX: 30, clientY: 40 });
    assert.equal(tip.hidden, false);
    assert.match(tip.innerHTML, /Desktop, 5m/);
    assert.match(tip.innerHTML, /Click to filter sessions/);
    assert.equal(attrs['aria-describedby'], 'cs-chart-tip');
    d.handlers.pointerout();
    assert.equal(tip.hidden, true);
    assert.equal(attrs['aria-describedby'], undefined);
    d.handlers.focusin({ target: bar });
    assert.equal(tip.hidden, false);
    d.handlers.focusout();
    assert.equal(tip.hidden, true);
});

async function chart({ bucket, width = 2400, days = 30, start = new Date(2023, 11, 1).getTime(), extra = [] }) {
    const end = new Date(start); end.setDate(end.getDate() + days);
    const aggregate = require('../aggregate.js').aggregate([
        { _id: 's_demo', start: start + 3600000, end: start + 7200000, type: 'desktop', nodeid: 'node//demo', nodename: 'Demo' }
    ].concat(extra), { start, end: +end, bucket, tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
    const sessions = { rows: [{ node: 'Demo', start: start + 3600000, end: start + 7200000, type: 'desktop' }], total: 1 };
    const d = dashboard({ width, storage: new Map([['loctag', 'de-CH']]),
        hash: '#preset=custom&start=' + start + '&end=' + (+end) + '&bucket=' + bucket,
        response: url => url.includes('api=meta') ? { devices: [], groups: [], users: [] } : url.includes('api=sessions') ? sessions : { aggregate, sessions }
    });
    await new Promise(resolve => setImmediate(resolve));
    const labels = [...d.root.innerHTML.matchAll(/class="ax cs-time-tick"[^>]*>([^<]+)<\/text>/g)].map(m => m[1]);
    return { ...d, labels };
}

test('day axis uses available width: all 30 dates on a wide chart, fewer on a narrow chart', async () => {
    const wide = await chart({ bucket: 'day' });
    const narrow = await chart({ bucket: 'day', width: 500 });
    assert.equal(wide.labels.length, 30);
    assert.match(wide.labels[0], /1\.12/);
    assert.match(wide.labels[29], /30\.12/);
    assert.ok(narrow.labels.length > 0 && narrow.labels.length < wide.labels.length);
});

test('month-long hourly charts and session timelines label dates instead of repeating clock times', async () => {
    const d = await chart({ bucket: 'hour' });
    assert.ok(d.labels.length >= 20);
    assert.ok(d.labels.every(s => /\d+\.12/.test(s) && !s.includes(':')));
    const timeline = d.root.innerHTML.split('<div class="hrs">')[1].split('<div class="row">')[0];
    assert.match(timeline, /1\.12/);
    assert.match(timeline, /30\.12/);
    assert.doesNotMatch(timeline, /03:00/);
});

test('short hourly ranges show times, with date context when crossing midnight', async () => {
    const single = await chart({ bucket: 'hour', days: 1 });
    assert.ok(single.labels.every(s => /^\d\d:\d\d$/.test(s)));
    const multi = await chart({ bucket: 'hour', days: 2 });
    assert.ok(multi.labels.every(s => /\.12.*\d\d:\d\d/.test(s)));
    assert.ok(multi.labels.some(s => /2\.12/.test(s)));
});

test('bars and weekday bubbles share totals, colored type rows and hover/focus behavior', async () => {
    const start = new Date(2023, 11, 1).getTime();
    const d = await chart({ bucket: 'day', start, extra: [
        { _id: 's_files', start: start + 3600000, end: start + 5400000, type: 'files', nodeid: 'node//demo' }
    ] });
    let tip;
    d.document.createElement = () => ({ style: {}, setAttribute() {}, offsetWidth: 220, offsetHeight: 150 });
    d.document.body = { appendChild: el => { tip = el; } };
    const makeTarget = dataset => {
        const attrs = {};
        const el = { dataset, closest: () => el, getAttribute: k => attrs[k],
            setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: k => { delete attrs[k]; },
            getBoundingClientRect: () => ({ left: 20, top: 30, width: 10 }) };
        return el;
    };
    const bar = makeTarget({ i: '0', t: 'desktop' });
    const bubble = makeTarget({ pc: '1', wd: String(new Date(start).getDay()), h: '1' });
    let barBreakdown;
    for (const el of [bar, bubble]) {
        // A pointer on a nested pie slice resolves to the parent bubble.
        d.handlers.pointerover({ target: { closest: () => el }, clientX: 2399, clientY: 799 });
        assert.equal(tip.hidden, false);
        assert.match(tip.innerHTML, /Total<\/span><b>1h 30m/);
        assert.match(tip.innerHTML, /background:#4477AA.*Desktop<\/span><b>1h 00m/);
        assert.match(tip.innerHTML, /background:#CCBB44.*Files<\/span><b>30m/);
        assert.doesNotMatch(tip.innerHTML, /Terminal/);
        const breakdown = tip.innerHTML.slice(tip.innerHTML.indexOf('<div class="cs-tip-total">'));
        if (el === bar) barBreakdown = breakdown; else assert.equal(breakdown, barBreakdown);
        assert.ok(parseFloat(tip.style.left) + 220 <= 2400);
        assert.ok(parseFloat(tip.style.top) + 150 <= 800);
        d.handlers.pointerout({ relatedTarget: { closest: () => el } });
        assert.equal(tip.hidden, false, 'moving between slices does not hide the tooltip');
        d.handlers.pointerout({ relatedTarget: null }); assert.equal(tip.hidden, true);
        d.handlers.focusin({ target: el }); assert.equal(tip.hidden, false);
        d.handlers.focusout(); assert.equal(tip.hidden, true);
    }
    assert.doesNotMatch(d.root.innerHTML, /class="pc[^>]*><title>/);
});

test('import coverage displays empty months between returned records', async () => {
    const coverage = {};
    for (const kind of ['events', 'relay', 'supportedRelay', 'sessions']) coverage[kind] = {
        count: 2, first: Date.UTC(2026, 0, 1), last: Date.UTC(2026, 8, 1), invalidTime: 0,
        months: { '2026-01': 1, '2026-09': 1 }
    };
    const d = dashboard({ boot: { view: 'settings' }, response: url => {
        if (url.includes('api=settings')) return { settings: { retentionDays: 0, recordTypes: [], activity: {} } };
        if (url.includes('api=backfill')) return { running: false, finishedAt: Date.now(), days: 0, coverage };
        return {};
    } });
    await new Promise(resolve => setImmediate(resolve));
    assert.match(d.root.innerHTML, /Database import coverage \(all history\)/);
    assert.match(d.root.innerHTML, /2026-02<\/td>(<td class="num">0<\/td>){4}/);
    assert.match(d.root.innerHTML, /2026-08<\/td>(<td class="num">0<\/td>){4}/);
});

test('multi-year month charts preserve January and both charts label each year', async () => {
    const d = await chart({ bucket: 'month', start: new Date(2023, 10, 1).getTime(), days: 1040 });
    assert.equal(d.labels.filter(s => s == 'Jan').length, 3);
    const sections = d.root.innerHTML.split('aria-label="Connected time per day"');
    assert.equal(sections.length, 2);
    for (const section of sections) {
        for (const year of [2023, 2024, 2025, 2026]) assert.match(section, new RegExp('class="ax cs-year-tick"[^>]*>' + year + '</text>'));
    }
    const narrow = await chart({ bucket: 'month', width: 650, start: new Date(2023, 10, 1).getTime(), days: 1040 });
    assert.equal(narrow.labels.filter(s => s == 'Jan').length, 3);
});

test('calendar days use shared totals and type breakdowns, including empty days', async () => {
    const start = new Date(2023, 11, 1).getTime();
    const d = await chart({ bucket: 'month', start });
    let tip;
    d.document.createElement = () => ({ style: {}, setAttribute() {}, offsetWidth: 200, offsetHeight: 100 });
    d.document.body = { appendChild: el => { tip = el; } };
    const cell = { dataset: { day: String(start) }, getAttribute: () => '', setAttribute() {}, removeAttribute() {},
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 12 }) };
    cell.closest = () => cell;
    d.handlers.pointerover({ target: cell, clientX: 30, clientY: 30 });
    assert.equal(tip.hidden, false);
    assert.match(tip.innerHTML, /Total<\/span><b>1h 00m/);
    assert.match(tip.innerHTML, /background:#4477AA.*Desktop/);
    assert.doesNotMatch(tip.innerHTML, /Click to filter/);
    d.handlers.pointerout(); assert.equal(tip.hidden, true);
    cell.dataset.day = String(start + 86400000);
    d.handlers.focusin({ target: cell });
    assert.equal(tip.hidden, false); assert.match(tip.innerHTML, /No sessions/);
    assert.match(tip.innerHTML, /Total<\/span><b>0s/);
    assert.doesNotMatch(d.root.innerHTML, /class="cs-day"[^>]*><title>/);
});

test('session timeline shows years and shared session tooltips on hover and focus', async () => {
    const d = await chart({ bucket: 'hour', start: new Date(2025, 11, 30).getTime(), days: 4 });
    assert.match(d.root.innerHTML, /class="cs-tl-year"[^>]*>2025/);
    assert.match(d.root.innerHTML, /class="cs-tl-year"[^>]*>2026/);
    assert.match(d.root.innerHTML, /data-session="0" tabindex="0"/);
    let tip;
    d.document.createElement = () => ({ style: {}, setAttribute() {}, offsetWidth: 250, offsetHeight: 120 });
    d.document.body = { appendChild: el => { tip = el; } };
    const session = { dataset: { session: '0' }, getAttribute: () => '', setAttribute() {}, removeAttribute() {},
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 20 }) };
    session.closest = () => session;
    for (const event of ['pointerover', 'focusin']) {
        d.handlers[event]({ target: session });
        assert.equal(tip.hidden, false); assert.match(tip.innerHTML, /Demo:.*2025/);
        assert.match(tip.innerHTML, /Total<\/span><b>1h 00m/);
        assert.match(tip.innerHTML, /background:#4477AA.*Desktop/);
        assert.doesNotMatch(tip.innerHTML, /Click to filter/);
        d.handlers.focusout(); assert.equal(tip.hidden, true);
    }
});

test('empty bucket, weekday/hour and timeline fields show their context and zero totals', async () => {
    const start = new Date(2023, 11, 1).getTime();
    for (const [bucket, dataset] of [
        ['day', { i: '1' }], ['day', { pc: '1', wd: '0', h: '23' }], ['hour', { track: 'Demo' }]
    ]) {
        const d = await chart({ bucket, start }); let tip;
        d.document.createElement = () => ({ style: {}, setAttribute() {}, offsetWidth: 200, offsetHeight: 100 });
        d.document.body = { appendChild: el => { tip = el; } };
        const field = { dataset, classList: { contains: name => dataset.i != null && name == 'cs-bucket' }, getAttribute: () => '', setAttribute() {}, removeAttribute() {},
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 100 }) };
        field.closest = () => field;
        d.handlers.pointerover({ target: field, clientX: 50, clientY: 0 });
        assert.equal(tip.hidden, false);
        assert.match(tip.innerHTML, /Total<\/span><b>0s/); assert.match(tip.innerHTML, /No sessions/);
        assert.doesNotMatch(tip.innerHTML, /cs-tip-heading"><\/div>/);
        if (dataset.pc) assert.match(tip.innerHTML, /23:00 to 00:00/);
        if (dataset.i) assert.match(d.root.innerHTML, /class="cs-bucket" data-i="1"/);
        if (dataset.track) assert.match(d.root.innerHTML, /data-track="Demo"/);
        if (bucket == 'day') {
            assert.equal((d.root.innerHTML.match(/class="cs-pc-hit"/g) || []).length, 168);
            assert.equal((d.root.innerHTML.match(/class="gl cs-pc-grid"/g) || []).length, 33);
        }
    }
});

test('share and where-time-went charts use custom breakdown tooltips without native titles', async () => {
    const d = await chart({ bucket: 'day' }); let tip;
    d.document.createElement = () => ({ style: {}, setAttribute() {}, offsetWidth: 220, offsetHeight: 140 });
    d.document.body = { appendChild: el => { tip = el; } };
    for (const dataset of [{ share: 'desktop' }, { where: '0', kind: 'group' }]) {
        const el = { dataset, getAttribute: () => '', setAttribute() {}, removeAttribute() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 10 }) };
        el.closest = () => el;
        for (const event of ['pointerover', 'focusin']) {
            d.handlers[event]({ target: el });
            assert.equal(tip.hidden, false); assert.match(tip.innerHTML, /Total<\/span><b>1h 00m/);
            assert.match(tip.innerHTML, /background:#4477AA.*Desktop/);
            assert.doesNotMatch(tip.innerHTML, /Click to filter/);
            if (dataset.share) assert.match(tip.innerHTML, /100%/);
            d.handlers.focusout(); assert.equal(tip.hidden, true);
        }
    }
    const share = d.root.innerHTML.split('<div class="cs-donut">')[1].split('</ul></div>')[0];
    const where = d.root.innerHTML.split('<div class="cs-hbars">')[1].split('</div></div></div>')[0];
    assert.doesNotMatch(share, /<title>| title=/);
    assert.doesNotMatch(where, /<title>| title=/);
});

test('Kimai initializes the shared parent theme before skipping dashboard rendering', () => {
    let dark = true, applied, observer;
    const handlers = {};
    const body = { classList: { contains: () => dark } };
    const window = { CS_BOOT: { view: 'kimai', night: false }, parent: { document: { body } }, addEventListener: (name, fn) => { handlers[name] = fn; } };
    const document = { documentElement: { classList: { toggle: (name, on) => { assert.equal(name, 'night'); applied = on; } } } };
    function MutationObserver(fn) { observer = fn; this.observe = (target, options) => { assert.equal(target, body); assert.deepEqual(Array.from(options.attributeFilter), ['class']); }; }
    vm.runInNewContext(source, { window, document, MutationObserver });
    assert.equal(applied, true, 'parent dark theme overrides absent URL flag');
    dark = false; observer(); assert.equal(applied, false, 'follows switching to light mode');
    dark = true; observer(); assert.equal(applied, true, 'follows switching back to dark mode');
    handlers.message({ data: { cs: 'night', night: false } }); assert.equal(applied, false);
});

test('standalone Kimai uses the boot theme when no parent body is accessible', () => {
    for (const night of [true, false]) {
        let applied;
        const window = { CS_BOOT: { view: 'kimai', night }, addEventListener() {} }; window.parent = window;
        vm.runInNewContext(source, { window, document: { documentElement: { classList: { toggle: (_, on) => { applied = on; } } } } });
        assert.equal(applied, night);
    }
});
