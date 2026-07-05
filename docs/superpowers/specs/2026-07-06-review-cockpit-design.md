# Review Cockpit — design

**Date:** 2026-07-06
**Status:** approved (build authorised — autonomous iteration)

## Problem

We want a "heinously quick" software review engine. An agent (just Claude Code —
no bespoke orchestration) grinds through Jira/Dart tickets for a day, produces a
PR train, and along the way emits a list of things a human must manually verify.
The human then spends ~5 minutes in the Screens app: read the check, click it,
land on the exact page with the right account/cookies already loaded, rule
pass/fail/changes with a note. Failed checks flow back to the agent, which fixes
and re-emits. You review → agent iterates → you re-review.

The embedded WebView, per-account cookie isolation, auto-login, `go`/`capture`,
and the CLI↔app inbox protocol **already exist**. This feature adds the *return
leg* of that loop: a review data model, a sidebar, and a verdict channel.

## Scope

- **In:** review data model (`review.json`), verdict channel (`verdicts.jsonl`),
  `screens review …` CLI, a Review view in the app (checklist + embedded browser),
  the closed feedback loop, a free-dump intake convention.
- **Out (V2):** live Jira/Dart API auth + sync. V1 ticket carries an *optional*
  external ref (URL/id) that the agent fills in; a human or the agent pastes
  ticket content in. (For the first real run, the operator uses the Atlassian MCP
  to pull DX tickets and drive the CLI — no app-side API integration.)

## Architecture — the symmetric loop

Today's flow is one-directional. The CLI writes project files and appends
commands to `inbox.jsonl`; the Rust watcher fans changes to the app. We add the
mirror image:

```
CLI  ──screens.json──▶ app        (exists: routes/screens)
CLI  ──inbox.jsonl───▶ app        (exists: runtime commands)
CLI  ──review.json───▶ app        (NEW: tickets + checks)
app  ──verdicts.jsonl▶ CLI/agent  (NEW: your pass/fail/notes — the return leg)
```

**Invariant: each file has exactly one writer.**

- `review.json` — **written only by the agent** (CLI `screens review …`). Read by
  the app. Changes already trigger the watcher's `store:project` event (it fires
  for any file under `projects/<slug>/`), so the sidebar hot-updates for free.
- `verdicts.jsonl` — **written only by the app** (append-only, one line per
  verdict). Drained by the agent via a line cursor, exactly like the Rust watcher
  drains `inbox.jsonl`.

No locking, no torn writes, lossless across restarts, zero new runtime processes.

### Round-based reconciliation (how the loop stays correct)

Each check carries an integer `round` (default 0). Each verdict line records the
`round` it was cast against. The app's *display status* for a check is: the latest
verdict whose `round === check.round`, else `awaiting`. When the agent fixes a
failed check and re-requests review, it **bumps `check.round`** — old verdicts no
longer match, so the check shows `awaiting` again. This prevents a stale `fail`
from sticking after a fix, and prevents an old verdict from being re-applied.

## Data model

### `projects/<slug>/review.json` (agent-authored)

```jsonc
{
  "tickets": [
    {
      "id": "DX-123",                 // external id or generated
      "title": "Billing widget on dashboard",
      "ref": "https://dexiq.atlassian.net/browse/DX-123",  // optional
      "pr": "https://github.com/org/repo/pull/45",          // optional
      "summary": "Short context for the reviewer.",         // optional
      "status": "in-review",          // agent hint: in-progress | in-review | done
      "createdAt": 1778625844000,
      "checks": [
        {
          "id": "dx-123-c1",
          "title": "Log in as tester → dashboard shows billing widget",
          "detail": "Widget top-right, shows current plan name.",   // optional
          "path": "/app/dashboard",   // where to jump; resolved against baseUrl
          "screenId": "dashboard",    // optional alt to path (canvas node id)
          "account": "tester",        // optional account id to switch to
          "status": "awaiting",       // canonical: awaiting | pass | fail | changes
          "round": 0
        }
      ]
    }
  ]
}
```

### `projects/<slug>/verdicts.jsonl` (app-authored, append-only)

```jsonc
{"ts":1778625851000,"ticketId":"DX-123","checkId":"dx-123-c1","round":0,"verdict":"pass"}
{"ts":1778625860000,"ticketId":"DX-123","checkId":"dx-123-c2","round":0,"verdict":"fail","note":"overflows on mobile"}
```

`verdict ∈ {pass, fail, changes}`. `note` optional.

### `projects/<slug>/verdicts.cursor` (agent-owned)

A single integer: count of verdict lines the agent has already drained via
`screens review pull`. Advanced on each pull.

### Ticket rollup (derived in UI, not stored)

