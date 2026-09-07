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
    var dismissalInstalled = false;
    var formGeneration = 0,
        lists = {},
        presented = new Set(),
        dismissed = new Set();
    var types = { desktop: 'Desktop', terminal: 'Terminal', files: 'Files' };
    var confirmation = null;
    function placeConfirmation(box, trigger) {
        var content = panel.querySelector('.cs-kd-content');
        if (trigger && content.contains(trigger)) {
            var footer = trigger.closest('footer');
            var article = trigger.closest('article');
            if (footer) footer.insertAdjacentElement('afterend', box);
            else if (article) article.append(box);
            else trigger.insertAdjacentElement('afterend', box);
        } else content.append(box);
    }
    function inlineConfirm(heading, text, action, trigger) {
        if (confirmation) return Promise.resolve(false);
        if (!panel || panel.hidden) shell('Kimai recording');
        var before = trigger || document.activeElement,
            box = document.createElement('section');
        box.className = 'cs-kd-confirm';
        box.setAttribute('role', 'region');
        box.setAttribute('aria-labelledby', 'cs-kd-confirm-title');
        box.innerHTML =
            '<h3 id="cs-kd-confirm-title">' +
            esc(heading) +
            '</h3><p>' +
            esc(text) +
            '</p><div><button type="button" data-confirm-cancel>Go back</button> <button type="button" class="cs-kd-primary" data-confirm-accept>' +
            esc(action) +
            '</button></div>';
        placeConfirmation(box, before);
        return new Promise(function (resolve) {
            function finish(value) {
                box.remove();
                confirmation = null;
                setBusy();
                if (before && before.isConnected) before.focus();
                resolve(value);
            }
            confirmation = {
                cancel: function () {
                    finish(false);
                },
            };
            setBusy();
            box.querySelector('[data-confirm-cancel]').onclick = function () {
                finish(false);
            };
            box.querySelector('[data-confirm-accept]').onclick = function () {
                finish(true);
            };
            box.addEventListener('keydown', function (e) {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    finish(false);
                }
            });
            box.querySelector('[data-confirm-cancel]').focus({ preventScroll: true });
            box.scrollIntoView({ block: 'nearest' });
        });
    }
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
    function settingsUrl() {
        var dark =
            (document.body && document.body.classList.contains('night')) ||
            (document.documentElement && document.documentElement.classList.contains('night'));
        return api + '&view=kimai&night=' + (dark ? '1' : '0');
    }
    function canStartAfter(a) {
        return !!(
            a &&
            a.overlap &&
            Number.isFinite(a.overlap.end) &&
            a.overlap.end > a.begin &&
            a.overlap.end < a.end
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
                b.disabled = !!busy || !!confirmation || (b.dataset && b.dataset.unavailable === 'true');
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
        if (confirmation) confirmation.cancel();
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
    function dismissPanel(e) {
        if (!panel || panel.hidden || busy) return;
        if (e.type === 'keydown') {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            if (confirmation) {
                confirmation.cancel();
                return;
            }
        } else if (panel.contains(e.target)) return;
        deferAndClose(false);
    }
    function shell(heading) {
        if (!dismissalInstalled) {
            document.addEventListener('keydown', dismissPanel, true);
            document.addEventListener('pointerdown', dismissPanel, true);
            dismissalInstalled = true;
        }
        var modal = state && state.preferences && state.preferences.presentation === 'dialog';
        if (confirmation) confirmation.cancel();
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
            ')</button></nav><p class="cs-kd-message" role="status" aria-live="polite"></p><div class="cs-kd-content"></div>';
        panel.querySelector('[data-close]').onclick = function () {
            deferAndClose(false);
        };
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
                    deferAndClose(false);
                });
                document.body.append(dialog);
            }
            dialog.append(panel);
            dialog.showModal();
        }
        setBusy();
    }
    function deferAndClose(returnToInbox) {
        if (active && active.review) {
            var id = active.id;
            saveDraft()
                .then(function () {
                    return post('defer', { id: id });
                })
                .then(function () {
                    return returnToInbox ? showInbox() : closePanel();
                })
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
    async function editor(a) {
        active = a || null;
        shell(a ? (ongoing(a) ? 'Recording details' : 'Review recording') : 'Start a timer');
        var generation = formGeneration;
        if (!state.connected) {
            content(
                '<p>Connect your personal Kimai account before recording time.</p><a href="' +
                    esc(settingsUrl()) +
                    '">Open Kimai settings</a>',
            );
            return;
        }
        var sessions = (state.sessions || []).filter(function (s) {
            return !s.end && (a || !s.mapped || s.basis !== 'active');
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
                (a && /overlap/i.test(a.error || '')
                    ? '<p>Adjust the start/end below, or review the existing entry in Kimai. Overlapping billing is not approved automatically.</p>'
                    : '') +
                (a && a.overlap
                    ? '<p>Kimai entry #' +
                      esc(a.overlap.remoteId) +
                      ': ' +
                      esc(local(a.overlap.begin)) +
                      ' to ' +
                      esc(a.overlap.end ? local(a.overlap.end) : 'still running') +
                      '; overlap ' +
                      duration(a.overlap.seconds) +
                      '.' +
                      (a.overlap.roundedOnly
                          ? ' Kimai rounding extended the existing entry. Review the reduced duration before approving.'
                          : '') +
                      '</p>' +
                      (canStartAfter(a)
                          ? '<button type="button" data-start-after>Start after existing entry</button>'
                          : '')
                    : '') +
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
        var after = panel.querySelector('[data-start-after]');
        if (after)
            after.onclick = function () {
                form.elements.beginLocal.value = local(a.overlap.end);
                draftUnsaved = true;
                message(
                    'Start adjusted in your draft. Proposed duration: ' +
                        duration((a.end - a.overlap.end) / 1000) +
                        '. Review the reduced time, then approve; nothing has been sent.',
                );
                form.elements.beginLocal.focus();
            };
        form.onsubmit = async function (e) {
            e.preventDefault();
            if (busy || confirmation) return;
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
                        !(await inlineConfirm(
                            'Apply to the entire recording?',
                            'Existing Kimai edits and locks will be checked.',
                            'Apply reviewed values',
                            e.submitter || form.querySelector('button[type=submit]'),
                        ))
                    )
                        return;
                    await post('save', { id: a.id, row: row, mode: mode, reviewed: true });
                }
                draftUnsaved = false;
                if (a && !ongoing(a)) await showInbox();
                else await openDevice();
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
                    !(await inlineConfirm(
                        'Retry creating this recording?',
                        'Continue only after checking Kimai and confirming no entry exists.',
                        'I checked; retry creation',
                        retry,
                    ))
                )
                    return;
                try {
                    cancelDraft();
                    await post('resolve', { id: a.id, choice: 'retry', row: readRow(), reviewed: true });
                    draftUnsaved = false;
                    await showInbox();
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
                    if (busy || confirmation) return;
                    try {
                        cancelDraft();
                        await post('resolve', { id: a.id, choice: choice, row: readRow(), reviewed: true });
                        draftUnsaved = false;
                        await showInbox();
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
        if (defer)
            defer.onclick = function () {
                deferAndClose(true);
            };
        panel.querySelectorAll('[data-detach]').forEach(function (b) {
            b.onclick = function () {
                stop(a, [b.dataset.detach]);
            };
        });
        var sb = panel.querySelector('[data-stop]');
        if (sb)
            sb.onclick = function () {
                stop(a, null, sb);
            };
        var eb = panel.querySelector('[data-exclude]');
        if (eb)
            eb.onclick = function () {
                exclude(a, eb);
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
    async function stop(a, ids, trigger) {
        if (busy || confirmation) return;
        if (
            !ids &&
            (a.source || []).length > 1 &&
            !(await inlineConfirm(
                'Stop all contributors?',
                'This stops tracking all ' +
                    a.source.length +
                    ' contributing connections. Remote access remains connected.',
                'Stop & keep time',
                trigger,
            ))
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
    async function exclude(a, trigger) {
        if (busy || confirmation) return;
        if (
            !(await inlineConfirm(
                'Discard ' + duration(a.seconds) + '?',
                'This excludes the entire recording and all contributors. Connection history is retained. An owned Kimai entry can only be removed if unchanged and unlocked.',
                'Discard recording',
                trigger,
            ))
        )
            return;
        try {
            cancelDraft();
            await post('exclude', { id: a.id, revision: a.revision, confirmed: true });
            draftUnsaved = false;
            await showInbox();
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
            if (busy || confirmation) return;
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
        var a = deviceAllocations().find(ongoing);
        var mapped = (state.sessions || []).filter(function (s) {
            return s.nodeid === currentNodeId() && s.end == null && s.mapped;
        });
        if (!a && mapped.length) {
            active = null;
            shell('Mapped recording');
            content(
                '<p class="cs-kd-summary">These connections already have a matching recording rule.</p>' +
                    mapped
                        .map(function (s) {
                            return (
                                '<section><h3>' +
                                esc(s.name || s.nodeid) +
                                ' · ' +
                                esc(types[s.type] || s.type) +
                                '</h3><p>' +
                                (s.basis === 'active'
                                    ? 'Active time is being measured. The recording will be prepared after disconnect using the measured active duration.'
                                    : 'Connected time will be prepared after disconnect using your mapping rule.') +
                                '</p></section>'
                            );
                        })
                        .join('') +
                    '<p>No additional timer is needed. Review settings and minimum session length determine what happens after disconnect.</p>' +
                    '<a href="' +
                    esc(settingsUrl()) +
                    '">Open Kimai settings</a>',
            );
            return;
        }
        return editor(
            a ||
                deviceAllocations().find(function (x) {
                    return x.review;
                }),
        );
    }
    function effectiveRow(a) {
        return Object.assign({}, a, a.draft || {});
    }
    function canApprove(a) {
        var row = effectiveRow(a);
        return (
            !ongoing(a) &&
            !a.error &&
            !['locked', 'excluded', 'conflict', 'attention', 'creating'].includes(a.status) &&
            Number(row.customer) > 0 &&
            Number(row.project) > 0 &&
            Number(row.activity) > 0
        );
    }
    function approvalValues(a) {
        var row = effectiveRow(a);
        return {
            customer: row.customer,
            project: row.project,
            activity: row.activity,
            description: row.description,
            tags: row.tags,
            billable: row.billable,
            beginLocal: row.beginLocal,
            endLocal: row.endLocal,
        };
    }
    function approvalTiming(a) {
        var row = effectiveRow(a);
        return { begin: row.beginLocal || local(a.begin), end: row.endLocal || local(a.end) };
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
        var generation = formGeneration,
            shown = (state.reviews || []).slice(),
            names = {};
        message('Loading destination names…');
        try {
            var values = await Promise.all(
                ['customers', 'projects', 'activities'].map(function (k) {
                    return destinations(k);
                }),
            );
            ['customers', 'projects', 'activities'].forEach(function (k, i) {
                names[k] = values[i];
            });
        } catch (e) {
            message('Destination names unavailable: ' + e.message, true);
        }
        if (generation !== formGeneration) return;
        function name(kind, id) {
            var value = (names[kind] || []).find(function (x) {
                return String(x.id) === String(id);
            });
            return value ? value.name : id ? 'Unavailable #' + id : 'Not selected';
        }
        content(
            '<p>Review the destination, description and effective start/end before approving. Times use ' +
                esc(state.timezone || 'UTC') +
                '.</p>' +
                shown
                    .map(function (a) {
                        var row = effectiveRow(a),
                            times = approvalTiming(a);
                        return (
                            '<article><h3>' +
                            esc(
                                (a.spans || [])
                                    .map(function (x) {
                                        return x.name;
                                    })
                                    .filter(Boolean)
                                    .join(', ') || 'Recording',
                            ) +
                            '</h3><p>' +
                            esc(times.begin.replace('T', ' ')) +
                            ' to ' +
                            esc(times.end.replace('T', ' ')) +
                            '<br>Source duration ' +
                            duration(a.seconds) +
                            '<br>' +
                            esc(name('customers', row.customer)) +
                            ' / ' +
                            esc(name('projects', row.project)) +
                            ' / ' +
                            esc(name('activities', row.activity)) +
                            '<br>' +
                            esc(row.description || 'No description') +
                            '<br>' +
                            esc(title(a)) +
                            '</p>' +
                            (a.error ? '<p class="cs-kd-warning">' + esc(a.error) + '</p>' : '') +
                            (!canApprove(a)
                                ? '<p><small>Open Review to resolve missing details or synchronization issues before approving.</small></p>'
                                : '') +
                            '<button type="button" data-review="' +
                            esc(a.id) +
                            '">Review recording</button> <button type="button" data-mutation data-approve="' +
                            esc(a.id) +
                            '"' +
                            (!canApprove(a) ? ' disabled data-unavailable="true"' : '') +
                            '>Approve</button> <button type="button" class="cs-kd-danger" data-mutation data-inbox-discard="' +
                            esc(a.id) +
                            '">Discard…</button></article>'
                        );
                    })
                    .join('') +
                (!shown.length ? '<p>No recordings need review.</p>' : '') +
                '<a href="' +
                esc(settingsUrl()) +
                '">Kimai settings and sync history</a>',
        );
        if (names.customers) message('');
        panel.querySelectorAll('[data-approve]').forEach(function (b) {
            b.onclick = async function () {
                if (busy || confirmation) return;
                var a = shown.find(function (x) {
                    return x.id === b.dataset.approve;
                });
                if (!a || !canApprove(a)) return;
                if (!latest(a.id) || latest(a.id).revision !== a.revision) {
                    await showInbox();
                    message('Recording changed. Review the refreshed values before approving.', true);
                    return;
                }
                if (
                    !(await inlineConfirm(
                        'Approve this recording?',
                        'Send the displayed effective start/end, destination and description. Existing Kimai edits and locks will be checked.',
                        'Approve recording',
                        b,
                    ))
                )
                    return;
                try {
                    await post('save', {
                        id: a.id,
                        revision: a.revision,
                        row: approvalValues(a),
                        mode: 'whole',
                        reviewed: true,
                    });
                    await showInbox();
                    message(
                        'Approval submitted. Any synchronization error remains visible beside its recording.',
                    );
                } catch (e) {
                    message(e.message, true);
                }
            };
        });
        panel.querySelectorAll('[data-inbox-discard]').forEach(function (b) {
            b.onclick = function () {
                var a = shown.find(function (x) {
                    return x.id === b.dataset.inboxDiscard;
                });
                if (a) exclude(a, b);
            };
        });
        panel.querySelectorAll('[data-review]').forEach(function (b) {
            b.onclick = function () {
                editor(latest(b.dataset.review));
            };
        });
        setBusy();
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
        ['deskstatus', 'termstatus', 'p13Status'].forEach(function (id) {
            var host = document.getElementById(id);
            if (!host || document.getElementById('cs-kd-' + id)) return;
            var wrap = document.createElement('span');
            wrap.className = 'cs-kd-strip';
            wrap.id = 'cs-kd-' + id;
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
            host.insertAdjacentElement('afterend', wrap);
        });
    }
    function updateChips() {
        var a = deviceAllocations().find(ongoing),
            count = (state.reviews || []).length,
            mapped = (state.sessions || []).filter(function (x) {
                return x.nodeid === currentNodeId() && x.end == null && x.mapped;
            });
        document.querySelectorAll('.cs-kd-chip').forEach(function (b) {
            b.textContent =
                'Kimai · ' +
                (!state.connected
                    ? 'Connect account'
                    : a
                      ? (a.status === 'recording-local' ? 'Recording locally' : 'Recording in Kimai') +
                        ' ' +
                        duration(a.seconds)
                      : mapped.length
                        ? mapped.some(function (x) {
                              return x.basis === 'active';
                          })
                            ? 'Active time · review after disconnect'
                            : 'Mapped · review after disconnect'
                        : 'Start timer') +
                (count ? ' · ' + count + ' to review' : '');
            b.title = 'Open personal Kimai controls';
        });
        document.querySelectorAll('.cs-kd-quick-stop').forEach(function (b) {
            var ids = a ? deviceSpans(a, currentNodeId()) : [];
            b.hidden = !ids.length;
            b.disabled = !!busy || !!confirmation || (b.dataset && b.dataset.unavailable === 'true');
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
                return !s.end && (a || !s.mapped || s.basis !== 'active');
            })
        )
            return;
        var prefs = state.preferences || {};
        var a = (state.reviews || []).find(function (x) {
            var prompt = x.prompt || prefs.prompt || 'always';
            return (
                prompt !== 'never' &&
                !presented.has(x.id + ':' + x.revision) &&
                !dismissed.has(x.id) &&
                (prompt !== 'issues' || x.error || x.status === 'conflict' || !x.project || !x.activity)
            );
        });
        if (!a) return;
        var key = a.id + ':' + a.revision;
        presented.add(key);
        try {
            var r = await post('claim', { id: a.id });
            if (r.show && !document.hidden && !(panel && !panel.hidden)) {
                dismissed.add(a.id);
                await editor(latest(a.id) || a);
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
