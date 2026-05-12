import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/screensStore';
import { CaretDown, Plus, Check } from './icons';
import { isTauri } from '../lib/tauri';

/**
 * Drop-down in the top bar showing every project on disk + a "new project"
 * affordance. Reads/writes through the store context — keeps the rest of the
 * UI declarative.
 */
export function ProjectSwitcher() {
  const { projects, registry, setCurrent, createProject, current } = useStore();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const label = current?.project.name ?? '(no project)';

  return (
    <div className="proj-switcher" ref={rootRef}>
      <button
        className="project-pill"
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Switch project"
      >
        {label}
        <CaretDown className="caret" />
      </button>
      {open && (
        <div className="proj-menu" role="menu">
          {projects.length === 0 ? (
            <div className="proj-empty">
              no projects yet
              <br />
              <span style={{ color: 'var(--text-3)' }}>
                run <code>screens project init &lt;slug&gt; --base-url=…</code>
              </span>
            </div>
          ) : (
            projects.map((p) => {
              const isCurrent = registry.current === p.slug;
              return (
                <button
                  key={p.slug}
                  className={'proj-item' + (isCurrent ? ' active' : '')}
                  onClick={() => {
                    setCurrent(p.slug);
                    setOpen(false);
                  }}
                  type="button"
                >
                  <span className="check">{isCurrent && <Check />}</span>
                  <span className="info">
                    <span className="name">{p.name}</span>
                    <span className="meta">{p.baseUrl}</span>
                  </span>
                </button>
              );
            })
          )}
          {isTauri() && (
            <button
              className="proj-create"
              type="button"
              onClick={() => {
                setCreating(true);
                setOpen(false);
              }}
            >
              <Plus />
              New project…
            </button>
          )}
        </div>
      )}
      {creating && (
        <CreateProjectModal
          onClose={() => setCreating(false)}
          onCreate={async (input) => {
            await createProject(input);
            await setCurrent(input.slug);
            setCreating(false);
          }}
        />
      )}
    </div>
  );
}

interface CreateProjectModalProps {
  onClose: () => void;
  onCreate: (input: { slug: string; baseUrl: string; name?: string }) => Promise<void>;
}

function CreateProjectModal({ onClose, onCreate }: CreateProjectModalProps) {
  const [slug, setSlug] = useState('');
  const [baseUrl, setBaseUrl] = useState('http://localhost:3000');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>New project</h3>
        <p className="modal-sub">
          A directory will be created at{' '}
          <code>~/.screens/projects/{slug || '<slug>'}</code>. You can also do
          this from the CLI:
          <br />
          <code>screens project init {slug || '&lt;slug&gt;'} --base-url={baseUrl}</code>
        </p>
        <label className="field">
          <span>slug</span>
          <input
            value={slug}
            onChange={(e) =>
              setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-'))
            }
            placeholder="my-app"
            autoFocus
          />
        </label>
        <label className="field">
          <span>base url</span>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </label>
        <label className="field">
          <span>name (optional)</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My App" />
        </label>
        {error && <div className="modal-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={!slug || !baseUrl || submitting}
            onClick={async () => {
              setSubmitting(true);
              setError(null);
              try {
                await onCreate({ slug, baseUrl, name: name || undefined });
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
                setSubmitting(false);
              }
            }}
          >
            {submitting ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
