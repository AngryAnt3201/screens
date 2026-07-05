/**
 * Demo project shipped for the browser-fallback mode of the React UI
 * (`npm run dev` without Tauri). Real projects live in `~/.screens/`.
 */
import type { ProjectBundle } from './screensStore';

export function demoSeed(): ProjectBundle {
  return {
    project: {
      slug: 'demo',
      name: 'Demo · Resona',
      baseUrl: 'http://localhost:3000',
    },
    screens: {
      groups: [
        { id: 'public',   label: '/ (public)',    color: 'var(--c-public)',   x: 40,   y: 40,   w: 640, h: 280 },
        { id: 'auth',     label: '/auth',         color: 'var(--c-auth)',     x: 40,   y: 360,  w: 640, h: 480 },
        { id: 'app',      label: '/app',          color: 'var(--c-app)',      x: 720,  y: 40,   w: 980, h: 480 },
        { id: 'settings', label: '/app/settings', color: 'var(--c-settings)', x: 720,  y: 560,  w: 640, h: 280 },
        { id: 'admin',    label: '/admin',        color: 'var(--c-admin)',    x: 1400, y: 560,  w: 300, h: 280 },
      ],
      screens: [
        { id: 'home',           group: 'public',   title: 'Landing',          path: '/',                       x: 80,   y: 80,  status: 'captured', visitedAt: '2m ago' },
        { id: 'pricing',        group: 'public',   title: 'Pricing',          path: '/pricing',                x: 380,  y: 80,  status: 'captured', visitedAt: '2m ago' },
        { id: 'login',          group: 'auth',     title: 'Log in',           path: '/login',                  x: 80,   y: 400, status: 'captured', visitedAt: 'just now' },
        { id: 'signup',         group: 'auth',     title: 'Sign up',          path: '/signup',                 x: 380,  y: 400, status: 'captured', visitedAt: '1h ago' },
        { id: 'forgot',         group: 'auth',     title: 'Forgot password',  path: '/forgot-password',        x: 80,   y: 640, status: 'stale',    visitedAt: '3d ago' },
        { id: 'verify',         group: 'auth',     title: 'Verify email',     path: '/verify',                 x: 380,  y: 640, status: 'missing', visitedAt: null },
        { id: 'app-home',       group: 'app',      title: 'Library',          path: '/app',                    x: 760,  y: 80,  status: 'captured', visitedAt: '5m ago' },
        { id: 'projects',       group: 'app',      title: 'Projects',         path: '/app/projects',           x: 1060, y: 80,  status: 'captured', visitedAt: '5m ago' },
        { id: 'project-detail', group: 'app',      title: 'Project detail',   path: '/app/projects/:id',       x: 1360, y: 80,  status: 'captured', visitedAt: '12m ago' },
        { id: 'queue',          group: 'app',      title: 'Queue',            path: '/app/queue',              x: 760,  y: 320, status: 'captured', visitedAt: '14m ago' },
        { id: 'share',          group: 'app',      title: 'Share link',       path: '/app/share/:token',       x: 1060, y: 320, status: 'stale',    visitedAt: '1d ago' },
        { id: 'invite',         group: 'app',      title: 'Invite team',      path: '/app/invite',             x: 1360, y: 320, status: 'missing', visitedAt: null },
        { id: 'settings',       group: 'settings', title: 'Settings',         path: '/app/settings',           x: 760,  y: 600, status: 'captured', visitedAt: '8m ago' },
        { id: 'billing',        group: 'settings', title: 'Billing',          path: '/app/settings/billing',   x: 1060, y: 600, status: 'captured', visitedAt: '8m ago' },
        { id: 'team',           group: 'settings', title: 'Team',             path: '/app/settings/team',      x: 1360, y: 600, status: 'captured', visitedAt: '8m ago' },
        { id: 'admin',          group: 'admin',    title: 'Admin',            path: '/admin',                  x: 1440, y: 600, status: 'captured', visitedAt: '20m ago' },
      ],
      edges: [
        ['home', 'login'], ['home', 'signup'], ['home', 'pricing'],
        ['pricing', 'signup'], ['login', 'forgot'], ['login', 'app-home'],
        ['signup', 'verify'], ['signup', 'app-home'], ['forgot', 'login'],
        ['verify', 'app-home'], ['app-home', 'projects'], ['app-home', 'queue'],
        ['projects', 'project-detail'], ['project-detail', 'share'],
        ['project-detail', 'invite'], ['app-home', 'settings'],
        ['settings', 'billing'], ['settings', 'team'], ['team', 'invite'],
      ],
    },
    accounts: {
      defaultAccountId: 'owner',
      accounts: [
        { id: 'owner',   name: 'Ada Owner',    email: 'ada@resona.test',     role: 'owner',   color: 240 },
        { id: 'admin',   name: 'Ben Admin',    email: 'ben@resona.test',     role: 'admin',   color: 80 },
        { id: 'pro',     name: 'Cleo Carter',  email: 'cleo+pro@test.io',    role: 'pro',     color: 160 },
        { id: 'free',    name: 'Dax Free',     email: 'dax+free@test.io',    role: 'free',    color: 30 },
        { id: 'invited', name: 'Eli Invitee',  email: 'eli@external.test',   role: 'invited', color: 310 },
      ],
    },
    review: {
      tickets: [
        {
          id: 'RES-142',
          title: 'Billing: annual plan toggle',
          ref: 'https://example.atlassian.net/browse/RES-142',
          pr: 'https://github.com/resona/web/pull/318',
          status: 'in-review',
          priority: 'High',
          summary: 'Adds monthly/annual switch with 2-months-free badge.',
          checks: [
            { id: 'res-142-toggle', title: 'Annual toggle shows “2 months free” badge', path: '/app/settings/billing', screenId: 'billing', account: 'pro', detail: 'Badge appears only when Annual is selected.', status: 'awaiting', round: 0 },
            { id: 'res-142-free', title: 'Free plan cannot select annual', path: '/app/settings/billing', screenId: 'billing', account: 'free', status: 'awaiting', round: 0 },
          ],
        },
        {
          id: 'RES-137',
          title: 'Team invite email validation',
          ref: 'https://example.atlassian.net/browse/RES-137',
          status: 'in-review',
          priority: 'Medium',
          checks: [
            { id: 'res-137-invalid', title: 'Invalid email shows inline error', path: '/app/invite', screenId: 'invite', account: 'owner', status: 'awaiting', round: 0 },
            { id: 'res-137-dupe', title: 'Duplicate invite is rejected', path: '/app/invite', screenId: 'invite', account: 'owner', status: 'awaiting', round: 0 },
          ],
        },
      ],
    },
    verdicts: [],
  };
}
