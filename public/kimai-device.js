/* Personal device timer controls. Accounting and permissions remain server-side. */
(function () {
    'use strict';
    if (window.CSDevice) {
        window.CSDevice.refresh();
        return;
    }
    var base = typeof domainUrl === 'string' ? domainUrl : location.pathname.replace(/[^/]*$/, ''),
        api = base + 'pluginadmin.ashx?pin=connectionstats';
    var state,
        node = '',
        refreshing = false,
        active,
        panel,
        dialog,
        draftTimer,
        serial = Promise.resolve(),
        busy = 0;
    var draftUnsaved = false;
    var formGeneration = 0,
        lists = {},
        presented = new Set(),
        dismissed = new Set();
    var types = { desktop: 'Desktop', terminal: 'Terminal', files: 'Files' };
    function esc(v) {
        return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function duration(s) {
        s = Math.max(0, Math.floor(Number(s) || 0));
        return (
            Math.floor(s / 3600) +
            ':' +
            String(Math.floor(s / 60) % 60).padStart(2, '0') +
            ':' +
            String(s % 60).padStart(2, '0')
        );
    }
    function local(ms) {
        if (!ms) return '';
        return new Intl.DateTimeFormat('sv-SE', {
            timeZone: state.timezone || 'UTC',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hourCycle: 'h23',
        })
            .format(new Date(ms))
            .replace(' ', 'T');
    }
    function currentNodeId() {
        return typeof currentNode !== 'undefined' && currentNode ? currentNode._id : '';
    }
    function ongoing(a) {
        return a && a.end == null && !['excluded', 'synced', 'kept', 'locked'].includes(a.status);
    }
    function all() {
        return (state.allocations || []).concat(state.reviews || []);
    }
    function latest(id) {
        return all().find(function (a) {
            return a.id === id;
        });
    }
    function title(a) {
        if (!a) return 'Not recording';
        if (a.status === 'recording-local') return 'Recording locally · send after review';
        if (['running', 'recording'].includes(a.status)) return 'Recording in Kimai';
        if (a.status === 'excluded') return 'Excluded from Kimai';
        if (a.error) return 'Needs attention';
        return a.review ? 'Awaiting review' : String(a.status || 'Recorded').replace(/-/g, ' ');
    }
    async function request(url, options) {
        var r = await fetch(url, Object.assign({ credentials: 'same-origin' }, options)),
            j;
        try {
            j = await r.json();
        } catch (_) {
            throw Error('The server returned an unreadable response. Refresh and try again.');
        }
        if (!r.ok || j.error) throw Error(j.error || 'Request failed (' + r.status + ')');
        return j;
    }
    function message(text, error) {
        if (!panel) return;
        var el = panel.querySelector('.cs-kd-message');
        if (el) {
            el.textContent = text;
            el.classList.toggle('cs-kd-error', !!error);
        }
    }
    function post(command, data) {
        busy++;
        setBusy();
        var work = serial
            .catch(function () {})
            .then(async function () {
                var payload = Object.assign(
                    { op: 'device', command: command, requestId: crypto.randomUUID() },
                    data || {},
                );
                if (payload.id && payload.revision == null) {
                    var a = active && active.id === payload.id ? active : latest(payload.id);
                    if (a) payload.revision = a.revision;
                }
                var result = await request(api, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        action: 'kimai',
                        csrf: state.csrf,
                        data: JSON.stringify(payload),
                    }).toString(),
                });
                await refresh(true);
                if (active && payload.id === active.id) {
                    // A poll may include another client's later change. Only adopt the
                    // revision acknowledged by this mutation, never an arbitrary poll.
                    if (result.revision != null) active.revision = result.revision;
                    updateEditorStatus();
                }
                return result;
            });
        serial = work;
        return work.finally(function () {
            busy--;
            setBusy();
        });
    }
    function setBusy() {
        if (panel)
            panel.querySelectorAll('button[data-mutation]').forEach(function (b) {
                b.disabled = !!busy;
            });
    }
    function cancelDraft() {
        clearTimeout(draftTimer);
        draftTimer = null;
    }
    async function saveDraft() {
        if (!active || !panel.querySelector('form[data-recording]')) return Promise.resolve();
        if (latest(active.id) && latest(active.id).revision !== active.revision) {
            cancelDraft();
            throw Error('Recording changed. Use Refresh with my draft before saving.');
        }
        var id = active.id,
            row = readRow(),
            snapshot = JSON.stringify(row),
            generation = formGeneration;
        cancelDraft();
        message('Saving draft…');
        return post('draft', { id: id, row: row })
            .then(function () {
                if (generation === formGeneration && JSON.stringify(readRow()) === snapshot)
                    draftUnsaved = false;
                message('Draft saved');
            })
            .catch(function (e) {
                message('Draft not saved: ' + e.message, true);
                throw e;
            });
    }
    async function closePanel() {
        if (draftTimer || draftUnsaved) {
            try {
                await saveDraft();
            } catch (_) {
                return;
            }
        }
        if (dialog && dialog.open) dialog.close();
        if (panel) panel.hidden = true;
    }
    function shell(heading, modal) {
        formGeneration++;
        cancelDraft();
        draftUnsaved = false;
        if (!panel) {
            panel = document.createElement('aside');
            panel.className = 'cs-kd-panel';
            panel.setAttribute('aria-labelledby', 'cs-kd-heading');
            document.body.append(panel);
        }
        if (dialog && dialog.open) dialog.close();
        document.body.append(panel);
        panel.hidden = false;
        panel.innerHTML =
            '<header><h2 id="cs-kd-heading" tabindex="-1">' +
            esc(heading) +
            '</h2><button type="button" data-close aria-label="Close Kimai panel">×</button></header><nav><button type="button" data-view="device">This device</button><button type="button" data-view="inbox">Review inbox (' +
            esc((state.reviews || []).length) +
            ')</button><button type="button" data-view="preferences">Preferences</button></nav><p class="cs-kd-message" role="status" aria-live="polite"></p><div class="cs-kd-content"></div>';
        panel.querySelector('[data-close]').onclick = deferAndClose;
        panel.querySelectorAll('[data-view]').forEach(function (b) {
            b.onclick = async function () {
                if (draftTimer || draftUnsaved) {
                    try {
                        await saveDraft();
                    } catch (_) {
                        return;
                    }
                }
                if (b.dataset.view === 'inbox') showInbox();
                else if (b.dataset.view === 'preferences') showPreferences();
                else openDevice();
            };
        });
        if (modal) {
            if (!dialog) {
                dialog = document.createElement('dialog');
                dialog.className = 'cs-kd-dialog';
                dialog.setAttribute('aria-labelledby', 'cs-kd-heading');
                dialog.addEventListener('cancel', function (e) {
                    e.preventDefault();
                    deferAndClose();
                });
                document.body.append(dialog);
            }
            dialog.append(panel);
            dialog.showModal();
        }
        setBusy();
    }
    function deferAndClose() {
        if (active && active.review) {
            var id = active.id;
            saveDraft()
                .then(function () {
                    return post('defer', { id: id });
                })
                .then(closePanel)
                .catch(function (e) {
                    message(e.message, true);
                });
        } else closePanel();
    }
    function content(html) {
        panel.querySelector('.cs-kd-content').innerHTML = html;
        setBusy();
    }
    function options(rows, selected, placeholder) {
        var found = (rows || []).some(function (r) {
            return String(r.id) === String(selected);
        });
        return (
            '<option value="">' +
            esc(placeholder) +
            '</option>' +
            (!found && selected
                ? '<option selected value="' +
                  esc(selected) +
                  '">Current selection #' +
                  esc(selected) +
                  '</option>'
                : '') +
            (rows || [])
                .map(function (r) {
                    return (
                        '<option value="' +
                        esc(r.id) +
                        '"' +
                        (String(r.id) === String(selected) ? ' selected' : '') +
                        '>' +
                        esc(r.name) +
                        '</option>'
                    );
                })
                .join('')
        );
    }
    async function destinations(kind, parent) {
        var key = kind + ':' + (parent || '');
        if (!lists[key])
            lists[key] = await request(
                api +
                    '&api=kimai-destinations&kind=' +
                    kind +
                    (parent ? '&parent=' + encodeURIComponent(parent) : ''),
            );
        return lists[key];
    }
    function rowField(name, label, value, type) {
        return (
            '<label>' +
            label +
            '<input name="' +
            name +
            '" type="' +
            (type || 'text') +
            '"' +
            (type === 'datetime-local' ? ' step="1"' : '') +
            ' value="' +
            esc(value) +
            '"></label>'
        );
    }
    function readRow() {
        var f = panel.querySelector('form[data-recording]'),
            d = new FormData(f),
            row = {
                customer: Number(d.get('customer')),
                project: Number(d.get('project')),
                activity: Number(d.get('activity')),
                description: d.get('description') || '',
                tags: String(d.get('tags') || '')
                    .split(',')
                    .map(function (t) {
                        return t.trim();
                    })
                    .filter(Boolean),
                billable: d.has('billable'),
                basis: d.get('basis') || 'connected',
            };
        if (d.get('beginLocal')) row.beginLocal = d.get('beginLocal');
        if (d.get('endLocal')) row.endLocal = d.get('endLocal');
        return row;
    }
    async function editor(a, modal) {
        active = a || null;
        shell(a ? (ongoing(a) ? 'Recording details' : 'Review recording') : 'Start a timer', modal);
        var generation = formGeneration;
        if (!state.connected) {
            content(
                '<p>Connect your personal Kimai account before recording time.</p><a href="' +
                    esc(api + '&view=kimai') +
                    '">Open Kimai settings</a>',
            );
            return;
        }
        var sessions = (state.sessions || []).filter(function (s) {
            return !s.end;
        });
        var data = Object.assign(
            { description: '', tags: [], billable: true, basis: 'connected' },
            a || {},
            (a && a.draft) || {},
        );
        content(
            '<p class="cs-kd-summary">' +
                (a
                    ? esc(title(a)) + ' · ' + duration(a.seconds) + '<br>' + esc(state.timezone || 'UTC')
                    : 'Choose a destination for this recording. No mapping rule is required.') +
                '</p>' +
                (a && a.error ? '<p class="cs-kd-warning">' + esc(a.error) + '</p>' : '') +
                (a && a.remoteStartReason ? '<p><small>' + esc(a.remoteStartReason) + '</small></p>' : '') +
                '<form data-recording><fieldset ' +
                (!a && !sessions.length ? 'disabled' : '') +
                '><label>Customer<select name="customer" required>' +
                options([], data.customer, 'Loading customers…') +
                '</select></label><label>Project<select name="project" required>' +
                options([], data.project, 'Choose project') +
                '</select></label><button type="button" class="cs-kd-create" data-create="projects">Create project…</button><label>Activity<select name="activity" required>' +
                options([], data.activity, 'Choose activity') +
                '</select><small>Kimai calls the type of work an activity.</small></label><button type="button" class="cs-kd-create" data-create="activities">Create activity…</button><div class="cs-kd-create-form" hidden></div><label>Description<textarea name="description" rows="3" placeholder="Describe the work for your timesheet">' +
                esc(data.description) +
                '</textarea></label>' +
                (!a
                    ? '<fieldset class="cs-kd-sources"><legend>Connections to track</legend>' +
                      sessions
                          .map(function (s) {
                              return (
                                  '<label><input type="checkbox" name="source" value="' +
                                  esc(s.id) +
                                  '" checked> ' +
                                  esc(types[s.type] || s.type) +
                                  ' · ' +
                                  esc(s.name || 'This device') +
                                  '</label>'
                              );
                          })
                          .join('') +
                      '</fieldset><label>Start counting<select name="from"><option value="now">From now</option><option value="connection">Include time since connection started (checked for overlaps)</option></select></label>'
                    : '') +
                (a && ongoing(a)
                    ? '<label>Destination changes<select name="mode"><option value="switch">Switch from now</option><option value="whole">Change whole recording (review required)</option></select></label><small>Description changes apply to this recording; rules are unchanged.</small>'
                    : '') +
                (a && !ongoing(a)
                    ? '<div class="cs-kd-times">' +
                      rowField(
                          'beginLocal',
                          'Start',
                          data.beginLocal || local(data.begin),
                          'datetime-local',
                      ) +
                      rowField('endLocal', 'End', data.endLocal || local(data.end), 'datetime-local') +
                      '</div>'
                    : '') +
                '<details><summary>Timing and billing</summary><label>Duration basis<select name="basis"><option value="connected">Connected time</option><option value="active"' +
                (data.basis === 'active' ? ' selected' : '') +
                '>Measured active time (after disconnect)</option></select></label><small>Missing or overlapping active measurements require review.</small>' +
                rowField(
                    'tags',
                    'Tags (comma separated)',
                    Array.isArray(data.tags) ? data.tags.join(', ') : data.tags,
                ) +
                '<label class="cs-kd-check"><input name="billable" type="checkbox"' +
                (data.billable ? ' checked' : '') +
                '> Billable</label></details><footer><button type="submit" class="cs-kd-primary" data-mutation>' +
                (!a ? 'Start timer' : ongoing(a) ? 'Save changes' : 'Save to Kimai') +
                '</button>' +
                (a ? '<button type="button" data-defer>Review later</button>' : '') +
                '</footer></fieldset></form>' +
                (a
                    ? '<section class="cs-kd-contributors"><h3>Contributing connections</h3>' +
                      (a.spans || [])
                          .map(function (s) {
                              return (
                                  '<div>' +
                                  esc(s.name || s.nodeid) +
                                  ' · ' +
                                  esc(types[s.type] || s.type) +
                                  (ongoing(a) && s.end == null
                                      ? ' <button type="button" data-detach="' +
                                        esc(s.sessionId) +
                                        '" data-mutation>Stop this connection</button>'
                                      : '') +
                                  '</div>'
                              );
                          })
                          .join('') +
                      '<p><small>Overlapping connections share elapsed time. Stopping Kimai tracking leaves remote access connected.</small></p>' +
                      (ongoing(a)
                          ? '<button type="button" data-stop data-mutation>Stop & keep all contributors</button>'
                          : '') +
                      ' <button type="button" class="cs-kd-danger" data-exclude data-mutation>Discard tracked time…</button></section>'
                    : '') +
                (!a && !sessions.length
                    ? '<p>No owned connection is currently open on this device. Connect Desktop, Terminal or Files first.</p>'
                    : ''),
        );
        var form = panel.querySelector('form[data-recording]');
        form.addEventListener('input', function () {
            if (active) {
                draftUnsaved = true;
                clearTimeout(draftTimer);
                if (latest(active.id) && latest(active.id).revision !== active.revision) {
                    updateEditorStatus();
                    return;
                }
                draftTimer = setTimeout(function () {
                    saveDraft().catch(function () {});
                }, 700);
            }
        });
        form.onsubmit = async function (e) {
            e.preventDefault();
            if (busy) return;
            cancelDraft();
            var row = readRow();
            try {
                if (!a) {
                    var ids = [...form.querySelectorAll('[name=source]:checked')].map(function (c) {
                        return c.value;
                    });
                    if (!ids.length) throw Error('Select at least one connection.');
                    await post('start', { sessions: ids, destination: row, from: form.elements.from.value });
                } else {
                    var mode = ongoing(a) ? form.elements.mode.value : 'whole';
                    if (
                        mode === 'whole' &&
                        !window.confirm(
                            'Apply these values to the entire displayed recording? Existing Kimai edits and locks will be checked.',
                        )
                    )
                        return;
                    await post('save', { id: a.id, row: row, mode: mode, reviewed: true });
                }
                draftUnsaved = false;
                await openDevice();
                message('Saved. Check the recording status above.');
            } catch (err) {
                message(err.message, true);
            }
        };
        if (a && !ongoing(a) && sessions.length) {
            var resume = document.createElement('button');
            resume.type = 'button';
            resume.textContent = 'Start another interval';
            resume.onclick = function () {
                editor(null);
            };
            panel.querySelector('.cs-kd-content').append(resume);
        }
        if (a && !ongoing(a) && /Create outcome uncertain/i.test(a.error || '')) {
            var retry = document.createElement('button');
            retry.type = 'button';
            retry.dataset.mutation = '';
            retry.textContent = 'Retry after checking Kimai';
            retry.onclick = async function () {
                if (
                    busy ||
                    !window.confirm('I checked Kimai and no entry exists. Retry creating this recording?')
                )
                    return;
                try {
                    cancelDraft();
                    await post('resolve', { id: a.id, choice: 'retry', row: readRow(), reviewed: true });
                    draftUnsaved = false;
                    await openDevice();
                    message('Retry requested. Check the synchronization result.');
                } catch (e) {
                    message(e.message, true);
                }
            };
            panel.querySelector('.cs-kd-content').append(retry);
        }
        if (a && !ongoing(a) && a.error && (a.remoteIds || []).length) {
            ['keep', 'replace'].forEach(function (choice) {
                var button = document.createElement('button');
                button.type = 'button';
                button.dataset.mutation = '';
                button.textContent =
                    choice === 'keep' ? 'Keep Kimai version' : 'Replace with reviewed values';
                button.onclick = async function () {
                    if (busy) return;
                    try {
                        cancelDraft();
                        await post('resolve', { id: a.id, choice: choice, row: readRow(), reviewed: true });
                        draftUnsaved = false;
                        await openDevice();
                        message(
                            choice === 'keep'
                                ? 'Kimai version kept.'
                                : 'Replacement requested; check the recording status.',
                        );
                    } catch (e) {
                        message(e.message, true);
                    }
                };
                panel.querySelector('.cs-kd-content').append(button);
            });
        }
        var defer = panel.querySelector('[data-defer]');
        if (defer) defer.onclick = deferAndClose;
        panel.querySelectorAll('[data-detach]').forEach(function (b) {
            b.onclick = function () {
                stop(a, [b.dataset.detach]);
            };
        });
        var sb = panel.querySelector('[data-stop]');
        if (sb)
            sb.onclick = function () {
                stop(a);
            };
        var eb = panel.querySelector('[data-exclude]');
        if (eb)
            eb.onclick = function () {
                exclude(a);
            };
        panel.querySelectorAll('[data-create]').forEach(function (b) {
            b.onclick = function () {
                createForm(b.dataset.create);
            };
        });
        form.elements.customer.onchange = async function () {
            form.elements.project.innerHTML = options([], null, 'Choose project');
            form.elements.activity.innerHTML = options([], null, 'Choose activity');
            try {
                var selected = this.value,
                    rows = await destinations('projects', selected);
                if (generation === formGeneration && form.elements.customer.value === selected)
                    form.elements.project.innerHTML = options(rows, null, 'Choose project');
            } catch (e) {
                message(e.message, true);
            }
        };
        form.elements.project.onchange = async function () {
            form.elements.activity.innerHTML = options([], null, 'Choose activity');
            try {
                var selected = this.value,
                    rows = await destinations('activities', selected);
                if (generation === formGeneration && form.elements.project.value === selected)
                    form.elements.activity.innerHTML = options(rows, null, 'Choose activity');
            } catch (e) {
                message(e.message, true);
            }
        };
        try {
            var values = await Promise.all([
                destinations('customers'),
                destinations('projects', data.customer),
                destinations('activities', data.project),
            ]);
            if (generation !== formGeneration) return;
            ['customer', 'project', 'activity'].forEach(function (k, i) {
                form.elements[k].innerHTML = options(values[i], data[k], 'Choose ' + k);
            });
        } catch (e) {
            if (generation === formGeneration) message('Could not load destinations: ' + e.message, true);
        }
        setBusy();
    }
    async function stop(a, ids) {
        if (busy) return;
        if (
            !ids &&
            (a.source || []).length > 1 &&
            !window.confirm(
                'Stop tracking all ' +
                    a.source.length +
                    ' contributing connections? Remote access remains connected.',
            )
        )
            return;
        try {
            if (draftTimer || draftUnsaved) await saveDraft();
            await post('stop', { id: a.id, sessionIds: ids });
            await editor(latest(a.id) || a);
            message('Stop requested. The status shows whether Kimai has confirmed it.');
        } catch (e) {
            if (!panel || panel.hidden) await editor(latest(a.id) || a);
            message(e.message, true);
        }
    }
    async function exclude(a) {
        if (busy) return;
        if (
            !window.confirm(
                'Discard ' +
                    duration(a.seconds) +
                    ' for this entire recording, including all contributors? Connection history is retained. An owned Kimai entry can only be removed if unchanged and unlocked.',
            )
        )
            return;
        try {
            cancelDraft();
            await post('exclude', { id: a.id, confirmed: true });
            draftUnsaved = false;
            await openDevice();
            message('Exclusion requested. Check the status for remote removal errors.');
        } catch (e) {
            message(e.message, true);
        }
    }
    function createForm(kind) {
        var form = panel.querySelector('form[data-recording]'),
            box = panel.querySelector('.cs-kd-create-form'),
            parent = form.elements[kind === 'projects' ? 'customer' : 'project'].value;
        if (!parent) {
            message('Choose the ' + (kind === 'projects' ? 'customer' : 'project') + ' first.', true);
            return;
        }
        box.hidden = false;
        box.innerHTML =
            '<label>New ' +
            (kind === 'projects' ? 'project' : 'activity') +
            ' name<input name="newDestination" autocomplete="off"></label><small>Requires permission in Kimai. Your recording details will be kept if creation is denied.</small><button type="button" data-create-save data-mutation>Create & select</button><button type="button" data-create-cancel>Cancel</button>';
        box.querySelector('[data-create-cancel]').onclick = function () {
            box.hidden = true;
        };
        box.querySelector('[data-create-save]').onclick = async function () {
            if (busy) return;
            var name = box.querySelector('input').value.trim();
            if (!name) {
                message('Enter a name.', true);
                return;
            }
            try {
                var r = await post('create', { kind: kind, name: name, parent: Number(parent) }),
                    field = kind === 'projects' ? 'project' : 'activity';
                form.elements[field].add(new Option(r.name || name, r.id, true, true));
                delete lists[kind + ':' + parent];
                box.hidden = true;
                if (field === 'project') form.elements.project.onchange();
                message('Created and selected ' + name);
            } catch (e) {
                message(e.message + ' You can also create it in Kimai and refresh destinations.', true);
            }
        };
        box.querySelector('input').focus();
    }
    async function openDevice() {
        if (draftTimer || draftUnsaved) {
            try {
                await saveDraft();
            } catch (_) {
                return;
            }
        }
        var a =
            deviceAllocations().find(ongoing) ||
            deviceAllocations().find(function (x) {
                return x.review;
            });
        return editor(a);
    }
    async function showInbox() {
        if (draftTimer || draftUnsaved) {
            try {
                await saveDraft();
            } catch (_) {
                return;
            }
        }
        active = null;
        shell('Review inbox');
        content(
            '<p>Deferred recordings remain here. Reviewing never extends their time.</p>' +
                (state.reviews || [])
                    .map(function (a) {
                        return (
                            '<article><h3>' +
                            esc(
                                (a.spans || [])
                                    .map(function (s) {
                                        return s.name;
                                    })
                                    .filter(Boolean)
                                    .join(', ') || 'Recording',
                            ) +
                            '</h3><p>' +
                            esc(local(a.begin).replace('T', ' ')) +
                            ' · ' +
                            duration(a.seconds) +
                            '<br>' +
                            esc(title(a)) +
                            '</p><button type="button" data-review="' +
                            esc(a.id) +
                            '">Review recording</button></article>'
                        );
                    })
                    .join('') +
                (!(state.reviews || []).length ? '<p>No recordings need review.</p>' : '') +
                '<a href="' +
                esc(api + '&view=kimai') +
                '">Kimai settings and sync history</a>',
        );
        panel.querySelectorAll('[data-review]').forEach(function (b) {
            b.onclick = function () {
                editor(latest(b.dataset.review));
            };
        });
    }
    async function showPreferences() {
        if (draftTimer || draftUnsaved) {
            try {
                await saveDraft();
            } catch (_) {
                return;
            }
        }
        active = null;
        shell('My recording preferences');
        var prefs = state.preferences || {};
        content(
            '<form data-preferences><label>After a recording ends<select name="prompt"><option value="always">Always open review</option><option value="issues">Only when attention is needed</option><option value="never">Never open automatically</option></select></label><label>Presentation<select name="presentation"><option value="drawer">Side panel</option><option value="dialog">Centered dialog</option></select></label><p>Reviews wait in your inbox while another connection is active. Disabling prompts never discards work or enables automatic billing.</p><button class="cs-kd-primary" data-mutation>Save preferences</button></form><p><a href="' +
                esc(api + '&view=kimai') +
                '">Manage rules, token and automation</a></p>',
        );
        var f = panel.querySelector('form');
        f.elements.prompt.value = prefs.prompt || 'always';
        f.elements.presentation.value = prefs.presentation || 'drawer';
        f.onsubmit = async function (e) {
            e.preventDefault();
            if (busy) return;
            try {
                await post('preferences', {
                    prompt: f.elements.prompt.value,
                    presentation: f.elements.presentation.value,
                });
                message('Preferences saved');
            } catch (err) {
                message(err.message, true);
            }
        };
    }
    function deviceAllocations() {
        var id = currentNodeId();
        return id
            ? (state.allocations || []).filter(function (a) {
                  return (a.spans || []).some(function (x) {
                      return x.nodeid === id;
                  });
              })
            : [];
    }
    function deviceSpans(a, id) {
        return (a.spans || [])
            .filter(function (x) {
                return x.nodeid === id && x.end == null;
            })
            .map(function (x) {
                return x.sessionId;
            });
    }
    function mount() {
        ['desktopCustomUiButtons', 'terminalCustomUiButtons', 'p13rightOfButtons'].forEach(function (id) {
            var host = document.getElementById(id);
            if (!host || host.querySelector('.cs-kd-strip')) return;
            var wrap = document.createElement('span');
            wrap.className = 'cs-kd-strip';
            var button = document.createElement('button');
            button.type = 'button';
            button.className = 'cs-kd-chip';
            button.textContent = 'Kimai';
            button.onclick = function () {
                if (state) openDevice();
                else refresh(true);
            };
            var stopButton = document.createElement('button');
            stopButton.type = 'button';
            stopButton.className = 'cs-kd-quick-stop';
            stopButton.hidden = true;
            wrap.append(button);
            wrap.append(stopButton);
            host.append(wrap);
        });
    }
    function updateChips() {
        var a = deviceAllocations().find(ongoing),
            count = (state.reviews || []).length;
        document.querySelectorAll('.cs-kd-chip').forEach(function (b) {
            b.textContent =
                'Kimai · ' +
                (!state.connected
                    ? 'Connect account'
                    : a
                      ? title(a) + ' ' + duration(a.seconds)
                      : 'Start timer') +
                (count ? ' · ' + count + ' to review' : '');
            b.title = 'Open personal Kimai controls';
        });
        document.querySelectorAll('.cs-kd-quick-stop').forEach(function (b) {
            var ids = a ? deviceSpans(a, currentNodeId()) : [];
            b.hidden = !ids.length;
            b.disabled = !!busy;
            b.textContent = a && (a.source || []).length > 1 ? 'Stop tracking this device' : 'Stop & keep';
            b.title = 'Stop only this device’s contributions; remote access and other devices keep running.';
            b.onclick = function () {
                if (a && ids.length) stop(a, ids);
            };
        });
    }
    function updateEditorStatus() {
        if (!active || !panel || panel.hidden) return;
        var changed = latest(active.id);
        if (!changed) return;
        var summary = panel.querySelector('.cs-kd-summary');
        if (summary)
            summary.textContent =
                title(changed) + ' · ' + duration(changed.seconds) + ' · ' + (state.timezone || 'UTC');
        var warning = panel.querySelector('.cs-kd-revision');
        if (changed.revision !== active.revision) {
            cancelDraft();
            if (!warning) {
                warning = document.createElement('div');
                warning.className = 'cs-kd-revision';
                var text = document.createElement('p');
                text.textContent = 'Recording changed. Your edits are still here.';
                var button = document.createElement('button');
                button.type = 'button';
                button.textContent = 'Refresh with my draft';
                button.onclick = async function () {
                    var row = readRow(),
                        updated = latest(active.id);
                    cancelDraft();
                    await editor(Object.assign({}, updated, { draft: row }));
                    draftUnsaved = true;
                    message('Latest recording loaded with your draft. Review and save your changes.');
                };
                warning.append(text);
                warning.append(button);
                panel.querySelector('.cs-kd-content').prepend(warning);
            }
        } else if (warning) warning.remove();
    }
    async function prompts() {
        if (
            document.hidden ||
            (panel && !panel.hidden) ||
            state.activeConnections > 0 ||
            (state.sessions || []).some(function (s) {
                return !s.end;
            })
        )
            return;
        var prefs = state.preferences || {};
        if (prefs.prompt === 'never') return;
        var a = (state.reviews || []).find(function (x) {
            return (
                !presented.has(x.id + ':' + x.revision) &&
                !dismissed.has(x.id) &&
                (prefs.prompt !== 'issues' || x.error || x.status === 'conflict' || !x.project || !x.activity)
            );
        });
        if (!a) return;
        var key = a.id + ':' + a.revision;
        presented.add(key);
        try {
            var r = await post('claim', { id: a.id });
            if (r.show && !document.hidden && !(panel && !panel.hidden)) {
                dismissed.add(a.id);
                await editor(latest(a.id) || a, prefs.presentation === 'dialog');
            }
        } catch (_) {}
    }
    async function refresh(force) {
        mount();
        if (refreshing) {
            await refreshing;
            if (force) return refresh(true);
            return;
        }
        var next = currentNodeId();
        if (!next && !force && !(panel && !panel.hidden)) return;
        refreshing = (async function () {
            try {
                var j = await request(
                    api + '&api=kimai-device' + (next ? '&nodeid=' + encodeURIComponent(next) : ''),
                );
                if (currentNodeId() !== next) return;
                state = j;
                node = next;
                updateChips();
                updateEditorStatus();
                if (!force) prompts();
            } catch (e) {
                if (panel && !panel.hidden) message(e.message, true);
            }
        })();
        try {
            await refreshing;
        } finally {
            refreshing = null;
        }
    }
    window.CSDevice = {
        refresh: function () {
            return refresh(false);
        },
        openInbox: async function () {
            if (draftTimer || draftUnsaved) {
                try {
                    await saveDraft();
                } catch (_) {
                    return;
                }
            }
            await refresh(true);
            if (state) return showInbox();
        },
    };
    refresh(false);
    setInterval(function () {
        refresh(false);
    }, 5000);
})();
