/** Personal Kimai synchronization. No credentials or remote work in the browser. */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const time = require('./aggregate');
const hash = (x) =>
    crypto
        .createHash('sha256')
        .update(JSON.stringify(x) || 'null')
        .digest('hex');
const copy = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
function wall(ms, tz) {
    return time.isoLocal(ms, tz).substring(0, 19);
}
function epoch(value, tz) {
    if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?$/.test(value))
        throw Error('Invalid local date/time');
    const v = value.length === 16 ? value + ':00' : value,
        a = v.match(/\d+/g).map(Number);
    const ms = time.fromLocal(a[0], a[1] - 1, a[2], a[3], a[4], tz) + a[5] * 1000;
    if (wall(ms, tz) !== v || ambiguous(ms, tz)) throw Error('Invalid or ambiguous daylight-saving timestamp');
    return ms;
}
function ambiguous(ms, tz) {
    const s = wall(ms, tz);
    return [-7200000, -3600000, -1800000, 1800000, 3600000, 7200000].some((d) => wall(ms + d, tz) === s);
}
function days(begin, end, tz) {
    const out = [];
    while (begin < end) {
        const p = time.partsIn(begin, tz),
            next = time.fromLocal(p.y, p.m, p.d + 1, 0, 0, tz);
        if (next <= begin) throw Error('Cannot resolve local midnight');
        out.push([begin, Math.min(end, next)]);
        begin = Math.min(end, next);
    }
    return out;
}
function rules(input) {
    if (!Array.isArray(input) || input.length > 100) throw Error('At most 100 rules are allowed');
    return input.map((r, i) => {
        if (!Number.isInteger(+r.project) || +r.project <= 0 || !Number.isInteger(+r.activity) || +r.activity <= 0)
            throw Error('Select a project and activity for every rule');
        return {
            id: String(r.id || crypto.randomUUID()),
            group: String(r.group || ''),
            device: String(r.device || ''),
            type: String(r.type || ''),
            customer: +r.customer || 0,
            project: +r.project,
            activity: +r.activity,
            billable: r.billable !== false,
            basis: r.basis === 'active' ? 'active' : 'connected',
            description: String(r.description || '{device}: {types} ({sessions} sessions)').substring(0, 1000),
            tags: String(r.tags || '').substring(0, 500),
        };
    });
}
function match(s, rs) {
    return rs.find(
        (r) =>
            (!r.group || r.group === s.meshid) &&
            (!r.device || r.device === s.nodeid) &&
            (!r.type || r.type === s.type),
    );
}
function build(sessions, rs, tz) {
    const blocks = [];
    sessions
        .filter((s) => !s.guest && s.end != null)
        .forEach((s) => {
            const r = match(s, rs);
            if (!r) return;
            let issue = '',
                end = s.end;
            if (r.basis === 'active') {
                if (s.active == null) issue = 'Active-time measurement unavailable';
                else end = s.start + Math.min(Math.max(0, s.active), (s.end - s.start) / 1000) * 1000;
            }
            if (end <= s.start && !issue) return;
            days(s.start, Math.max(s.start + 1000, end), tz).forEach(([begin, finish]) => {
                const fields = {
                    device: s.nodename || s.nodeid,
                    group: s.meshname || s.meshid || '',
                    types: s.type,
                    admin: s.username || s.userid,
                    date: wall(begin, tz).slice(0, 10),
                    sessions: '1',
                };
                blocks.push({
                    begin,
                    end: finish,
                    project: r.project,
                    activity: r.activity,
                    billable: r.billable !== false,
                    basis: r.basis,
                    description: r.description.replace(
                        /\{(device|group|types|admin|date|sessions)\}/g,
                        (_, k) => fields[k],
                    ),
                    tags: [
                        ...new Set(
                            ['meshcentral'].concat(
                                r.tags
                                    .split(',')
                                    .map((t) => t.trim())
                                    .filter(Boolean),
                            ),
                        ),
                    ].join(','),
                    source: [s._id],
                    rule: r.id,
                    issue,
                    sourceBegin: s.start,
                    sourceEnd: s.end,
                });
            });
        });
    blocks.sort((a, b) => a.begin - b.begin || a.end - b.end);
    // Active measurements cannot be unioned: activity instants were not persisted.
    for (let i = 0; i < blocks.length; i++)
        for (let j = i + 1; j < blocks.length; j++) {
            const a = blocks[i],
                b = blocks[j];
            if (b.begin >= Math.max(a.end, a.sourceEnd)) break;
            if (
                a.source[0] !== b.source[0] &&
                Math.max(a.sourceBegin, b.sourceBegin) < Math.min(a.sourceEnd, b.sourceEnd) &&
                (a.basis === 'active' || b.basis === 'active')
            )
                a.issue = b.issue = 'Overlapping activity requires a reviewed duration';
            else if (
                a.begin < b.end &&
                b.begin < a.end &&
                (a.project !== b.project ||
                    a.activity !== b.activity ||
                    a.basis !== b.basis ||
                    a.billable !== b.billable)
            )
                a.issue = b.issue = 'Overlapping destinations require review';
        }
    const merged = [],
        previous = new Map();
    blocks.forEach((b) => {
        const key = [b.project, b.activity, b.billable, wall(b.begin, tz).slice(0, 10)].join('|'),
            candidate = previous.get(key);
        const prev = b.basis === 'connected' && !b.issue && candidate && b.begin <= candidate.end ? candidate : null;
        if (prev) {
            prev.end = Math.max(prev.end, b.end);
            prev.sourceEnd = Math.max(prev.sourceEnd, b.sourceEnd);
            prev.source = [...new Set(prev.source.concat(b.source))];
            prev.description = [...new Set([prev.description, b.description])].join('; ');
            prev.tags = [...new Set((prev.tags + ',' + b.tags).split(','))].join(',');
        } else {
            merged.push(b);
            if (!b.issue && b.basis === 'connected') previous.set(key, b);
        }
    });
    return merged.map((b) => {
        b.coverageBegin = b.begin;
        b.coverageEnd = b.end;
        b.source.sort();
        b.id = hash([b.source, b.begin, b.project, b.activity, b.basis]);
        b.seconds = (b.end - b.begin) / 1000;
        if (ambiguous(b.begin, tz) || ambiguous(b.end, tz)) b.issue = 'Ambiguous daylight-saving timestamp';
        return b;
    });
}
class Client {
    constructor(url, token) {
        this.url = new URL(url);
        if (
            this.url.protocol !== 'https:' ||
            this.url.username ||
            this.url.password ||
            this.url.search ||
            this.url.hash
        )
            throw Error('Kimai requires an HTTPS base URL without credentials, query, or fragment');
        this.token = token;
    }
    request(method, path, body) {
        const url = new URL(this.url.toString().replace(/\/$/, '') + '/api' + path);
        return new Promise((resolve, reject) => {
            const data = body == null ? null : JSON.stringify(body);
            const req = https.request(
                url,
                {
                    method,
                    headers: {
                        Authorization: 'Bearer ' + this.token,
                        Accept: 'application/json',
                        ...(data
                            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
                            : {}),
                    },
                    timeout: 20000,
                },
                (res) => {
                    let text = '';
                    res.on('data', (chunk) => {
                        text += chunk;
                        if (text.length > 8 * 1024 * 1024) req.destroy(Error('Kimai response too large'));
                    });
                    res.on('error', reject);
                    res.on('aborted', () => reject(Error('Kimai response interrupted')));
                    res.on('end', () => {
                        let json;
                        try {
                            json = text ? JSON.parse(text) : {};
                        } catch (_) {
                            return reject(Error('Kimai returned invalid JSON'));
                        }
                        if (res.statusCode < 200 || res.statusCode >= 300) {
                            const e = Error(
                                'Kimai HTTP ' +
                                    res.statusCode +
                                    (json.message ? ': ' + String(json.message).slice(0, 300) : ''),
                            );
                            e.status = res.statusCode;
                            return reject(e);
                        }
                        if (
                            this.timeline &&
                            /^\/timesheets(\/\d+)?$/.test(path) &&
                            ['POST', 'PATCH'].includes(method) &&
                            json.id
                        ) {
                            this.timeline = this.timeline.filter((r) => r.id !== json.id).concat([json]);
                        }
                        resolve(json);
                    });
                },
            );
            req.on('timeout', () => req.destroy(Error('Kimai request timed out; reconciliation required')));
            req.on('error', reject);
            if (data) req.write(data);
            req.end();
        });
    }
    async ensureTags(value, journal, persist) {
        const wanted = [...new Set(String(value || '').split(',').map(x => x.trim()).filter(Boolean))];
        const existing = new Set((await this.list('/tags')).map(t => typeof t === 'string' ? t : t.name));
        for (const name of wanted) {
            const key = hash(name);
            if (existing.has(name)) { delete journal[key]; continue; }
            if (journal[key]) throw Error('Tag creation is unconfirmed; check Kimai for "' + name + '" before retrying');
            journal[key] = { name, attempted: true };
            await persist();
            try {
                await this.request('POST', '/tags', { name, visible: true });
                delete journal[key]; existing.add(name); await persist();
            } catch (e) {
                if (e.status >= 400 && e.status < 500) { delete journal[key]; await persist(); }
                throw Error('Create the tag "' + name + '" in Kimai, then save again. ' + e.message);
            }
        }
        await persist();
    }
    async list(path) {
        if (path === '/timesheets' && this.timeline) return this.timeline;
        const finish = (out) => {
            if (path === '/timesheets') this.timeline = out;
            return out;
        };
        let out = [];
        for (let page = 1; page <= 10000; page++) {
            let rows;
            try {
                rows = await this.request(
                    'GET',
                    path + (path.includes('?') ? '&' : '?') + 'page=' + page + '&size=100',
                );
            } catch (e) {
                if (page > 1 && e.status === 404) return finish(out);
                throw e;
            }
            if (!Array.isArray(rows)) throw Error('Unexpected Kimai list response');
            if (page > 1 && rows.length && out.some((x) => x.id === rows[0].id)) return finish(out); // unpaginated destination endpoints
            out = out.concat(rows);
            if (rows.length < 100) return finish(out);
        }
        throw Error('Kimai pagination limit exceeded');
    }
}
class Vault {
    constructor(path) {
        this.path = path;
    }
    key() {
        try {
            return fs.readFileSync(this.path);
        } catch (e) {
            if (e.code !== 'ENOENT') throw e;
            const key = crypto.randomBytes(32);
            try {
                fs.writeFileSync(this.path, key, { flag: 'wx', mode: 0o600 });
                return key;
            } catch (e2) {
                if (e2.code === 'EEXIST') return fs.readFileSync(this.path);
                throw e2;
            }
        }
    }
    seal(token) {
        const iv = crypto.randomBytes(12),
            c = crypto.createCipheriv('aes-256-gcm', this.key(), iv);
        return [iv, c.update(token, 'utf8'), c.final(), c.getAuthTag()].map((b) => b.toString('base64'));
    }
    open(value) {
        const key = fs.readFileSync(this.path),
            d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(value[0], 'base64'));
        d.setAuthTag(Buffer.from(value[3], 'base64'));
        return Buffer.concat([d.update(Buffer.from(value[1], 'base64')), d.final()]).toString('utf8');
    }
}
function snapshot(r) {
    return {
        begin: r.begin,
        end: r.end || null,
        project: typeof r.project === 'object' ? r.project.id : r.project,
        activity: typeof r.activity === 'object' ? r.activity.id : r.activity,
        description: r.description || '',
        exported: !!r.exported,
        billable: !!r.billable,
        tags: (Array.isArray(r.tags)
            ? r.tags
            : String(r.tags || '')
                  .split(',')
                  .filter(Boolean)
        )
            .map((t) => (typeof t === 'object' ? t.name : t))
            .sort(),
        rate: r.rate,
        internalRate: r.internalRate,
        duration: r.duration,
    };
}
class Service {
    constructor(plugin, options = {}) {
        this.p = plugin;
        this.db = plugin.db;
        this.vault =
            options.vault || new Vault(plugin.meshServer.getConfigFilePath('plugin-connectionstats-kimai.key'));
        this.clientFactory = options.clientFactory || ((url, token) => new Client(url, token));
        this.locks = new Map();
        this.persisted = new Map();
        this.csrf = new Map();
        this.device = new (require('./kimai-device').Device)(this);
    }
    serial(key, fn) {
        const prev = this.locks.get(key) || Promise.resolve();
        const next = prev.catch(() => {}).then(fn);
        this.locks.set(key, next);
        return next.finally(() => {
            if (this.locks.get(key) === next) this.locks.delete(key);
        });
    }
    key(user) {
        return 'kimai:user:' + hash([user.domain || '', user._id]);
    }
    async state(user) {
        const s = (await this.db.getSetting(this.key(user))) || {
            rules: [],
            live: false,
            nightly: false,
            previews: {},
        };
        s.ledger = {};
        for (const id of s.ledgerIds || []) {
            const l = await this.db.getSetting(this.key(user) + ':block:' + id);
            if (l) {
                s.ledger[id] = l;
                this.persisted.set(this.key(user) + ':block:' + id, hash(l));
            }
        }
        s.allocations = {};
        for (const id of s.allocationIds || []) {
            const a = await this.db.getSetting(this.key(user) + ':allocation:' + id);
            if (a) s.allocations[id] = a;
        }
        return s;
    }
    async save(user, s) {
        const index = { ...s, ledgerIds: Object.keys(s.ledger) };
        delete index.ledger;
        index.allocationIds = Object.keys(s.allocations || {});
        delete index.allocations;
        for (const id of index.allocationIds) {
            const key = this.key(user) + ':allocation:' + id, value = s.allocations[id], digest = hash(value);
            if (this.persisted.get(key) !== digest) {
                await this.db.setSetting(key, value);
                this.persisted.set(key, digest);
            }
        }
        for (const id of index.ledgerIds) {
            const key = this.key(user) + ':block:' + id,
                digest = hash(s.ledger[id]);
            if (this.persisted.get(key) !== digest) {
                await this.db.setSetting(key, s.ledger[id]);
                this.persisted.set(key, digest);
            }
        }
        return this.db.setSetting(this.key(user), index);
    }
    async client(s) {
        const global = await this.db.getSetting('kimai:server');
        if (!global || !global.url || s.server !== global.url)
            throw Error('Connect your token to the configured Kimai server first');
        const c = this.clientFactory(global.url, this.vault.open(s.token));
        const me = await c.request('GET', '/users/me'),
            cfg = await c.request('GET', '/config/timesheet');
        const tz = me.timezone || (me.preferences || []).find((p) => p.name === 'timezone')?.value;
        if (me.id !== s.account.id || tz !== s.tz)
            throw Error('Kimai account or timezone changed; reconnect before syncing');
        const mode = cfg.trackingMode || cfg.tracking_mode;
        if (!['default', 'duration'].includes(mode)) throw Error('Incompatible Kimai tracking mode: ' + mode);
        return c;
    }
    async register(user) {
        await this.serial('registry', async () => {
            const r = (await this.db.getSetting('kimai:users')) || { users: [] };
            if (!r.users.includes(user._id)) {
                r.users.push(user._id);
                await this.db.setSetting('kimai:users', r);
            }
        });
    }
    nonce(user) {
        let n = this.csrf.get(user._id);
        if (!n) {
            n = crypto.randomBytes(24).toString('hex');
            this.csrf.set(user._id, n);
        }
        return n;
    }
    async info(user) {
        const s = await this.state(user),
            global = (await this.db.getSetting('kimai:server')) || {};
        return {
            url: global.url || '',
            connected: !!s.token && s.server === global.url,
            timezone: s.tz,
            automationError: s.automationError || null,
            account: s.account,
            rules: s.rules,
            live: s.live,
            nightly: s.nightly,
            csrf: this.nonce(user),
            history: Object.values(s.ledger)
                .sort((a, b) => (b.updated || 0) - (a.updated || 0))
                .slice(0, 200),
        };
    }
    async destinations(user, kind, parent) {
        const s = await this.state(user),
            c = await this.client(s);
        const paths = {
            customers: '/customers',
            projects: '/projects?ignoreDates=1' + (parent ? '&customer=' + Number(parent) : ''),
            activities: '/activities' + (parent ? '?project=' + Number(parent) : ''),
        };
        if (!paths[kind]) throw Error('Unknown destination list');
        return c.list(paths[kind]);
    }
    async sessions(user, query) {
        const p = this.p.parseQuery ? this.p.parseQuery(query) : query;
        const f = await this.p.perms.filterFor(user, p);
        if (!f) throw Error('Session scope is not accessible');
        f.userids = [user._id];
        f.includeGuests = false;
        return this.db.findSessions(f);
    }
    async preview(user, s, query) {
        if (!s.token) throw Error('Connect to Kimai first');
        if (query.startLocal) query.start = epoch(query.startLocal, s.tz);
        if (query.endLocal) query.end = epoch(query.endLocal, s.tz);
        const docs = await this.sessions(user, query);
        if (docs.length > 20000) throw Error('More than 20000 sessions; select a shorter preview range');
        const rows = build(s.device ? require('./kimai-device').available(s, docs) : docs, s.rules, s.tz);
        if (rows.length > 2000) throw Error('More than 2000 entries; select a shorter preview range');
        for (const b of rows) {
            const exact = s.ledger[b.id];
            if (exact) {
                b.status = exact.status;
                b.remoteId = exact.remoteId;
            }
            const occupied = Object.values(s.ledger).filter(
                (l) =>
                    l.id !== b.id &&
                    l.source.some((id) => b.source.includes(id)) &&
                    (l.basis === 'active' ||
                        b.basis === 'active' ||
                        ((l.coverageBegin || l.begin) < b.coverageEnd &&
                            b.coverageBegin < (l.coverageEnd || l.end || Infinity))),
            );
            if (
                occupied.length === 1 &&
                occupied[0].source.every((id) => b.source.includes(id)) &&
                !['kept', 'locked', 'running'].includes(occupied[0].status)
            ) {
                const l = occupied[0],
                    unchanged =
                        hash(l.source) === hash(b.source) &&
                        l.project === b.project &&
                        l.activity === b.activity &&
                        l.basis === b.basis &&
                        l.coverageBegin === b.coverageBegin &&
                        l.coverageEnd === b.coverageEnd;
                b.id = l.id;
                b.status = l.status;
                b.remoteId = l.remoteId;
                if (!unchanged)
                    b.issue = 'Source membership or mapping changed; reviewed send updates the existing entry';
            } else if (occupied.length)
                b.issue = 'Source time already belongs to another synchronized block; review history';
        }
        const id = crypto.randomUUID();
        s.previews = {
            [id]: {
                created: Date.now(),
                rows,
                query,
                revisions: Object.fromEntries(docs.map((d) => [hash(d._id), hash(d)])),
            },
        };
        await this.save(user, s);
        return { id, rows, timezone: s.tz };
    }
    async action(user, input) {
        return this.serial(this.key(user), async () => {
            const s = await this.state(user),
                op = input.op;
            if (op === 'device') return this.device.action(user, s, input);
            if (op === 'server') {
                if (!this.p.isAdmin(user)) throw Error('Site administrators only');
                const url = String(input.url).replace(/\/+$/, '');
                new Client(url, '');
                await this.db.setSetting('kimai:server', { url });
                return { ok: true };
            }
            if (op === 'connect') {
                const global = await this.db.getSetting('kimai:server');
                if (!global) throw Error('An administrator must configure the Kimai URL');
                const c = this.clientFactory(global.url, String(input.token || ''));
                const me = await c.request('GET', '/users/me'),
                    version = await c.request('GET', '/version');
                const config = await c.request('GET', '/config/timesheet');
                const mode = config.trackingMode || config.tracking_mode;
                if (!['default', 'duration'].includes(mode))
                    throw Error('Kimai tracking mode does not support exact begin/end: ' + mode);
                const tz = me.timezone || (me.preferences || []).find((p) => p.name === 'timezone')?.value;
                if (!tz) throw Error('Kimai did not return the account timezone');
                new Intl.DateTimeFormat('en', { timeZone: tz });
                await c.list('/activities');
                await c.request('GET', '/timesheets?size=1');
                if (s.account && (s.account.id !== me.id || s.server !== global.url) && Object.keys(s.ledger).length)
                    throw Error('This profile has synchronized entries for a different Kimai account');
                return this.serial('account-claims', async () => {
                    const registry = (await this.db.getSetting('kimai:users')) || { users: [] };
                    for (const id of registry.users) {
                        const other = this.p.meshServer.webserver.users[id];
                        if (!other || id === user._id) continue;
                        const profile = await this.state(other);
                        if (profile.account && profile.account.id === me.id && profile.server === global.url)
                            throw Error('This Kimai account is already linked to another MeshCentral user');
                    }
                    delete s.automationError;
                s.token = this.vault.seal(String(input.token));
                    s.server = global.url;
                    s.tz = tz;
                    s.account = { id: me.id, username: me.username, version };
                    s.live = false;
                    s.nightly = false;
                    await this.save(user, s);
                    await this.register(user);
                    return { ok: true };
                });
            }
            if (op === 'disconnect') {
                if (Object.values(s.ledger).some((l) => l.live && !l.end && l.status !== 'kept'))
                    throw Error('Stop or reconcile the owned live timer before removing the token');
                delete s.token;
                s.live = s.nightly = false;
                await this.save(user, s);
                return { ok: true };
            }
            if (op === 'settings') {
                if (
                    s.live &&
                    input.live !== true &&
                    Object.values(s.ledger).some((l) => l.live && !l.end && l.status !== 'kept')
                )
                    throw Error('Disconnect sessions or resolve the live timer before disabling live sync');
                s.rules = rules(input.rules);
                const now = Date.now(),
                    p = time.partsIn(now, s.tz || 'UTC');
                if (input.nightly === true && !s.nightly)
                    s.enabledAt = Math.min(s.enabledAt || now, time.fromLocal(p.y, p.m, p.d - 1, 0, 0, s.tz));
                if (input.live === true && !s.live) s.liveSince = now;
                s.enabledAt = s.enabledAt || now;
                s.live = input.live === true;
                s.nightly = input.nightly === true;
                if ((s.live || s.nightly) && !s.token) throw Error('Connect first');
                await this.save(user, s);
                if (this.timer) this.kick();
                return { ok: true };
            }
            if (op === 'preview') return this.preview(user, s, input.query || {});
            const c = await this.client(s);
            if (op === 'resolve') {
                const l = s.ledger[input.id];
                if (!l) throw Error('No entry to resolve');
                if (l.allocation) throw Error('Use the device recording review to resolve this entry');
                if (input.choice === 'retry') {
                    if (!input.row || !input.row.reviewed)
                        throw Error('Review the entry in Kimai and confirm before retrying');
                    const allowed = await this.sessions(user, {
                        start: l.sourceBegin || l.begin,
                        end: l.sourceEnd || l.end || Date.now(),
                        scope: 'all',
                    });
                    if (!l.source.every((id) => allowed.some((d) => d._id === id)))
                        throw Error('Source sessions are no longer accessible');
                    if (l.remoteId) {
                        try {
                            await c.request('GET', '/timesheets/' + l.remoteId);
                            throw Error('Remote entry exists; use keep or replace');
                        } catch (e) {
                            if (e.status !== 404) throw e;
                        }
                        delete l.remoteId;
                    }
                    const matches = (await c.list('/timesheets')).filter((r) =>
                        String(r.description || '').includes('[' + l.marker + ']'),
                    );
                    if (matches.length) throw Error('Remote marker exists; refresh/reconcile instead of recreating');
                    const block = this.edit(l, input.row, s.tz);
                    l.attempted = false;
                    l.status = 'pending';
                    await this.save(user, s);
                    await this.sync(user, s, c, block);
                    return { ok: true };
                }
                if (!l.remoteId) throw Error('No remote entry to resolve');
                let remote;
                try {
                    remote = await c.request('GET', '/timesheets/' + l.remoteId);
                } catch (e) {
                    if (e.status !== 404 || input.choice !== 'keep') throw e;
                    remote = { description: 'Deleted in Kimai' };
                }
                if (input.choice === 'keep') {
                    l.last = snapshot(remote);
                    l.status = 'kept';
                    l.updated = Date.now();
                    await this.save(user, s);
                    return { ok: true };
                }
                if (input.choice !== 'replace') throw Error('Unknown resolution');
                if (remote.exported || remote.locked) throw Error('Entry is locked in Kimai');
                const allowed = await this.sessions(user, { start: l.begin, end: l.end || Date.now(), scope: 'all' });
                if (!l.source.every((id) => allowed.some((d) => d._id === id)))
                    throw Error('Source sessions are no longer accessible');
                const block = this.edit(l, input.row || {}, s.tz);
                l.last = snapshot(remote);
                l.status = 'pending';
                await this.save(user, s);
                await this.sync(user, s, c, block, true);
                return { ok: true };
            }
            if (op === 'send') {
                const preview = s.previews[input.preview];
                if (!preview || Date.now() - preview.created > 30 * 60000)
                    throw Error('Preview expired; create a new preview');
                const current = await this.sessions(user, preview.query),
                    allowed = new Set(current.map((d) => d._id));
                const selected = [];
                for (const edit of input.rows || []) {
                    const original = preview.rows.find((b) => b.id === edit.id);
                    if (!original || !original.source.every((id) => allowed.has(id)))
                        throw Error('Preview row is no longer accessible');
                    if (
                        original.source.some(
                            (id) => preview.revisions[hash(id)] !== hash(current.find((d) => d._id === id)),
                        )
                    )
                        throw Error('Source sessions changed; refresh the preview');
                    if (original.issue && !edit.reviewed) throw Error('Resolve flagged rows before sending');
                    if (/already belongs|Ambiguous daylight/.test(original.issue || '')) throw Error(original.issue);
                    if (s.device && require('./kimai-device').reserved(s, original)) throw Error('Source time is now reserved or excluded by device controls; refresh the preview');
                    const b = this.edit(original, edit, s.tz);
                    selected.push(b);
                }
                for (const a of selected)
                    for (const b of selected)
                        if (a !== b && a.begin < b.end && b.begin < a.end)
                            throw Error('Selected entries overlap; adjust them before sending');
                for (const b of selected) await this.sync(user, s, c, b);
                return { ok: true, history: Object.values(s.ledger) };
            }
            throw Error('Unknown Kimai operation');
        });
    }
    edit(original, edit, tz) {
        const b = copy(original);
        for (const k of ['begin', 'end', 'project', 'activity']) if (edit[k] != null) b[k] = Number(edit[k]);
        if (edit.beginLocal) b.begin = epoch(edit.beginLocal, tz);
        if (edit.endLocal) b.end = epoch(edit.endLocal, tz);
        if (
            ![b.begin, b.end, b.project, b.activity].every(Number.isFinite) ||
            b.end <= b.begin ||
            b.end > Date.now() ||
            !Number.isInteger(b.project) ||
            b.project <= 0 ||
            !Number.isInteger(b.activity) ||
            b.activity <= 0
        )
            throw Error('Invalid entry times or destination');
        if (ambiguous(b.begin, tz) || ambiguous(b.end, tz) || days(b.begin, b.end, tz).length !== 1)
            throw Error('Entries must stay within one unambiguous local day');
        if (
            /Active-time measurement unavailable|Overlapping activity/.test(original.issue || '') &&
            b.begin === original.begin &&
            b.end === original.end
        )
            throw Error('Enter the reviewed active duration before sending');
        b.description = String(edit.description == null ? b.description : edit.description).slice(0, 1000);
        b.issue = '';
        return b;
    }
    async sync(user, s, c, block, replace = false) {
        let l = s.ledger[block.id];
        if (l && ['kept', 'excluded'].includes(l.status)) return;
        if (!l) {
            l = s.ledger[block.id] = {
                ...copy(block),
                status: 'pending',
                marker: 'meshcentral:' + hash([user._id, block.id]),
                updated: Date.now(),
            };
            await this.save(user, s);
        }
        if (ambiguous(block.begin, s.tz) || (block.end != null && ambiguous(block.end, s.tz))) {
            l.status = 'conflict';
            l.error = 'Ambiguous daylight-saving timestamp';
            await this.save(user, s);
            return;
        }
        if (!l.marker) l.marker = 'meshcentral:' + hash([user._id, block.id]);
        l.pendingBlock = Object.fromEntries(
            [
                'id',
                'begin',
                'end',
                'project',
                'activity',
                'description',
                'tags',
                'source',
                'basis',
                'live',
                'sourceBegin',
                'sourceEnd',
                'coverageBegin',
                'coverageEnd',
                'billable',
                'allocation',
            ].map((k) => [k, copy(block[k])]),
        );
        const payload = {
            begin: wall(block.begin, s.tz),
            end: block.end == null ? null : wall(block.end, s.tz),
            project: block.project,
            activity: block.activity,
            description: block.description + '\n[' + l.marker + ']',
            tags: [...new Set(('meshcentral,' + (block.tags || '')).split(',').map(x => x.trim()).filter(Boolean))].join(','),
            billable: block.billable !== false,
        };
        try {
            if (c.ensureTags) {
                s.tagCreates = s.tagCreates || {};
                await c.ensureTags(payload.tags, s.tagCreates, () => this.save(user, s));
            }
            if (!l.remoteId && l.attempted) {
                const matches = (await c.list('/timesheets')).filter((r) =>
                    String(r.description || '').includes('[' + l.marker + ']'),
                );
                if (matches.length !== 1)
                    throw Error(
                        matches.length
                            ? 'Multiple matching remote entries; review required'
                            : 'Create outcome uncertain; no remote marker found. Review in Kimai before retrying',
                    );
                l.remoteId = matches[0].id;
                if (l.pendingRequest && !this.matches(matches[0],l.pendingRequest)) {
                    l.status='conflict'; throw Error('Recovered entry differs from the request; review in Kimai');
                }
                l.last = snapshot(matches[0]);
                await this.save(user, s);
            }
            let remote;
            if (l.remoteId) {
                remote = await c.request('GET', '/timesheets/' + l.remoteId);
                if (remote.exported || remote.locked) {
                    l.status = 'locked';
                    throw Error('Entry is locked in Kimai');
                }
                if (l.pendingRequest && this.matches(remote, l.pendingRequest)) {
                    l.last = snapshot(remote);
                    l.sent = l.pendingRequest;
                    delete l.pendingRequest;
                }
                if (l.last && hash(snapshot(remote)) !== hash(l.last)) {
                    l.status = 'conflict';
                    throw Error('Entry was edited in Kimai; choose keep or replace');
                }
                if (hash(l.sent) === hash(payload) && !replace) {
                    Object.assign(l, l.pendingBlock);
                    delete l.pendingBlock;
                    l.status = block.end == null ? 'running' : 'synced';
                    l.error = null;
                    return;
                }
            }
            {
                const others = await c.list('/timesheets');
                if (
                    others.some((r) => {
                        if (r.id === l.remoteId) return false;
                        const begin = Date.parse(r.begin),
                            end = r.end ? Date.parse(r.end) : Infinity;
                        return begin < (block.end || Infinity) && block.begin < end;
                    })
                )
                    throw Error('Existing Kimai time overlaps this entry; review required');
                if (!l.remoteId) {
                    l.status = 'creating';
                    l.attempted = true;
                    await this.save(user, s);
                }
            }
            l.pendingRequest = payload;
            await this.save(user, s);
            remote = await c.request(
                l.remoteId ? 'PATCH' : 'POST',
                '/timesheets' + (l.remoteId ? '/' + l.remoteId : ''),
                payload,
            );
            l.remoteId = remote.id;
            l.last = snapshot(remote);
            l.sent = payload;
            l.begin = block.begin;
            l.end = block.end;
            l.source = block.source;
            l.coverageBegin = block.coverageBegin;
            l.coverageEnd = block.coverageEnd;
            l.sourceBegin = block.sourceBegin;
            l.sourceEnd = block.sourceEnd;
            l.basis = block.basis;
            l.description = block.description;
            l.project = block.project;
            l.activity = block.activity;
            l.tags = block.tags;
            l.billable = block.billable;
            l.live = block.live;
            l.allocation = block.allocation;
            l.status = block.end == null ? 'running' : 'synced';
            l.error = null;
            delete l.pendingRequest;
            delete l.pendingBlock;
            const seconds = block.end == null ? null : (block.end - block.begin) / 1000;
            l.remoteSeconds = remote.duration;
            l.warning =
                seconds != null && remote.duration != null && remote.duration !== seconds
                    ? 'Kimai changed the duration (rounding)'
                    : null;
        } catch (e) {
            l.error = e.message;
            l.retryAt = Date.now() + 5 * 60000;
            if (e.status === 403) l.status = 'locked';
            else if (e.status === 404 && l.remoteId) l.status = 'conflict';
            else if (!['locked', 'conflict', 'creating'].includes(l.status)) l.status = 'error';
            if (e.status >= 400 && e.status < 500) delete l.pendingRequest;
            if (e.status >= 400 && e.status < 500 && !l.remoteId) {
                l.attempted = false;
                l.status = 'error';
            }
        } finally {
            l.updated = Date.now();
            await this.save(user, s);
        }
    }
    matches(remote, payload) {
        const actual = snapshot(remote),
            tags = String(payload.tags || '')
                .split(',')
                .filter(Boolean)
                .sort();
        return (
            actual.begin.slice(0, 19) === payload.begin &&
            (actual.end ? actual.end.slice(0, 19) : null) === payload.end &&
            actual.project === payload.project &&
            actual.activity === payload.activity &&
            actual.description === payload.description &&
            actual.billable === payload.billable &&
            hash(actual.tags) === hash(tags)
        );
    }
    start() {
        this.timer = setInterval(() => this.kick(), 30000);
        this.timer.unref();
        this.kick();
    }
    close() {
        clearInterval(this.timer);
        clearTimeout(this.pending);
        this.closed = true;
    }
    kick() {
        if (this.closed || this.pending) return;
        this.pending = setTimeout(() => {
            this.pending = null;
            if (this.ticking) {
                this.kick();
                return;
            }
            this.ticking = true;
            this.tick()
                .catch((e) => console.log('CONNSTATS: Kimai: ' + e.message))
                .finally(() => {
                    this.ticking = false;
                });
        }, 50);
        this.pending.unref();
    }
    async tick() {
        const registry = (await this.db.getSetting('kimai:users')) || { users: [] };
        for (const id of registry.users) {
            if (this.closed) break;
            const user = this.p.meshServer.webserver.users[id];
            if (!user || (user.siteadmin !== 0xffffffff && user.siteadmin & 32)) continue;
            await this.serial(this.key(user), async () => {
                try {
                    const s = await this.state(user);
                    if (!s.token || (!s.device && !s.live && !s.nightly && !Object.values(s.ledger).some((l) => l.live && !l.end)))
                        return;
                    const now = Date.now();
                    let docs = await this.sessions(user, {
                            start: s.device ? Math.min(s.device.since, s.enabledAt || now) : (s.enabledAt || now),
                            end: now,
                            scope: 'all',
                            types: null,
                        });
                    if (s.device) await this.device.refresh(user, s, docs);
                    const c = await this.client(s);
                    if (s.device) {
                        await this.device.flush(user, s, c);
                        // New device allocations own all current scheduling. Never fall through to
                        // legacy live starts for a competing destination that refresh held for review.
                        for (const l of Object.values(s.ledger)) {
                            if (l.allocation || l.live || !['pending','error','creating'].includes(l.status) || (l.retryAt && l.retryAt > now)) continue;
                            if (require('./kimai-device').reserved(s,l)) continue;
                            await this.device.owned(user,l.source);
                            await this.sync(user,s,c,l.pendingBlock||l);
                        }
                        return;
                    }
                    const open = docs.filter((d) => !d.guest && d.end == null),
                        running = Object.values(s.ledger).find((l) => !l.allocation && l.live && !l.end && l.status !== 'kept');
                    if (running) {
                        const known = await Promise.all(running.source.map((id) => this.db.getSession(id)));
                        const connectedUntil = known.some((d) => d && d.end == null)
                            ? Infinity
                            : Math.max(running.begin, ...known.filter(Boolean).map((d) => d.end));
                        const contributors = open.filter((d) => {
                            const r = match(d, s.rules);
                            return (
                                r &&
                                r.basis === 'connected' &&
                                r.project === running.project &&
                                r.activity === running.activity &&
                                (r.billable !== false) === (running.billable !== false) &&
                                d.start <= connectedUntil
                            );
                        });
                        running.source = [...new Set(running.source.concat(contributors.map((d) => d._id)))];
                        const sourceDocs = await Promise.all(running.source.map((id) => this.db.getSession(id)));
                        if (!contributors.length) {
                            if (sourceDocs.some((d) => !d || d.end == null || d.truncated)) {
                                running.status = 'conflict';
                                running.error = 'Timer end uncertain after restart; review in Kimai';
                                await this.save(user, s);
                            } else {
                                const end = Math.max(...sourceDocs.map((d) => d.end)),
                                    pieces = end === running.begin ? [[end, end]] : days(running.begin, end, s.tz);
                                if (!pieces.length) throw Error('Invalid timer end; review in Kimai');
                                const tail = pieces.slice(1).map((piece) => ({
                                    ...running,
                                    begin: piece[0],
                                    end: piece[1],
                                    coverageBegin: piece[0],
                                    coverageEnd: piece[1],
                                    sourceEnd: end,
                                    id: hash([running.id, piece[0]]),
                                    live: false,
                                }));
                                for (const b of tail) {
                                    for (const k of [
                                        'remoteId',
                                        'last',
                                        'sent',
                                        'attempted',
                                        'marker',
                                        'pendingBlock',
                                        'pendingRequest',
                                        'splitTail',
                                    ])
                                        delete b[k];
                                    if (!s.ledger[b.id])
                                        s.ledger[b.id] = {
                                            ...b,
                                            status: 'pending',
                                            marker: 'meshcentral:' + hash([user._id, b.id]),
                                        };
                                }
                                running.splitTail = tail.map((b) => b.id);
                                await this.save(user, s);
                                await this.sync(user, s, c, {
                                    ...running,
                                    end: pieces[0][1],
                                    coverageBegin: running.begin,
                                    coverageEnd: pieces[0][1],
                                    sourceEnd: end,
                                    live: false,
                                });
                                if (s.ledger[running.id].status === 'synced')
                                    for (const b of tail) await this.sync(user, s, c, b);
                            }
                        } else await this.sync(user, s, c, running);
                    } else if (s.live) {
                        const candidate = open.find((d) => {
                            const r = match(d, s.rules);
                            return (
                                r &&
                                r.basis === 'connected' &&
                                !Object.values(s.ledger).some((l) => l.source.includes(d._id))
                            );
                        });
                        if (candidate) {
                            const r = match(candidate, s.rules),
                                b = build([{ ...candidate, end: now }], [r], s.tz)[0];
                            if (b && !b.issue) {
                                b.end = null;
                                b.live = true;
                                b.id = hash(['live', candidate._id]);
                                await this.sync(user, s, c, b);
                            }
                        }
                    }
                    const p = time.partsIn(now, s.tz),
                        today = time.fromLocal(p.y, p.m, p.d, 0, 0, s.tz);
                    const completed = docs.filter(
                        (d) =>
                            d.end != null &&
                            d.source === 'live' &&
                            !Object.values(s.ledger).some((l) => l.source.includes(d._id)) &&
                            ((s.live && d.start >= (s.liveSince || s.enabledAt)) ||
                                (s.nightly && p.h >= 2 && d.end <= today)),
                    );
                    for (const b of build(completed, s.rules, s.tz)) {
                        if (b.issue) {
                            s.ledger[b.id] = { ...b, status: 'conflict', error: b.issue, updated: now };
                            await this.save(user, s);
                        } else await this.sync(user, s, c, b);
                    }
                    for (const l of Object.values(s.ledger))
                        if (!l.allocation && !l.live && ['pending', 'error', 'creating'].includes(l.status)) {
                            if (l.retryAt && l.retryAt > now) continue;
                            if (
                                Object.values(s.ledger).some(
                                    (parent) =>
                                        parent.splitTail &&
                                        parent.splitTail.includes(l.id) &&
                                        parent.status !== 'synced',
                                )
                            )
                                continue;
                            const permitted = await this.sessions(user, {
                                start: l.begin,
                                end: l.end || now,
                                scope: 'all',
                            });
                            if (!l.source.every((id) => permitted.some((d) => d._id === id))) {
                                l.status = 'conflict';
                                l.error = 'Source sessions are no longer accessible';
                                await this.save(user, s);
                                continue;
                            }
                            await this.sync(user, s, c, l.pendingBlock || l);
                        }
                    if (s.automationError) {
                        delete s.automationError;
                        await this.save(user, s);
                    }
                } catch (e) {
                    const current = await this.state(user);
                    current.automationError = e.message;
                    await this.save(user, current);
                }
            }).catch((e) => {
                console.log('CONNSTATS: Kimai automation: ' + e.message);
            });
        }
    }
}
module.exports = { epoch, build, rules, match, wall, days, ambiguous, Client, Vault, Service, snapshot };
