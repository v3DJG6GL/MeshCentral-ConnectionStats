# Connection Stats, design and technical proposal

Interactive mockup: https://claude.ai/code/artifact/6d3c7065-b8ad-4fd4-b138-fb924fd97557

A MeshCentral plugin that shows how long an admin was remote-connected to a
device or a device group, split by connection type, at hour, day, week, month
and year granularity, with export of everything on screen.

Research basis: the MeshCentral source at `../MeshCentral` (commit 4e03c5e1),
the sibling plugins Quick Commands and EventLog, and a survey of time-tracking
dashboards (Toggl, RescueTime, WakaTime, Screen Time, Grafana).

## 1. Where it lives

| Surface | How | Default scope |
| --- | --- | --- |
| Device page, Plugins tab | `registerPluginTab` on every `onDeviceRefreshEnd` (the tab DOM is wiped before each refresh) | that device, compact layout |
| My Server, Plugins, Connection Stats | `hasAdminPanel: true`, `handleAdminReq` renders `views/admin.handlebars` by hand (not `res.render`, the views path is process-global) | all visible devices, full layout |
| My Devices group action menu | extra entry like Quick Commands adds, opens the admin page with `#scope=group:<meshid>` | that group |

## 2. Dashboard anatomy

1. Scope: All devices, Group, Device.
2. Connection type chips, one fixed colour per type everywhere.
3. Admin filter, with a separate "Guests" entry for device-share guests, off by default.
4. Period presets: Today, Yesterday, Last 7 days, This week, Last 30 days,
   This month, Last month, Year to date, Last 12 months, Custom (two date
   fields). The resolved absolute range and time zone are always printed.
5. Granularity auto from range length (aim 20 to 60 buckets), overridable.
   Compare toggle draws the previous period as a dotted total and adds deltas.
6. Totals row: connected time, active time (with its coverage, see section
   4a), sessions, median session, longest session, devices touched. Deltas
   against the previous period.
7. Stacked bar chart per bucket. Click a segment: filters the session list.
   Click a bar: zooms one level (month to days, day to hours). Weekends shaded.
8. Share by type (doughnut) and where the time went (top groups or devices,
   clickable to drill the scope down, breadcrumb to go up).
9. Secondary panel by granularity: hour view shows a per-device session
   timeline for the day; day view shows a weekday by hour punchcard; month
   view shows a calendar heatmap.
10. Session list, server-side paged, honouring every filter.

Filter state lives in the URL hash so views are bookmarkable and the back
button undoes the last filter. Chips and bars are keyboard reachable, every
chart has a "show as table" link.

### Colours (Paul Tol bright, colourblind-safe, works on the night background)

| Type | Colour | Protocols |
| --- | --- | --- |
| Desktop | `#4477AA` | 2 (also multiplex join/leave) |
| Terminal | `#228833` | 1, 6, 8, 9 |
| Files | `#CCBB44` | 5 |
| Web RDP / SSH / SFTP | `#66CCEE` | 201, 202, 203 |
| Messenger | `#AA3377` | 200 |
| Intel AMT | `#EE6677` | 100, 101 |
| Other relay, Router tunnels, local relay | `#BBBBBB` | 10 to 14 and anything else |

Ongoing sessions: same colour, hatched. Duration formatting: `47m`,
`3h 12m`, `2d 5h`; seconds only in the session list and exports.

Night mode: MeshCentral toggles `body.night`. All plugin colours go through
CSS variables overridden under `.night`; a MutationObserver on the body class
re-themes charts live.

## 3. Export

One Export button with a menu. Every item exports exactly the filtered view.

- Sessions as CSV (server-streamed via a route registered in
  `hook_setupHttpHandlers`, same permission check as the page)
- Totals per bucket and type as CSV (client-side)
- Sessions as JSON (server-streamed)
- Send to Kimai (opens the block preview, section 4b)
- Chart as PNG (canvas `toBlob`, 2x)
- Print or save as PDF (print stylesheet, `window.print()`)
- Copy link to this view

File name: `meshcentral-connectionstats_<scope>_<from>_<to>_<bucket>.csv`.
ISO 8601 timestamps with offset, `duration_seconds` and `active_seconds`
integers (active empty when not observable), `guest` column, first line a
comment with filters, tz, user and plugin version. UTF-8 with BOM, RFC 4180.

## 4. Capturing sessions

MeshCentral has no plugin hook for relay sessions. All session start and end
events are dispatched through the server event bus with a `'*'` target, so:

