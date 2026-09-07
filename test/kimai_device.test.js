'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Service } = require('../kimai');
const { subtract, available } = require('../kimai-device');
const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
const uuid = () => require('crypto').randomUUID();
function setup(t) {
    let now = Date.parse('2026-09-07T12:00:00Z');
    t.mock.method(Date, 'now', () => now);
    const user = { _id: 'user//a', domain: '' },
        settings = new Map(),
        docs = [],
        remotes = [],
        calls = [];
    const db = {
        getSetting: async (k) => clone(settings.get(k)),
        setSetting: async (k, v) => settings.set(k, clone(v)),
        getSession: async (id) => clone(docs.find((d) => d._id === id)),
        findSessions: async (f) =>
            clone(
                docs.filter(
                    (d) => d.start < f.end && (d.end == null || d.end >= f.start) && d.userid === user._id,
                ),
            ),
    };
    const c = {
        list: async (path) => {
            if (path.startsWith('/projects'))
                return [
                    { id: 1, customer: 1, name: 'Support', visible: true },
                    { id: 3, customer: 1, name: 'Migration', visible: true },
                ];
            if (path.startsWith('/activities')) return [{ id: 2, name: 'Repair', visible: true }];
            return clone(remotes);
        },
        request: async (method, path, body) => {
            calls.push({ method, path, body });
            if (path === '/users/me') return { id: 1, timezone: 'UTC' };
            if (path === '/config/timesheet') return { trackingMode: 'default' };
            if (method === 'POST' && path === '/timesheets') {
                const r = {
                    ...body,
                    id: remotes.length + 1,
                    begin: body.begin + 'Z',
                    end: body.end ? body.end + 'Z' : null,
                    duration: body.end
                        ? (Date.parse(body.end + 'Z') - Date.parse(body.begin + 'Z')) / 1000
                        : 0,
                };
                remotes.push(r);
                return clone(r);
            }
            const r = remotes.find((x) => x.id === +path.split('/').pop());
            if (!r) {
                const e = Error('not found');
                e.status = 404;
                throw e;
            }
            if (method === 'DELETE') {
                remotes.splice(remotes.indexOf(r), 1);
                return {};
            }
            if (method === 'PATCH')
                Object.assign(r, body, {
                    begin: body.begin + 'Z',
                    end: body.end ? body.end + 'Z' : null,
                    duration: (Date.parse(body.end + 'Z') - Date.parse(body.begin + 'Z')) / 1000,
                });
            return clone(r);
        },
    };
    const p = {
        db,
        meshServer: { getConfigFilePath: () => '/unused', webserver: { users: { [user._id]: user } } },
        perms: { filterFor: async (u, q) => q },
    };
    const service = new Service(p, { vault: { open: (x) => x }, clientFactory: () => c });
    const dest = {
        customer: 1,
        project: 1,
        activity: 2,
        description: 'Repair printer',
        tags: 'support',
        billable: true,
    };
    async function ready() {
        await db.setSetting('kimai:server', { url: 'https://kimai.example' });
        await service.save(user, {
            ledger: {},
            allocations: {},
            token: 'encrypted',
            server: 'https://kimai.example',
            account: { id: 1 },
            tz: 'UTC',
            rules: [],
            live: false,
            nightly: false,
            previews: {},
        });
    }
    function doc(id = 'a', offset = -600000) {
        const d = {
            _id: id,
            userid: user._id,
            domain: '',
            nodeid: 'node//' + id,
            nodename: id,
            type: 'desktop',
            source: 'live',
            start: now + offset,
            end: null,
        };
        docs.push(d);
        return d;
    }
    const action = (command, other = {}) =>
        service.action(user, { op: 'device', command, requestId: uuid(), ...other });
    const view = () => service.device.state(user);
    const step = (ms) => (now += ms);
    return {
        service,
        db,
        user,
        docs,
        remotes,
        c,
        calls,
        dest,
        ready,
        doc,
        action,
        view,
        step,
        get now() {
            return now;
        },
    };
}
test('coverage subtraction preserves disconnected gaps and unbounded running spans', () => {
    assert.deepEqual(
        subtract(0, 30, [
            { begin: 5, end: 10 },
            { begin: 15, end: 20 },
        ]),
        [
            { begin: 0, end: 5 },
            { begin: 10, end: 15 },
            { begin: 20, end: 30 },
        ],
    );
    assert.deepEqual(subtract(0, null, [{ begin: 5, end: null }]), [{ begin: 0, end: 5 }]);
});
test('manual start works with live automation off, stop/resume keeps every gap excluded', async (t) => {
    const f = setup(t);
    await f.ready();
    const d = f.doc();
    await f.view();
    const first = await f.action('start', { sessions: [d._id], destination: f.dest, from: 'now' });
    f.step(10000);
    let a = (await f.view()).allocations[0];
    await f.action('stop', { id: first.id, revision: a.revision });
    f.step(5000);
    const second = await f.action('start', { sessions: [d._id], destination: f.dest, from: 'now' });
    f.step(10000);
    a = (await f.view()).allocations.find((x) => x.id === second.id);
    await f.action('stop', { id: a.id, revision: a.revision });
    f.step(5000);
    await f.action('start', { sessions: [d._id], destination: f.dest, from: 'now' });
    f.step(10000);
    d.end = f.now;
    const v = await f.view();
    assert.deepEqual(
        v.allocations
            .filter((x) => x.origin === 'manual')
            .map((x) => x.seconds)
            .sort(),
        [10, 10, 10],
    );
    assert.equal(
        v.reviews.some((x) => x.origin === 'unmatched'),
        false,
        'untracked earlier time must not create a Kimai review',
    );
    const state = await f.service.state(f.user);
    const remaining = available(state, [d]);
    assert.equal(remaining.length, 1, 'only time before the explicit manual start remains available');
    assert.equal(remaining[0].end - remaining[0].start, 600000);
    assert.equal(
        f.calls.filter((x) => x.method === 'POST').length,
        0,
        'local running never POSTs an unsafe remote timer',
    );
});
test('same destination shares one allocation; detach leaves the other contributor recording', async (t) => {
    const f = setup(t);
    await f.ready();
    const a = f.doc('a'),
        b = f.doc('b');
    await f.view();
    const first = await f.action('start', { sessions: [a._id], destination: f.dest });
    const second = await f.action('start', { sessions: [b._id], destination: f.dest });
    assert.equal(first.id, second.id);
    f.step(5000);
    let item = (await f.view()).allocations[0];
    await f.action('stop', { id: item.id, revision: item.revision, sessionIds: [a._id] });
    item = (await f.view()).allocations[0];
    assert.equal(item.end, null);
    assert.notEqual(item.spans[0].end, null);
    assert.equal(item.spans[1].end, null);
    f.step(5000);
    b.end = f.now;
    item = (await f.view()).allocations[0];
    assert.equal(item.seconds, 10);
    assert.equal(item.review, true);
});
test('external Kimai timer blocks manual start without modifying it', async (t) => {
    const f = setup(t);
    await f.ready();
    const d = f.doc();
    await f.view();
    f.remotes.push({ id: 88, begin: '2026-09-07T11:00:00Z', end: null });
    await assert.rejects(f.action('start', { sessions: [d._id], destination: f.dest }), /unrelated timer/);
    assert.equal(
        f.calls.some((x) => ['POST', 'PATCH', 'DELETE'].includes(x.method)),
        false,
    );
});
test('manual recordings enter durable inbox with popups disabled; claims deduplicate', async (t) => {
    const f = setup(t);
    await f.ready();
    const d = f.doc();
    await f.view();
    await f.action('preferences', { prompt: 'never', presentation: 'drawer' });
    await f.action('start', { sessions: [d._id], destination: f.dest, from: 'now' });
    f.step(1000);
    d.end = f.now;
    let a = (await f.view()).reviews[0];
    assert.equal(a.origin, 'manual');
    assert.equal((await f.action('claim', { id: a.id })).show, true);
    assert.equal((await f.action('claim', { id: a.id })).show, false);
    const restarted = new Service(f.service.p, { vault: { open: (x) => x }, clientFactory: () => f.c });
    assert.equal((await restarted.device.state(f.user)).reviews.length, 1);
});
test('completed sends preserve seconds and repeated exports cannot duplicate covered source time', async (t) => {
    const f = setup(t);
    await f.ready();
    const d = f.doc();
    await f.view();
    await f.action('start', { sessions: [d._id], destination: f.dest, from: 'connection' });
    f.step(3000);
    d.end = f.now;
    let a = (await f.view()).reviews[0];
    await f.action('save', { id: a.id, revision: a.revision, row: f.dest, reviewed: true });
    a = (await f.view()).allocations[0];
    assert.equal(a.status, 'synced');
    assert.equal(f.remotes[0].duration, 603);
    await f.action('save', { id: a.id, revision: a.revision, row: f.dest, reviewed: true });
    assert.equal(f.remotes.length, 1);
    const state = await f.service.state(f.user);
    assert.deepEqual(available(state, [d]), []);
});
test('discard is durable, deletes only an owned unchanged entry, and survives retention', async (t) => {
    const f = setup(t);
    await f.ready();
    const d = f.doc();
    await f.view();
    await f.action('start', { sessions: [d._id], destination: f.dest, from: 'connection' });
    f.step(1000);
    d.end = f.now;
    let a = (await f.view()).reviews[0];
    await f.action('save', { id: a.id, revision: a.revision, row: f.dest, reviewed: true });
    a = (await f.view()).allocations[0];
    await f.action('exclude', { id: a.id, revision: a.revision, confirmed: true });
    assert.equal(f.remotes.length, 0);
    assert.deepEqual(available(await f.service.state(f.user), [d]), []);
    f.docs.length = 0;
    assert.equal(Object.values((await f.service.state(f.user)).allocations)[0].status, 'excluded');
});
test('remote edits are preserved on discard and remain actionable in inbox', async (t) => {
    const f = setup(t);
    await f.ready();
    const d = f.doc();
    await f.view();
    await f.action('start', { sessions: [d._id], destination: f.dest, from: 'connection' });
    f.step(1000);
    d.end = f.now;
    let a = (await f.view()).reviews[0];
    await f.action('save', { id: a.id, revision: a.revision, row: f.dest, reviewed: true });
    a = (await f.view()).allocations[0];
    f.remotes[0].description = 'External edit';
    await f.action('exclude', { id: a.id, revision: a.revision, confirmed: true });
    assert.equal(f.remotes.length, 1);
    a = (await f.view()).reviews[0];
    assert.match(a.error, /Remote entry changed/);
});
test('stale revision, other-user sources, and reused request identity are rejected', async (t) => {
    const f = setup(t);
    await f.ready();
    const d = f.doc();
    await f.view();
    const requestId = uuid(),
        req = { op: 'device', command: 'start', requestId, sessions: [d._id], destination: f.dest };
    const result = await f.service.action(f.user, req);
    assert.deepEqual(await f.service.action(f.user, req), result);
    await assert.rejects(f.service.action(f.user, { ...req, from: 'connection' }), /reused/);
    await assert.rejects(f.action('stop', { id: result.id, revision: 0 }), /another window/);
    const foreign = f.doc('foreign');
    foreign.userid = 'user//other';
    await assert.rejects(f.action('start', { sessions: [foreign._id], destination: f.dest }), /accessible/);
});
test('destination switching closes the old interval and never edits its earlier description', async (t) => {
    const f = setup(t);
    await f.ready();
    const d = f.doc();
    await f.view();
    await f.action('start', { sessions: [d._id], destination: f.dest });
    f.step(10000);
    const a = (await f.view()).allocations[0];
    await f.action('save', {
        id: a.id,
        revision: a.revision,
        mode: 'switch',
        row: { ...f.dest, project: 3, description: 'Migration' },
    });
    const entries = (await f.view()).allocations;
    assert.equal(entries.length, 2);
    const old = entries.find((x) => x.id === a.id),
        next = entries.find((x) => x.id !== a.id);
    assert.equal(old.end, next.begin);
    assert.equal(old.description, 'Repair printer');
    assert.equal(next.project, 3);
});
test('midnight splits a completed recording into daily owned entries without losing seconds', async (t) => {
    const f = setup(t);
    await f.ready();
    f.step(12 * 3600000 - 1000);
    const d = f.doc('a', 0);
    await f.view();
    await f.action('start', { sessions: [d._id], destination: f.dest });
    f.step(3000);
    d.end = f.now;
    const a = (await f.view()).reviews[0];
    await f.action('save', { id: a.id, revision: a.revision, row: f.dest, reviewed: true });
    assert.deepEqual(
        f.remotes.map((x) => x.duration),
        [1, 2],
    );
});
test('a preview created before exclusion is invalidated at send time', async (t) => {
    const f = setup(t);
    await f.ready();
    const d = f.doc();
    d.end = f.now;
    let s = await f.service.state(f.user);
    s.rules = [{ id: 'r', ...f.dest, basis: 'connected' }];
    await f.service.save(f.user, s);
    const preview = await f.service.action(f.user, {
        op: 'preview',
        query: { start: d.start, end: f.now + 1000, scope: 'all' },
    });
    let a = (await f.view()).reviews[0];
    await f.action('exclude', { id: a.id, revision: a.revision, confirmed: true });
    await assert.rejects(
        f.service.action(f.user, {
            op: 'send',
            preview: preview.id,
            rows: preview.rows.map((x) => ({ id: x.id, reviewed: true })),
        }),
        /reserved or excluded/,
    );
    assert.equal(f.remotes.length, 0);
});
test('device-enabled live sync never falls through to a remote start for a competing project', async (t) => {
    const f = setup(t);
    await f.ready();
    f.doc('a');
    const b = f.doc('b');
    b.type = 'files';
    await f.view();
    let s = await f.service.state(f.user);
    s.rules = [
        { id: 'a', ...f.dest, basis: 'connected', type: 'desktop' },
        { id: 'b', ...f.dest, project: 3, basis: 'connected', type: 'files' },
    ];
    s.live = true;
    await f.service.save(f.user, s);
    await f.db.setSetting('kimai:users', { users: [f.user._id] });
    await f.service.tick();
    assert.equal(f.remotes.length, 0);
    assert.equal((await f.view()).allocations.length, 1);
});
test('competing completed destinations are both held before unattended sending', async (t) => {
    const f = setup(t);
    await f.ready();
    const a = f.doc('a'),
        b = f.doc('b');
    b.type = 'files';
    await f.view();
    let s = await f.service.state(f.user);
    s.rules = [
        { id: 'a', ...f.dest, basis: 'connected', type: 'desktop' },
        { id: 'b', ...f.dest, project: 3, basis: 'connected', type: 'files' },
    ];
    s.live = true;
    s.device.preferences.prompt = 'never';
    await f.service.save(f.user, s);
    f.step(1000);
    a.end = b.end = f.now;
    await f.view();
    s = await f.service.state(f.user);
    await f.service.device.flush(f.user, s, f.c);
    assert.equal(f.remotes.length, 0);
    assert.equal(Object.values(s.allocations).filter((x) => /Overlapping/.test(x.error)).length, 2);
});
test('connected rules merge overlap; active zero is omitted and oversized measurements capped', async (t) => {
    const f = setup(t);
    await f.ready();
    const a = f.doc('a'),
        b = f.doc('b');
    await f.view();
    let s = await f.service.state(f.user);
    s.rules = [{ id: 'r', ...f.dest, basis: 'connected' }];
    await f.service.save(f.user, s);
    f.step(1000);
    a.end = b.end = f.now;
    let view = await f.view();
    assert.equal(view.allocations.length, 1);
    assert.equal(view.allocations[0].source.length, 2);
    const c = f.doc('zero', 0),
        d = f.doc('large', 0);
    c.active = 0;
    d.active = 9999;
    f.step(1000);
    c.end = d.end = f.now;
    s = await f.service.state(f.user);
    s.rules = [{ id: 'r', ...f.dest, basis: 'active' }];
    await f.service.save(f.user, s);
    view = await f.view();
    const zero = view.allocations.find((x) => x.source.includes(c._id)),
        large = view.allocations.find((x) => x.source.includes(d._id));
    assert.equal(zero.status, 'excluded');
    assert.equal(large.seconds, 1);
});
test('lost create response is reconciled with the mandatory meshcentral tag and no second POST', async (t) => {
    const f = setup(t);
    await f.ready();
    const d = f.doc();
    await f.view();
    await f.action('start', { sessions: [d._id], destination: { ...f.dest, tags: '' }, from: 'connection' });
    f.step(1000);
    d.end = f.now;
    let a = (await f.view()).reviews[0],
        original = f.c.request,
        lost = false;
    f.c.request = async (method, path, body) => {
        const r = await original(method, path, body);
        if (method === 'POST' && path === '/timesheets' && !lost) {
            lost = true;
            throw Error('response lost');
        }
        return r;
    };
    await f.action('save', { id: a.id, revision: a.revision, row: { ...f.dest, tags: '' }, reviewed: true });
    assert.equal(f.remotes.length, 1);
    assert.match(f.remotes[0].tags, /meshcentral/);
    a = (await f.view()).allocations[0];
    await f.action('save', { id: a.id, revision: a.revision, row: { ...f.dest, tags: '' }, reviewed: true });
    assert.equal(f.remotes.length, 1);
    assert.equal((await f.view()).allocations[0].status, 'synced');
});
test('tag creation is explicit, visible, and reconciled after a lost response without another POST', async () => {
    const { Client } = require('../kimai'),
        c = new Client('https://kimai.example', 'unused'),
        journal = {},
        names = [];
    let posts = 0,
        persisted = false;
    c.list = async () => names.slice();
    c.request = async (method, path, body) => {
        assert.equal(persisted, true);
        assert.equal(body.visible, true);
        posts++;
        names.push(body.name);
        throw Error('response lost');
    };
    await assert.rejects(
        c.ensureTags('meshcentral', journal, async () => {
            persisted = true;
        }),
        /save again/,
    );
    await c.ensureTags('meshcentral', journal, async () => {});
    assert.equal(posts, 1);
    assert.deepEqual(journal, {});
});
test('unconfirmed missing tag creation is never posted again automatically', async () => {
    const { Client } = require('../kimai'),
        c = new Client('https://kimai.example', 'unused'),
        journal = {};
    let posts = 0;
    c.list = async () => [];
    c.request = async () => {
        posts++;
        throw Error('connection lost');
    };
    await assert.rejects(c.ensureTags('meshcentral', journal, async () => {}));
    await assert.rejects(
        c.ensureTags('meshcentral', journal, async () => {}),
        /unconfirmed/,
    );
    assert.equal(posts, 1);
});

