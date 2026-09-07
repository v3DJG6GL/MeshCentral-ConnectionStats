'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'),
    os = require('os'),
    path = require('path');
const { build, rules, epoch, days, ambiguous, Client, Vault, Service } = require('../kimai');
const base = Date.parse('2026-01-05T10:00:00Z');
const rule = { id: 'r', project: 1, activity: 2, basis: 'connected', description: '{device} {types}', tags: '' };
function doc(id, start, end, extra = {}) {
    return {
        _id: id,
        userid: 'user//a',
        nodeid: 'node//x',
        meshid: 'mesh//g',
        start: base + start * 60000,
        end: end == null ? null : base + end * 60000,
        type: 'desktop',
        source: 'live',
        ...extra,
    };
}
function fixture(docs = []) {
    const settings = new Map(),
        remotes = [],
        calls = [];
    const clone = (x) => (x == null ? null : JSON.parse(JSON.stringify(x)));
    const user = { _id: 'user//a', domain: '' };
    const db = {
        getSetting: async (k) => clone(settings.get(k)),
        setSetting: async (k, v) => {
            settings.set(k, clone(v));
        },
        findSessions: async (f) =>
            docs.filter((d) => d.userid === f.userids[0] && d.start < f.end && (d.end == null || d.end > f.start)),
        getSession: async (id) => clone(docs.find((d) => d._id === id)),
    };
    const c = {
        list: async (p) => clone(remotes),
        request: async (method, p, body) => {
            calls.push({ method, p, body });
            if (p === '/users/me') return { id: 1, username: 'a', timezone: 'UTC' };
            if (p === '/version') return { version: '2' };
            if (p === '/config/timesheet') return { trackingMode: 'default' };
            if (p === '/timesheets?size=1') return [];
            if (method === 'POST') {
                const r = {
                    ...body,
                    id: remotes.length + 1,
                    begin: body.begin + '+0000',
                    end: body.end ? body.end + '+0000' : null,
                    duration: body.end ? (Date.parse(body.end + 'Z') - Date.parse(body.begin + 'Z')) / 1000 : 0,
                };
                remotes.push(r);
                return clone(r);
            }
            const r = remotes.find((r) => r.id === Number(p.split('/').pop()));
            if (!r) {
                const e = Error('not found');
                e.status = 404;
                throw e;
            }
            if (method === 'PATCH')
                Object.assign(r, body, {
                    begin: body.begin + '+0000',
                    end: body.end ? body.end + '+0000' : null,
                    duration: body.end ? (Date.parse(body.end + 'Z') - Date.parse(body.begin + 'Z')) / 1000 : 0,
                });
            return clone(r);
        },
    };
    const plugin = {
        db,
        meshServer: { webserver: { users: { [user._id]: user } }, getConfigFilePath: () => '/unused' },
        isAdmin: () => true,
        perms: { filterFor: async (u, q) => ({ ...q, domain: u.domain }) },
    };
    const service = new Service(plugin, {
        vault: { seal: (t) => ['encrypted', t], open: (t) => t[1] },
        clientFactory: () => c,
    });
    async function connected() {
        await db.setSetting('kimai:server', { url: 'https://kimai.example' });
        await service.action(user, { op: 'connect', token: 'secret' });
        await service.action(user, { op: 'settings', rules: [rule], live: false, nightly: false });
    }
    return { service, db, user, settings, c, remotes, calls, docs, connected };
}
test('connected union counts overlap once and preserves disconnected gaps', () => {
    const b = build([doc('a', 0, 10), doc('b', 5, 15), doc('c', 20, 25)], [rule], 'UTC');
    assert.deepEqual(
        b.map((x) => x.seconds),
        [900, 300],
    );
    assert.deepEqual(b[0].source, ['a', 'b']);
});
test('first matching rule and cross-project conflicts', () => {
    const b = build(
        [doc('a', 0, 10), doc('b', 5, 15, { type: 'files' })],
        [{ ...rule, type: 'files', project: 3 }, rule],
        'UTC',
    );
    assert.equal(b[0].project, 1);
    assert.equal(b[1].project, 3);
    assert.ok(b.every((b) => b.issue.includes('Overlapping')));
});
test('active time is a duration; missing and overlapping measurements require review', () => {
    const r = { ...rule, basis: 'active' };
    assert.equal(build([doc('a', 0, 20, { active: 300 })], [r], 'UTC')[0].seconds, 300);
    assert.match(build([doc('a', 0, 20)], [r], 'UTC')[0].issue, /unavailable/);
    assert.ok(
        build([doc('a', 0, 20, { active: 300 }), doc('b', 10, 30, { active: 60 })], [r], 'UTC').every((b) =>
            b.issue.includes('Overlapping'),
        ),
    );
    assert.equal(build([doc('a', 0, 20, { active: 0 })], [r], 'UTC').length, 0);
});
test('midnight splitting and DST use real elapsed time', () => {
    assert.deepEqual(
        days(Date.parse('2026-03-28T23:00:00Z'), Date.parse('2026-03-29T22:00:00Z'), 'Europe/Zurich').map(
            (x) => (x[1] - x[0]) / 3600000,
        ),
        [23],
    );
    assert.equal(ambiguous(Date.parse('2026-10-25T00:30:00Z'), 'Europe/Zurich'), true);
    assert.throws(() => epoch('2026-03-29T02:30:00', 'Europe/Zurich'), /Invalid/);
    assert.throws(() => epoch('2026-10-25T02:30:00', 'Europe/Zurich'), /ambiguous/);
    assert.equal(epoch('2026-01-05T11:00:12', 'Europe/Zurich'), base + 12000);
});
test('ongoing, guest and unmatched sessions are excluded', () =>
    assert.equal(
        build(
            [doc('a', 0, null), doc('b', 0, 10, { guest: 'G' }), doc('c', 0, 10, { type: 'files' })],
            [{ ...rule, type: 'desktop' }],
            'UTC',
        ).length,
        0,
    ));
