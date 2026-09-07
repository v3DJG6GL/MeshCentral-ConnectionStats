'use strict';
const { test } = require('node:test'),
    assert = require('node:assert/strict');
const { Client, Service } = require('../kimai');
const url = process.env.CS_TEST_KIMAI_URL,
    token = process.env.CS_TEST_KIMAI_TOKEN;
test(
    'real Kimai API: connect, destinations, preview, create, update, and live timer',
    { skip: !url || !token },
    async () => {
        const c = new Client(url, token),
            created = [];
        const customer = await c.request('POST', '/customers', {
            name: 'ConnectionStats integration ' + Date.now(),
            country: 'CH',
            currency: 'CHF',
            timezone: 'UTC',
            visible: true,
            billable: true,
        });
        const project = await c.request('POST', '/projects', {
            name: 'Test project',
            customer: customer.id,
            visible: true,
            billable: true,
        });
        const activity = await c.request('POST', '/activities', {
            name: 'Remote support',
            project: project.id,
            visible: true,
            billable: true,
        });
        try {
            const settings = new Map(),
                user = { _id: 'user//test', domain: '' },
                start = Date.now() - 3600000,
                docs = [
                    {
                        _id: 's_test',
                        userid: user._id,
                        nodeid: 'node//test',
                        type: 'desktop',
                        start,
                        end: start + 600000,
                        source: 'live',
                    },
                ];
            const clone = (x) => (x == null ? null : JSON.parse(JSON.stringify(x)));
            const db = {
                getSetting: async (k) => clone(settings.get(k)),
                setSetting: async (k, v) => settings.set(k, clone(v)),
                findSessions: async () => docs,
                getSession: async (id) => docs.find((d) => d._id === id),
            };
            const svc = new Service(
                {
                    db,
                    meshServer: { getConfigFilePath: () => '/unused', webserver: { users: { [user._id]: user } } },
                    isAdmin: () => true,
                    perms: { filterFor: async (u, q) => q },
                },
                { vault: { seal: (x) => x, open: (x) => x } },
            );
            await svc.action(user, { op: 'server', url });
            await svc.action(user, { op: 'connect', token });
            assert.equal((await svc.info(user)).connected, true);
            const rule = {
                id: 'test',
                project: project.id,
                activity: activity.id,
                basis: 'connected',
                description: 'Integration test',
                tags: '',
            };
            await svc.action(user, { op: 'settings', rules: [rule] });
            assert.ok((await svc.destinations(user, 'projects', customer.id)).some((p) => p.id === project.id));
            const preview = await svc.action(user, { op: 'preview', query: { start, end: start + 600000 } });
            await svc.action(user, { op: 'send', preview: preview.id, rows: [{ id: preview.rows[0].id }] });
            let history = (await svc.info(user)).history;
            assert.equal(history[0].status, 'synced', history[0].error);
            created.push(history[0].remoteId);
            await svc.action(user, {
                op: 'send',
                preview: preview.id,
                rows: [{ id: preview.rows[0].id, description: 'Updated description' }],
            });
            assert.match((await c.request('GET', '/timesheets/' + created[0])).description, /Updated description/);
            docs.push({
                _id: 's_live',
                userid: user._id,
                nodeid: 'node//test',
                type: 'desktop',
                start: Date.now() - 10000,
                end: null,
                source: 'live',
            });
            await svc.action(user, { op: 'settings', rules: [rule], live: true });
            await svc.tick();
            history = (await svc.info(user)).history;
            const live = history.find((l) => l.live);
            assert.equal(live.status, 'running', live.error);
            created.push(live.remoteId);
            docs[1].end = Date.now();
            await svc.tick();
            history = (await svc.info(user)).history;
            assert.equal(
                history.find((l) => l.id === live.id).status,
                'synced',
                history.find((l) => l.id === live.id).error,
            );
            assert.ok((await c.request('GET', '/timesheets/' + live.remoteId)).end);
        } finally {
            for (const id of created) await c.request('DELETE', '/timesheets/' + id);
            await c.request('DELETE', '/activities/' + activity.id);
            await c.request('DELETE', '/projects/' + project.id);
            await c.request('DELETE', '/customers/' + customer.id);
        }
    },
);