```js
obj.server_startup = function () {
    obj.meshServer.RemoveEventDispatch(['*'], obj);   // reload safety
    obj.meshServer.AddEventDispatch(['*'], obj);
};
obj.HandleEvent = function (source, event, ids, id) {
    if (event.etype !== 'relay' || event.action !== 'relaylog') return;
    // classify by msgid, pair start/end, write to plugin DB
};
```

Same mechanism core's `amtmanager.js` uses. Works on every DB backend, needs
no polling, and also receives peer-server events. The built-in `events`
collection expires after 20 days (`settings.dbexpire.events`) and is used
only for a one-time backfill on first install.

| Type | Start msgid | End msgid | Join key | Duration and bytes on the end event |
| --- | --- | --- | --- | --- |
| Terminal | 14 | 10 | `msgArgs[0]` relay id | seconds = last `msgArgs`, `bytesin`, `bytesout` |
| Desktop | 15 | 11 | `msgArgs[0]` | same |
| Desktop multiplex (per viewer) | 143 | 144 | `msgArgs[0]` | seconds = `msgArgs[1]`, bytes apportioned |
| Files | 16 | 12 | `msgArgs[0]` | same as terminal |
| Messenger | 162 | 112 | `msgArgs[0]` | same |
| Web RDP / SSH / SFTP | 150 / 148 / 149 | 125 / 123 / 124 | `sessionid` | seconds = `msgArgs[0]`, `bytesin`, `bytesout` |
| Intel AMT KVM | 13 | 9 (protocol 101) | `msgArgs[0]` | seconds only |
| Local relay (no agent) | 120 | 121 | `msgArgs[0]` | seconds = `msgArgs[3]`, bytes in `in` / `out` |
| Other relay, Router | 13 | 9 | `msgArgs[0]` | seconds, bytes |

Rules:

- Classify by msgid, not by message text. `parseInt(event.protocol)`, it is a
  string from meshrelay and a number elsewhere.
- Web apps open an inner relay (protocol 10 to 14) that fires its own events.
  Count only the 201 to 203 pair while one is open.
- Write an open record on start (live counts), finalise on end. An end without
  a start becomes a session of the reported length ending at `event.time`,
  flagged `truncated`.
- Multiplex 145 / 147 carry no user and are ignored.
- Events for a session also exist in `msgArgs` of the end event, so nothing is
  lost if the start event was missed during a restart.

## 4a. Active time

Connected time is the tunnel; active time is the admin's input. Both are
shown, nothing is trimmed from stored sessions.

- Client: the plugin's exported code runs in the same page as the Desktop,
  Terminal and Files views. Passive listeners on the `#Desk` canvas (mouse
  and key), the xterm element, and the file table count input. Throttled to
  one heartbeat every 30 s, sent as
  `{action:'plugin', plugin:'connectionstats', pluginaction:'beat', nodeid, kind}`.
  Only "still active" is sent, never the input.
- Server: heartbeats stored as `{sid, t}` next to the open session. On close,
  active seconds = union of `[t, t + idleThreshold]` windows clipped to the
  session, folded into the session's `active` field. Default idle threshold
  5 min. Ongoing sessions count up to the last heartbeat.
- Not observable, so `active: null` and "no data" in the UI: Router,
  Assistant, device-share guest page, Web RDP/SSH/SFTP iframes, AMT KVM,
  Messenger. The totals row prints how many connected seconds had input data
  so the active figure is read against its coverage.
