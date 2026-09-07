'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../public/dashboard.js'), 'utf8');

function dashboard({ storage = new Map(), hash = '', boot = {} } = {}) {
    const handlers = {}, inputs = [], timers = [];
    const root = { innerHTML: '', clientWidth: 1000, addEventListener: (k, f) => { handlers[k] = f; }, querySelectorAll: () => inputs };
    const document = { getElementById: () => root, documentElement: { classList: { toggle() {} } }, addEventListener() {}, activeElement: null };
    const location = { hash, pathname: '/pluginadmin.ashx' };
    const window = { CS_BOOT: { user: 'user//admin', ...boot }, addEventListener() {} };
    window.parent = window;
    vm.runInNewContext(source, { window, document, location, history: { replaceState: (_, __, h) => { location.hash = h; } },
        localStorage: { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v) },
        fetch: () => new Promise(() => {}), setInterval() {}, setTimeout: f => timers.push(f), Intl, Date });
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
    assert.match(tip.textContent, /Desktop, 5m/);
    assert.match(tip.textContent, /Click to filter sessions/);
    assert.equal(attrs['aria-describedby'], 'cs-chart-tip');
    d.handlers.pointerout();
    assert.equal(tip.hidden, true);
    assert.equal(attrs['aria-describedby'], undefined);
    d.handlers.focusin({ target: bar });
    assert.equal(tip.hidden, false);
    d.handlers.focusout();
    assert.equal(tip.hidden, true);
});
