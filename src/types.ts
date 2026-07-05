/**
 * Public types for the agent-editable JSON configs. Keep these in sync with
 * `screens.json` and `accounts.json` at the project root.
 */

export type ScreenStatus = 'captured' | 'stale' | 'missing';

export interface Group {
  id: string;
  label: string;
  /** CSS color value — typically `var(--c-<groupid>)`. */
  color: string;
  /** Bounding box for the dashed frame on the canvas. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Screen {
  id: string;
  /** Path that gets appended to baseUrl, e.g. `/app/projects/:id`. */
  path: string;
  /** Human-readable name shown in the node card. */
  title: string;
  /** Must match a `Group.id`. */
  group: string;
  /** Position on the canvas (px). */
  x: number;
  y: number;
  status?: ScreenStatus;
  /**
   * Last visit / capture time. Epoch-ms is the canonical form (so cards age
   * over time). Free-form strings ("5m ago") are accepted on read for legacy
   * `screens.json` files and for the in-repo demo seed.
   */
  visitedAt?: number | string | null;
  /**
   * Epoch-ms timestamp of the last successful screenshot capture. Used to
   * cache-bust the `<img src="file://…">` so the canvas re-renders the new
   * PNG even though the path on disk stays the same.
   */
  capturedAt?: number | null;
}

/** Directed edge `[from, to]` between two screen IDs. */
export type Edge = [string, string];

/**
 * Optional config used by the embedded webview to auto-log-in when the user
 * picks an account. All three selectors must match in the post-navigation
 * DOM. The injection polls for up to 5s before giving up.
 */
export interface LoginAutomation {
  /** Path or full URL to navigate to before injecting. Resolved against baseUrl. */
  url: string;
  /** CSS selector for the email/username input. */
  emailSelector: string;
  /** CSS selector for the password input. */
  passwordSelector: string;
  /** CSS selector for the submit button. */
  submitSelector: string;
  /** Optional: where to navigate after a successful login (default: stay). */
  successUrl?: string;
}

export interface Account {
  id: string;
  name: string;
  email: string;
  /** Free-form label; routes can gate on this in your app. */
  role: string;
  /** OKLCH hue (0-360) for the avatar/swatch. */
  color: number;
  /** Credential for auto-login (only stored in `accounts.json`). */
  password?: string;
  /** When present, picking this account triggers the embedded auto-login flow. */
  login?: LoginAutomation;
}

export interface ScreensConfig {
  groups: Group[];
  screens: Screen[];
  edges: Edge[];
}

export interface AccountsConfig {
  defaultAccountId?: string;
  accounts: Account[];
}

export type ViewMode = 'map' | 'split' | 'app' | 'review';

// ─── Review cockpit ──────────────────────────────────────────────────────────
//
// `review.json` (agent-authored) → tickets + checks. `verdicts.jsonl`
// (app-authored, append-only) → your rulings. See the review cockpit spec.

/** A reviewer's ruling on a check. */
export type VerdictKind = 'pass' | 'fail' | 'changes';

/** Canonical status the agent records on a check (reconciled from verdicts). */
export type CheckStatus = 'awaiting' | VerdictKind;

export type TicketStatus = 'in-progress' | 'in-review' | 'done';

/** Derived rollup of a ticket's checks, computed in the UI. */
export type TicketRollup = 'empty' | 'awaiting' | 'needs-work' | 'passed';

export interface ReviewCheck {
  id: string;
  /** What to verify. */
  title: string;
  /** Optional expanded "what done looks like". */
  detail?: string;
  /** Where to jump — path resolved against baseUrl. */
  path?: string;
  /** Optional alternative to `path`: a canvas screen node id. */
  screenId?: string;
  /** Optional account id to switch to before reviewing (triggers auto-login). */
  account?: string;
  /** Canonical status recorded by the agent. Display status is derived from
   *  the verdict log (latest verdict for the current `round`). */
  status?: CheckStatus;
  /** Review round. Bumped by the agent on re-request so stale verdicts drop. */
  round?: number;
}

export interface ReviewTicket {
  id: string;
  title: string;
  /** External ticket URL/id (Jira/Dart), shown as a link. */
  ref?: string;
  /** Pull-request URL. */
  pr?: string;
  summary?: string;
  status?: TicketStatus;
  createdAt?: number;
  checks: ReviewCheck[];
}

export interface ReviewConfig {
  tickets: ReviewTicket[];
}

/** One line of `verdicts.jsonl`. */
export interface Verdict {
  ts: number;
  ticketId: string;
  checkId: string;
  round: number;
  verdict: VerdictKind;
  note?: string;
}

export interface ActivityEntry {
  ts: string;
  verb: string;
  text: string;
  level?: 'info' | 'warn';
}