- Rejected routes: patching the desktop multiplexer's viewer parser on the
  server (no hook, breaks on updates) and an agent-side meshcore module
  (cannot separate injected admin input from the local user's).
- Settings: activity tracking on/off, idle threshold minutes, heartbeat
  interval. Heartbeats follow the session retention.

## 4b. Kimai integration (0.3.0)

Implemented after review on 2026-09-07. See readme.md's Kimai section for setup,
accounting behavior, recovery, and test instructions. This supersedes the original
10-minute gap merging, automatic overlap trimming, and service-token proposal.

- One administrator-configured HTTPS server, personal encrypted tokens, and
  per-user ordered group/device/type mapping rules. Each remote account has one
  MeshCentral owner. Guests and other users' sessions cannot be sent.
- Connected time unions overlapping or adjacent same-destination intervals but
  preserves all disconnected gaps. Different destinations require review.
- Active time is sent after disconnect as a union of persisted activity windows (0.5.0).
  Missing/legacy totals and uncertain restart data still require review when overlapping.
- Editable manual preview, optional nightly sync at 02:00 in the account timezone,
  and optional automatic live timers. Both automation modes default off.
- Daily completed entries; live timers can cross midnight and split on closure.
  Foreign timers are untouched. Uncertain end times require review.
- A durable per-user index plus separate block documents in the common settings
  store preserve identity across retention, retries, restarts, and all sync modes.
  Persist operations before remote writes and reconcile uncertain responses using
  stable description markers. Never blindly retry a create.
- Preserve remote edits; user can keep the Kimai version or review a replacement.
  Locked/exported entries are not overwritten. Remote deletions, changed membership,
  and uncertain creates are surfaced for review.
- Bearer authentication, certificate verification, no redirect following, encrypted
  tokens with a separate 0600 key, user/domain scope checks and CSRF tokens for all
  mutation endpoints. Read current account/timezone/tracking mode before syncing.
- Service accounts, per-user servers and custom-field plugins remain deferred.

## 5. Data model and storage

```js
{ _id: "s_<relayid|sessionid>", domain, nodeid, meshid, userid, username,
  guest, type, protocol, start /* ms UTC */, end /* null while ongoing */,
  seconds, active /* null when not observable */, bytesin, bytesout, ip,
  source: "live"|"backfill", truncated }
```

- Raw sessions are authoritative. Bucketing happens at query time in the
  viewer's time zone; sessions crossing a bucket edge are split
  proportionally. No stored splits, so tz changes and DST stay correct.
- Indexes: `start`, `nodeid`, `userid`, `meshid`.
- Optional nightly rollup per day, device, admin, type, only if year views
  get slow. Rebuilt from raw.
- Retention setting, default 0 (disabled), swept at startup and daily.
- Device and group names are stored with the session so history survives
  deletion.
- Store: NeDB file `plugin-connectionstats-sessions.db` via
  `meshServer.getConfigFilePath`, stashed on `pluginHandler` so a reload
  reuses it; `plugin_connectionstats` collection on MongoDB, selected by
  `db.databaseType` (EventLog / ScriptTask pattern).

Permissions: site admins see everything. Others see devices where
`GetNodeRights` grants a remote-control right and only their own sessions
unless they may manage users. Enforced in `serveraction` and the export
route; the client only hides controls.

## 6. Implementation recommendations

- Charts: implemented as inline SVG drawn by the page itself (stacked bars,
  doughnut, punchcard, calendar, timeline). No library at all: the mockup's
  renderers covered every chart, are theme-aware through CSS variables and
  keyboard-focusable, and MeshCentral servers are often offline. Chart.js
  4.3.3 ships with MeshCentral at `scripts/charts-min.js` should a canvas
  chart ever be wanted.
- Client: exported functions are `toString`-serialised, so each is
  self-contained and reaches peers via `pluginHandler.connectionstats`.
  Markup from strings with one escaping helper, `cs`-prefixed classes, one
  idempotent style block.
- One `query` server action returns buckets, totals, top devices, punchcard,
  and the first page of sessions in one round trip; `sessions` pages the list.
- Settings under My Server: retention days, minimum session length to record,
  types to record, activity tracking with idle threshold and heartbeat
  interval, import existing events (with progress), export time zone.

## 7. Files and build order

```
config.json                shortName "connectionstats", hasAdminPanel true
connectionstats.js         server_startup, HandleEvent, serveraction, handleAdminReq, exports
db.js                      NeDB / Mongo store, indexes, retention, backfill
aggregate.js               bucketing, boundary splitting, punchcard, previous period
activity.js                heartbeat intake, idle-window union, viewer listeners
kimai.js                   Kimai client, block builder, rules, scheduler, sync log
export.js                  streaming CSV / JSON route
views/admin.handlebars     dashboard and settings page
public/chart.umd.js        vendored Chart.js 4
public/connectionstats.css
docs/                      screenshots
readme.md, changelog.md, LICENSE
```

1. Capture: bus subscription, pairing, store, retention. Proof: four session
   types produce four records with correct seconds and bytes, no double count.
2. Query: aggregation with splitting and previous period. Proof: unit test of
   a 23:30 to 00:30 session across a DST change.
3. Admin page: full dashboard, filters, charts, list, night mode.
4. Device tab: compact dashboard that survives the refresh wipe.
5. Active time: viewer listeners, heartbeats, union, settings. Proof: five
   minutes of typing in a 25-minute desktop session gives about five minutes
   active; a Router session shows no data.
6. Export: CSV, JSON, PNG, print, link.
7. Backfill and settings.
8. Kimai sync: connection, rules, blocks, preview, nightly sync, log. Proof:
   two overlapping sessions on one server become one entry; a second sync
   updates instead of duplicating; a locked entry is left alone.

Decided 2026-09-07:

- Idle time is not trimmed. Instead, active time is a second measure
  observed in the browser viewer via heartbeats (section 4a). Approved
  2026-09-07.
- Device-share guest sessions are kept separate. Events with `guestname`
  (and multiplex viewers without a user) are stored with `guest` set, appear
  as a "Guests" entry in the admin filter (off by default), are never added
  into admin totals, show as "Guest: name" in the session list, and get a
  `guest` column in exports.

## Kimai device controls (0.4.0)

Implemented from the approved [UX specification](docs/kimai-device-ux/design.md).
The [interactive mockup](docs/kimai-device-ux/mockup.html) remains the design study.
Device toolbars open a shared recording editor; disconnect review and the persistent
inbox operate on the same allocations. Manual starts, contributor-specific stops,
stop/resume gaps, reviewed destination changes, drafts and explicit exclusion are
persisted separately from source sessions. Revision checks protect concurrent edits.

`kimai-device.js` supplies allocation, coverage and review logic; the scoped
`public/kimai-device.js` and `.css` supply the host-toolbar UI. Allocation documents
and durable operation records share the supported settings stores, independently of
session retention. All entry paths check coverage, including previously built
previews. Account serialization, ownership checks and existing CSRF protection apply.

Device-enabled profiles use the approved completed-entry fallback: live elapsed time
is tracked locally because remote timer creation cannot atomically guarantee that
another Kimai client's timer remains untouched. Existing owned remote timers are
reconciled, while new completed entries use the shared synchronization ledger.
Automation remains disabled by default; review defaults to always. See readme.md for
migration behavior, recovery, setup and validation limits.


### Recording review refinements (0.4.2)

Personal prompt, presentation and minimum-duration defaults live on the Kimai
settings page. Ordered rules override prompt/minimum independently; automatic
recordings snapshot effective policies per source. Shared recordings apply the
strictest review prompt. Short contributors receive durable exclusions and never
fill a gap between remaining eligible intervals. Raw ConnectionStats sessions and
already-exported Kimai entries are preserved.

The inbox displays the effective draft and offers approval/discard with inline
confirmation; flagged entries open the editor. Decisions return to the inbox.
Remote-overlap feedback includes timestamps and rounding evidence, with a draft-only
boundary adjustment requiring an explicit reviewed send. Standalone settings carry
the originating theme and fall back to the stored MeshCentral/system preference.

### Multi-type rules and concurrency (0.4.9)

Rules persist a `types` array (empty means wildcard), with legacy `type` strings read compatibly. Group/device/type predicates remain conjunctive; selected types use membership and rule ordering stays first-match-wins. The editor uses labeled checkboxes rather than a native multi-select requiring modifier keys.

Device toolbars scope status, clocks, popup selection, and quick stop by node and connection type. Only mapped sessions or open allocation contributors receive Kimai clocks; a closed contributor cannot inherit the status of a shared allocation still running elsewhere.

After source lifecycle reconciliation, untouched automatic connected allocations are unioned transitively by project/activity/billable destination, including open-ended intervals. Merge preserves source membership, spans, strictest review policy and tags. Entries with drafts, errors or remote block history remain separate for review. Separate destinations retain overlap protection. Active totals remain unmergeable without event-level activity intervals; overlapping tracked sources require review instead of summation.


### Durable active intervals (0.5.0)

The tracker stores canonical half-open millisecond intervals for heartbeat plus idle-timeout windows, clipped to the source connection. The idle timeout is captured with each heartbeat, so settings changes do not rewrite earlier activity. The session stores `activeIntervals` alongside the aggregate `active` total. Null means unavailable/legacy; an empty array means observed zero. The common document shape persists arrays in MongoDB/NeDB and the existing JSON document field in all SQL backends; no schema migration is needed. Source writes are serialized per session so an older activity flush cannot overwrite disconnect measurements. Crash-recovered open sessions remain truncated and are never treated as complete.

New active allocations retain full source spans plus canonical activity windows. Same-destination allocations union intervals transitively when their source sessions overlap/abut; idle gaps are preserved. They wait while a same-destination contributing session remains open. Completed windows are normalized to whole-second boundaries and split at local midnight before sending. Destination overlap checks use actual windows, not the envelope containing idle gaps. Legacy totals cannot be reconstructed; they keep explicit duration review.

Complete new active recordings automatically sync when their effective review policy is issues/never, independently of the connected-time live switch and nightly schedule. Always still requires review. Errors, drafts, unresolved remote operations, locks and uncertain contributors block automatic sending. Source membership and interval pieces are persisted before remote calls and share existing marker reconciliation. Precise standalone preview exports reserve exported windows rather than the entire source; remaining windows stay available without duplicating already-sent activity.

Review UI distinguishes unique active duration and explains that editing envelope start/end replaces the measured windows with a user-reviewed continuous duration. Existing allocations with drafts or remote history are not silently regrouped.
