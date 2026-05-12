import { useState } from 'react';
import type {
  Account,
  ActivityEntry,
  Group,
  Screen,
} from '../types';
import { Avatar } from './Avatar';
import { Chevron } from './icons';

interface SidebarProps {
  groups: Group[];
  screens: Screen[];
  currentScreenId: string | null;
  selectedScreenId: string | null;
  onPickScreen: (s: Screen) => void;

  accounts: Account[];
  currentAccountId: string | null;
  defaultAccountId: string | null;
  onPickAccount: (a: Account) => void;

  activity: ActivityEntry[];
}

export function Sidebar({
  groups,
  screens,
  currentScreenId,
  selectedScreenId,
  onPickScreen,
  accounts,
  currentAccountId,
  defaultAccountId,
  onPickAccount,
  activity,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  return (
    <aside className="sidebar">
      <div className="sb-section">
        <div className="sb-head">
          <span>Routes</span>
        </div>
        {groups.length === 0 ? (
          <div className="activity-empty" style={{ padding: '8px 8px 4px' }}>
            no routes yet
            <br />
            run <code>screens add &lt;url&gt;</code>
          </div>
        ) : (
          groups.map((g) => {
            const items = screens.filter((s) => s.group === g.id);
            const isCollapsed = collapsed[g.id];
            return (
              <div className="route-group" key={g.id}>
                <div
                  className={'route-group-head' + (isCollapsed ? ' collapsed' : '')}
                  onClick={() =>
                    setCollapsed({ ...collapsed, [g.id]: !isCollapsed })
                  }
                >
                  <Chevron className="chev" />
                  <span
                    className="swatch"
                    style={{ background: `var(--c-${g.id}, var(--c-default))` }}
                  />
                  <span className="name">{g.label}</span>
                  <span className="count">{items.length}</span>
                </div>
                {!isCollapsed && items.length > 0 && (
                  <div className="route-list">
                    {items.map((s) => {
                      const active =
                        currentScreenId === s.id || selectedScreenId === s.id;
                      const statusClass =
                        s.status === 'captured'
                          ? 'captured'
                          : s.status === 'stale'
                            ? 'stale'
                            : s.status === 'missing'
                              ? 'missing'
                              : 'unknown';
                      return (
                        <div
                          key={s.id}
                          className={'route-item' + (active ? ' active' : '')}
                          onClick={() => onPickScreen(s)}
                          title={s.title}
                        >
                          <span className="path">{s.path}</span>
                          <span
                            className={`status-dot ${statusClass}`}
                            title={s.status ?? 'unknown'}
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="sb-section">
        <div className="sb-head">
          <span>Test accounts</span>
        </div>
        {accounts.length === 0 ? (
          <div className="activity-empty" style={{ padding: '8px 8px 4px' }}>
            no accounts yet
            <br />
            run <code>screens account add &lt;id&gt;</code>
          </div>
        ) : (
          <>
            {accounts.map((a) => (
              <div
                key={a.id}
                className={'account' + (currentAccountId === a.id ? ' active' : '')}
                onClick={() => onPickAccount(a)}
              >
                <Avatar color={a.color} name={a.name} size={24} />
                <div className="info">
                  <div className="name">{a.name}</div>
                  <div className="meta">
                    {a.role} · {a.email}
                  </div>
                </div>
                {currentAccountId === a.id && (
                  <span className="tag">active</span>
                )}
                {currentAccountId !== a.id && defaultAccountId === a.id && (
                  <span className="tag">default</span>
                )}
              </div>
            ))}
          </>
        )}
      </div>

      <div className="sb-section flex activity">
        <div className="sb-head">
          <span>History</span>
          {activity.length > 0 && <span className="live">live</span>}
        </div>
        <div className="activity-list">
          {activity.length === 0 ? (
            <div className="activity-empty">
              waiting for events
              <br />
              <span style={{ fontSize: 10.5 }}>
                edits, captures, CLI commands appear here.
              </span>
            </div>
          ) : (
            activity.map((a, i) => (
              <div
                key={i}
                className={'activity-item' + (a.level === 'warn' ? ' warn' : '')}
              >
                <span className="ts">{a.ts}</span>
                <span className="verb">{a.verb}</span>
                <span className="text">{a.text}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </aside>
  );
}