test('device state identifies mapped pending sessions without enabling live automation', async (t) => {
    const f = setup(t);
    await f.ready();
    const s = await f.service.state(f.user);
    s.rules = [{ ...f.dest, basis: 'connected' }];
    await f.service.save(f.user, s);
    const d = f.doc();
    let v = await f.view();
    assert.equal(v.sessions[0].mapped, true);
    assert.equal(v.sessions[0].basis, 'connected');
    assert.equal(v.sessions[0].active, d.active ?? null);
    d.active = 42;
    assert.equal((await f.view()).sessions[0].active, 42);
    assert.equal(v.allocations.length, 0);
    const a = await f.action('start', { sessions: [d._id], destination: f.dest, from: 'now' });
    f.step(10000);
    v = await f.view();
    await f.action('stop', { id: a.id, revision: v.allocations[0].revision });
    v = await f.view();
    assert.equal(v.sessions[0].mapped, false, 'stopped contributions must not imply ongoing mapped capture');
});

test('rule prompt overrides personal defaults and strictest concurrent contributor wins', async (t) => {
    const f = setup(t);
    await f.ready();
    await f.view();
    await f.action('preferences', { prompt: 'never', presentation: 'drawer', minSeconds: 0 });
    const s = await f.service.state(f.user);
    s.live = true;
    s.rules = [
        { ...f.dest, basis: 'connected', device: 'node//a', prompt: 'always' },
        { ...f.dest, basis: 'connected', prompt: 'never' },
    ];
    await f.service.save(f.user, s);
    const a = f.doc('a', 0),
        b = f.doc('b', 0);
    let v = await f.view();
    assert.equal(v.allocations.length, 1);
    assert.equal(v.allocations[0].prompt, 'always');
    f.step(10000);
    a.end = b.end = f.now;
    v = await f.view();
    const state = await f.service.state(f.user);
    await f.service.device.flush(f.user, state, f.c);
    assert.equal(f.remotes.length, 0, 'always review prevents automatic export');
});

