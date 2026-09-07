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
            created = [], createdDestinations = [];
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
            history = (await svc.info(user)).history;
            assert.equal(history[0].status, 'synced', JSON.stringify({error:history[0].error,last:history[0].last,remote:await c.request('GET','/timesheets/'+created[0])}));
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
            // Isolate the next workflow from the server's minute rounding on the legacy timer.
            for (const id of created) await c.request('DELETE', '/timesheets/' + id);
            created.length = 0;

            // Device controls: independent manual recording and permission-checked inline creation.
            await svc.action(user, { op: 'settings', rules: [rule], live: false, nightly: false });
            const session = { _id:'s_device', userid:user._id, nodeid:'node//device', type:'terminal', start:Date.now(), end:null, source:'live' };
            docs.push(session);
            await svc.device.state(user,session.nodeid);
            const action = (command,data) => svc.action(user,{op:'device',command,requestId:require('crypto').randomUUID(),...data});
            const newProject = await action('create',{kind:'projects',name:'Device work '+Date.now(),parent:customer.id});
            createdDestinations.push('/projects/'+newProject.id);
            const newActivity = await action('create',{kind:'activities',name:'Device activity',parent:newProject.id});
            createdDestinations.push('/activities/'+newActivity.id);
            const destination={customer:customer.id,project:newProject.id,activity:newActivity.id,description:'Device recording with seconds',tags:''};
            await action('start',{sessions:[session._id],destination,from:'now'});
            await new Promise(resolve=>setTimeout(resolve,2100));
            session.end=Date.now();
            let deviceState=await svc.device.state(user,session.nodeid);
            let allocation=deviceState.allocations.find(a=>a.origin==='manual');
            assert.equal(allocation.status,'review');
            await action('save',{id:allocation.id,revision:allocation.revision,row:destination,reviewed:true});
            deviceState=await svc.device.state(user,session.nodeid);
            allocation=deviceState.allocations.find(a=>a.id===allocation.id);
            assert.equal(allocation.status,'synced',allocation.error);
            created.push(...allocation.remoteIds);
            const remote=await c.request('GET','/timesheets/'+allocation.remoteIds[0]);
            assert.match(remote.description,/Device recording with seconds/);
            assert.ok(remote.tags.some(t=>(t.name||t)==='meshcentral'), JSON.stringify({tags:remote.tags, tagsFull:remote.tagsFull}));
            await action('exclude',{id:allocation.id,revision:allocation.revision,confirmed:true});
            created.splice(created.indexOf(allocation.remoteIds[0]),1);
            await assert.rejects(c.request('GET','/timesheets/'+allocation.remoteIds[0]),e=>e.status===404);

        } finally {
            for (const id of created) await c.request('DELETE', '/timesheets/' + id);
            for (const dest of createdDestinations.reverse()) await c.request('DELETE',dest);
            await c.request('DELETE', '/activities/' + activity.id);
            await c.request('DELETE', '/projects/' + project.id);
            await c.request('DELETE', '/customers/' + customer.id);
        }
    },
);
