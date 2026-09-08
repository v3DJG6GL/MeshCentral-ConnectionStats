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

test('persistable intervals merge activity across sessions without filling idle gaps', () => {
    const { intervals, seconds } = require('../activity');
    const a = new Tracker(10), b = new Tracker(10);
    a.beat('a',T); a.beat('a',T+20000);
    b.beat('b',T+5000);
    const merged = intervals([...a.intervalsFor('a',T,T+40000),...b.intervalsFor('b',T,T+40000)]);
    assert.deepEqual(merged,[[T,T+15000],[T+20000,T+30000]]);
    assert.equal(seconds(merged),25);
    assert.equal(intervals(null),null);
    assert.deepEqual(intervals([]),[]);
    assert.equal(intervals([[T,'bad']]),null);
    a.idleSeconds=60;
    assert.deepEqual(a.intervalsFor('a',T,T+40000),[[T,T+10000],[T+20000,T+30000]],'changed idle setting does not rewrite old activity');
});
