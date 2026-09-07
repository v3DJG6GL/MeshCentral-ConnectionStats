'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../public/kimai-device.js'), 'utf8');
function element() {
    return {
        children: [],
        className: '',
        textContent: '',
        insertAdjacentElement(position, c) {
            assert.equal(position, 'afterend');
            this.children.push(c);
        },
        append(c) {
            this.children.push(c);
        },
        querySelector(selector) {
            return this.children.find((c) => selector === '.' + c.className) || null;
        },
    };
}
async function harness(overrides = {}, environment = {}) {
    const calls = [],
        hosts = Object.fromEntries(['deskstatus', 'termstatus', 'p13Status'].map((id) => [id, element()]));
    const initial = {
        csrf: 'csrf-sample',
        connected: true,
        timezone: 'Europe/Zurich',
        preferences: { prompt: 'never' },
        sessions: [],
        allocations: [],
        reviews: [],
        ...overrides,
    };
    const context = {
        URLSearchParams,
        Intl,
        Date,
        Set,
        Promise,
        Error,
        Number,
        String,
        Object,
        Array,
        Math,
        crypto: { randomUUID: () => 'operation-id' },
        console,
        setTimeout: () => 1,
        clearTimeout() {},
        setInterval() {},
        currentNode: { _id: 'node/test' },
        domainUrl: '/tenant/',
        document: {
            hidden: false,
            getElementById: (id) =>
                hosts[id] ||
                Object.values(hosts)
                    .flatMap((h) => h.children)
                    .find((c) => c.id === id),
            createElement: element,
            querySelectorAll: (selector) =>
                Object.values(hosts)
                    .flatMap((h) => h.children.flatMap((c) => c.children || []))
                    .filter((c) => selector === '.' + c.className),
        },
        window: {},
        fetch: async (url, options) => {
            calls.push({ url, options });
            return {
                ok: true,
                json: async () => (options && options.method === 'POST' ? { ok: true } : initial),
            };
        },
    };
    Object.assign(context, environment);
    context.window.window = context.window;
    vm.createContext(context);
    vm.runInContext(
        source.replace(
            /window\.CSDevice\s*=\s*\{/,
            'window.__test={duration,title,post,refresh,deviceSpans,deviceAllocations,canApprove,approvalValues,approvalTiming,setActive:function(a){active=a;}};window.CSDevice={',
        ),
        context,
    );
    await new Promise((resolve) => setImmediate(resolve));
    return { context, calls, hosts, initial, api: context.window.__test };
}
test('device mounting preserves host toolbar content and avoids duplicate controls', async () => {
    const h = await harness();
    for (const host of Object.values(h.hosts)) assert.equal(host.children.length, 1);
    h.hosts.deskstatus.children.push({ className: 'other-plugin' });
    await h.api.refresh(true);
    assert.equal(h.hosts.deskstatus.children.length, 2);
    assert.match(
        h.calls[0].url,
        /^\/tenant\/pluginadmin\.ashx\?pin=connectionstats&api=kimai-device&nodeid=node%2Ftest$/,
    );
});
test('local fallback and remote running status are never conflated', async () => {
    const h = await harness();
    assert.equal(h.api.title({ status: 'recording-local' }), 'Recording locally · send after review');
    assert.equal(h.api.title({ status: 'recording' }), 'Recording in Kimai');
    assert.equal(h.api.title({ status: 'running' }), 'Recording in Kimai');
    assert.equal(h.api.duration(60), '0:01:00');
    assert.equal(h.api.duration(97449), '27:04:09');
});
test('device mutation sends CSRF and editor revision rather than silently adopting newer poll state', async () => {
    const h = await harness({ allocations: [{ id: 'a', revision: 8 }] });
    h.api.setActive({ id: 'a', revision: 7 });
    await h.api.post('save', { id: 'a', row: { description: 'Reviewed work' } });
    const call = h.calls.find((c) => c.options && c.options.method === 'POST'),
        body = new URLSearchParams(call.options.body),
        data = JSON.parse(body.get('data'));
    assert.equal(body.get('csrf'), 'csrf-sample');
    assert.equal(body.get('action'), 'kimai');
    assert.equal(data.revision, 7);
    assert.equal(data.op, 'device');
    assert.equal(data.command, 'save');
    assert.equal(data.requestId, 'operation-id');
    await h.api.post('draft', { id: 'a', row: { description: 'Still editing' } });
    const next = h.calls.filter((c) => c.options && c.options.method === 'POST')[1];
    assert.equal(JSON.parse(new URLSearchParams(next.options.body).get('data')).revision, 7);
});
test('failed mutations are not blindly retried, and queue recovers for later requests', async () => {
    const h = await harness();
    let attempts = 0;
    h.context.fetch = async (url, options) => {
        if (options && options.method === 'POST') {
            attempts++;
            if (attempts === 1) throw Error('Connection lost');
        }
        return { ok: true, json: async () => (options ? { ok: true } : h.initial) };
    };
    await assert.rejects(h.api.post('start', {}), /Connection lost/);
    assert.equal(attempts, 1);
    await h.api.post('preferences', { prompt: 'never', presentation: 'drawer' });
    assert.equal(attempts, 2);
});
test('another device active connection suppresses automatic review presentation', async () => {
    const h = await harness({
        preferences: { prompt: 'always' },
        activeConnections: 1,
        reviews: [{ id: 'review-a', revision: 1, review: true }],
    });
    assert.equal(h.calls.filter((c) => c.options && c.options.method === 'POST').length, 0);
});

test('standalone inbox refresh preserves tenant prefix and omits node filter', async () => {
    const h = await harness(
        {},
        { domainUrl: undefined, location: { pathname: '/tenant/pluginadmin.ashx' }, currentNode: null },
    );
    await h.api.refresh(true);
    assert.equal(h.calls[0].url, '/tenant/pluginadmin.ashx?pin=connectionstats&api=kimai-device');
    assert.equal(typeof h.context.window.CSDevice.openInbox, 'function');
});
test('quick stop selects only open contributors on the current device', async () => {
    const h = await harness();
    const ids = h.api.deviceSpans(
        {
            spans: [
                { sessionId: 'desktop', nodeid: 'a', end: null },
                { sessionId: 'terminal', nodeid: 'a', end: null },
                { sessionId: 'other-device', nodeid: 'b', end: null },
                { sessionId: 'closed', nodeid: 'a', end: 200 },
            ],
        },
        'a',
    );
    assert.deepEqual(Array.from(ids), ['desktop', 'terminal']);
});

test('mapped open sessions show pending review without claiming a running Kimai timer', async () => {
    const h = await harness({
        sessions: [{ nodeid: 'node/test', end: null, mapped: true, basis: 'connected' }],
    });
    assert.match(h.hosts.deskstatus.children[0].children[0].textContent, /Mapped · review after disconnect/);
    h.initial.sessions[0].basis = 'active';
    await h.api.refresh(true);
    assert.match(
        h.hosts.termstatus.children[0].children[0].textContent,
        /Active time · review after disconnect/,
    );
    h.initial.sessions[0].end = Date.now();
    await h.api.refresh(true);
    assert.match(h.hosts.p13Status.children[0].children[0].textContent, /Start timer/);
});
test('per-allocation prompt override can enable review against a never global default', async () => {
    const h = await harness({
        preferences: { prompt: 'never' },
        reviews: [{ id: 'r', revision: 1, prompt: 'always', review: true }],
    });
    const call = h.calls.find((c) => c.options && c.options.method === 'POST');
    assert.ok(call);
    assert.equal(JSON.parse(new URLSearchParams(call.options.body).get('data')).command, 'claim');
});
test('per-allocation never suppresses review against an always global default', async () => {
    const h = await harness({
        preferences: { prompt: 'always' },
        reviews: [{ id: 'r', revision: 1, prompt: 'never', review: true }],
    });
    assert.equal(h.calls.filter((c) => c.options && c.options.method === 'POST').length, 0);
});

test('approval displays and sends effective draft timing and destinations', async () => {
    const h = await harness();
    const a = {
        id: 'a',
        revision: 3,
        status: 'review',
        begin: Date.UTC(2026, 8, 7, 8),
        end: Date.UTC(2026, 8, 7, 9),
        customer: 1,
        project: 2,
        activity: 3,
        description: 'Original',
        draft: {
            project: 4,
            description: 'Reviewed',
            beginLocal: '2026-09-07T10:15:00',
            endLocal: '2026-09-07T10:45:00',
        },
    };
    assert.equal(h.api.canApprove(a), true);
    const shown = h.api.approvalTiming(a),
        sent = h.api.approvalValues(a);
    assert.equal(shown.begin, sent.beginLocal);
    assert.equal(shown.end, sent.endLocal);
    assert.equal(sent.project, 4);
    assert.equal(sent.description, 'Reviewed');
    await h.api.post('save', { id: a.id, revision: a.revision, row: sent, mode: 'whole', reviewed: true });
    const call = h.calls.find((c) => c.options && c.options.method === 'POST');
    const data = JSON.parse(new URLSearchParams(call.options.body).get('data'));
    assert.equal(data.row.beginLocal, shown.begin);
    assert.equal(data.row.endLocal, shown.end);
    assert.equal(data.revision, 3);
});
test('direct inbox approval rejects ongoing, uncertain and incomplete entries', async () => {
    const h = await harness();
    const a = { end: 100, status: 'review', customer: 1, project: 2, activity: 3 };
    assert.equal(h.api.canApprove(a), true);
    for (const patch of [
        { end: null },
        { error: 'Create outcome uncertain' },
        { error: 'Edited remotely' },
        { project: 0 },
        { draft: { activity: 0 } },
        { status: 'locked' },
    ])
        assert.equal(h.api.canApprove({ ...a, ...patch }), false);
});
