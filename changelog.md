## 0.4.6 — 2026-09-08

- Show progress labels and form-local success/error feedback for Kimai settings
  actions. Preserve entered values on failure and identify unsaved rule changes.
- Add visible hover, pressed, keyboard-focus and disabled states to settings buttons.

## 0.4.5 — 2026-09-08

- Apply the selected review presentation consistently to manual device controls,
  recording review and inbox navigation, as well as automatic disconnect review.
  Centered panels no longer revert to the side panel when navigating.

## 0.4.4 — 2026-09-08

- Keep inline confirmations beside the triggering Save, Discard or review action,
  including within the relevant inbox item. Reveal only the nearby confirmation
  and restore focus to the original action on cancellation.

## 0.4.3 — 2026-09-08

- Do not create Kimai recording reviews for unmatched sessions after disconnect.
  Manual timers still work without rules; mapped active-time sessions still use
  their after-disconnect review policy independently of connected-time live timers.
- Preserve existing reviews and raw ConnectionStats sessions.

## 0.4.2 — 2026-09-08

- Move personal recording preferences into Kimai settings. Add per-rule review
  prompt overrides and minimum connected-session duration, inheriting personal
  defaults. Exclude short automatic recordings durably without deleting statistics.
- Replace browser confirmations with inline review actions. Add inbox Approve and
  Discard, show effective draft values and errors, and return to the inbox after
  review decisions. Flagged entries still require the editor.
- Explain remote overlap conflicts with the existing entry, timestamps and overlap
  seconds. Identify verified rounding-only conflicts and offer an explicit start
  adjustment; never trim or bill overlapping time automatically.
- Preserve dark/light theme when settings open in a standalone PWA window, using
  the launch theme or MeshCentral's saved/system preference.

## 0.4.1 — 2026-09-08

- Place Kimai controls beside connection status consistently in Desktop, Terminal
  and Files, leaving file-operation controls untouched.
- Identify mapped sessions awaiting disconnect review separately from running
  timers, and keep running-timer labels compact.
- Expose personal recording preferences beside mapping rules and clarify that
  they apply to all devices and rules for the signed-in account.

## 0.4.0 — 2026-09-08

- Add device-toolbar Kimai controls, manual recording without rules, contributor
  stop/resume, a shared side editor, optional disconnect review and a persistent
  review inbox. Edit destinations, description, timing and billing; create projects
  and activities with the user's Kimai permissions.
- Persist drafts, allocation coverage, exclusions, revisions and operation identity.
  Prevent duplicate exports across device, manual and scheduled workflows; preserve
  remote edits and require review for uncertain writes and conflicting time.
- Use local elapsed-time recording and completed-entry sync for device-enabled
  profiles until remote timer creation can safely preserve concurrent external
  timers. Both automation options remain off by default; review defaults to always.
- Explicitly create visible Kimai tags and recover older entries by description
  marker even when their tag was missing. Preserve seconds and report rounding.
- Validate allocation persistence across all supported stores and exercise manual
  recording, destination creation and discard against disposable Kimai 2.66.0.

## 0.3.3 — 2026-09-07

- Correct Terminal/Files activity attribution for SSH/SFTP and the connection’s own
  device, capture legacy terminal keyboard and paste/drop input, and reset activity
  throttling when a connection is recreated. Keep open-session active totals growing
  through the idle window even without a new heartbeat.

- Show durations as h:mm:ss, preserving seconds in session Duration/Active columns,
  summaries, chart tooltips, and Kimai previews; hours do not wrap after 24.
  Numeric CSV/JSON exports and chart scales remain unchanged.

## 0.3.2 — 2026-09-07

- Version all dashboard JavaScript/CSS URLs and prevent page caching so upgrades
  cannot combine stale Kimai theme code with the updated theme initialization.

## 0.3.1 — 2026-09-07

- Make Kimai settings inherit MeshCentral's dark theme and follow theme changes,
  using the same initialization as the dashboard and general settings.

## 0.3.0 — 2026-09-07

- Add personal Kimai connections, ordered mapping rules, editable export previews,
  shared live timers, optional nightly sync, and per-entry synchronization history.
- Preserve connected intervals and gaps; support reviewed active-time durations,
  midnight splitting, overlap conflicts, remote edits, and locked entries.
- Add encrypted token storage and a durable cross-backend synchronization ledger,
  with marker reconciliation for uncertain creates/updates and ownership checks.
- Restore the startup heartbeat flush that was unreachable after an early return.
- Validate unit/recovery behavior, all database backends, browser UI, and the real
  HTTPS API against a disposable Kimai 2.66.0 instance.

# Changelog

## 0.2.15

- Every-day calendar cells and session timeline bars use the shared hover and
  keyboard-focus tooltip design. Calendar tooltips include daily totals and
  color-marked connection types; timeline tooltips include session dates.
- Share-by-type and where-time-went charts use the same custom tooltips.
- Empty chart buckets, weekday/hour cells and timeline areas show their date or
  time and totals. The weekday/hour chart now includes visible cell gridlines.
- Monthly charts, calendars and session timelines show a separate year row.
  January labels no longer need to fit a year on the same line and take priority
  when the monthly axis must omit labels on narrower screens.

## 0.2.14

- Database imports report UTC date coverage and monthly counts for returned
  events, relay events, supported relay events and sessions found. Import
  details show empty months too, helping distinguish missing database history
  from filtering or pairing issues. The server log identifies the query mode.

## 0.2.13

- Connected-time and weekday/hour charts share immediate hover and keyboard-focus
  tooltips showing total duration and a breakdown by connection type with color
  markers. Weekday/hour bubbles also highlight on hover and focus.

## 0.2.12

- Direct database import defaults to all retained history (days back = 0), using
  MeshCentral's GetAllEvents method without an age cutoff. Day-limited imports
  continue through empty weeks and report database read failures.
- Retention defaults to 0 (disabled). Both automatic and manual cleanup preserve
  all sessions at 0; existing installations keep their saved retention setting.

## 0.2.11

- Backup imports list files newest first by the timestamp in their filename,
  so copying backups no longer scrambles the order. The displayed date follows
  that timestamp, with filesystem modification time as the fallback.

## 0.2.10

- MongoDB backup imports recover device and group names from backup records.
  Re-importing repairs missing names without duplicating sessions.
- Chart bars highlight on hover and keyboard focus, with immediate tooltips
  showing the date, connection type, duration and period total.
- Daily chart labels use the available width instead of a fixed label count.
- Hourly charts spanning multiple days include date context, and session
  timeline labels follow the actual selected range.

## 0.2.9

- Custom dates wait for Apply or Enter so the full year can be typed without
  resetting the field after the first digit.
- Dashboard filters are saved per user and restored when returning to the plugin.
- The saved session-list page size is restored correctly.

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
