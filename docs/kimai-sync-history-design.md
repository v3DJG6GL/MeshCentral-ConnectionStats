# Kimai sync history and connection clocks

Implemented in 0.4.8.

## Design decisions

The history is an accounting audit list. Users need to answer: what recording was sent, how much time did Kimai accept, and does anything need action? The previous layout gave most of its width to diagnostic prose while wrapping timestamps into four lines.

Keep one row per ledger entry, ordered by latest update. Give recording date/time, project/activity, duration, and result stable columns. Show recorded and Kimai durations together, with a signed difference when rounding changed the result. Every duration includes seconds. State the timezone once above the table; retain the end date for recordings spanning days.

Use explicit status text with restrained semantic color. A discarded item may have a previous error, but it is no longer an unresolved failure. Preserve that diagnostic under “Previous sync issue.” Put detailed errors and existing resolution actions in an expandable section beside the result. Do not introduce a new confirmation or alter synchronization policy.

The Show filter separates all results, attention, synced, pending/running, and discarded. Filtering changes only the history region so unsaved settings elsewhere survive. The view covers the latest 200 ledger records returned by the existing API; its count is the loaded set, not the entire lifetime history. Server-side search/pagination would be the next step if older audit history needs browsing.

## Visual direction

Use MeshCentral's existing Arial/Helvetica typography and tabular numerals. Preserve its theme variables: white/#222 panels, #111/#ddd text, #5c6b82/#9aa5b5 secondary text, #d5dbe4/#444 rules, and existing green/red status colors. Avoid a second theme or decorative cards inside each row. Left-align content and keep long explanations collapsed. Narrow screens retain column relationships through horizontal scrolling.

```
Sync history                               Show [All results]
Latest N entries · timezone · Latest update first
Recording time   Recording / destination   Duration       Sync result
2026-09-08       Project                    0:00:17        Synced · Kimai #11
10:09:25 → ...   Activity                   Recorded       Rounding changed duration
                 Description               0:01:00
                                           In Kimai +0:00:43
```

## Connection clocks

Each Desktop, Terminal, or Files toolbar reports its own open connections on the current device. Elapsed time advances locally between five-second status polls. Active time displays the latest persisted server measurement; it is never extrapolated while idle. Missing measurements say unavailable, while measured zero displays 0:00:00. When multiple same-type connections exist, their active values are listed individually, avoiding an unsupported sum of potentially overlapping activity. Elapsed time starts at the earliest currently open connection and is not a billing total or a substitute for the Kimai allocation duration.

## Research and recommendations

- [Carbon: data tables](https://carbondesignsystem.com/components/data-table/usage/) recommends expandable rows for supplementary information. Applied here to diagnostics and resolution controls, keeping the accounting comparison visible.
- [GOV.UK: tags](https://design-system.service.gov.uk/components/tag/) uses short tags to communicate item status. Applied here with explicit text, so color is supplementary.

These are design recommendations adapted to this workflow, not evidence of user testing. Validate scanning speed and narrow-screen usability with real histories; keep all existing overlap and remote-edit protections.
