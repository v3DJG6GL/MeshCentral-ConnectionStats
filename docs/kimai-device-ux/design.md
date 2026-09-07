# Kimai controls where remote work happens

Design proposal · 7 September 2026 · based on ConnectionStats 0.3.2

[Open the interactive mockup](mockup.html). This document proposes the next integration phase. The mockup uses sample data and simulated actions; it does not contact Kimai. The separate 0.3.3 duration-format fix is production code; the device controls described here are not implemented in the plugin.

## Recommendation

Add a persistent personal timer strip to the device interface, with an expandable recording editor. Manual Start works even when no mapping rule exists or automatic live sync is disabled. Make Stop & keep, Disconnect, and Discard separate actions with explicit scope.

After a completed recording, open an optional review panel by default. Stop timing before asking for billing details. Provide Always / Only when attention is needed / Never preferences, an optional centered dialog, and a durable review inbox for deferred or missed reviews. Never steal focus from an active remote session to display another session's review.

Use Customer → Project → Activity, with a visible Description field. Add permission-aware inline project/activity creation, but keep actual Kimai Task Management integration separate. Introduce interval-level accounting before adding these controls: the existing source-session ledger cannot safely represent partial-session start, stop, resume, or exclusion.

## Research and implications

Evidence describes the source product or platform; recommendations are our synthesis for MeshCentral. Online documentation and Kimai `main` source were checked on 7 September 2026. Deployed-version API and permission validation remain necessary.

