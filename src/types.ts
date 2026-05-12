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
  /** Free-form timestamp string shown on the card, e.g. "5m ago". */
  visitedAt?: string | null;
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

export type ViewMode = 'map' | 'split' | 'app';

export interface ActivityEntry {
  ts: string;
  verb: string;
  text: string;
  level?: 'info' | 'warn';
}
