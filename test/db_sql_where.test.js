"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildWhere, connConfig, toNum } = require('../db_sql.js');
const { normFilter } = require('../db.js').helpers;

const PG = { kind: 'pg', ph: i => '$' + i };
const SQLITE = { kind: 'sqlite', ph: () => '?' };
const MYSQL = { kind: 'mysql', ph: () => '?' };

test('overlap predicate and guest exclusion are always present', () => {
    const w = buildWhere(normFilter({ domain: 'd', start: 10, end: 20 }), PG);
    assert.equal(w.sql, 'domain = $1 AND start_ms < $2 AND (end_ms IS NULL OR end_ms > $3) AND guest IS NULL');
    assert.deepEqual(w.params, ['d', 20, 10]);
    const w2 = buildWhere(normFilter({ domain: 'd', start: 10, end: 20, includeGuests: true }), PG);
    assert.equal(w2.sql.indexOf('guest'), -1);
});

test('pg binds an id list as one array parameter', () => {
    const ids = []; for (let i = 0; i < 500; i++) ids.push('n' + i);
    const w = buildWhere(normFilter({ start: 0, end: 1, nodeids: ids, types: ['desktop', 'files'] }), PG);
    assert.ok(w.sql.includes('nodeid = ANY($4::text[])'));
    assert.ok(w.sql.includes('type = ANY($5::text[])'));
    assert.equal(w.params.length, 5);
    assert.deepEqual(w.params[3], ids);
});

test('sqlite binds an id list as one JSON parameter through json_each', () => {
    const ids = []; for (let i = 0; i < 500; i++) ids.push('n' + i);
    const w = buildWhere(normFilter({ start: 0, end: 1, nodeids: ids }), SQLITE);
    assert.ok(w.sql.includes('nodeid IN (SELECT value FROM json_each(?))'));
    assert.equal(w.params.length, 4);
    assert.deepEqual(JSON.parse(w.params[3]), ids);
});

test('mysql expands the list into placeholders', () => {
    const ids = []; for (let i = 0; i < 500; i++) ids.push('n' + i);
    const w = buildWhere(normFilter({ start: 0, end: 1, nodeids: ids }), MYSQL);
    assert.equal((w.sql.match(/\?/g) || []).length, 503);
    assert.equal(w.params.length, 503);
});

test('connConfig accepts a URL, a legacy string and an object', () => {
    assert.deepEqual(connConfig('postgres://u:p%40ss@db.local:5432/mesh'), { host: 'db.local', port: 5432, user: 'u', password: 'p@ss', database: 'mesh' });
    assert.equal(connConfig('mysql://user:pw@host:3306/').database, undefined);
    assert.deepEqual(connConfig({ host: 'h', user: 'u' }), { host: 'h', user: 'u' });
    assert.deepEqual(connConfig(null), {});
});

test('toNum handles strings, bigints and null', () => {
    assert.equal(toNum('42'), 42); assert.equal(toNum(7n), 7); assert.equal(toNum(null), null); assert.equal(toNum('x'), null);
});
