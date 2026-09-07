"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { unionActive, Tracker } = require('../activity.js');

const T = 1_700_000_000_000;

test('no beats is zero, one beat is one idle window', () => {
    assert.equal(unionActive([], 300, T, T + 3600000), 0);
    assert.equal(unionActive([T + 1000], 300, T, T + 3600000), 300);
});

test('overlapping windows merge, gaps do not', () => {
    // beats at 0s, 60s, 120s with a 5 min window -> one window of 7 min
    assert.equal(unionActive([T, T + 60000, T + 120000], 300, T, T + 3600000), 420);
    // beats at 0s and 20 min -> two separate 5 min windows
    assert.equal(unionActive([T, T + 1200000], 300, T, T + 3600000), 600);
});

test('windows are clipped to the session and beats outside are ignored', () => {
    assert.equal(unionActive([T + 3500000], 300, T, T + 3600000), 100);
    assert.equal(unionActive([T - 100000, T + 5000000], 300, T, T + 3600000), 0);
    assert.equal(unionActive([T + 10000], 300, T, null), 300); // open session, now is far later
});

test('five minutes of typing in a 25 minute session is about five minutes active', () => {
    const beats = []; for (let s = 0; s < 300; s += 30) beats.push(T + s * 1000);
    assert.equal(unionActive(beats, 60, T, T + 1500000), 330); // 300 s of beats plus one trailing 60 s window, minus overlap
});

test('tracker throttles bursts, tracks dirty ids and forgets', () => {
    const tr = new Tracker(300);
    tr.beat('s1', T); tr.beat('s1', T + 200); tr.beat('s1', T + 2000);
    assert.equal(tr.beats.s1.length, 2);
    assert.equal(tr.lastBeat('s1'), T + 2000);
    assert.deepEqual(tr.takeDirty(), ['s1']);
    assert.deepEqual(tr.takeDirty(), []);
    assert.equal(tr.activeFor('s1', T, T + 3600000), 302);
    tr.forget('s1');
    assert.equal(tr.has('s1'), false);
});
