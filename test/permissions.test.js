"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { Permissions } = require('../permissions.js');

function server() {
    const nodes = [
        { _id: 'node//a', meshid: 'mesh//g1' }, { _id: 'node//b', meshid: 'mesh//g1' },
        { _id: 'node//c', meshid: 'mesh//g2' }, { _id: 'node//d', meshid: 'mesh//g3' }
    ];
    return {
        webserver: {
            meshes: { 'mesh//g1': { _id: 'mesh//g1' }, 'mesh//g2': { _id: 'mesh//g2' }, 'mesh//g3': { _id: 'mesh//g3' } },
            GetAllMeshWithRights: function (user) { return Object.keys(user.links || {}).filter(k => k.indexOf('mesh/') == 0).map(k => ({ _id: k })); }
        },
        db: { GetAllTypeNoTypeField: function (type, domain, cb) { cb(null, nodes); } }
    };
}

const admin = { _id: 'user//admin', domain: '', siteadmin: 0xFFFFFFFF };
const tech = { _id: 'user//tech', domain: '', siteadmin: 0, links: { 'mesh//g1': { rights: 8 }, 'node//d': { rights: 8 } } };
const lead = { _id: 'user//lead', domain: '', siteadmin: 2, links: { 'mesh//g2': { rights: 8 } } };

test('site admin sees everything and may filter by any user', async () => {
    const p = new Permissions(server());
    const f = await p.filterFor(admin, { scope: 'all', start: 1, end: 2, userids: ['user//x'] });
    assert.equal(f.nodeids, undefined); assert.equal(f.meshids, undefined); assert.deepEqual(f.userids, ['user//x']);
});

test('a plain user sees group nodes plus direct nodes, and only own sessions', async () => {
    const p = new Permissions(server());
    const f = await p.filterFor(tech, { scope: 'all', start: 1, end: 2, userids: ['user//admin'] });
    assert.deepEqual(f.nodeids.sort(), ['node//a', 'node//b', 'node//d']);
    assert.deepEqual(f.userids, ['user//tech']);
    assert.equal(await p.filterFor(tech, { scope: 'mesh:mesh//g2', start: 1, end: 2 }), null);
    assert.equal(await p.filterFor(tech, { scope: 'node:node//c', start: 1, end: 2 }), null);
    assert.deepEqual((await p.filterFor(tech, { scope: 'node:node//d', start: 1, end: 2 })).nodeids, ['node//d']);
    assert.deepEqual((await p.filterFor(tech, { scope: 'mesh:mesh//g1', start: 1, end: 2 })).meshids, ['mesh//g1']);
});

test('manage-users right unlocks other admins sessions but not other groups', async () => {
    const p = new Permissions(server());
    const f = await p.filterFor(lead, { scope: 'all', start: 1, end: 2, userids: ['user//tech'] });
    assert.deepEqual(f.nodeids, ['node//c']);
    assert.deepEqual(f.userids, ['user//tech']);
    const g = await p.filterFor(lead, { scope: 'all', start: 1, end: 2 });
    assert.equal(g.userids, undefined);
});

test('a user without any device gets an empty scope, not everything', async () => {
    const p = new Permissions(server());
    const f = await p.filterFor({ _id: 'user//nobody', domain: '', siteadmin: 0 }, { scope: 'all', start: 1, end: 2 });
    assert.deepEqual(f.nodeids, ['none']);
});
