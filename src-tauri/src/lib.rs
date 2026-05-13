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
    webview::WebviewBuilder, AppHandle, Emitter, LogicalPosition, LogicalSize, Manager,
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
    init_script: Option<String>,
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
    if let Some(script) = init_script {
        builder = builder.initialization_script(script);
    }
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

/// The embedded webview's current URL. Used by the auto-login outcome
/// detector — App.tsx polls this after switching account and treats a
/// transition to `login.successUrl` as a successful sign-in.
#[tauri::command]
async fn embed_url(app: AppHandle) -> Result<String, String> {
    let wv = embedded(&app)?;
    wv.url().map(|u| u.to_string()).map_err(|e| e.to_string())
}

/// Capture the embedded webview pane to `~/.screens/projects/<slug>/screenshots/<id>.png`.
///
/// `x/y/w/h` are the webview's bounds in *logical* (CSS) pixels relative to the
/// main window's content area — exactly what the frontend already tracks via
/// `getBoundingClientRect` and feeds to `embed_bounds`. We add the main
/// window's `inner_position` (converted from physical to logical via the scale
/// factor) to get screen-absolute logical coords, then shell out to macOS's
/// `screencapture -R x,y,w,h` which expects logical points.
///
/// Returns the `file://` URL of the freshly-written PNG on success.
#[tauri::command]
async fn embed_capture(
    app: AppHandle,
    slug: String,
    screen_id: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<String, String> {
    // Ensure the embedded webview actually exists before we go off and grab
    // the screen — otherwise the user is staring at the React UI and we'd be
    // capturing the wrong rectangle.
    let _ = embedded(&app)?;

    let main = app
        .get_window("main")
        .ok_or_else(|| "no main window".to_string())?;
    let win_inner = main
        .inner_position()
        .map_err(|e| format!("inner_position: {}", e))?;
    let scale = main
        .scale_factor()
        .map_err(|e| format!("scale_factor: {}", e))?;
    if scale <= 0.0 {
        return Err(format!("invalid scale factor: {}", scale));
    }

    // `inner_position` is physical pixels; the bounds we got from JS are
    // logical. Convert the window origin to logical so we can add cleanly.
    let win_inner_x_logical = win_inner.x as f64 / scale;
    let win_inner_y_logical = win_inner.y as f64 / scale;
    let abs_x = win_inner_x_logical + x;
    let abs_y = win_inner_y_logical + y;
    let abs_w = w.max(1.0);
    let abs_h = h.max(1.0);

    let path = store::screenshot_path(&slug, &screen_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }
    // Wipe any prior file first so we can detect a silent screencapture failure
    // by checking that the file (re)appeared.
    let _ = std::fs::remove_file(&path);

    #[cfg(target_os = "macos")]
    {
        // `screencapture -R x,y,w,h` accepts logical screen points. `-x` mutes
        // the shutter sound; `-C` would include the cursor — we omit it so an
        // accidental hover doesn't leak into the thumbnail.
        let region = format!(
            "{},{},{},{}",
            abs_x.round() as i64,
            abs_y.round() as i64,
            abs_w.round() as i64,
            abs_h.round() as i64,
        );
        let output = std::process::Command::new("/usr/sbin/screencapture")
            .arg("-x")
            .arg("-t").arg("png")
            .arg("-R").arg(&region)
            .arg(&path)
            .output()
            .map_err(|e| format!("spawn screencapture: {}", e))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "screencapture exited with {} — {}",
                output.status,
                stderr.trim(),
            ));
        }
        // macOS denies screen capture silently when Screen Recording permission
        // isn't granted: the process exits 0 but writes nothing. Surface a
        // useful message in that case.
        let len = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        if !path.exists() || len == 0 {
            let _ = std::fs::remove_file(&path);
            return Err(
                "screencapture wrote no output. Grant Screen Recording permission to this app in System Settings → Privacy & Security → Screen Recording, then try again."
                    .into(),
            );
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        // Stop the linter from yelling about unused vars on Windows / Linux.
        let _ = (abs_x, abs_y, abs_w, abs_h);
        return Err(
            "embed_capture: native screenshot is only implemented on macOS so far. PRs welcome.".into(),
        );
    }

    Ok(format!("file://{}", path.display()))
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

/// Return the absolute filesystem path of a screenshot. The TS side wraps
/// this in Tauri's `convertFileSrc()` to produce an `asset://` URL the
/// webview is permitted to load — `file://` URLs are blocked by Tauri 2's
/// default security policy. Returns null when the file doesn't exist.
#[tauri::command]
fn store_screenshot_url(_app: AppHandle, slug: String, screen_id: String) -> Option<String> {
    let path = store::screenshot_path(&slug, &screen_id);
    if !path.exists() {
        return None;
    }
    Some(path.to_string_lossy().into_owned())
}

// ─── Tauri builder ─────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("screens-ipc", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let body_bytes = request.body().to_vec();
            let path = request.uri().path().trim_start_matches('/').to_string();
            tauri::async_runtime::spawn(async move {
                if path == "post" {
                    match serde_json::from_slice::<serde_json::Value>(&body_bytes) {
                        Ok(v) => {
                            let _ = app.emit("console:event", v);
                        }
                        Err(e) => log::warn!("[screens-ipc] bad payload: {}", e),
                    }
                }
                let resp = tauri::http::Response::builder()
                    .status(tauri::http::StatusCode::NO_CONTENT)
                    .header("Access-Control-Allow-Origin", "*")
                    .header("Access-Control-Allow-Methods", "POST, OPTIONS")
                    .header("Access-Control-Allow-Headers", "Content-Type")
                    .body(Vec::new())
                    .unwrap();
                responder.respond(resp);
            });
        })
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
            embed_url,
            embed_capture,
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
