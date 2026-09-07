# Changelog

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