test('minimum duration durably excludes short automatic sessions while raw stats survive', async (t) => {
    const f = setup(t);
    await f.ready();
    await f.view();
    await f.action('preferences', { prompt: 'always', presentation: 'drawer', minSeconds: 60 });
    const s = await f.service.state(f.user);
    s.rules = [{ ...f.dest, basis: 'connected' }];
    await f.service.save(f.user, s);
    const d = f.doc('short', 0);
    f.step(59000);
    d.end = f.now;
    let v = await f.view();
    assert.equal(v.allocations[0].status, 'excluded');
    assert.equal(v.reviews.length, 0);
    const state = await f.service.state(f.user);
    assert.deepEqual(available(state, [d]), []);
    assert.equal((await f.db.getSession(d._id)).end - d.start, 59000);
    await f.action('preferences', { prompt: 'always', presentation: 'drawer', minSeconds: 0 });
    v = await f.view();
    assert.equal(v.allocations.length, 1);
    assert.equal(v.allocations[0].status, 'excluded');
});

test('per-rule minimum zero overrides personal default and manual tracking is exempt', async (t) => {
    const f = setup(t);
    await f.ready();
    await f.view();
    await f.action('preferences', { prompt: 'always', presentation: 'drawer', minSeconds: 60 });
    const s = await f.service.state(f.user);
    s.rules = [{ ...f.dest, basis: 'connected', minSeconds: 0 }];
    await f.service.save(f.user, s);
    const d = f.doc('rule', 0);
    f.step(10000);
    d.end = f.now;
    let v = await f.view();
    assert.equal(v.allocations[0].status, 'review');
    const manual = f.doc('manual', 0);
    const started = await f.action('start', { sessions: [manual._id], destination: f.dest, from: 'now' });
    f.step(10000);
    manual.end = f.now;
    v = await f.view();
    assert.equal(v.allocations.find((a) => a.id === started.id).status, 'review');
});