test('token vault encrypts, authenticates, restricts permissions and fails closed on missing key', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimai-vault-')),
        file = path.join(dir, 'key');
    try {
        const v = new Vault(file),
            sealed = v.seal('very-secret');
        assert.equal(v.open(sealed), 'very-secret');
        assert.ok(!JSON.stringify(sealed).includes('very-secret'));
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
        sealed[3] = Buffer.alloc(16).toString('base64');
        assert.throws(() => v.open(sealed));
        fs.unlinkSync(file);
        assert.throws(() => v.open(sealed));
        assert.equal(fs.existsSync(file), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
test('HTTP and credential-bearing server URLs are rejected', () => {
    for (const url of ['http://kimai.test', 'https://user:pass@kimai.test', 'https://kimai.test?token=x'])
        assert.throws(() => new Client(url, 'x'));
});
test('paginated reads include every page', async () => {
    const c = new Client('https://kimai.test', 'x');
    c.request = async (m, p) =>
        new URL('https://x' + p).searchParams.get('page') === '1'
            ? Array.from({ length: 100 }, (_, id) => ({ id }))
            : [{ id: 100 }];
    assert.equal((await c.list('/timesheets')).length, 101);
});
test('personal tokens are redacted, storage separated, other users cannot preview sessions', async () => {
    const f = fixture([doc('a', 0, 10), doc('b', 0, 10, { userid: 'user//other' })]);
    await f.connected();
    const info = await f.service.info(f.user);
    assert.ok(!JSON.stringify(info).includes('secret'));
    const p = await f.service.action(f.user, { op: 'preview', query: { start: base, end: base + 3600000 } });
    assert.deepEqual(p.rows[0].source, ['a']);
    assert.equal((await f.service.info({ _id: 'user//other', domain: '' })).connected, false);
});
test('repeated and concurrent sends create only one remote entry', async () => {
    const f = fixture([doc('a', 0, 10)]);
    await f.connected();
    const p = await f.service.action(f.user, { op: 'preview', query: { start: base, end: base + 3600000 } });
    await Promise.all(
        [1, 2].map(() => f.service.action(f.user, { op: 'send', preview: p.id, rows: [{ id: p.rows[0].id }] })),
    );
    assert.equal(f.remotes.length, 1);
    assert.equal(f.calls.filter((c) => c.method === 'POST').length, 1);
    assert.ok([...f.settings.keys()].some((k) => k.includes(':block:')));
});
test('lost create response reconciles marker without a second POST', async () => {
    const f = fixture([doc('a', 0, 10)]);
    await f.connected();
    const s = await f.service.state(f.user),
        b = build(f.docs, [rule], 'UTC')[0],
        request = f.c.request;
    f.c.request = async (...args) => {
        const result = await request(...args);
        if (args[0] === 'POST') throw Error('lost response');
        return result;
    };
    await f.service.sync(f.user, s, f.c, b);
    assert.equal(s.ledger[b.id].status, 'creating');
    await f.service.sync(f.user, s, f.c, b);
    assert.equal(f.remotes.length, 1);
    assert.equal(s.ledger[b.id].status, 'synced');
});
test('unresolved create never blindly retries', async () => {
    const f = fixture([doc('a', 0, 10)]);
    await f.connected();
    const s = await f.service.state(f.user),
        b = build(f.docs, [rule], 'UTC')[0];
    let n = 0;
    f.c.request = async () => {
        n++;
        throw Error('lost');
    };
    await f.service.sync(f.user, s, f.c, b);
    await f.service.sync(f.user, s, f.c, b);
    assert.equal(n, 1);
    assert.match(s.ledger[b.id].error, /uncertain/);
});
test('remote edits and locked records are preserved', async () => {
    const f = fixture([doc('a', 0, 10)]);
    await f.connected();
    const s = await f.service.state(f.user),
        b = build(f.docs, [rule], 'UTC')[0];
    await f.service.sync(f.user, s, f.c, b);
    f.remotes[0].description = 'edited';
    await f.service.sync(f.user, s, f.c, b);
    assert.equal(s.ledger[b.id].status, 'conflict');
    assert.equal(f.remotes[0].description, 'edited');
    await f.service.action(f.user, { op: 'resolve', id: b.id, choice: 'keep' });
    assert.equal((await f.service.state(f.user)).ledger[b.id].status, 'kept');
    s.ledger[b.id].status = 'synced';
    f.remotes[0].exported = true;
    await f.service.sync(f.user, s, f.c, b);
    assert.equal(s.ledger[b.id].status, 'locked');
});
test('existing foreign timer is never modified', async () => {
    const f = fixture([doc('a', 0, 10)]);
    await f.connected();
    f.remotes.push({ id: 99, begin: '2026-01-05T09:00:00+0000', end: null, description: 'External' });
    const s = await f.service.state(f.user),
        b = build(f.docs, [rule], 'UTC')[0];
    await f.service.sync(f.user, s, f.c, b);
    assert.equal(f.remotes.length, 1);
    assert.equal(f.calls.filter((c) => ['PATCH', 'POST'].includes(c.method)).length, 0);
    assert.match(s.ledger[b.id].error, /overlaps/);
});
test('live connections share one timer and stop after the last disconnect', async () => {
    const now = Date.now(),
        f = fixture([doc('a', 0, null, { start: now - 10000 }), doc('b', 0, null, { start: now - 5000 })]);
    await f.connected();
    await f.service.action(f.user, { op: 'settings', rules: [rule], live: true, nightly: false });
    let s = await f.service.state(f.user);
    s.enabledAt = now - 60000;
    await f.service.save(f.user, s);
    await f.service.tick();
    await f.service.tick();
    assert.equal(f.remotes.length, 1);
    assert.equal(f.remotes[0].end, null);
    f.docs[0].end = now - 1000;
    await f.service.tick();
    assert.equal(f.remotes[0].end, null);
    f.docs[1].end = now;
    await f.service.tick();
    assert.ok(f.remotes[0].end);
    assert.equal(f.remotes.length, 1);
});
test('changed source membership cannot create duplicate time', async () => {
    const f = fixture([doc('a', 0, 10)]);
    await f.connected();
    let p = await f.service.action(f.user, { op: 'preview', query: { start: base, end: base + 3600000 } });
    await f.service.action(f.user, { op: 'send', preview: p.id, rows: [{ id: p.rows[0].id }] });
    f.docs.push(doc('b', 5, 15));
    p = await f.service.action(f.user, { op: 'preview', query: { start: base, end: base + 3600000 } });
    assert.match(p.rows[0].issue, /membership/);
    await f.service.action(f.user, { op: 'send', preview: p.id, rows: [{ id: p.rows[0].id, reviewed: true }] });
    assert.equal(f.remotes.length, 1);
    assert.equal(Date.parse(f.remotes[0].end), base + 15 * 60000);
});
test('active conflicts require adjusted duration, not merely a checked box', () => {
    const f = fixture(),
        b = build([doc('a', 0, 10)], [{ ...rule, basis: 'active' }], 'UTC')[0];
    assert.throws(() => f.service.edit(b, { reviewed: true }, 'UTC'), /duration/);
    assert.equal(f.service.edit(b, { end: base + 60000 }, 'UTC').end, base + 60000);
});
test('failed stop retains timer ownership and retries without a new timer', async () => {
    const now = Date.now(),
        f = fixture([doc('a', 0, null, { start: now - 10000 })]);
    await f.connected();
    await f.service.action(f.user, { op: 'settings', rules: [rule], live: true });
    await f.service.tick();
    const request = f.c.request;
    let fail = true;
    f.c.request = async (...args) => {
        if (args[0] === 'PATCH' && fail) {
            fail = false;
            throw Error('network failure');
        }
        return request(...args);
    };
    f.docs[0].end = now;
    await f.service.tick();
    let s = await f.service.state(f.user);
    assert.equal(Object.values(s.ledger)[0].end, null);
    assert.equal(Object.values(s.ledger)[0].live, true);
    await f.service.tick();
    s = await f.service.state(f.user);
    assert.equal(Object.values(s.ledger)[0].status, 'synced');
    assert.equal(f.remotes.length, 1);
});
test('lost PATCH response is reconciled instead of treated as a foreign edit', async () => {
    const f = fixture([doc('a', 0, 10)]);
    await f.connected();
    const s = await f.service.state(f.user),
        b = build(f.docs, [rule], 'UTC')[0];
    await f.service.sync(f.user, s, f.c, b);
    const request = f.c.request;
    let once = true;
    f.c.request = async (...args) => {
        const r = await request(...args);
        if (args[0] === 'PATCH' && once) {
            once = false;
            throw Error('lost response');
        }
        return r;
    };
    const updated = { ...b, description: 'Adjusted' };
    await f.service.sync(f.user, s, f.c, updated);
    await f.service.sync(f.user, s, f.c, updated);
    assert.equal(s.ledger[b.id].status, 'synced');
    assert.equal(f.remotes.length, 1);
});
test('live timer crossing midnight becomes daily records with one shared source', async () => {
    const now = Date.now(),
        midnight = new Date(now).setUTCHours(0, 0, 0, 0),
        f = fixture([doc('a', 0, null, { start: midnight - 600000 })]);
    await f.connected();
    await f.service.action(f.user, { op: 'settings', rules: [rule], live: true });
    let s = await f.service.state(f.user);
    s.enabledAt = midnight - 3600000;
    await f.service.save(f.user, s);
    await f.service.tick();
    assert.equal(f.remotes.length, 1);
    f.docs[0].end = midnight + 600000;
    await f.service.tick();
    s = await f.service.state(f.user);
    assert.equal(f.remotes.length, 2);
    assert.ok(Object.values(s.ledger).every((l) => l.status === 'synced'));
    assert.equal(Date.parse(f.remotes[0].end), midnight);
    assert.equal(Date.parse(f.remotes[1].begin), midnight);
});
test('restarts with missing or truncated source end flag the owned timer', async () => {
    const now = Date.now(),
        f = fixture([doc('a', 0, null, { start: now - 10000 })]);
    await f.connected();
    await f.service.action(f.user, { op: 'settings', rules: [rule], live: true });
    await f.service.tick();
    f.docs[0].end = now;
    f.docs[0].truncated = true;
    await f.service.tick();
    assert.equal((await f.service.info(f.user)).history[0].status, 'conflict');
    assert.equal(f.remotes[0].end, null);
});
test('nightly includes previous day and late closures, excludes backup history', async () => {
    const real = Date.now;
    Date.now = () => Date.parse('2026-01-06T03:00:00Z');
    try {
        const f = fixture([
            doc('a', 0, 10),
            doc('b', 20, 30, { source: 'backup' }),
            doc('c', 40, 50, { source: 'backfill' }),
        ]);
        await f.connected();
        await f.service.action(f.user, { op: 'settings', rules: [rule], nightly: true });
        let s = await f.service.state(f.user);
        s.enabledAt = base - 3600000;
        await f.service.save(f.user, s);
        await f.service.tick();
        assert.equal(f.remotes.length, 1);
        await f.service.tick();
        assert.equal(f.remotes.length, 1);
    } finally {
        Date.now = real;
    }
});
test('preview mutations and revoked access cannot send stale sessions', async () => {
    const f = fixture([doc('a', 0, 10)]);
    await f.connected();
    const p = await f.service.action(f.user, { op: 'preview', query: { start: base, end: base + 3600000 } });
    f.docs[0].active = 10;
    await assert.rejects(
        f.service.action(f.user, { op: 'send', preview: p.id, rows: [{ id: p.rows[0].id }] }),
        /changed/,
    );
    f.docs.length = 0;
    await assert.rejects(
        f.service.action(f.user, { op: 'send', preview: p.id, rows: [{ id: p.rows[0].id }] }),
        /accessible/,
    );
    assert.equal(f.remotes.length, 0);
});
test('Kimai POST endpoint requires an unguessable per-user request token', () => {
    const plugin = require('../connectionstats').connectionstats({ parent: {} });
    let called = 0,
        status;
    plugin.kimai = {
        nonce: () => 'expected',
        action: () => {
            called++;
            return Promise.resolve({});
        },
    };
    const res = {
        set() {},
        status(n) {
            status = n;
            return this;
        },
        json() {},
    };
    plugin.handleAdminPostReq({ body: { action: 'kimai', csrf: 'wrong', data: '{}' } }, res, { _id: 'user//a' });
    assert.equal(status, 403);
    assert.equal(called, 0);
});
