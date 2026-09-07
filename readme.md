# MeshCentral Connection Stats

How long you were remoted into each device, split by Desktop, Terminal, Files and the other connection types, per device or device group, at any zoom from an hour to a year. Everything on screen can be exported.

![Dashboard](https://raw.githubusercontent.com/v3DJG6GL/MeshCentral-ConnectionStats/master/docs/dashboard.png)

## What you get

| Where | What |
| --- | --- |
| My Server > Plugins > Connection Stats | The full dashboard: scope (all devices, a group, a device), connection type chips, admin filter, period presets from today to everything ever recorded and a custom range, granularity by hour, day, week or month, comparison with the previous period, totals, the time chart, share by type, top devices or groups, a weekday-by-hour punchcard coloured by type that filters the list, a calendar heatmap for long ranges, a per-device timeline for a single day, and a paged session list. |
| Device page > Plugins > Connection Stats | The same dashboard scoped to that device. |
| Export menu | Sessions as CSV or JSON, totals per bucket as CSV, the chart as PNG, print or save as PDF, copy a link to the current view. |
| Settings (site admins) | Retention, minimum session length, which types to record, active-time measurement, import of past sessions from MeshCentral's event log, import from MeshCentral backups. |

![Twelve months for a group](https://raw.githubusercontent.com/v3DJG6GL/MeshCentral-ConnectionStats/master/docs/year.png)

### Two measures

**Connected time** is how long the session was open. **Active time** is how long you were giving input in the Desktop, Terminal or Files view, measured in the browser and reported as "still active" heartbeats, never the input itself. Both are shown; nothing is trimmed from the stored session. A Desktop, Terminal or Files session from another client, such as MeshCentral Router or MeshCentral Assistant, cannot be observed and shows "no data"; the other types show a dash because no input is measured for them. The totals row tells you how much of the connected time had input data.

The dashboard is live: new and ended sessions appear within about ten seconds while the page is open, and ongoing sessions keep counting.

### Session types

Desktop, Terminal, Files, Web RDP/SSH/SFTP, Messenger, Intel AMT KVM, Router tunnel (MeshCentral Router and other port tunnels, which carry no protocol so RDP, SSH, VNC or any forwarded port all land here), Plugin (data tunnels plugins open to the agent, for example the Event Log plugin's live view), Registry (MeshCentral's remote registry editor), and everything else as "Other". For "Other" the share-by-type legend and the session list name the relay protocol, so you can tell an RDP relay from a tunnel a third-party plugin opened. Device-share guests are recorded separately with the guest name, are off by default in the dashboard, and never count into admin totals.

![Night mode, one day](https://raw.githubusercontent.com/v3DJG6GL/MeshCentral-ConnectionStats/master/docs/night-day.png)

## Install

1. Enable plugins in your MeshCentral `config.json`:
   ```json
   "settings": { "plugins": { "enabled": true } }
   ```
   and restart MeshCentral.
2. In the web UI go to My Server > Plugins, click "Download plugin" and paste
   `https://raw.githubusercontent.com/v3DJG6GL/MeshCentral-ConnectionStats/master/config.json`
3. Enable the plugin. It starts recording immediately and imports what MeshCentral still has in its event log (20 days by default).

Manual install: clone this repository into `meshcentral-data/plugins/connectionstats` and add `connectionstats` to `settings.plugins.list`, or install it through the Plugins page as above.

## Storage

Sessions are kept in the plugin's own store because MeshCentral can expire its events. The store follows MeshCentral's database: with PostgreSQL, MariaDB, MySQL or SQLite the sessions live in a `plugin_connectionstats_sessions` table inside MeshCentral's database; with MongoDB in a `plugin_connectionstats_sessions` collection; otherwise in `meshcentral-data/plugin-connectionstats-sessions.db`. Every backend is exercised by the test suite against a real server. Retention defaults to **0 (disabled)**, keeping all sessions. A positive number enables cleanup of closed sessions older than that many days; open sessions are never removed. Existing installations keep their saved setting: set "Keep sessions for" to 0 and save to disable cleanup.

## Getting sessions back from before the plugin was installed

MeshCentral defaults to 20-day event retention (`settings.dbExpire.events`, in seconds), but older records may still be present depending on configuration and expiration behavior. To import directly from the **live database**, open settings, leave **days back = 0 (all history)** under "Import past sessions from MeshCentral's event log", and click **Import now**. This uses MeshCentral's `GetAllEvents` database method, filters relay events and pairs them into sessions. It has no 400-day cutoff or early stop after empty weeks. A positive day count scans that entire period in weekly windows. Existing sessions are skipped.

If records have already been deleted from the live database, use "Import from a backup" instead. It lists files in the server's backup folder and accepts uploads. The plugin reads events from the backup and adds missing sessions; re-importing also repairs missing device/group names when the backup contains them.

| MeshCentral database | What the plugin reads from the backup |
| --- | --- |
| NeDB | `meshcentral-data/meshcentral-events.db` |
| MongoDB | the `mongodump` archive at the root of the zip (`*mongodump-*.archive`, with or without the database name in front, plain or gzip); also a `mongoexport` JSON file |
| MariaDB, MySQL | the `mysqldump` or `mariadb-dump` file |
| PostgreSQL | the `pg_dump` file |
| SQLite | the database copy (`*-sqlitedump-*.db3`) |

Files are recognised by their content, so the same files work outside a zip. A password-protected backup cannot be read directly: unzip it with the password and upload the file from inside it. Sessions from a backup carry the source `backup` in exports.

## Permissions

Site administrators see every device and every admin. Everyone else sees the device groups and devices they hold rights on, and only their own sessions unless they have the "manage users" right. The check happens on the server for every query and export.

## Supported web UIs

Tested with the classic web UI. The Bootstrap UI uses the same plugin hooks and element ids, so it should work the same; please report differences. Night mode is followed live.

## Notes

- A session whose start or end the plugin did not see (server restart, plugin installed mid-session) is kept with the length MeshCentral reported and marked with an asterisk in the list.
- Dates follow the "Dates & Time" locale from My Account > Localization Settings, like the rest of MeshCentral; times are shown in your browser's time zone. A session that crosses midnight gives each day its share, and daylight-saving days are 23 or 25 hours long as they should be.
- Exports use ISO 8601 timestamps with offset and integer seconds. The first line of a CSV records the filters, the time zone, the user and the plugin version.
- Desktop multiplexing (several admins on one desktop) is counted per viewer.

![Device tab](https://raw.githubusercontent.com/v3DJG6GL/MeshCentral-ConnectionStats/master/docs/device-tab.png)

## Development

```
npm install
npm test
```
runs the unit tests with Node's built-in test runner, including the store contract on NeDB and SQLite (Node's built-in `node:sqlite` and the `sqlite3` driver MeshCentral uses).

```
npm run test:live
```
additionally runs the store contract, the retention sweep and an end-to-end relay session against real PostgreSQL, MariaDB, MySQL and MongoDB servers started with Docker Compose (`test/docker-compose.yml`, shifted ports, removed again afterwards). The same tests run on GitHub Actions for every push, see `.github/workflows/test.yml`; each backend is skipped when its `CS_TEST_*` connection URL is not set.

## License

Apache-2.0

## Kimai integration (0.4.0)

Open **Kimai** from the dashboard. A site administrator first configures one HTTPS
Kimai base URL. Each user then supplies a personal Bearer API token using **Test
and save token**. One Kimai account can be linked to one MeshCentral user. The
connection checks the current user, timezone, version, timesheet configuration,
and API read access. Tested with Kimai 2.66.0. Default and duration tracking modes
are supported; incompatible modes and ambiguous daylight-saving timestamps are
reported rather than silently converted. API create/update permissions are also
required; permission and lockdown failures appear in the sync history.

Configure ordered rules matching group, device and connection type. Select a
customer, project, activity, connected/active time, billable status, description,
and tags. The first matching rule wins; unmatched and guest sessions are excluded.
Unmatched sessions do not create automatic Kimai reviews; explicitly started manual
timers remain reviewable without a rule. Disabling connected-time live timers does
not disable after-disconnect processing for matching active-time rules.
Description placeholders: `{device}`, `{group}`, `{types}`, `{admin}`, `{date}`,
`{sessions}`. The `meshcentral` tag and a stable description marker identify entries.
Do not remove markers while an entry is managed by the integration. Missing tags
are created explicitly as visible tags. Give the API user tag-creation permission,
or pre-create the visible `meshcentral` tag and any configured tags in Kimai.

Use **Export → Send to Kimai** to preview the current range and filters. Only your
own currently permitted sessions are included. Sessions intersecting the range
are included in full and split at midnight in your Kimai timezone. Preview is
limited to 2,000 entries / 20,000 source sessions; use smaller ranges for a large
historical import. Adjust times, destinations and descriptions, exclude rows, and
review flagged entries before sending. Seconds are preserved; differences in the
duration returned by Kimai (including configured rounding) are shown in history.

Connected-time rules merge overlapping/adjacent intervals for the same destination
and billing choice, without counting overlap twice or filling disconnected gaps.
Active-time entries are sent only after disconnect: begin is the session start,
end is begin plus the measured duration. They do not represent exact activity
instants. Missing measurements and overlapping activity require a reviewed duration;
there is no automatic fallback to connected time.

**Both automation options start disabled.** For users who open the new device
controls, live automation starts a local shared recording for matching connected-time
sessions. It closes after the last contributing connection disconnects. Completed
recordings are reviewed or synchronized according to the personal review preference.
The default preference is **Always review**. Active-time rules run after disconnect.

### Device controls and review

A compact Kimai control appears in the device's Desktop, Terminal and Files toolbars.
Use it to open the side editor and start tracking an owned connection even without a
mapping rule or live automation. Choose customer, project, activity, description,
tags and billing. Project/activity creation is available when your Kimai permissions
allow it. Manual starts count from now by default; including earlier connection time
requires overlap checks. Destination changes switch from now by default.

Stopping tracking leaves remote access connected. Stop one contributor or all
contributors, keep the recorded time, and resume later without filling the gap.
Discarding time excludes it from subsequent exports; it does not delete the underlying
ConnectionStats session. Removing an already-sent entry requires confirmation and
is allowed only for an unchanged, unlocked entry owned by the integration.

The side editor and disconnect review edit the same recording. Review is offered
after your last connection ends, with personal **always / only issues / never**
prompt preferences and drawer/modal presentation, configured in Kimai settings.
Each mapping rule can override the prompt or inherit the personal default. For a
shared recording, the strictest contributing prompt wins (always, issues, never).
These preferences do not enable
live or nightly automation. Unresolved items remain in **Kimai → Review inbox**.
The inbox supports **Approve**, **Discard**, and opening the editor; flagged entries
require review in the editor. Approving, discarding or choosing **Review later**
returns to the inbox. Confirmations appear inline instead of browser dialogs.

Personal settings and mapping rules also offer a **minimum session length in
seconds** (default 0, disabled). The threshold uses the full connected session
length, including for active-time rules; equality is included. Rules can override
or inherit the personal minimum. Short automatic recordings are durably excluded
from Kimai without deleting statistics. Manual starts and existing remote entries
are exempt. Open recordings snapshot their contributing rules; changing settings
does not resurrect excluded time or retroactively rewrite existing reviews.

Kimai can round an entry's end upward, overlapping a later session even when the
original sessions were separate. Conflicts now show the existing entry ID and
actual interval. **Start after existing entry** edits the draft start for explicit
review, reducing the time to send. It never modifies the existing Kimai entry.
Check Kimai's [time rounding settings](https://www.kimai.org/documentation/configurations.html#time-rounding)
if rounding repeatedly recreates overlaps. Genuine overlap remains blocked to
prevent duplicate billing; adjust the reviewed interval or correct it in Kimai.

Drafts survive closing the editor. Concurrent changes require an explicit refresh
before editing the newer revision; remote edits require keeping Kimai's version or
explicitly reviewing a replacement.

**Remote-timer compatibility fallback:** new device recordings count locally and
send completed entries. They deliberately do not start a running Kimai timer:
Kimai's default tracking mode can stop another timer when a competing client starts
one, and a preflight check cannot make that operation atomic. Existing timers owned
by earlier integration versions are reconciled and stopped on closure; unrelated
timers are never stopped. Profiles that have not opened the new controls retain the
legacy live workflow. Keep automation disabled until your installation is validated.

Nightly sync runs after 02:00 in your Kimai timezone. It includes the previous day,
late closures and outstanding work since enabling sync; backup/backfill history
requires manual preview. Failed requests are retried with a five-minute delay.
All modes share a durable coverage ledger, so repeat exports do not create duplicates.
Allocations and explicit stop/discard intervals also prevent an older preview from
re-exporting time reserved by the device controls.
Remote edits and deletions are flagged. **Keep Kimai version** relinquishes updates;
**Review replacement** lets you explicitly review a replacement or a retry after
checking Kimai. Locked/exported entries remain untouched. An uncertain create is
reconciled by its marker before any automatic retry; absence of a marker requires
explicit review. Changed source membership is flagged instead of creating another
entry. A reviewed send can update a single existing block that contains the original
sources. Cases spanning multiple existing blocks require reconciliation in Kimai.

### Token and state backups

Tokens are encrypted using AES-256-GCM. The random 32-byte key is stored in
`meshcentral-data/plugin-connectionstats-kimai.key` (or MeshCentral's configured
config-file directory), created with permissions `0600`. Back up this key securely
alongside the plugin database; it is never returned through the plugin API. A
missing/corrupt key fails closed: restore it or reconnect personal tokens. Never
replace the key while tokens encrypted with it are still needed.

Personal configuration, operation state and individual block records use the
plugin's existing settings store on NeDB, MongoDB, PostgreSQL, MariaDB, MySQL and
SQLite. The ledger is independent of session retention. Preserve it when restoring
backups to avoid losing remote ownership. Changing the server URL requires users
to reconnect; an existing ledger cannot be reassigned to another server/account.

### Integration tests

`npm test` runs unit/regression tests; `test/live.sh` additionally exercises all
supported database services in disposable Docker containers. For a disposable
Kimai instance, run:

```sh
CS_TEST_KIMAI_URL=https://your-test-instance \
CS_TEST_KIMAI_TOKEN=your-test-token \
node test/kimai_live.test.js
```

This test creates and deletes a test customer, project, activity and timesheets.
Use a dedicated test instance/account with those permissions. It exercises the
real HTTPS client, connection setup, preview, create/update, legacy live timers,
manual device recording, destination creation and owned-entry discard. Browser
regressions cover device controls; the classic MeshCentral toolbar integration has
been visually checked in a fixture. Bootstrap layouts and your deployed instance
still need installation-specific validation.
Automation should remain disabled on a deployment until connection testing and a
small manual preview/send have succeeded against that installation.