| Verified evidence | Recommendation for ConnectionStats |
| --- | --- |
| Toggl supports editing running entries and continuing previous work as a new entry. [Creating entries](https://support.toggl.com/en-us/article/creating-a-time-entry-wg8nug/) | Let people enter a description while working. Resume creates a new interval and preserves the stopped gap. |
| Clockify exposes running status and editable timer details. [Time tracking](https://clockify.me/help/getting-started/track-your-time-as-regular-user) | Keep status beside the device, visible across session tabs. |
| Harvest supports searchable destinations and notes before or after recording; destination availability can depend on administrators. [Member tracking](https://support.getharvest.com/hc/en-us/articles/360048181612) | Use searchable dependent selectors and an explicit unavailable/permission state. |
| Carbon describes modal notifications as disruptive and supports notification preferences and persistent centers. [Notification patterns](https://carbondesignsystem.com/patterns/notification-pattern/) | Default to a side panel and inbox; offer focused dialog mode as a personal preference. |
| Kimai distinguishes projects, activities, and an optional Task Management plugin. [Activities](https://www.kimai.org/documentation/activity.html), [Task Management](https://www.kimai.org/documentation/plugin-task-management.html) | Label the core field Activity, with explanatory help. Do not pretend an activity is an actual task object. |
| Kimai's default simultaneous timer limit can stop another timer when a new one starts. [Configuration](https://www.kimai.org/documentation/configurations.html) | Preflight active entries; never use Create as an implicit timer switch. External-client races still need mitigation. |
| Kimai project and activity creation require separate ACL permissions. [Project API source](https://github.com/kimai/kimai/blob/main/src/API/ProjectController.php), [Activity API source](https://github.com/kimai/kimai/blob/main/src/API/ActivityController.php) | Inline creation is optional and permission-sensitive; opening a picker never causes a remote create. |
| Kimai stop, update, and delete are separate operations. [Timesheet API source](https://github.com/kimai/kimai/blob/main/src/API/TimesheetController.php) | Avoid the ambiguous verb Cancel. Stop preserves elapsed time; discard has additional ownership and deletion checks. |
| Browser unload events are unreliable and browser-close warnings cannot contain our custom form. [MDN beforeunload](https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeunload_event) | Persist review items on the server and show them on the next visit when the browser has closed. |
| Accessible modal dialogs contain keyboard focus and return it on close. [W3C dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) | Use native dialog behavior for optional modal mode; Escape means defer, never discard. |

Familiar timer tools permit fast starts, but Kimai needs a valid destination. Our recommended compromise is recent valid assignments and dependent search, not a fabricated default project. The mapping hierarchy follows [Kimai initial setup](https://www.kimai.org/documentation/initial-setup.html).

## Design direction and alternatives

The product is a technician's remote-management workspace, not a billing dashboard. Preserve MeshCentral's blue navigation, dense device context, and theme inheritance. The memorable element is a small contributor timeline showing why two simultaneous connections count as one elapsed interval.

Design tokens: navigation blue `#194878`; action blue `#477BB9`; panel charcoal `#25292F`; text `#EDF0F5`; success mint `#80D5AD`; attention amber `#F1C56D`. Light mode uses white surfaces, ink `#202C3A`, and darker status colors. Production should reuse existing theme variables rather than introduce independent theme detection. Status always includes words; color is supplementary.

Use Segoe UI with Arial/system fallbacks, matching desktop administration conventions without downloading fonts. Titles 25px, panel headings 20px, body 14px, metadata 12px; timer numerals have stable widths. Left-align forms and descriptions. Keep remote controls usable while the editor is open.

The initial idea of placing billing details in several cards was rejected: it would fragment a single recording task and compete with the remote screen. Use one compact strip, one editor, and one timeline instead.

```text
Recommended: persistent strip + side editor
┌ Device name                         Your connection status ┐
│ Kimai 0:24:18  Customer / Project    Edit    Stop & keep     │
├ Desktop | Terminal | Files ─────────────┬───────────────────┤
│ Existing remote controls               │ Recording details │
│                                        │ Customer          │
│             Remote surface             │ Project / Activity│
│                                        │ Description       │
│ Desktop ━━━━━━━━━━━━━━━━━━━━━          │ Timing / billable │
│ Terminal       ━━━━━━━━━━━━━━          │ Save / Later      │
│ Kimai   ━━━━━━━━━━━━━━━━━━━━━          │                   │
└────────────────────────────────────────┴───────────────────┘

Compact alternative: toolbar chip → editor
[Connect] [Disconnect] ... [Kimai 0:24:18 ▾]

Focused alternative: after disconnection
          ┌ Review your recording ──────────────┐
          │ Remote disconnected; timer stopped │
          │ Destination / Description / Timing │
          │ Save to Kimai     Review later     │
          └────────────────────────────────────┘
```

| Variant | Best fit | Tradeoff |
| --- | --- | --- |
| Strip + side editor (recommended) | Normal desktop work, shared-timer visibility | Uses vertical space and reduces remote width while expanded |
| Compact toolbar chip | Small screens or users who rarely adjust billing | Destination/conflict details need an extra click |
| Centered review dialog (optional) | People who want a focused end-of-job habit | Interruptive; never open over another active terminal |
| Inbox-only review | Rapid connection switching and batch bookkeeping | Requires a visible review count and a reliable habit |

On narrow screens the editor becomes full-width, with a clear return to remote view. The prototype demonstrates that layout rather than shrinking inputs into unusable columns. Production should preserve the remote view's resolution/aspect behavior when the editor opens.

## Interaction specification

### Device timer strip

Show status, exact elapsed duration, customer/project, activity, origin (manual or rule name), and contributor count. Show the current user's timer only. A device-wide summary may contain several of that user's connections, with expandable rows for precise selection.

Visible states: Not connected to Kimai; Not recording; Starting; Recording; Measuring active time; Stop pending; Stopped; Awaiting review; Syncing; Synced; Excluded; Needs attention. A remote write request is not success until acknowledged or reconciled. Seconds are always shown as `h:mm:ss` with unbounded hours, e.g. `0:01:00`, `1:59:03`, `27:04:09`. Ongoing time may tick locally, anchored to server timestamps; stopping, saving, or rounding uses authoritative values.

### Start without a rule

1. Select Start timer on the device.
2. Pick customer, project, activity; optionally reuse a recently used valid assignment. Display Description immediately. Billable/tags can sit under details.
3. Default to From now. Include time since connection started is an explicit choice showing the exact interval and conflicts. Uncovered prior time remains available for later review; it is not silently included.
4. Start creates a one-off assignment, not a rule. Automatic live sync can remain disabled.
5. Offer Create a rule from this assignment separately after successful recording, with group/device/type scope preview.

Require an owned connected session in the first implementation. Recording non-remote preparation or aftercare is a potential future manual work-entry feature, not an invented remote connection. A user can resume while still connected; every resume creates a new interval.

### Stop, detach, discard, and switch

| Action | Scope and effect |
| --- | --- |
| Stop & keep | Ends the selected device's current tracking contributions at server time; preserves elapsed work and remote access. Suppresses automatic restart on those source connections. |
| Stop tracking this connection | Detaches one exact source session. Other contributors keep the shared timer running. Use this in contributor details. |
| Stop shared timer (N connections) | Explicit account-wide scope with device/type list. Stops all owned contributors and suppresses their automatic restart. |
| Disconnect Desktop/Terminal/Files | Existing remote action executes immediately. Kimai stops only when the last relevant contributor ends. |
| Resume tracking | Starts a new covered span. The stopped gap remains excluded unless explicitly reviewed and re-included. |
| Discard tracked time… | Confirm duration, interval and affected contributors. Mark exclusion durably, then reconcile/delete only an owned, unchanged, unlocked remote entry. |
| Switch destination from now | Finish old allocation at one server timestamp and begin the new one there. Default for destination changes while running. |
| Apply to whole recording | Explicit alternative with affected interval/contributors preview, overlap checks and remote edit protection. |

Description-only edits apply to the current recording. Destination switching must not silently rewrite all past work. Changes never edit the user's mapping rules implicitly.

Example: stop at 14:10 and resume at 14:15. Entries 14:00–14:10 and 14:15–14:25 total `0:20:00`; never `0:25:00`. If Desktop and Terminal overlap, their elapsed union is billed once. Detaching Desktop cannot remove overlap legitimately covered by Terminal. Partial discard from a shared entry therefore needs a preview/rebuild; the initial release should only allow a whole shared-entry discard with explicit scope, or defer partial adjustment to review.

Discard must not claim to reverse an invoice, exported time, or an external timer. If remote deletion fails, show Exclusion saved; remote removal needs attention. Keep the remote ID and recovery operation. Never allow nightly synchronization to recreate the discarded entry.

### Post-session review

Trigger after a tracked allocation's final contributor closes, or after an unmatched eligible personal session ends. Consolidate simultaneous relay endings into one review per allocation; do not show a modal for Desktop and another for Terminal when they share a timer.

Save the end boundary first. The panel may show Stop confirmation pending while Kimai is unavailable, but must not claim the remote timer is stopped. Permit draft editing while reconciliation runs; block unsafe new remote creates. Never add time spent writing the description.

Review fields: device/contributors; date and timezone; start/end to seconds; connected or measured-active basis; source duration; customer/project/activity; description; tags; billable; Kimai-returned duration and rounding difference. Active-time entries explicitly say Duration-based: starts at session start and spans measured active time. Missing or overlapping active measurements require review; no inferred zero or fallback to connected duration.

Actions: Save to Kimai; Review later; Discard tracked time. Existing live entries use an update rather than duplicate create. If an entry is already live-synced, say so: a local review queue does not make that entry a Kimai draft or prevent a separate Kimai invoicing process from seeing it.

Dismiss/Escape means Review later. Save the draft immediately as fields change, with debounce and explicit save status. Selecting Don't open automatically again changes the personal preference when saved/deferred; it never discards work. Production must persist drafts across reload and expose failures to save locally/server-side.

| Preference | Default / behavior |
| --- | --- |
| Review prompt | Always, for connected Kimai users; never enables live or nightly automation |
| Presentation | Side panel; centered dialog optional |
| Prompt types | All supported selected connection types; user may narrow |
| Only attention needed | Opens for unmapped destinations, missing required description, conflicts, missing activity, uncertain ends, or rounding/remote changes requiring review |
| Never automatically open | Badge and inbox remain; unresolved work is not auto-approved |
| Automatic live timers | Off unless explicitly enabled |
| Nightly synchronization | Off unless explicitly enabled |

For Always, keep the newly completed item in review until explicitly saved. For Only attention needed / Never, otherwise valid rule-based work may continue under existing authorized automation, while genuine unresolved items remain held. State this in preference help so disabling popups is not confused with enabling billing. Description-required policy should be explicit; optional descriptions alone are not an error.

When the browser is closed, disconnected, or busy in another session, queue server-side and surface the badge next visit. Claim presentation once per review revision across tabs; simultaneous notifications stack in the inbox rather than opening several dialogs. Browser visibility changes can save UI drafts, but must not be treated as authoritative remote disconnects.

### Customer, project, activity, and optional creation

Production selectors should support search, recent assignments, pagination, loading states, and stale/archived destinations. A changed customer invalidates incompatible project/activity selections. Global activities are available only where the project's policy permits them. A changed selection must not silently pick an unrelated first option.

Create project opens a small inline secondary form: selected customer, project name, optional comment. Create activity defaults to the selected project; global scope is an explicit later option. Preserve the recording draft, search for duplicates, then require Create & select. Avoid nested modal dialogs. Creating a customer has broader organizational impact and is deferred; link to Kimai instead.

Do not infer creation permission from a role name or from successful destination reads. Kimai `/users/me` is not a universal effective-ACL endpoint. During capability verification, distinguish supported, denied, and unknown. If effective permission cannot be discovered, offer a capability-neutral Open Kimai fallback; an explicit create attempt may return a clear 403 while preserving the draft. Do not send a test create merely to probe access. New-object POST failures with uncertain responses need reconciliation before retry, just like timesheets.

Core Activity is not Task Management. If the optional plugin is detected later, add Task under advanced details with its own assignment/project constraints. It should not be mandatory for normal Kimai installations.

## Architecture required before implementation

The repository audit identified concrete reusable hooks and a critical data-model limitation.

- `connectionstats.js:51` initializes the client integration; `:144` mounts the device tab during refresh. Add a small named wrapper and clean remount logic.
- Sibling MeshCentral `views/default.handlebars` provides Desktop `desktopCustomUiButtons`, Terminal `terminalCustomUiButtons`, and Files `p13rightOfButtons`. Preserve existing container content. A toolbar chip can open the shared editor if a cross-tab strip cannot be mounted cleanly on every supported MeshCentral version.
- Desktop disconnect hooks do not cover every state change; Terminal/Files have no equivalent general hook. Use server lifecycle handling around `connectionstats.js:398` for accounting and a personal state/review endpoint for UI updates. Existing five-second `csObserve` polling is only a UI hint.
- Reuse authenticated personal POST/CSRF protection around `connectionstats.js:748`, per-account serialization in `kimai.js:332`, owned-session queries around `:433`, and destination reads around `:422`.
- The live tick around `kimai.js:895` treats a source session appearing anywhere in the ledger as already covered. Buttons alone would lose remainder time or allow incorrect restart/export behavior.

These line references describe the audited baseline and may shift as code changes.

### Durable coverage model

Add allocation identity independent of source-session identity. Keep raw session history unchanged.

```text
allocation
  id, owner/domain/account, revision, origin(manual/rule)
  destination, basis, description, tags, billable
  sourceSpans[{sessionId, begin, end, disposition}]
  suppression[{sessionId, from, untilDisconnectOrResume}]
  remoteEntries[{id, marker, acceptedSnapshot, operationState}]
  review{status, draft, presentedRevision, resolvedAt}
```

Use half-open UTC spans `[begin,end)`, with local dates/timezone for presentation and midnight splitting. Union compatible covered intervals; preserve gaps. Uncovered, excluded, and awaiting-review spans are distinct states. Retain exclusions, operation IDs, remote identity and coverage independently of raw session retention. Existing ledger entries migrate as full known coverage; ambiguous historical mappings are held for review rather than guessed.

Manual, live, nightly, history replacement, and retry all consume this model. Suppression applies to the stopped source sessions until disconnect or explicit resume; a genuinely new connection may follow its normal rule. Explain this in UI help. New competing destinations cannot silently override an existing timer.

### Suggested interfaces

These are proposed operation names within the existing authenticated plugin endpoint, not implemented routes.

| Operation | Contract |
| --- | --- |
| device-state(nodeId) | Exact owned session IDs, allocations, contributors, capability states, revisions, pending reviews |
| timer-start | Session IDs, chosen destination, explicit start boundary, idempotency key |
| timer-stop | Selected allocation/contributor scope, expected revision; server chooses stop instant |
| allocation-switch | Current revision, destination, from-now/whole-entry mode; serialized transition |
| review-save / defer / exclude | Draft and intended coverage, optimistic revision, remote snapshot protection |
| review-list / presentation-claim | Paginated personal queue, cross-tab presentation deduplication |
| destination-create | Explicit project/activity scope, validated parent, capability handling, idempotent intent |

Authorize every source ID and device/domain relationship on the server. Never target a destructive action by device and type alone: multiple browser tabs can create several same-type sessions. Validate origin/source for any iframe messaging; do not expose tokens to host-page JavaScript. Mutation responses include the resulting revision and confirmed/pending state.

### Failure and concurrency rules

Persist ownership and operation intent before remote requests; no session-recording handler waits for Kimai. Reconcile uncertain creates using stable markers, and uncertain updates against pending request values. Preserve external edits and locked/exported entries. Map 401/403 to reconnect or permission-specific guidance, not a generic empty picker.

For stop at an exact known disconnect instant, use the appropriate timesheet update with that timestamp; stop-now API behavior is not a substitute for a delayed authoritative end. Verify verbs and allowed fields against the deployed `/api/doc`; current source exposes PATCH stop and DELETE, while older generated SDK documentation can differ. Preserve local datetime and seconds as documented by the [Kimai API](https://www.kimai.org/documentation/rest-api.html).

A preflight active-timer read followed by POST is not atomic across external Kimai clients. Local serialization only prevents our own concurrent operations. Because Kimai can auto-stop another timer, this is a release-gating limitation: validate a server mode that rejects competing starts without mutating the first timer, add an atomic Kimai-side mechanism, or fall back to completed-entry export for accounts where that guarantee cannot be met. Do not claim the plugin can guarantee external-timer preservation through a read-before-write check alone.

Live midnight splits, uncertain ends, retention migration, and direct Kimai edits remain governed by existing reconciliation rules. Switching across midnight must preserve daily coverage and avoid recreating the unsplit original. Rate/billing changes need snapshot protection as well as destination checks.

## Validation and phased implementation

| Phase | Deliverable | Acceptance gate |
| --- | --- | --- |
| 1 | Coverage spans, suppression, migration, review queue | Stop/resume gaps remain gaps; all export paths agree; restart preserves excluded intervals |
| 2 | Device state strip, manual start, scoped stop, description/editor | Exact session ownership, cross-tab revisions, external-timer preservation, no blocking session capture |
| 3 | Post-session panel/dialog and inbox | Disconnect never waits for form; draft survives reload; once-only presentation; preferences persist |
| 4 | Destination switch, whole-entry review, explicit discard | No duplicated or silently erased shared time; remote edit/lock/delete recovery |
| 5 | Capability-aware inline project/activity creation | Parent scope/permissions, duplicate handling, lost-response reconciliation |

Keep Task Management, arbitrary preparation/aftercare timers, and more complex partial shared-entry removal outside the first release. Search/recent destinations and description templates are useful refinements once core accounting is proven.

Required scenarios: manual start now/backdated; live off with manual start; stop/resume while still connected; shared timers on one and several devices; disconnect one contributor; disconnect all; switch destinations; external running timer and cross-client races; no matching rule; missing active samples; overlapping active sessions; network loss before/after POST/PATCH/DELETE; expired token; denied creation; duplicate names; remote edits/deletion/locks; midnight/DST; two tabs editing one revision; retention sweep; close browser before review; remote session input focus; dark/light theme changes; keyboard-only dialog flow; narrow viewport.

Meaningful accounting assertions include `10:00–10:10 + 10:15–10:25 = 0:20:00`, overlapping Desktop/Terminal union rather than sum, and no nightly re-export after exclusion. UI assertions include no “Stopped” success before remote reconciliation, focus return after dialog dismissal, and durations with seconds throughout.

## Prototype scope and walkthrough

The HTML demonstrates eight states, timer-strip placement, manual start choice, editing, destination switching choice, inline sample creation, stop/keep, shared contributor feedback, discard confirmation, post-session side panel and native dialog, opt-out preferences, review inbox, and dark/light themes. All data is in memory; durations are illustrative and the clock is fixed.

Searchable asynchronous pickers, real permissions, multi-device contributor selection, durable draft saving, conflict resolution, exact duration recalculation and API behavior are specified here but not implemented in the mockup. Scenario switching is a design-lab control, not a proposed production feature. Inbox samples reuse the same editor to demonstrate navigation, not distinct persisted records.

Open `mockup.html` directly in a browser, or serve this directory locally. Try No matching rule → Start timer; Automatic timer → Disconnect Desktop → Review later; Shared timer → Disconnect Desktop; then Preferences → Centered dialog → Automatic timer → Disconnect Desktop. Try theme switching, destination creation, and the offline/locked states.

## Activity and idle feedback

The current plugin defaults to a five-minute active window after the last input heartbeat. Mouse movement, clicks, typing, scrolling and touch can count; merely watching an untouched session does not. Browser heartbeats are currently throttled to 30 seconds, so this is an estimate rather than exact last-input timing. No visible Idle badge exists in the baseline UI. Terminal/Files activity fixes and duration formatting are being handled separately from this proposal.

For the future strip, distinguish `Measuring active time` from a Kimai live timer. An optional `Idle · last input 0:05:12 ago` detail would explain why active duration stopped growing. Never imply that idle detection pauses a connected-time Kimai rule: connected and active bases are separate choices. Show the effective server idle threshold in the editor's help; do not introduce a second contradictory personal threshold without a deliberate accounting change.

## Prototype verification

Reviewed the dark desktop layout and the light layout at a 390px viewport. Exercised manual start with a changed customer/project/activity, shared Desktop disconnect leaving Terminal active, inline project creation, deferred inbox navigation, opt-out queuing, and the native centered review dialog with Escape dismissal. Verified the client script parses and no browser errors appeared in the exercised flows. These checks validate the design artifact only; they do not establish deployed MeshCentral/Kimai compatibility or replace the implementation acceptance gates above.
