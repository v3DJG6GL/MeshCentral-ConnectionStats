"use strict";
// Round trip through the NeDB backend. Needs @seald-io/nedb resolvable from the plugin folder
// (npm install brings it in as a devDependency); skipped otherwise.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { storeSuite } = require('./store_suite.js');

let nedbAvailable = true;
try { require('@seald-io/nedb'); } catch (e) { nedbAvailable = false; }

function fakeServer(dir) {
    return {
        args: {},
        db: { databaseType: 1 },
        pluginHandler: {},
        getConfigFilePath: function (f) { return path.join(dir, f); }
    };
}


test('nedb backend round trip', { skip: !nedbAvailable && 'nedb not resolvable' }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-nedb-'));
    process.env.CONNECTIONSTATS_STORAGE = 'nedb';
    const db = require('../db.js').CreateDB(fakeServer(dir));
    try {
        await storeSuite(db, 'nedb');
    } finally {
        db.close();
        delete process.env.CONNECTIONSTATS_STORAGE;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
