//! Screens — Tauri 2 backend.
//!
//! Three responsibilities:
//!   1. Embedded webview (real browser pane with DevTools + per-account cookies)
//!   2. Project store at `~/.screens/` (mirrors `bin/lib/store.mjs`)
//!   3. File watcher that turns store + inbox changes into frontend events

mod store;
mod watcher;

use std::path::PathBuf;
use tauri::{
    webview::WebviewBuilder, AppHandle, LogicalPosition, LogicalSize, Manager,
    Url, WebviewUrl,
};

// ─── Embedded webview ──────────────────────────────────────────────────────

const EMBEDDED: &str = "embedded";

fn embedded(app: &AppHandle) -> Result<tauri::Webview, String> {
    app.webviews()
        .get(EMBEDDED)
        .cloned()
        .ok_or_else(|| "embedded webview not created".to_string())
}

#[tauri::command]
async fn embed_open(
    app: AppHandle,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    data_dir: Option<String>,
) -> Result<(), String> {
    if let Some(existing) = app.webviews().get(EMBEDDED).cloned() {
        let _ = existing.close();
    }
    let main = app
        .get_window("main")
        .ok_or_else(|| "no main window".to_string())?;

    let parsed_url = parse_url(&url)?;
    let mut builder = WebviewBuilder::new(EMBEDDED, WebviewUrl::External(parsed_url))
        .devtools(true);
    if let Some(dir) = data_dir {
        builder = builder.data_directory(PathBuf::from(dir));
    }
    main.add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn embed_bounds(
    app: AppHandle,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let wv = embedded(&app)?;
    wv.set_position(LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    wv.set_size(LogicalSize::new(w.max(1.0), h.max(1.0)))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn embed_navigate(app: AppHandle, url: String) -> Result<(), String> {
    let wv = embedded(&app)?;
    let parsed = parse_url(&url)?;
    wv.navigate(parsed).map_err(|e| e.to_string())
}

#[tauri::command]
async fn embed_eval(app: AppHandle, js: String) -> Result<(), String> {
    let wv = embedded(&app)?;
    wv.eval(&js).map_err(|e| e.to_string())
}

#[tauri::command]
async fn embed_close(app: AppHandle) -> Result<(), String> {
    if let Some(wv) = app.webviews().get(EMBEDDED).cloned() {
        let _ = wv.close();
    }
    Ok(())
}

#[tauri::command]
async fn embed_reload(app: AppHandle) -> Result<(), String> {
    let wv = embedded(&app)?;
    wv.eval("window.location.reload()").map_err(|e| e.to_string())
}

#[tauri::command]
async fn embed_devtools(app: AppHandle) -> Result<(), String> {
    let wv = embedded(&app)?;
    wv.open_devtools();
    Ok(())
}

#[tauri::command]
fn account_data_dir(_app: AppHandle, project: String, account_id: String) -> Result<String, String> {
    let safe_project: String = sanitize(&project);
    let safe_account: String = sanitize(&account_id);
    if safe_project.is_empty() || safe_account.is_empty() {
        return Err("invalid project or account id".into());
    }
    let path = store::home()
        .join("accounts")
        .join(safe_project)
        .join(safe_account);
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

fn sanitize(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        .collect()
}

fn parse_url(input: &str) -> Result<Url, String> {
    input
        .parse::<Url>()
        .map_err(|e| format!("invalid url `{}`: {}", input, e))
}

// ─── Store / project commands ──────────────────────────────────────────────

#[tauri::command]
fn store_home() -> String {
    store::home().to_string_lossy().into_owned()
}

#[tauri::command]
fn store_registry() -> Result<store::Registry, String> {
    store::read_registry()
}

#[tauri::command]
fn store_list_projects() -> Result<Vec<store::ProjectMeta>, String> {
    store::list_projects()
}

#[tauri::command]
fn store_project(slug: String) -> Result<store::ProjectBundle, String> {
    store::read_project_bundle(&slug)
}

#[tauri::command]
fn store_set_current(slug: String) -> Result<(), String> {
    store::set_current(&slug)
}

#[tauri::command]
fn store_create_project(
    slug: String,
    base_url: String,
    name: Option<String>,
) -> Result<store::ProjectMeta, String> {
    store::create_project(&slug, name.as_deref(), &base_url)
}

#[tauri::command]
fn store_delete_project(slug: String) -> Result<(), String> {
    store::delete_project(&slug)
}

#[tauri::command]
fn store_update_project_meta(slug: String, patch: serde_json::Value) -> Result<store::ProjectMeta, String> {
    store::update_project_meta(&slug, patch)
}

#[tauri::command]
fn store_write_screens(slug: String, data: serde_json::Value) -> Result<(), String> {
    store::write_screens_value(&slug, data)
}

#[tauri::command]
fn store_write_accounts(slug: String, data: serde_json::Value) -> Result<(), String> {
    store::write_accounts_value(&slug, data)
}

/// Return a file:// URL for a screenshot, suitable for `<img src>` in the
/// webview. Returns null when the file doesn't exist.
#[tauri::command]
fn store_screenshot_url(_app: AppHandle, slug: String, screen_id: String) -> Option<String> {
    let path = store::screenshot_path(&slug, &screen_id);
    if !path.exists() {
        return None;
    }
    Some(format!("file://{}", path.display()))
}

// ─── Tauri builder ─────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // Bootstrap the on-disk store + start file watcher.
            if let Err(e) = store::ensure_store() {
                log::warn!("store init: {}", e);
            }
            watcher::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // embedded webview
            embed_open,
            embed_bounds,
            embed_navigate,
            embed_eval,
            embed_close,
            embed_reload,
            embed_devtools,
            account_data_dir,
            // store
            store_home,
            store_registry,
            store_list_projects,
            store_project,
            store_set_current,
            store_create_project,
            store_delete_project,
            store_update_project_meta,
            store_write_screens,
            store_write_accounts,
            store_screenshot_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