`passed` if every check's display-status is `pass`; `needs-work` if any is
`fail`/`changes`; otherwise `awaiting`.

## CLI surface (`screens review …`)

Agent-facing. All operate on the current project unless `--project=<slug>`.

| Command | Effect |
| --- | --- |
| `review add-ticket <id> --title=<t> [--ref --pr --summary --status]` | Create/upsert a ticket group. |
| `review check <ticketId> --title=<t> [--path=/x \| --screen=<id>] [--account --detail --id]` | Add a check to a ticket. |
| `review list [--json]` | Print tickets + checks + display status. |
| `review pull [--json]` | Print new verdicts since the cursor; advance it. This is how the agent learns what you ruled. |
| `review resolve <checkId> <pass\|fail\|changes\|awaiting>` | Set a check's canonical status (agent reconciles after reading a verdict). |
| `review reopen <checkId>` | Bump `round`, set `awaiting` — re-request review after a fix. |
| `review remove-ticket <id>` / `review remove-check <checkId>` | Cleanup. |

The **free-dump intake** needs no special command: the agent (Claude Code) reads
the paste/ticket, decides tickets + checks, and calls `add-ticket` / `check`. The
`round` reconciliation makes the loop:

```
1. Take dump/ticket → task list → do work → open PR.
2. screens review add-ticket <id> --title=… --ref=…
3. screens review check <id> --title="…" --path=/… [--account=…]
4. …later… screens review pull            # read verdicts
5. For each fail/changes: fix, then `screens review reopen <checkId>`
6. Goto 4 until all pass.
```

## App / UI

- New `ViewMode` value `review`, alongside `map | split | app`. `Cmd/Ctrl+4`.
  Top bar gains a **Review** tab with a badge = count of `awaiting` checks.
- **Review view layout:** left pane = `ReviewPanel` (the checklist), right pane =
  the existing `EmbeddedBrowser`. Clicking a check drives the browser.
- **`ReviewPanel`** — tickets as collapsible groups with a rollup pill and
  external-ref link; each check row shows title, target path, an account chip, its
  display status, and three verdict buttons (Pass / Changes / Fail) + an optional
  note field. Clicking a check row (or its "Go" affordance) calls the existing
  `navigate(path|screen)` and, if `check.account` is set and differs, the existing
  `pickAccount(account)` (which triggers auto-login).
- **Verdict action** → `appendVerdict(slug, {ts, ticketId, checkId, round, verdict, note})`
  (optimistic in-memory update; canonical state re-arrives via the watcher).

### Rust (`src-tauri`)

- `store.rs`: `review_path`/`verdicts_path`; `read_review` (default `{tickets:[]}`);
  `read_verdicts` (parse jsonl, tolerate blank lines); `append_verdict`. Extend
  `ProjectBundle` with `review: Value` and `verdicts: Vec<Value>`.
- `lib.rs`: register `store_append_verdict`. Reads ride along in `store_project`.
- `watcher.rs`: **no change** — it already emits `store:project` for any file
  under the project dir, covering `review.json` and `verdicts.jsonl`.

### React (`src`)

- `types.ts`: `ReviewConfig`, `ReviewTicket`, `ReviewCheck`, `Verdict`,
  `VerdictKind`, `CheckStatus`; extend `ViewMode`.
- `screensStore.ts`: `review` + `verdicts` on `ProjectBundle`; `appendVerdict`
  action (Tauri invoke; in-memory in fallback).
- `seed.ts`: demo review (a couple tickets/checks) so `npm run dev` shows it.
- `components/Review/ReviewPanel.tsx` (+ small row/group subcomponents).
- `App.tsx`: review view wiring, display-status overlay, `onGoToCheck`,
  `onVerdict`. `TopBar.tsx`: Review tab + badge.
- `styles.css`: review panel styles (reuse route-list / account idioms).

## Testing

- **CLI:** a Node test exercising `add-ticket → check → list → (simulate app
  append verdict) → pull (cursor advances) → reopen (round bumps, pull sees it)`,
  under a temp `$SCREENS_HOME`. Asserts the one-writer invariant paths.
- **Store overlay:** a vitest for the display-status function (latest verdict for
  matching round wins; round bump resets to awaiting).
- **Typecheck:** `npm run typecheck`. **Rust:** `cargo check` in `src-tauri`.
- **Manual E2E:** the DX intake run itself — pull real tickets, `add-ticket`/
  `check`, open the app, click a check, confirm navigation + account switch.

## Non-goals / YAGNI

- No live Jira/Dart API in V1 (ref field only).
- No verdicts.jsonl compaction yet (grows like inbox.jsonl; revisit if needed).
- No multi-reviewer/assignment model.
- No screenshots-diff/visual-regression (the canvas already captures PNGs).
