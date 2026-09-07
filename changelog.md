# Changelog

## 0.2.8

- No weekday in front of dates any more: the session list shows "7.9.2026, 19:08",
  exactly like MeshCentral.

## 0.2.7

- Dates are written the way MeshCentral itself writes them for the chosen
  locale: numeric, "7.9.2026" for de-CH, "07/09/2026" for en-GB. 0.2.6 used
  month names ("7. Sept. 2026").

## 0.2.6

- **"All" period**: from the oldest recorded session in the current scope to
  today, in month buckets. Comparison is off for it, there is nothing before.
  A query may now span ten years instead of five.
- **Dates follow MeshCentral's "Dates & Time" setting** (My Account >
  Localization Settings), the same way MeshCentral's own pages do; without a
  choice the browser's locale is used. Weekday and month names in the charts
  follow it too.
- The session list, the timeline tooltips and the import status show the
  year, so a range from 2023 no longer reads like this year.
- Month labels in the calendar heatmap no longer overlap when the range
  starts late in a month.

## 0.2.5

- **Backups from before MeshCentral 1.1.34 import again**: those name the
  database dump `mongodump-<date>.archive`, `mysqldump-<date>` and
  `pgdump-<date>.sql` without the database name in front, and the importer
  skipped them ("No events file or database dump found in this zip"). The
  name filter now takes both spellings, and gzip-compressed SQL dumps.

## 0.2.4

- **Fits the frame**: charts are drawn at their pixel width instead of
  scaling with the page, the list defaults to 10 sessions per page, and when
  the frame is still too short the session table scrolls inside its card
  rather than the whole page.
- **Registry type** for the built-in registry editor (protocol 4); existing
  records are re-typed once. Unknown protocols are labelled "protocol N".

## 0.2.3

- **Full height on My Server > Plugins**: the page sizes MeshCentral's plugin
  frame to the space that is really left above the footer, instead of the
  fixed height that left a strip unused and put a scrollbar inside the frame.
- **Sessions per page**: the list footer has a 10 / 25 / 50 / 100 / 250
  selector; the choice is remembered in the browser.
- CI: the live-backend job no longer uses the `job.services` context in
  job-level env (GitHub refused the whole workflow file), and the unit test
  glob is expanded by the shell so Node 20 runs it too.

## 0.2.2

- **Two new types instead of "Other"**: *Router tunnel* for MeshCentral
  Router and other port tunnels (they carry no protocol number) and *Plugin*
  for the data tunnels plugins open, such as the Event Log live view. Existing
  records are re-typed once at startup, and both types are recorded wherever
  "Other" was. What remains in "Other" shows its relay protocol.
- **Live session list**: the page notices new, ended and updated sessions
  within about ten seconds and refreshes in place, keeping the selection and
  the page; ongoing sessions keep counting.
- **Session table**: Duration and Active moved next to Start; Active shows a
  dash for types where no input is measured and "no data" only for Desktop,
  Terminal and Files sessions without heartbeats.

## 0.2.1

- **"Other" explained**: the share-by-type legend breaks "Other" down by what
  it was (MeshCentral Router or port tunnel, RDP relay, SSH relay, ...), and
  the session list shows the same next to the type. Router opens its tunnels
  without a protocol, which is why it made up most of "Other".
- **Punchcard by type**: the bubbles in "When you connect" are sliced by
  connection type instead of all blue, and clicking one filters the session
  list to the sessions that started on that weekday and hour. Escape or
  "Clear" removes the filter.
- A query with an out-of-range timestamp is clamped instead of failing.

## 0.2.0

- **Import from backups**: MeshCentral deletes relay events after 20 days,
  but its backups keep them. The settings page now lists the files in the
  server's backup folder and accepts an upload; the plugin reads the events
  file or database dump inside (`meshcentral-events.db`, a mongodump archive,
  plain or gzip, a mysqldump, mariadb-dump or pg_dump file, or a SQLite
  copy) and adds the sessions it does not have yet. Files are recognised by
  content. Password-protected backups are reported and have to be unzipped
  first. Sessions restored this way carry the source `backup` in exports.
- Tested with the real dump tools: `pg_dump`, `mysqldump`, `mariadb-dump`
  and `mongodump` run inside the test containers and their output is read
  back.

## 0.1.1

- **Night mode on the My Server > Plugins page**: the page now reads
  MeshCentral's night setting from the page that embeds it and follows changes
  live, instead of relying on a flag only the device tab passed.
- **Tested on every backend**: the store contract, retention sweep and an
  end-to-end relay session run against real PostgreSQL, MariaDB, MySQL and
  MongoDB servers (Docker Compose locally, service containers on GitHub
  Actions) as well as NeDB and SQLite.

## 0.1.0

- **First release**: records every remote session MeshCentral relays (Desktop,
  Terminal, Files, Web RDP/SSH/SFTP, Messenger, Intel AMT KVM, tunnels) into
  the plugin's own store on every MeshCentral database backend, and shows
  connected time per device, device group and connection type at hour, day,
  week and month granularity with comparison to the previous period.
- **Active time**: input in the Desktop, Terminal and Files views is reported
  as heartbeats, so the dashboard shows how much of the connected time you
  were actually working. Sessions from other clients show "no data".
- **Device tab** with the same dashboard scoped to one device.
- **Export**: sessions as CSV or JSON, totals per bucket as CSV, chart as
  PNG, print, and a link to the current view.
- **Settings** for retention, minimum session length, recorded types and
  active-time measurement, plus an import of past sessions from
  MeshCentral's event log that also runs once on first start.
