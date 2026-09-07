'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function harness() {
    const button = { textContent: 'Save preferences', isConnected: true },
        statuses = [];
    const host = { querySelector: () => statuses[0], append: (s) => statuses.push(s) };
    const root = {
        innerHTML: 'existing form values',
        querySelector: () => host,
        querySelectorAll: () => [button],
        setAttribute() {},
        addEventListener() {},
    };
    const context = {
        window: { CS_BOOT: { view: 'kimai' } },
        document: { getElementById: () => root, createElement: () => ({ dataset: {}, setAttribute() {} }) },
        URLSearchParams,
        Object,
        Array,
        Promise,
    };
    let code = fs.readFileSync(path.join(__dirname, '../public/kimai.js'), 'utf8');
    code =
        code.slice(0, code.lastIndexOf('    reload().catch')) +
        '    window.testApi={captureRules,getState:function(){return state;},historyRows,historyCategory,clockDuration,setHistory:function(s, data, filter){state=s;lists=data;historyFilter=filter;},run,setReload:function(fn){reload=fn;}};})();';
    vm.runInNewContext(code, context);
    context.window.testApi.setReload(async () => {});
    return { api: context.window.testApi, button, statuses, root };
}
test('settings show pending and success feedback beside the submitted form', async () => {
    const h = harness();
    let finish;
    const pending = new Promise((resolve) => {
        finish = resolve;
    });
    const run = h.api.run(() => pending, {
        form: 'recording-preferences',
        button: h.button,
        pending: 'Saving…',
        success: 'Recording preferences saved.',
    });
    assert.equal(h.button.textContent, 'Saving…');
    assert.equal(h.button.disabled, true);
    assert.equal(h.statuses[0].textContent, 'Saving…');
    finish();
    await run;
    assert.equal(h.statuses[0].textContent, 'Recording preferences saved.');
    assert.match(h.statuses[0].className, /success/);
    assert.equal(h.button.textContent, 'Save preferences');
    assert.equal(h.button.disabled, false);
});
test('failed save retains form contents and displays actionable error', async () => {
    const h = harness();
    await h.api.run(
        async () => {
            throw Error('Connection timed out');
        },
        { form: 'settings', button: h.button },
    );
    assert.equal(h.root.innerHTML, 'existing form values');
    assert.equal(h.statuses[0].textContent, 'Connection timed out');
    assert.match(h.statuses[0].className, /error/);
    assert.equal(h.button.disabled, false);
});

test('history keeps durations comparable, escapes content and distinguishes discarded errors', () => {
    const h = harness();
    const entry = {
        id: 'x',
        status: 'synced',
        begin: Date.UTC(2026, 8, 8, 8, 0, 0),
        end: Date.UTC(2026, 8, 8, 8, 0, 17),
        remoteSeconds: 60,
        remoteId: 11,
        project: 1,
        activity: 2,
        description: '<script>bad</script>',
        warning: 'Kimai changed the duration (rounding)',
    };
    const lists = { projects: [{ id: 1, name: 'Support' }], activities: [{ id: 2, name: 'Remote work' }] };
    h.api.setHistory({ timezone: 'UTC', history: [entry] }, lists, 'all');
    const html = h.api.historyRows();
    assert.match(html, /08:00:00 → 08:00:17/);
    assert.match(html, /0:00:17/);
    assert.match(html, /0:01:00/);
    assert.match(html, /\+0:00:43/);
    assert.match(html, /Support/);
    assert.doesNotMatch(html, /<script>/);
    h.api.setHistory(
        { timezone: 'UTC', history: [{ ...entry, status: 'excluded', error: 'Old overlap' }] },
        lists,
        'attention',
    );
    assert.match(h.api.historyRows(), /No recordings/);
    h.api.setHistory(
        { timezone: 'UTC', history: [{ ...entry, status: 'conflict', error: 'Overlap' }] },
        lists,
        'attention',
    );
    assert.match(h.api.historyRows(), /Review issue & actions/);
    assert.match(h.api.historyRows(), /data-review="x"/);
    assert.equal(h.api.historyCategory({ status: 'kept' }), 'synced');
});

test('rule editor captures checked connection types and preserves an empty wildcard selection', () => {
    const h = harness();
    h.api.setHistory({ rules: [{ id: 'r' }] }, {}, 'all');
    const controls = [
        { name: 'types', value: 'desktop', checked: true },
        { name: 'types', value: 'terminal', checked: true },
        { name: 'types', value: 'files', checked: false },
        { name: 'billable', value: 'false' },
    ];
    const row = { dataset: { rule: '0' }, querySelectorAll: () => controls };
    h.root.querySelector = () => ({
        querySelectorAll: () => [row],
        elements: { live: { checked: false }, nightly: { checked: false } },
    });
    h.api.captureRules();
    assert.deepEqual(Array.from(h.api.getState().rules[0].types), ['desktop', 'terminal']);
    assert.equal(h.api.getState().rules[0].billable, false);
    controls.forEach((x) => (x.checked = false));
    h.api.captureRules();
    assert.deepEqual(Array.from(h.api.getState().rules[0].types), []);
});
