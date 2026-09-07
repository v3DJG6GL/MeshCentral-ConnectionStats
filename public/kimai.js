/* Personal Kimai settings and reviewed exports. */
(function () {
    'use strict';
    var boot = window.CS_BOOT || {};
    if (boot.view !== 'kimai') return;
    var root = document.getElementById('cs-root'),
        api = 'pluginadmin.ashx?pin=connectionstats',
        state,
        meta,
        preview,
        message = '',
        busy = false,
        range = null;
    var lists = { customers: [], projects: [], activities: [] };
    function esc(v) {
        return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function request(url, options) {
        return fetch(url, Object.assign({ credentials: 'same-origin' }, options)).then(function (r) {
            return r.json().then(function (j) {
                if (!r.ok || j.error) throw Error(j.error || 'Request failed');
                return j;
            });
        });
    }
    function post(data) {
        return request(api, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                action: 'kimai',
                csrf: state.csrf,
                data: JSON.stringify(data),
            }).toString(),
        });
    }
    function input(name, value, type) {
        return (
            '<input name="' +
            name +
            '" aria-label="' +
            name +
            '" type="' +
            (type || 'text') +
            '" value="' +
            esc(value) +
            '"' +
            (type === 'datetime-local' ? ' step="1"' : '') +
            '>'
        );
    }
    function select(name, rows, value, empty) {
        return (
            '<select aria-label="' +
            name +
            '" name="' +
            name +
            '">' +
            (value &&
            !rows.some(function (r) {
                return String(r.id == null ? r._id : r.id) === String(value);
            })
                ? '<option selected value="' +
                  esc(value) +
                  '">Unavailable destination #' +
                  esc(value) +
                  '</option>'
                : '') +
            (empty != null ? '<option value="">' + esc(empty) + '</option>' : '') +
            rows
                .map(function (r) {
                    var id = r.id == null ? r._id : r.id;
                    return (
                        '<option value="' +
                        esc(id) +
                        '"' +
                        (String(id) === String(value) ? ' selected' : '') +
                        '>' +
                        esc(r.name || r.username || id) +
                        '</option>'
                    );
                })
                .join('') +
            '</select>'
        );
    }
    function types() {
        return [
            'desktop',
            'terminal',
            'files',
            'webapp',
            'messenger',
            'amt',
            'tunnel',
            'plugin',
            'registry',
            'other',
        ].map(function (s) {
            return { id: s, name: s };
        });
    }
    function local(ms) {
        var parts = new Intl.DateTimeFormat('sv-SE', {
            timeZone: state.timezone || 'UTC',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hourCycle: 'h23',
        }).format(new Date(ms));
        return parts.replace(' ', 'T');
    }
    // Submit wall-clock edits; conversion and DST validation happen on the server.
    function rule(r, i) {
        return (
            '<fieldset class="km-rule" data-rule="' +
            i +
            '"><legend>Rule ' +
            (i + 1) +
            '</legend><div class="km-fields">' +
            '<label>Group' +
            select('group', meta.groups || [], r.group, 'Any group') +
            '</label><label>Device' +
            select('device', meta.devices || [], r.device, 'Any device') +
            '</label><label>Connection type' +
            select('type', types(), r.type, 'Any type') +
            '</label>' +
            '<label>Customer' +
            select('customer', lists.customers, r.customer, 'Select customer') +
            '</label><label>Project' +
            select('project', lists.projects, r.project, 'Select project') +
            '</label><label>Activity' +
            select('activity', lists.activities, r.activity, 'Select activity') +
            '</label>' +
            '<label>Duration' +
            select(
                'basis',
                [
                    { id: 'connected', name: 'Connected time' },
                    { id: 'active', name: 'Active time (after disconnect)' },
                ],
                r.basis,
            ) +
            '</label><label>Billing' +
            select(
                'billable',
                [
                    { id: 'true', name: 'Billable' },
                    { id: 'false', name: 'Non-billable' },
                ],
                r.billable !== false ? 'true' : 'false',
            ) +
            '</label><label>Open review after disconnect' +
            select(
                'prompt',
                [
                    { id: 'inherit', name: 'Use personal default' },
                    { id: 'always', name: 'Always' },
                    { id: 'issues', name: 'Only when attention is needed' },
                    { id: 'never', name: 'Never automatically' },
                ],
                r.prompt || 'inherit',
            ) +
            '</label><label>Minimum session length (seconds)' +
            '<input name="minSeconds" type="number" min="0" max="86400" step="1" placeholder="Use personal default" value="' +
            esc(r.minSeconds == null ? '' : r.minSeconds) +
            '">' +
            '</label><label>Description' +
            input('description', r.description) +
            '</label><label>Tags' +
            input('tags', r.tags) +
            '</label></div><button type="button" data-move="' +
            i +
            '" data-direction="-1">Move up</button> <button type="button" data-move="' +
            i +
            '" data-direction="1">Move down</button> <button type="button" data-remove="' +
            i +
            '">Remove</button></fieldset>'
        );
    }
    function render() {
        var h =
            '<div class="cs-bar"><b>Kimai</b><a class="cs-btn" href="' +
            api +
            '">Back to dashboard</a><button data-refresh>Refresh status</button><button data-device-inbox>Review inbox</button></div><p role="status">' +
            esc(message || (state && state.automationError) || '') +
            '</p>';
        if (!state || !meta) {
            root.innerHTML = h + '<p>Loading…</p>';
            return;
        }
        if (boot.isAdmin)
            h +=
                '<form data-form="server" class="km-panel"><label>Kimai server URL ' +
                input('url', state.url, 'url') +
                '</label> <button>Save server</button></form>';
        h +=
            '<form data-form="connect" class="km-panel"><h2>My connection</h2><p>' +
            esc(state.url || 'A site administrator must configure the Kimai server URL.') +
            '</p><p>' +
            (state.connected
                ? 'Connected as ' + esc(state.account.username) + ' · ' + esc(state.timezone)
                : 'Not connected') +
            '</p><label>Personal API token <input type="password" name="token" autocomplete="new-password" required></label> <button>Test and save token</button>' +
            (state.connected ? ' <button type="button" data-disconnect>Disconnect</button>' : '') +
            '</form>';
        var prefs = state.recordingPreferences || {};
        h +=
            '<form data-form="recording-preferences" class="km-panel"><h2>Recording preferences</h2><p>Personal defaults for all devices. Each mapping rule can override when review opens and the minimum session length.</p><div class="km-fields"><label>Open review after disconnect';
        h +=
            select(
                'prompt',
                [
                    { id: 'always', name: 'Always' },
                    { id: 'issues', name: 'Only when attention is needed' },
                    { id: 'never', name: 'Never automatically' },
                ],
                prefs.prompt || 'always',
            ) +
            '</label><label>Review presentation' +
            select(
                'presentation',
                [
                    { id: 'drawer', name: 'Side panel' },
                    { id: 'dialog', name: 'Centered panel' },
                ],
                prefs.presentation || 'drawer',
            ) +
            '</label><label>Minimum session length (seconds)<input name="minSeconds" type="number" min="0" max="86400" step="1" required value="' +
            esc(prefs.minSeconds || 0) +
            '"></label></div><p>Shorter sessions are excluded from Kimai review and automatic export; ConnectionStats keeps the original statistics. Zero disables the minimum. Manually started timers are kept for your decision.</p><button>Save recording preferences</button></form>';
        if (state.connected) {
            h +=
                '<form data-form="settings" class="km-panel"><h2>Mapping rules</h2><p>First matching rule wins. Unmatched and guest sessions are not sent. Description placeholders: {device}, {group}, {types}, {admin}, {date}, {sessions}.</p>' +
                state.rules.map(rule).join('') +
                '<button type="button" data-add>Add rule</button><p><label><input name="live" type="checkbox"' +
                (state.live ? ' checked' : '') +
                '> Automatically start live timers for connected-time rules</label></p><p><label><input name="nightly" type="checkbox"' +
                (state.nightly ? ' checked' : '') +
                '> Nightly sync at 02:00 (' +
                esc(state.timezone) +
                ')</label></p><button>Save rules and automation</button></form>';
            var q = new URLSearchParams(location.hash.slice(1)),
                start = Number(q.get('start')) || Date.now() - 86400000,
                end = Number(q.get('end')) || Date.now();
            h +=
                '<form data-form="preview" class="km-panel"><h2>Send to Kimai</h2><p>Only your permitted sessions are included. Times below use ' +
                esc(state.timezone) +
                '. Sessions crossing the selected range are included in full and split at midnight.</p><label>From ' +
                input('start', range ? range.start : local(start), 'datetime-local') +
                '</label> <label>To ' +
                input('end', range ? range.end : local(end), 'datetime-local') +
                '</label> <button>Create preview</button></form>';
            if (preview)
                h +=
                    '<form data-form="send" class="km-panel"><h2>Review entries</h2><p>Active-time entries use start + measured duration. Check “Reviewed” after resolving flagged timing. Uncheck rows to exclude them.</p><div class="km-table"><table><thead><tr><th>Send</th><th>Begin / end</th><th>Project / activity</th><th>Description</th><th>Duration / status</th></tr></thead><tbody>' +
                    preview.rows
                        .map(function (b, i) {
                            return (
                                '<tr data-row="' +
                                i +
                                '"><td><input name="include" type="checkbox"' +
                                ((
                                    b.include == null
                                        ? !b.issue && !['synced', 'kept', 'running'].includes(b.status)
                                        : b.include
                                )
                                    ? ' checked'
                                    : '') +
                                ' aria-label="Include row"></td><td>' +
                                input('begin', b.beginLocal || local(b.begin), 'datetime-local') +
                                input('end', b.endLocal || local(b.end), 'datetime-local') +
                                '</td><td>' +
                                select('project', lists.projects, b.project) +
                                select('activity', lists.activities, b.activity) +
                                '</td><td>' +
                                input('description', b.description) +
                                '</td><td>' +
                                esc(
                                    window.CS_FORMAT_DURATION(b.seconds) +
                                        ' · ' +
                                        b.basis +
                                        ' · ' +
                                        (b.status || 'new'),
                                ) +
                                (b.issue
                                    ? '<p>' +
                                      esc(b.issue) +
                                      '</p><label><input type="checkbox" name="reviewed"' +
                                      (b.reviewed ? ' checked' : '') +
                                      '>Reviewed</label>'
                                    : '') +
                                '</td></tr>'
                            );
                        })
                        .join('') +
                    '</tbody></table></div><button>Send selected entries</button></form>';
        }
        h +=
            '<section class="km-panel"><h2>Sync history</h2>' +
            (state.history.length
                ? '<div class="km-table"><table><thead><tr><th>Time</th><th>Status</th><th>Details</th><th>Resolution</th></tr></thead><tbody>' +
                  state.history
                      .map(function (l) {
                          return (
                              '<tr><td>' +
                              esc(local(l.begin)) +
                              '<br>' +
                              esc(l.end ? local(l.end) : 'Running / end unknown') +
                              '</td><td>' +
                              esc(l.status) +
                              (l.remoteId ? ' · #' + esc(l.remoteId) : '') +
                              '</td><td>' +
                              esc(l.error || l.warning || l.description) +
                              (l.remoteSeconds != null
                                  ? '<br>Kimai: ' + esc(l.remoteSeconds) + ' seconds'
                                  : '') +
                              '</td><td>' +
                              (['conflict', 'error', 'creating'].includes(l.status)
                                  ? (l.remoteId
                                        ? '<button data-resolve="' +
                                          esc(l.id) +
                                          '" data-choice="keep">Keep Kimai version</button> '
                                        : '') +
                                    '<button data-review="' +
                                    esc(l.id) +
                                    '">Review replacement</button>'
                                  : '') +
                              '</td></tr>'
                          );
                      })
                      .join('') +
                  '</tbody></table></div>'
                : '<p>No entries synchronized yet.</p>') +
            '</section>';
        root.innerHTML = h;
        root.querySelectorAll('button').forEach(function (b) {
            b.disabled = busy;
        });
    }
    async function reload() {
        state = await request(api + '&api=kimai');
        meta = await request(api + '&api=meta');
        if (state.connected) {
            var values = await Promise.all(
                ['customers', 'projects', 'activities'].map(function (kind) {
                    return request(api + '&api=kimai-destinations&kind=' + kind);
                }),
            );
            ['customers', 'projects', 'activities'].forEach(function (k, i) {
                lists[k] = values[i];
            });
        }
        render();
    }
    function captureRules() {
        var form = root.querySelector('[data-form=settings]');
        if (!form) return;
        state.rules = Array.from(form.querySelectorAll('[data-rule]')).map(function (el) {
            var r = { id: state.rules[Number(el.dataset.rule)].id };
            el.querySelectorAll('[name]').forEach(function (x) {
                r[x.name] = x.name === 'billable' ? x.value === 'true' : x.value;
            });
            return r;
        });
        state.live = form.elements.live.checked;
        state.nightly = form.elements.nightly.checked;
    }
    async function run(fn) {
        if (busy) return;
        busy = true;
        root.querySelectorAll('button').forEach(function (b) {
            b.disabled = true;
        });
        try {
            await fn();
            message = 'Saved / completed. Check entry status below.';
            await reload();
        } catch (e) {
            message = e.message;
        } finally {
            busy = false;
            render();
        }
    }
    root.addEventListener('submit', function (ev) {
        var f = ev.target;
        if (!f.dataset.form) return;
        ev.preventDefault();
        var fd = new FormData(f),
            op = f.dataset.form;
        run(async function () {
            if (op === 'server') await post({ op: op, url: fd.get('url') });
            if (op === 'connect') {
                var token = fd.get('token');
                f.elements.token.value = '';
                await post({ op: op, token: token });
            }
            if (op === 'recording-preferences') {
                await post({
                    op: 'device',
                    command: 'preferences',
                    requestId: crypto.randomUUID(),
                    prompt: fd.get('prompt'),
                    presentation: fd.get('presentation'),
                    minSeconds: Number(fd.get('minSeconds')),
                });
            }
            if (op === 'settings') {
                captureRules();
                await post({ op: op, rules: state.rules, live: state.live, nightly: state.nightly });
            }
            if (op === 'preview') {
                var q = Object.fromEntries(new URLSearchParams(location.hash.slice(1)));
                range = { start: fd.get('start'), end: fd.get('end') };
                q.startLocal = fd.get('start');
                q.endLocal = fd.get('end');
                preview = await post({ op: op, query: q });
            }
            if (op === 'send') {
                var rows = Array.from(f.querySelectorAll('[data-row]'))
                    .filter(function (r) {
                        return r.querySelector('[name=include]').checked;
                    })
                    .map(function (r) {
                        var b = { id: preview.rows[Number(r.dataset.row)].id };
                        r.querySelectorAll('[name]').forEach(function (x) {
                            if (x.name === 'begin' || x.name === 'end') b[x.name + 'Local'] = x.value;
                            else b[x.name] = x.type === 'checkbox' ? x.checked : x.value;
                        });
                        return b;
                    });
                if (preview.resolve) {
                    if (rows.length !== 1) throw Error('Select the replacement row');
                    await post({
                        op: 'resolve',
                        id: preview.resolve,
                        choice: preview.choice || 'replace',
                        row: rows[0],
                    });
                } else await post({ op: op, preview: preview.id, rows: rows });
                preview = null;
            }
        });
    });
    root.addEventListener('click', function (ev) {
        var b = ev.target.closest('button');
        if (!b || busy) return;
        if (b.hasAttribute('data-device-inbox')) {
            var deviceAction = 'openInbox';
            try {
                if (window.parent.CSDevice) {
                    window.parent.CSDevice[deviceAction]();
                    return;
                }
            } catch (_) {}
            if (window.CSDevice) {
                window.CSDevice[deviceAction]();
                return;
            }
            var css = document.createElement('link');
            css.rel = 'stylesheet';
            css.href = api + '&file=kimai-device.css&v=' + encodeURIComponent(boot.version);
            document.head.appendChild(css);
            var script = document.createElement('script');
            script.src = api + '&file=kimai-device.js&v=' + encodeURIComponent(boot.version);
            script.onload = function () {
                window.CSDevice[deviceAction]();
            };
            document.head.appendChild(script);
            return;
        }
        if (b.hasAttribute('data-add')) {
            captureRules();
            state.rules.push({ basis: 'connected', description: '{device}: {types} ({sessions} sessions)' });
            render();
        }
        if (b.hasAttribute('data-remove')) {
            captureRules();
            state.rules.splice(+b.dataset.remove, 1);
            render();
        }
        if (b.hasAttribute('data-move')) {
            captureRules();
            var i = +b.dataset.move,
                j = i + Number(b.dataset.direction);
            if (j >= 0 && j < state.rules.length) {
                var r = state.rules.splice(i, 1)[0];
                state.rules.splice(j, 0, r);
            }
            render();
        }
        if (b.hasAttribute('data-refresh')) run(reload);
        if (b.hasAttribute('data-disconnect'))
            run(function () {
                return post({ op: 'disconnect' });
            });
        if (b.hasAttribute('data-resolve'))
            run(function () {
                return post({ op: 'resolve', id: b.dataset.resolve, choice: b.dataset.choice });
            });
        if (b.hasAttribute('data-review')) {
            var l = state.history.find(function (l) {
                return l.id === b.dataset.review;
            });
            preview = {
                resolve: l.id,
                choice: l.remoteId && !/not found|404/.test(l.error || '') ? 'replace' : 'retry',
                rows: [
                    Object.assign({}, l, {
                        end: l.end || Date.now(),
                        seconds: l.end ? (l.end - l.begin) / 1000 : 0,
                        issue: l.remoteId
                            ? 'Review the replacement times and destination'
                            : 'Check Kimai for an existing entry before retrying. Mark Reviewed only after confirming no entry exists.',
                    }),
                ],
            };
            render();
        }
    });
    root.addEventListener('input', function (ev) {
        var row = ev.target.closest('[data-row]');
        if (!preview || !row) return;
        var b = preview.rows[Number(row.dataset.row)],
            x = ev.target,
            name = x.name;
        if (name === 'begin' || name === 'end') b[name + 'Local'] = x.value;
        else b[name] = x.type === 'checkbox' ? x.checked : x.value;
    });
    root.addEventListener('change', function (ev) {
        var target = ev.target,
            row = target.closest('[data-rule], [data-row]');
        if (!row || !['customer', 'project'].includes(target.name)) return;
        var kind = target.name === 'customer' ? 'projects' : 'activities',
            field = target.name === 'customer' ? 'project' : 'activity';
        request(api + '&api=kimai-destinations&kind=' + kind + '&parent=' + encodeURIComponent(target.value))
            .then(function (rows) {
                row.querySelector('[name=' + field + ']').outerHTML = select(
                    field,
                    rows,
                    '',
                    'Select ' + field,
                );
                if (field === 'project')
                    row.querySelector('[name=activity]').outerHTML = select(
                        'activity',
                        [],
                        '',
                        'Select activity',
                    );
            })
            .catch(function (e) {
                message = e.message;
                render();
            });
    });
    reload().catch(function (e) {
        message = e.message;
        render();
    });
})();
