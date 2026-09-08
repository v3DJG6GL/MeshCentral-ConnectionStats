'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const create = require('../connectionstats').connectionstats;
const { Pairer } = require('../events');

function browser() {
    const plugin = create({ parent: {} }), sent = [], handlers = {};
    const body = { nodeType: 1, id: '', parentNode: null };
    const ctx = vm.createContext({ window: {}, document: { body, documentElement: {}, addEventListener: (name, fn) => { handlers[name] = fn; } },
        pluginHandler: { connectionstats: {} }, meshserver: { send: c => sent.push(c) }, setInterval() {},
        currentNode: { _id: 'node//wrong' }, terminalNode: { _id: 'node//term' }, filesNode: { _id: 'node//files' },
        terminal: { State: 3, urlname: 'meshrelay.ashx' }, files: { State: 3, urlname: 'meshrelay.ashx' },
        xterm: null, xxcurrentView: 12, xxdialogMode: 0 });
    for (const name of ['csKindOf', 'csActivitySession', 'csBeat', 'csObserve', 'csActivityInit'])
        ctx.pluginHandler.connectionstats[name] = vm.runInContext('(' + plugin[name].toString() + ')', ctx);
    ctx.pluginHandler.connectionstats.csActivityInit();
    return { ctx, sent, handlers, body, api: ctx.pluginHandler.connectionstats };
}

test('Terminal and Files use their connection node; reconnect does not inherit heartbeat throttling', () => {
    const b = browser();
    b.api.csObserve();
    assert.deepEqual(b.sent.map(c => [c.kind, c.nodeid]), [['terminal', 'node//term'], ['files', 'node//files']]);
    b.api.csBeat('terminal'); b.api.csBeat('terminal');
    assert.equal(b.sent.filter(c => c.pluginaction === 'beat').length, 1);
    b.ctx.terminal = { State: 3, nodeid: 'node//term' };
    b.api.csBeat('terminal');
    assert.equal(b.sent.filter(c => c.pluginaction === 'beat').length, 2);
    b.ctx.files.State = 0; b.api.csBeat('files');
    assert.equal(b.sent.filter(c => c.pluginaction === 'beat').length, 2);
});

test('legacy body keyboard and xterm paste reach activity, while dialogs and My Files do not', () => {
    const b = browser();
    b.handlers.keydown({ type: 'keydown', target: b.body });
    assert.equal(b.sent[0].kind, 'terminal');
    b.ctx.terminal = { State: 3, nodeid: 'node//term' }; b.ctx.xxdialogMode = 2;
    b.handlers.keydown({ type: 'keydown', target: b.body });
    assert.equal(b.sent.length, 1);
    b.ctx.xxdialogMode = 0;
    b.handlers.paste({ type: 'paste', target: { nodeType: 1, id: '', classList: { contains: c => c === 'xterm' } } });
    assert.equal(b.sent.length, 2);
    b.handlers.drop({ type: 'drop', target: { nodeType: 1, id: 'p13filetable' } });
    assert.equal(b.sent[2].kind, 'files');
    b.handlers.mousedown({ type: 'mousedown', target: { nodeType: 1, id: 'p5filetable' } });
    assert.equal(b.sent.length, 3);
});

test('SSH/SFTP heartbeats match their webapp protocols without crossing users or another webapp', () => {
    const b = browser(), plugin = create({ parent: {} });
    plugin.settings = plugin.defaultSettings(); plugin.pairer = new Pairer();
    const user = { _id: 'user//one' };
    for (const [id, protocol, userid] of [['ssh', 202, user._id], ['sftp', 203, user._id], ['rdp', 201, user._id], ['foreign', 202, 'user//two']])
        plugin.pairer.open[id] = { _id: 's_' + id, userid, nodeid: 'node//same', type: 'webapp', protocol, start: 1 };
    b.ctx.terminal = { State: 3, nodeid: 'node//same', urlname: 'sshterminalrelay.ashx' };
    b.ctx.files = { State: 3, nodeid: 'node//same', urlname: 'sshfilesrelay.ashx' };
    b.api.csBeat('terminal'); b.api.csBeat('files');
    b.sent.forEach(c => plugin.serveraction(c, { user }));
    assert.equal(plugin.tracker.has('s_ssh'), true); assert.equal(plugin.tracker.has('s_sftp'), true);
    assert.equal(plugin.tracker.has('s_rdp'), false); assert.equal(plugin.tracker.has('s_foreign'), false);
    assert.deepEqual(b.sent.map(c => c.protocol), [202, 203]);
});


test('active time continues through the idle window across flushes without more input', async t => {
    const plugin = create({ parent: {} }), updates = [];
    plugin.pairer = new Pairer();
    plugin.pairer.open.one = { _id: 's_one', start: 1000, active: null };
    plugin.db = { updateSession: async (sid, patch) => { updates.push(patch.active); } };
    plugin.tracker.beat('s_one', 1000);
    let now = 61000;
    t.mock.method(Date, 'now', () => now);
    await plugin.flushActivity();
    now = 121000; await plugin.flushActivity();
    now = 400000; await plugin.flushActivity();
    now = 500000; await plugin.flushActivity();
    assert.deepEqual(updates, [60, 120, 300]);
    await Promise.resolve();
});

test('disconnect intervals are written after an older pending activity flush', async t => {
    const plugin=create({parent:{}}), writes=[];
    plugin.pairer=new Pairer();
    const doc={_id:'s_one',start:1000,end:null,type:'desktop',active:null,nodename:'Device'};
    plugin.pairer.open.one=doc;
    plugin.tracker.beat(doc._id,1000);
    let now=11000, release;
    t.mock.method(Date,'now',()=>now);
    plugin.db={updateSession:async (id,patch)=>{await new Promise(resolve=>{release=resolve;}); writes.push({kind:'flush',active:patch.active});},upsertSession:async d=>{writes.push({kind:'end',active:d.active,intervals:d.activeIntervals});}};
    plugin.settings={recordTypes:['desktop'],minSeconds:0};
    plugin.events.classify=()=>({kind:'end'});
    plugin.pairer.onEnd=()=>{delete plugin.pairer.open.one;return {...doc,end:21000,seconds:20};};
    const pending=plugin.flushActivity();
    await new Promise(resolve=>setImmediate(resolve));
    now=21000;
    plugin.HandleEvent(null,{});
    assert.equal(writes.length,0);
    release(); await pending; await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(writes,[{kind:'flush',active:10},{kind:'end',active:20,intervals:[[1000,21000]]}]);
});