test('open rule recording below minimum is excluded on disconnect without remote deletion', async (t) => {
    const f = setup(t);
    await f.ready();
    await f.view();
    const s = await f.service.state(f.user);
    s.live = true;
    s.rules = [{ ...f.dest, basis: 'connected', minSeconds: 60 }];
    await f.service.save(f.user, s);
    const d = f.doc('open', 0);
    let v = await f.view();
    assert.equal(v.allocations[0].status, 'recording-local');
    f.step(10000);
    d.end = f.now;
    v = await f.view();
    assert.ok(v.allocations.every((a) => a.status === 'excluded'));
    assert.equal(v.reviews.length, 0);
    assert.equal(f.calls.filter((c) => c.method === 'DELETE').length, 0);
});

test('shared recording removes a short contributor without discarding eligible time', async (t) => {
    const f = setup(t);
    await f.ready();
    await f.view();
    const s = await f.service.state(f.user);
    s.live = true;
    s.rules = [
        { ...f.dest, basis: 'connected', device: 'node//short', minSeconds: 60, prompt: 'always' },
        { ...f.dest, basis: 'connected', minSeconds: 0, prompt: 'never' },
    ];
    await f.service.save(f.user, s);
    const short = f.doc('short', 0);
    await f.view();
    f.step(5000);
    const long = f.doc('long', 0);
    await f.view();
    f.step(5000);
    short.end = f.now;
    await f.view();
    f.step(65000);
    long.end = f.now;
    const v = await f.view();
    const eligible = v.allocations.find((a) => a.status === 'review');
    assert.deepEqual(eligible.source, ['long']);
    assert.equal(eligible.begin, long.start);
    assert.equal(eligible.prompt, 'never');
    assert.equal(v.allocations.find((a) => a.status === 'excluded').source[0], 'short');
});

