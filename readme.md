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
