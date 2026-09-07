/** Device-scoped recording allocations. Raw sessions are immutable accounting evidence. */
'use strict';
const crypto = require('crypto');
const digest = (x) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const second = (n) => Math.floor(n / 1000) * 1000;
const infinity = (n) => (n == null ? Infinity : n);
const overlap = (a, b) => a.begin < infinity(b.end) && b.begin < infinity(a.end);
function subtract(begin, end, occupied) {
    let spans = [{ begin, end }];
    for (const x of occupied)
        spans = spans.flatMap((p) => {
            if (!overlap(p, x)) return [p];
            const out = [];
            if (p.begin < x.begin) out.push({ begin: p.begin, end: Math.min(infinity(p.end), x.begin) });
            if (infinity(x.end) < infinity(p.end)) out.push({ begin: x.end, end: p.end });
            return out;
        });
    return spans;
}
function init(s) {
    s.allocations = s.allocations || {};
    s.device = s.device || {
        since: Date.now(),
        preferences: { prompt: 'always', presentation: 'drawer', minSeconds: 0 },
        suppressed: {},
        operations: {},
    };
    s.device.preferences = {
        prompt: 'always',
        presentation: 'drawer',
        minSeconds: 0,
        ...s.device.preferences,
    };
    return s.device;
}
function effectivePrompt(rule, cfg) {
    return ['always', 'issues', 'never'].includes(rule?.prompt) ? rule.prompt : cfg.preferences.prompt;
}
function strictPrompt(a, b) {
    const order = ['never', 'issues', 'always'];
    return order[Math.max(order.indexOf(a), order.indexOf(b), 0)];
}
function minimum(rule, cfg) {
    return rule?.minSeconds == null ? cfg.preferences.minSeconds : rule.minSeconds;
}
function ruleSpan(doc, begin, end, rule, cfg) {
    return { ...span(doc, begin, end), minSeconds: minimum(rule, cfg), prompt: effectivePrompt(rule, cfg) };
}
function excludeShort(a, known, s) {
    if (a.origin !== 'rule' || a.blocks.length || a.remoteLive || a.end == null) return;
    const short = a.spans.filter((x) => {
        const d = known.find((d) => d?._id === x.sessionId);
        return d && !d.truncated && d.end != null && d.end - d.start < (x.minSeconds || 0) * 1000;
    });
    if (!short.length) return;
    const remaining = a.spans.filter((x) => !short.includes(x)).sort((x, y) => x.begin - y.begin);
    if (!remaining.length) {
        a.status = 'excluded';
        a.review = false;
        a.exclusionReason = 'Below minimum connected-session duration';
        return;
    }
    for (const x of short) {
        const excluded = {
            ...a,
            id: crypto.randomUUID(),
            source: [x.sessionId],
            spans: [x],
            begin: x.begin,
            end: x.end,
            status: 'excluded',
            review: false,
            exclusionReason: 'Below minimum connected-session duration',
            blocks: [],
        };
        s.allocations[excluded.id] = excluded;
    }
    const groups = [];
    for (const x of remaining) {
        const last = groups[groups.length - 1];
        if (!last || x.begin > Math.max(...last.map((y) => y.end))) groups.push([x]);
        else last.push(x);
    }
    const base = { ...a };
    groups.forEach((spans, i) => {
        const item = i ? { ...base, id: crypto.randomUUID() } : a;
        Object.assign(item, {
            spans,
            source: [...new Set(spans.map((x) => x.sessionId))],
            begin: Math.min(...spans.map((x) => x.begin)),
            end: Math.max(...spans.map((x) => x.end)),
            prompt: spans.reduce((p, x) => strictPrompt(p, x.prompt || base.prompt), 'never'),
        });
        s.allocations[item.id] = item;
    });
}
function cuts(s, doc) {
    const out = Object.values(s.allocations || {}).flatMap((a) =>
        a.spans.filter((x) => x.sessionId === doc._id),
    );
    const suppressions = s.device?.suppressed[digest(doc._id)] || [];
    for (const suppression of suppressions)
        out.push({ begin: suppression.from, end: suppression.end == null ? doc.end : suppression.end });
    for (const l of Object.values(s.ledger || {})) {
        if (l.allocation || !l.source?.includes(doc._id)) continue;
        out.push({
            begin: l.basis === 'active' ? doc.start : (l.coverageBegin ?? l.begin),
            end: l.basis === 'active' ? doc.end : l.end == null ? null : (l.coverageEnd ?? l.end),
        });
    }
    return out;
}
function indexCuts(s, docs) {
    const map = new Map(),
        byId = new Map(docs.map((d) => [d._id, d]));
    const add = (id, x) => {
        if (!map.has(id)) map.set(id, []);
        map.get(id).push(x);
    };
    for (const a of Object.values(s.allocations || {})) for (const x of a.spans) add(x.sessionId, x);
    for (const list of Object.values(s.device?.suppressed || {}))
        for (const x of list) add(x.sessionId, { begin: x.from, end: x.end ?? byId.get(x.sessionId)?.end });
    for (const l of Object.values(s.ledger || {}))
        if (!l.allocation)
            for (const id of l.source || []) {
                const d = byId.get(id);
                if (d)
                    add(id, {
                        begin: l.basis === 'active' ? d.start : (l.coverageBegin ?? l.begin),
                        end: l.basis === 'active' ? d.end : l.end == null ? null : (l.coverageEnd ?? l.end),
                    });
            }
    return map;
}
function available(s, docs) {
    const index = indexCuts(s, docs);
    return docs.flatMap((d) => {
        const occupied = index.get(d._id) || [];
        if (!occupied.length) return [d];
        // Aggregate active measurements cannot be divided between partially covered intervals.
        const remainder = subtract(d.start, d.end, occupied);
        return remainder.map((x) => ({ ...d, start: x.begin, end: x.end, active: null }));
    });
}
function reserved(s, block) {
    return block.source.some((id) => {
        const spans = Object.values(s.allocations || {}).flatMap((a) =>
            a.spans.filter((x) => x.sessionId === id),
        );
        const suppressed = (s.device?.suppressed[digest(id)] || []).map((x) => ({
            begin: x.from,
            end: x.end,
        }));
        return spans.concat(suppressed).some(
            (x) =>
                block.basis === 'active' ||
                overlap(x, {
                    begin: block.coverageBegin ?? block.begin,
                    end: block.coverageEnd ?? block.end,
                }),
        );
    });
}
function destination(row) {
    const out = {
        customer: Number(row.customer) || 0,
        project: Number(row.project),
        activity: Number(row.activity),
        description: String(row.description || '').slice(0, 1000),
        tags: String(row.tags || '').slice(0, 500),
        billable: row.billable !== false,
        basis: row.basis === 'active' ? 'active' : 'connected',
    };
    if (![out.project, out.activity].every((n) => Number.isInteger(n) && n > 0))
        throw Error('Choose a project and activity');
    return out;
}
function suppress(cfg, id, from) {
    const list = cfg.suppressed[digest(id)] || (cfg.suppressed[digest(id)] = []);
    if (!list.some((x) => x.end == null)) list.push({ sessionId: id, from, end: null });
}
function span(d, begin, end) {
    return { sessionId: d._id, nodeid: d.nodeid, name: d.nodename || d.nodeid, type: d.type, begin, end };
}
function make(docs, dest, begin, end, origin) {
    return {
        id: crypto.randomUUID(),
        revision: 1,
        ...dest,
        begin,
        end,
        origin,
        status: end == null ? 'recording-local' : 'review',
        source: docs.map((d) => d._id),
        spans: docs.map((d) => span(d, Math.max(begin, d.start), end == null ? null : Math.min(end, d.end))),
        review: end != null,
        blocks: [],
        updated: Date.now(),
    };
}
function revise(a) {
    a.revision++;
    a.updated = Date.now();
}
class Device {
    constructor(service) {
        this.s = service;
    }
    helpers() {
        return require('./kimai');
    }
    async owned(user, ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 100)
            throw Error('Select one or more connections');
        const docs = await Promise.all([...new Set(ids)].map((id) => this.s.db.getSession(id)));
        if (
            docs.some(
                (d) => !d || d.userid !== user._id || d.guest || (d.domain || '') !== (user.domain || ''),
            )
        )
            throw Error('Connection is not accessible');
        const allowed = await this.s.sessions(user, {
            start: Math.min(...docs.map((d) => d.start)),
            end: Date.now() + 1000,
            scope: 'all',
        });
        if (docs.some((d) => !allowed.some((x) => x._id === d._id))) throw Error('Device permission changed');
        return docs;
    }
    public(a, s) {
        const { draft, ...out } = a;
        out.prompt = a.prompt || s.device?.preferences.prompt || 'always';
        out.overlap = (a.blocks || []).map((id) => s.ledger[id]?.overlap).find(Boolean) || null;
        out.seconds = Math.max(0, ((a.end ?? second(Date.now())) - a.begin) / 1000);
        out.remoteIds = (a.blocks || []).map((id) => s.ledger[id]?.remoteId).filter(Boolean);
        out.remoteSeconds = (a.blocks || []).reduce((n, id) => n + (s.ledger[id]?.remoteSeconds || 0), 0);
        out.draft = draft || null;
        return out;
    }
    async state(user, nodeid) {
        return this.s.serial(this.s.key(user), async () => {
            const s = await this.s.state(user);
            const d = init(s);
            const global = (await this.s.db.getSetting('kimai:server')) || {};
            const connected = !!s.token && s.server === global.url;
            const docs = await this.s.sessions(user, {
                start: d.since,
                end: Date.now() + 1000,
                scope: 'all',
            });
            if (connected) await this.refresh(user, s, docs);
            await this.s.save(user, s);
            const { match } = this.helpers();
            const visible = docs.filter((x) => !nodeid || x.nodeid === nodeid);
            const permitted = new Set(docs.map((x) => x._id));
            const allocations = Object.values(s.allocations).filter(
                (a) =>
                    a.source.every((id) => permitted.has(id)) &&
                    (!nodeid || a.spans.some((x) => x.nodeid === nodeid)),
            );
            const reviews = Object.values(s.allocations).filter(
                (a) => a.review && a.source.every((id) => permitted.has(id)),
            );
            return {
                csrf: this.s.nonce(user),
                connected,
                url: global.url || '',
                timezone: s.tz || 'UTC',
                serverNow: Date.now(),
                preferences: d.preferences,
                activeConnections: docs.filter((x) => x.end == null).length,
                sessions: visible.map((x) => ({
                    id: x._id,
                    nodeid: x.nodeid,
                    name: x.nodename || x.nodeid,
                    type: x.type,
                    active: x.active ?? null,
                    mapped:
                        x.source === 'live' &&
                        !x.guest &&
                        !!match(x, s.rules || []) &&
                        subtract(x.start, x.end, cuts(s, x)).some((piece) => piece.end == null),
                    basis: match(x, s.rules || [])?.basis || null,
                    start: x.start,
                    end: x.end,
                })),
                allocations: allocations
                    .sort((a, b) => b.updated - a.updated)
                    .slice(0, 100)
                    .map((a) => this.public(a, s)),
                reviews: reviews
                    .sort((a, b) => b.updated - a.updated)
                    .slice(0, 200)
                    .map((a) => this.public(a, s)),
                remoteStartSupported: false,
                remoteStartReason:
                    'Recording locally preserves unrelated Kimai timers. Completed intervals are sent after review.',
            };
        });
    }
    async refresh(user, s, docs) {
        const cfg = init(s),
            now = second(Date.now()),
            { match, build } = this.helpers();
        const mapped = (doc, r) =>
            destination({
                ...r,
                ...(build(
                    [{ ...doc, end: doc.end ?? Math.max(now, doc.start + 1000) }],
                    [{ ...r, minSeconds: 0 }],
                    s.tz,
                )[0] || {}),
            });
        // Adopt existing owned live records; their eventual end must still reach Kimai.
        for (const l of Object.values(s.ledger))
            if (l.live && l.end == null && !l.allocation && l.status !== 'kept') {
                let known;
                try {
                    known = await this.owned(user, l.source);
                } catch (e) {
                    l.status = 'conflict';
                    l.error = 'Owned timer needs review in Kimai: ' + e.message;
                    continue;
                }
                if (known.some((x) => !x || x.userid !== user._id || x.guest)) continue;
                const a = make(known, l, l.begin, null, 'legacy');
                a.blocks = [l.id];
                a.remoteLive = true;
                a.status = 'recording';
                l.allocation = a.id;
                s.allocations[a.id] = a;
            }
        for (const a of Object.values(s.allocations)) {
            if (a.end != null || a.status === 'excluded') continue;
            const known = await Promise.all(a.spans.map((x) => this.s.db.getSession(x.sessionId)));
            let changed = false;
            for (let i = 0; i < a.spans.length; i++) {
                const x = a.spans[i],
                    doc = known[i];
                if (x.end != null) continue;
                if (!doc || doc.truncated) {
                    a.error = 'Connection end is uncertain; review the end time before sending';
                    a.review = true;
                    a.status = 'attention';
                    continue;
                }
                if (doc.end != null) {
                    x.end = Math.max(x.begin, second(doc.end));
                    changed = true;
                }
            }
            if (a.spans.every((x) => x.end != null)) {
                a.end = Math.max(...a.spans.map((x) => x.end));
                a.review = true;
                a.status = 'review';
                excludeShort(a, known, s);
                changed = true;
            }
            if (changed) revise(a);
        }
        for (const item of Object.values(cfg.suppressed).flat()) {
            if (item.end != null) continue;
            const doc = await this.s.db.getSession(item.sessionId);
            if (doc?.end != null) item.end = Math.max(item.from, second(doc.end));
        }
        const occupiedIndex = indexCuts(s, docs);
        for (const doc of docs) {
            if (doc.source !== 'live' || doc.guest) continue;
            const r = match(doc, s.rules || []),
                rest = subtract(doc.start, doc.end, occupiedIndex.get(doc._id) || []);
            if (!rest.length) continue;
            if (doc.end == null) {
                if (!s.live || !r || r.basis === 'active') continue;
                const piece = rest.find((x) => x.end == null);
                if (!piece) continue;
                const current = Object.values(s.allocations).find((a) => a.end == null);
                if (
                    current &&
                    (current.project !== r.project ||
                        current.activity !== r.activity ||
                        current.billable !== (r.billable !== false) ||
                        current.basis !== r.basis)
                )
                    continue;
                if (current) {
                    const contribution = mapped(doc, r);
                    current.description = [...new Set([current.description, contribution.description])].join('; ').slice(0, 1000);
                    current.tags = [...new Set((current.tags + ',' + contribution.tags).split(',').filter(Boolean))].join(',');
                    current.source.push(doc._id);
                    current.spans.push(ruleSpan(doc, Math.max(piece.begin, current.begin), null, r, cfg));
                    current.prompt = strictPrompt(
                        current.prompt || cfg.preferences.prompt,
                        effectivePrompt(r, cfg),
                    );
                    revise(current);
                } else {
                    const a = make([doc], mapped(doc, r), piece.begin, null, 'rule');
                    a.prompt = effectivePrompt(r, cfg);
                    a.spans = [ruleSpan(doc, piece.begin, null, r, cfg)];
                    s.allocations[a.id] = a;
                }
            } else {
                // No historical-import popup. Open sessions spanning adoption remain eligible.
                if (doc.end < cfg.since || !r) continue;
                for (const piece of rest) {
                    if (piece.end <= piece.begin) continue;
                    const a = make([doc], mapped(doc, r), piece.begin, piece.end, 'rule');
                    a.prompt = effectivePrompt(r, cfg);
                    a.spans = [ruleSpan(doc, piece.begin, piece.end, r, cfg)];
                    if (!doc.truncated && doc.end - doc.start < minimum(r, cfg) * 1000) {
                        a.status = 'excluded';
                        a.review = false;
                        a.exclusionReason = 'Below minimum connected-session duration';
                        s.allocations[a.id] = a;
                        continue;
                    }
                    if (r?.basis === 'active') {
                        a.sourceEnd = doc.end;
                        a.active = doc.active;
                        if (doc.active == null || piece.begin !== doc.start || piece.end !== doc.end)
                            a.error =
                                'Active-time measurement unavailable or partially covered; enter a reviewed duration';
                        else {
                            a.seconds = Math.min(
                                Math.max(0, Math.round(doc.active)),
                                (doc.end - doc.start) / 1000,
                            );
                            a.end = doc.start + a.seconds * 1000;
                            if (a.seconds === 0) {
                                a.status = 'excluded';
                                a.review = false;
                            }
                        }
                        if (
                            docs.some(
                                (x) =>
                                    x._id !== doc._id && !x.guest &&
                                    (!!match(x, s.rules || []) || Object.values(s.allocations).some((a) =>
                                        a.status !== 'excluded' && a.source.includes(x._id))) &&
                                    x.start < doc.end && doc.start < (x.end ?? Infinity),
                            )
                        )
                            a.error = 'Overlapping activity requires a reviewed duration';
                    }
                    if (doc.truncated) a.error = 'Connection end is uncertain; review the end time';
                    const merged =
                        !a.error &&
                        a.origin === 'rule' &&
                        a.basis === 'connected' &&
                        Object.values(s.allocations).find(
                            (x) =>
                                x.origin === 'rule' &&
                                x.status === 'review' &&
                                !x.error &&
                                !x.draft &&
                                !x.blocks.length &&
                                x.basis === a.basis &&
                                x.project === a.project &&
                                x.activity === a.activity &&
                                x.billable === a.billable &&
                                x.begin <= a.end &&
                                a.begin <= x.end,
                        );
                    if (merged) {
                        merged.begin = Math.min(merged.begin, a.begin);
                        merged.end = Math.max(merged.end, a.end);
                        merged.source = [...new Set(merged.source.concat(a.source))];
                        merged.spans.push(...a.spans);
                        merged.tags = [...new Set((merged.tags + ',' + a.tags).split(',').filter(Boolean))].join(',');
                        merged.prompt = strictPrompt(merged.prompt || cfg.preferences.prompt, a.prompt);
                        merged.description = [...new Set([merged.description, a.description])]
                            .join('; ')
                            .slice(0, 1000);
                        revise(merged);
                    } else s.allocations[a.id] = a;
                }
            }
        }
        // Union all untouched automatic connected recordings, including transitive bridges
        // and a completed contributor that overlaps a still-open connection.
        const groups = new Map();
        for (const a of Object.values(s.allocations).sort((a, b) => a.begin - b.begin)) {
            if (a.origin !== 'rule' || a.basis !== 'connected' || a.error || a.draft ||
                a.blocks.length || !['review', 'recording-local'].includes(a.status)) continue;
            const key = JSON.stringify([a.project, a.activity, a.billable]);
            const prior = groups.get(key);
            if (!prior || a.begin > infinity(prior.end)) {
                groups.set(key, a);
                continue;
            }
            prior.end = prior.end == null || a.end == null ? null : Math.max(prior.end, a.end);
            prior.source = [...new Set(prior.source.concat(a.source))];
            prior.spans.push(...a.spans);
            prior.prompt = strictPrompt(prior.prompt || cfg.preferences.prompt, a.prompt || cfg.preferences.prompt);
            prior.description = [...new Set([prior.description, a.description])].join('; ').slice(0, 1000);
            prior.tags = [...new Set((prior.tags + ',' + a.tags).split(',').filter(Boolean))].join(',');
            prior.review = prior.end != null;
            prior.status = prior.review ? 'review' : 'recording-local';
            revise(prior);
            delete s.allocations[a.id];
        }
        // Flag both destinations before any automation can bill one side of an overlap.
        const entries = Object.values(s.allocations)
            .filter((a) => !['excluded', 'kept'].includes(a.status))
            .sort((a, b) => a.begin - b.begin);
        for (let i = 0; i < entries.length; i++)
            for (let j = i + 1; j < entries.length; j++) {
                const a = entries[i],
                    b = entries[j];
                if (b.begin >= infinity(a.end)) break;
                if (
                    overlap(a, b) &&
                    (a.project !== b.project ||
                        a.activity !== b.activity ||
                        a.basis !== b.basis ||
                        a.billable !== b.billable)
                ) {
                    for (const x of [a, b])
                        if (x.end != null && x.status !== 'synced') {
                            x.error = 'Overlapping destinations require review';
                            x.review = true;
                        }
                }
            }
        await this.s.save(user, s);
    }
    async send(user, s, a, c, stopOnly = false) {
        const { days, ambiguous } = this.helpers();
        if (a.end == null) return;
        if (a.end <= a.begin) {
            a.error = 'Recording has no positive duration';
            a.status = 'attention';
            await this.s.save(user, s);
            return;
        }
        if (ambiguous(a.begin, s.tz) || ambiguous(a.end, s.tz))
            throw Error('Ambiguous daylight-saving timestamp');
        const pieces = days(a.begin, a.end, s.tz);
        if (a.blocks.length > pieces.length) throw Error('Changed daily membership requires review in Kimai');
        for (let i = 0; i < pieces.length; i++) {
            const id = a.blocks[i] || digest([a.id, pieces[i][0]]);
            if (!a.blocks.includes(id)) a.blocks.push(id);
            const block = {
                ...a,
                id,
                begin: pieces[i][0],
                end: pieces[i][1],
                live: false,
                source: a.source,
                sourceBegin: Math.min(...a.spans.map((x) => x.begin)),
                sourceEnd: Math.max(...a.spans.map((x) => x.end ?? a.end)),
                coverageBegin: pieces[i][0],
                coverageEnd: pieces[i][1],
                allocation: a.id,
            };
            await this.s.save(user, s); // Membership before a remote operation.
            await this.s.sync(user, s, c, block);
            s.ledger[id].allocation = a.id;
            if (s.ledger[id].status !== 'synced') {
                a.status = 'attention';
                a.error = s.ledger[id].error;
                await this.s.save(user, s);
                return;
            }
        }
        a.remoteLive = false;
        a.status = stopOnly ? 'review' : 'synced';
        a.review = stopOnly;
        a.error = null;
        revise(a);
        await this.s.save(user, s);
    }
    async flush(user, s, c) {
        const cfg = init(s),
            now = Date.now(),
            time = require('./aggregate'),
            p = time.partsIn(now, s.tz),
            today = time.fromLocal(p.y, p.m, p.d, 0, 0, s.tz);
        for (const a of Object.values(s.allocations)) {
            if (a.end == null || ['excluded', 'synced', 'kept'].includes(a.status)) continue;
            if (a.remoteLive) {
                try {
                    await this.owned(user, a.source);
                    await this.send(user, s, a, c, true);
                } catch (e) {
                    a.error = e.message;
                    a.review = true;
                    await this.s.save(user, s);
                }
                continue;
            }
            const records = a.blocks.map((id) => s.ledger[id]).filter(Boolean);
            if (
                records.some(
                    (l) =>
                        ['locked', 'conflict', 'creating'].includes(l.status) ||
                        (l.retryAt && l.retryAt > now && l.status !== 'synced'),
                )
            )
                continue;
            if (
                a.sendRequested ||
                (a.origin === 'rule' &&
                    (a.prompt || cfg.preferences.prompt) !== 'always' &&
                    !a.error &&
                    (s.live || (s.nightly && p.h >= 2 && a.end <= today)))
            ) {
                try {
                    await this.owned(user, a.source);
                    await this.send(user, s, a, c);
                } catch (e) {
                    a.error = e.message;
                    a.status = 'attention';
                    a.review = true;
                    await this.s.save(user, s);
                }
            }
        }
    }
    async action(user, s, input) {
        const cfg = init(s),
            op = input.command;
        if (!/^[a-zA-Z0-9-]{8,100}$/.test(input.requestId || '')) throw Error('Missing request identity');
        const previous = cfg.operations[input.requestId],
            bodyHash = digest(input);
        if (previous) {
            if (previous.hash !== bodyHash) throw Error('Request identity was reused for different changes');
            if (previous.result) return previous.result;
            throw Error('Previous request outcome requires refresh; it will not be repeated automatically');
        }
        if (Object.keys(cfg.operations).length > 500)
            for (const key of Object.keys(cfg.operations).slice(0, 100))
                if (cfg.operations[key].result) delete cfg.operations[key];
        const remember = async (result) => {
            cfg.operations[input.requestId] = { hash: bodyHash, result };
            await this.s.save(user, s);
            return result;
        };
        if (op === 'preferences') {
            if (
                !['always', 'issues', 'never'].includes(input.prompt) ||
                !['drawer', 'dialog'].includes(input.presentation)
            )
                throw Error('Invalid review preference');
            const minSeconds =
                input.minSeconds == null ? cfg.preferences.minSeconds : Number(input.minSeconds);
            if (!Number.isInteger(minSeconds) || minSeconds < 0 || minSeconds > 86400)
                throw Error('Minimum duration must be whole seconds between 0 and 86400');
            cfg.preferences = { prompt: input.prompt, presentation: input.presentation, minSeconds };
            return remember({ ok: true });
        }
        if (!s.token) throw Error('Connect to Kimai in your personal settings first');
        if (op === 'start') {
            const docs = await this.owned(user, input.sessions),
                now = second(Date.now()),
                dest = destination(input.destination || {});
            if (docs.some((d) => d.end != null))
                throw Error('A selected connection ended; refresh before starting');
            if (dest.basis !== 'connected')
                throw Error('Active time is finalized after disconnect; use the review inbox');
            let begin = input.from === 'connection' ? Math.min(...docs.map((d) => d.start)) : now;
            // Explicit resume lifts future suppression, but never fills an earlier stopped gap.
            for (const doc of docs) {
                const sup = (cfg.suppressed[digest(doc._id)] || []).find((x) => x.end == null);
                if (sup && input.from === 'connection')
                    throw Error('Stopped time cannot be included automatically; start from now');
                const blocked = cuts(s, doc).filter((x) => x !== sup);
                if (
                    blocked.some(
                        (x) =>
                            overlap({ begin: Math.max(begin, doc.start), end: null }, x) &&
                            !(sup && x.begin === sup.from && x.end == null),
                    )
                )
                    throw Error('This connection already has recorded or excluded time; refresh');
            }
            const current = Object.values(s.allocations).find(
                (a) => a.end == null && a.status !== 'excluded',
            );
            if (
                current &&
                (current.project !== dest.project ||
                    current.activity !== dest.activity ||
                    current.billable !== dest.billable ||
                    current.basis !== dest.basis)
            )
                throw Error('A different destination is already recording; stop it before switching');
            const c = await this.s.client(s);
            await this.validateDestination(c, dest);
            const timeline = await c.list('/timesheets'),
                remote = timeline.find((r) => !r.end);
            if (
                input.from === 'connection' &&
                timeline.some((r) => r.end && Date.parse(r.begin) < now && begin < Date.parse(r.end))
            )
                throw Error(
                    'Earlier connection time overlaps Kimai time; start from now or review it separately',
                );
            if (remote && !current?.blocks.some((id) => s.ledger[id]?.remoteId === remote.id))
                throw Error(
                    'An unrelated timer is running in Kimai. Finish it there before starting, or review this connection later.',
                );
            if (current?.remoteLive && begin < current.begin)
                throw Error('Earlier time needs a separate reviewed entry');
            const a = current || make(docs, dest, begin, null, 'manual');
            if (current) {
                a.source.push(...docs.map((d) => d._id));
                a.spans.push(...docs.map((d) => span(d, Math.max(begin, d.start), null)));
                a.begin = Math.min(a.begin, begin);
                revise(a);
            }
            for (const doc of docs) {
                const sup = (cfg.suppressed[digest(doc._id)] || []).find((x) => x.end == null);
                if (sup) sup.end = now;
            }
            s.allocations[a.id] = a;
            return remember({ ok: true, id: a.id });
        }
        if (op === 'create') {
            if (!['projects', 'activities'].includes(input.kind)) throw Error('Unsupported destination type');
            const name = String(input.name || '').trim(),
                parent = Number(input.parent);
            if (!name || name.length > 150 || !Number.isInteger(parent) || parent <= 0)
                throw Error('Enter a name and select its parent');
            const createKey = digest([input.kind, parent, name.toLowerCase()]);
            if (Object.values(cfg.operations).some((x) => x.createKey === createKey && !x.result))
                throw Error(
                    'An earlier create is unconfirmed. Check Kimai before attempting another creation.',
                );
            const c = await this.s.client(s),
                path = '/' + input.kind;
            const existing = await c.list(
                path + '?' + (input.kind === 'projects' ? 'customer' : 'project') + '=' + parent,
            );
            if (existing.some((x) => String(x.name).toLowerCase() === name.toLowerCase()))
                throw Error('A destination with this name already exists; select it from the list');
            cfg.operations[input.requestId] = { hash: bodyHash, attempted: true, createKey };
            await this.s.save(user, s);
            try {
                const created = await c.request('POST', path, {
                    name,
                    visible: true,
                    [input.kind === 'projects' ? 'customer' : 'project']: parent,
                    comment: '[meshcentral-create:' + input.requestId + ']',
                });
                return remember({ ok: true, id: created.id, name: created.name });
            } catch (e) {
                if (e.status >= 400 && e.status < 500) {
                    delete cfg.operations[input.requestId];
                    await this.s.save(user, s);
                }
                throw Error(
                    e.status === 403
                        ? 'Kimai does not permit creating this destination. Create it in Kimai or contact its administrator.'
                        : 'Creation could not be confirmed. Check Kimai before creating again: ' + e.message,
                );
            }
        }
        const a = s.allocations[input.id];
        if (!a) throw Error('Recording not found');
        await this.owned(user, a.source);
        if (op === 'claim') {
            if (!a.review || a.presentedRevision === a.revision) return remember({ ok: true, show: false });
            a.presentedRevision = a.revision;
            return remember({ ok: true, show: true });
        }
        if (input.revision !== a.revision)
            throw Error('Recording changed in another window. Refresh before saving.');
        if (op === 'draft') {
            a.draft = { ...(a.draft || {}), ...this.draft(input.row || {}) };
            return remember({ ok: true, revision: a.revision });
        }
        if (op === 'defer') {
            a.review = true;
            a.draft = { ...(a.draft || {}), ...this.draft(input.row || {}) };
            return remember({ ok: true });
        }
        if (op === 'stop') {
            if (a.end != null) return remember({ ok: true });
            const selected = input.sessionIds || a.source;
            if (!Array.isArray(selected) || !selected.length || selected.some((id) => !a.source.includes(id)))
                throw Error('Invalid contributor selection');
            const now = second(Date.now());
            for (const x of a.spans)
                if (x.end == null && selected.includes(x.sessionId)) {
                    x.end = Math.max(x.begin, now);
                    suppress(cfg, x.sessionId, now);
                }
            if (a.spans.every((x) => x.end != null)) {
                a.end = Math.max(...a.spans.map((x) => x.end));
                a.review = true;
                a.status = 'review';
            }
            revise(a);
            await this.s.save(user, s);
            if (a.remoteLive && a.end != null) {
                try {
                    await this.send(user, s, a, await this.s.client(s), true);
                } catch (e) {
                    a.status = 'attention';
                    a.error = 'Stop confirmation pending: ' + e.message;
                    await this.s.save(user, s);
                }
            }
            return remember({ ok: true });
        }
        if (op === 'exclude') {
            if (input.confirmed !== true)
                throw Error('Confirm the recording duration and affected contributors before discarding');
            const now = second(Date.now());
            for (const x of a.spans)
                if (x.end == null) {
                    x.end = now;
                    suppress(cfg, x.sessionId, now);
                }
            a.end = a.end ?? now;
            a.review = false;
            a.status = 'excluded';
            revise(a);
            await this.s.save(user, s);
            // Never remove an unrelated, remotely edited, locked or uncertain record.
            let c;
            try {
                c = await this.s.client(s);
            } catch (e) {
                a.review = true;
                a.error = 'Excluded locally; remote removal needs review: ' + e.message;
                return remember({ ok: true });
            }
            const { snapshot } = this.helpers();
            for (const id of a.blocks) {
                const l = s.ledger[id];
                if (!l) continue;
                if (l.attempted && !l.remoteId) {
                    a.review = true;
                    a.error = 'Excluded locally; uncertain remote create needs reconciliation';
                    continue;
                }
                if (!l.remoteId) {
                    l.status = 'excluded';
                    continue;
                }
                try {
                    const remote = await c.request('GET', '/timesheets/' + l.remoteId);
                    if (remote.exported || remote.locked || digest(snapshot(remote)) !== digest(l.last))
                        throw Error('Remote entry changed or is locked');
                    l.deletePending = true;
                    await this.s.save(user, s);
                    await c.request('DELETE', '/timesheets/' + l.remoteId);
                    l.status = 'excluded';
                    l.deletePending = false;
                } catch (e) {
                    if (e.status === 404) {
                        l.status = 'excluded';
                        l.deletePending = false;
                    } else {
                        a.review = true;
                        a.error = 'Excluded locally; remote removal needs review: ' + e.message;
                    }
                }
            }
            return remember({ ok: true });
        }
        if (op === 'resolve') {
            if (!a.blocks.length || a.end == null)
                throw Error('Stop the recording before resolving its remote version');
            if (!['keep', 'replace', 'retry'].includes(input.choice) || input.reviewed !== true)
                throw Error('Review the remote entry before choosing a resolution');
            const c = await this.s.client(s),
                { snapshot } = this.helpers();
            if (input.choice === 'retry') {
                const entries = await c.list('/timesheets');
                for (const id of a.blocks) {
                    const l = s.ledger[id];
                    if (!l || l.remoteId || !l.attempted)
                        throw Error('This entry is not an uncertain create');
                    if (entries.some((r) => String(r.description || '').includes('[' + l.marker + ']')))
                        throw Error(
                            'The remote entry exists; save again to reconcile it instead of creating another',
                        );
                    l.attempted = false;
                    l.status = 'pending';
                    delete l.retryAt;
                }
                await this.s.save(user, s);
                return remember(
                    await this.action(user, s, {
                        ...input,
                        command: 'save',
                        requestId: input.requestId + '-retry',
                        mode: 'whole',
                        reviewed: true,
                    }),
                );
            }
            for (const id of a.blocks) {
                const l = s.ledger[id];
                if (!l?.remoteId) throw Error('Remote create must be reconciled before resolution');
                let remote;
                try {
                    remote = await c.request('GET', '/timesheets/' + l.remoteId);
                } catch (e) {
                    if (input.choice === 'keep' && e.status === 404)
                        remote = { description: 'Deleted in Kimai' };
                    else throw e;
                }
                if (input.choice === 'replace' && (remote.exported || remote.locked))
                    throw Error('Locked or exported entries cannot be replaced');
                if (!remote.end && remote.id)
                    throw Error('The remote timer is still running; confirm its end before resolving');
                l.last = snapshot(remote);
                if (input.choice === 'keep') l.status = 'kept';
            }
            if (input.choice === 'keep') {
                a.status = 'kept';
                a.review = false;
                a.remoteLive = false;
                a.error = null;
                revise(a);
                return remember({ ok: true });
            }
            a.draft = { ...(a.draft || {}), ...this.draft(input.row || {}) };
            await this.s.save(user, s);
            return remember(
                await this.action(user, s, {
                    ...input,
                    command: 'save',
                    requestId: input.requestId + '-replace',
                    mode: 'whole',
                    reviewed: true,
                }),
            );
        }
        if (op === 'save') {
            const row = { ...a, ...a.draft, ...input.row },
                dest = destination(row),
                c = await this.s.client(s);
            await this.validateDestination(c, dest);
            if (a.status === 'excluded') throw Error('Excluded recording cannot be sent again');
            if (a.end == null) {
                const changed =
                    a.project !== dest.project ||
                    a.activity !== dest.activity ||
                    a.billable !== dest.billable;
                if (changed && input.mode !== 'whole') {
                    if (a.remoteLive)
                        throw Error('Stop the existing remote timer before switching its destination');
                    const now = second(Date.now()),
                        docs = await this.owned(
                            user,
                            a.spans.filter((x) => x.end == null).map((x) => x.sessionId),
                        );
                    a.spans.forEach((x) => {
                        if (x.end == null) x.end = now;
                    });
                    a.end = now;
                    a.review = true;
                    a.status = 'review';
                    revise(a);
                    const next = make(docs, dest, now, null, 'manual');
                    s.allocations[next.id] = next;
                } else {
                    if (changed && input.reviewed !== true)
                        throw Error('Review the whole-recording destination change');
                    Object.assign(a, dest);
                    revise(a);
                }
                delete a.draft;
                return remember({ ok: true });
            }
            const { epoch } = this.helpers();
            const begin = row.beginLocal ? epoch(row.beginLocal, s.tz) : a.begin,
                end = row.endLocal ? epoch(row.endLocal, s.tz) : a.end;
            if (!Number.isFinite(begin) || !Number.isFinite(end) || end <= begin || end > Date.now())
                throw Error('Enter a valid completed interval');
            if (a.error && input.reviewed !== true)
                throw Error('Review the flagged recording before sending');
            if (/Active-time|Overlapping activity/.test(a.error || '') && begin === a.begin && end === a.end)
                throw Error('Enter a reviewed duration for missing or overlapping activity');
            for (const other of Object.values(s.allocations))
                if (other.id !== a.id && other.status !== 'excluded' && overlap({ begin, end }, other))
                    throw Error('This time overlaps another recording; adjust it before sending');
            Object.assign(a, dest, { begin, end, sendRequested: true });
            delete a.draft;
            revise(a);
            await this.s.save(user, s);
            await this.send(user, s, a, c);
            return remember({ ok: true });
        }
        throw Error('Unknown device recording action');
    }
    draft(row) {
        return Object.fromEntries(
            ['customer', 'project', 'activity', 'description', 'tags', 'billable', 'beginLocal', 'endLocal']
                .filter((k) => row[k] != null)
                .map((k) => [k, typeof row[k] === 'string' ? row[k].slice(0, 1000) : row[k]]),
        );
    }
    async validateDestination(c, d) {
        const projects = await c.list(
            '/projects?ignoreDates=1' + (d.customer ? '&customer=' + d.customer : ''),
        );
        const p = projects.find((x) => x.id === d.project);
        if (!p || p.visible === false) throw Error('Project is unavailable for this customer');
        const activities = await c.list('/activities?project=' + d.project);
        if (!activities.some((x) => x.id === d.activity && x.visible !== false))
            throw Error('Activity is unavailable for this project');
    }
}
module.exports = { Device, init, subtract, available, cuts, destination, reserved };