test('unmatched sessions never create Kimai allocations, with live automation on or off', async (t) => {
    const f = setup(t);
    await f.ready();
    await f.view();
    for (const live of [false, true]) {
        const s = await f.service.state(f.user);
        s.live = live;
        s.rules = [{ ...f.dest, basis: 'connected', device: 'node//different' }];
        await f.service.save(f.user, s);
        const d = f.doc('unmatched-' + live, 0);
        assert.equal((await f.view()).allocations.length, 0);
        f.step(67000);
        d.end = f.now;
        const v = await f.view();
        assert.equal(v.allocations.length, 0);
        assert.equal(v.reviews.length, 0);
    }
    assert.equal(f.calls.filter((c) => ['POST', 'PATCH'].includes(c.method)).length, 0);
    assert.equal(f.docs.length, 2, 'raw ConnectionStats sessions remain');
});

test('active-time group rule applies after disconnect with live timers disabled, only to its group', async (t) => {
    const f = setup(t);
    await f.ready();
    await f.view();
    const s = await f.service.state(f.user);
    s.rules = [{...f.dest, group:'mesh//practice',type:'desktop',basis:'active',prompt:'issues'}];
    await f.service.save(f.user, s);
    const matching = f.doc('matching',0), other = f.doc('other',0);
    matching.meshid = 'mesh//practice';
    other.meshid = 'mesh//elsewhere';
    assert.equal((await f.view()).allocations.length,0);
    f.step(67000);
    matching.end = other.end = f.now;
    const v = await f.view();
    assert.equal(v.reviews.length,1);
    assert.deepEqual(v.reviews[0].source,['matching']);
    assert.equal(v.reviews[0].project,f.dest.project);
    assert.equal(v.reviews[0].prompt,'issues');
    assert.match(v.reviews[0].error,/Active-time|Overlapping activity/);
});
