//! Watches `~/.screens/` and fans changes out to the React frontend.
//!
//! Three kinds of event:
//!   - `store:registry`  — projects.json changed (current project, or set).
//!   - `store:project`   — files inside the currently-tracked project changed.
//!   - `inbox:command`   — a new line was appended to inbox.jsonl.

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    mpsc, Arc, Mutex,
};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::store;

#[derive(Serialize, Deserialize, Clone)]
pub struct InboxCommand {
    pub ts: u64,
    pub cmd: String,
    #[serde(default)]
    pub args: serde_json::Value,
}

#[derive(Default)]
struct State {
    inbox_offset: AtomicU64,
}

pub fn start(app: AppHandle) {
    // Make sure the store exists before we try to watch it.
    if let Err(e) = store::ensure_store() {
        log::warn!("store init failed: {}", e);
    }
    // Drain any pre-existing inbox entries on startup so the user can queue
    // commands before the app is even open.
    let state = Arc::new(State::default());

    // notify uses a std mpsc channel; spawn a thread to consume it.
    let (tx, rx) = mpsc::channel();
    let mut watcher: RecommendedWatcher = match notify::Watcher::new(
        move |res: Result<Event, notify::Error>| {
            let _ = tx.send(res);
        },
        notify::Config::default().with_poll_interval(Duration::from_millis(300)),
    ) {
        Ok(w) => w,
        Err(e) => {
            log::warn!("watcher init failed: {}", e);
            return;
        }
    };
    let home = store::home();
    if let Err(e) = watcher.watch(&home, RecursiveMode::Recursive) {
        log::warn!("watch {}: {}", home.display(), e);
        return;
    }

    // Initial dispatch (so the frontend gets the current state immediately).
    if let Ok(reg) = store::read_registry() {
        let _ = app.emit("store:registry", reg);
    }
    drain_inbox(&app, &state);

    let watcher = Arc::new(Mutex::new(watcher));
    let app_handle = app.clone();
    thread::spawn(move || {
        // Keep the watcher alive for the duration of the thread.
        let _keep = watcher;
        while let Ok(res) = rx.recv() {
            match res {
                Ok(event) => handle_event(&app_handle, &state, event),
                Err(e) => log::warn!("watch error: {}", e),
            }
        }
    });
}

fn handle_event(app: &AppHandle, state: &Arc<State>, event: Event) {
    // We only care about content changes.
    let is_modify = matches!(
        event.kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
    );
    if !is_modify {
        return;
    }
    let registry_path = store::registry_path();
    let inbox_path = store::inbox_path();
    let projects_root = store::projects_dir();

    for path in event.paths {
        if path == registry_path {
            if let Ok(reg) = store::read_registry() {
                let _ = app.emit("store:registry", reg);
            }
        } else if path == inbox_path {
            drain_inbox(app, state);
        } else if path.starts_with(&projects_root) {
            // Determine which project changed.
            if let Some(slug) = slug_for_path(&projects_root, &path) {
                let _ = app.emit("store:project", serde_json::json!({ "slug": slug }));
            }
        }
    }
}

fn slug_for_path(projects_root: &PathBuf, path: &PathBuf) -> Option<String> {
    let rel = path.strip_prefix(projects_root).ok()?;
    let first = rel.components().next()?;
    let slug = first.as_os_str().to_string_lossy().to_string();
    if slug.is_empty() { None } else { Some(slug) }
}

fn drain_inbox(app: &AppHandle, state: &Arc<State>) {
    use std::fs::File;
    use std::io::{BufRead, BufReader, Seek, SeekFrom};

    let path = store::inbox_path();
    let Ok(mut file) = File::open(&path) else { return; };
    let metadata = match file.metadata() {
        Ok(m) => m,
        Err(_) => return,
    };
    let size = metadata.len();
    let mut offset = state.inbox_offset.load(Ordering::SeqCst);

    // If the file shrank (truncated externally), reset to zero.
    if offset > size {
        offset = 0;
    }
    if offset == size {
        return;
    }
    if file.seek(SeekFrom::Start(offset)).is_err() {
        return;
    }
    let reader = BufReader::new(&mut file);
    for line in reader.lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<InboxCommand>(&line) {
            Ok(cmd) => {
                let _ = app.emit("inbox:command", cmd);
            }
            Err(e) => log::warn!("inbox parse: {} -- {}", e, line),
        }
    }
    state.inbox_offset.store(size, Ordering::SeqCst);
}
