//! File-backed project store at `$SCREENS_HOME` (default: `~/.screens/`).
//!
//! Mirrors the JS implementation in `bin/lib/store.mjs` — every read/write
//! goes through here so the watcher and the Tauri commands stay in lock-step.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Registry {
    pub current: Option<String>,
    #[serde(default)]
    pub projects: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectMeta {
    pub slug: String,
    pub name: String,
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    #[serde(rename = "defaultAccountId", skip_serializing_if = "Option::is_none")]
    pub default_account_id: Option<String>,
    #[serde(rename = "createdAt", skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectBundle {
    pub project: ProjectMeta,
    pub screens: Value,
    pub accounts: Value,
    /// Agent-authored review tickets + checks (`review.json`). Empty default
    /// when the project predates the review cockpit.
    pub review: Value,
    /// App-authored verdict log (`verdicts.jsonl`), one parsed object per line.
    pub verdicts: Vec<Value>,
}

/// Returns the configured Screens home directory (`$SCREENS_HOME` or `~/.screens`).
pub fn home() -> PathBuf {
    if let Ok(s) = std::env::var("SCREENS_HOME") {
        PathBuf::from(s)
    } else {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".screens")
    }
}

pub fn projects_dir() -> PathBuf {
    home().join("projects")
}

pub fn registry_path() -> PathBuf {
    home().join("projects.json")
}

pub fn inbox_path() -> PathBuf {
    home().join("inbox.jsonl")
}

pub fn review_path(slug: &str) -> PathBuf {
    project_dir(slug).join("review.json")
}

pub fn verdicts_path(slug: &str) -> PathBuf {
    project_dir(slug).join("verdicts.jsonl")
}

pub fn project_dir(slug: &str) -> PathBuf {
    projects_dir().join(slug)
}

pub fn screenshots_dir(slug: &str) -> PathBuf {
    project_dir(slug).join("screenshots")
}

pub fn screenshot_path(slug: &str, screen_id: &str) -> PathBuf {
    screenshots_dir(slug).join(format!("{}.png", screen_id))
}

/// Make sure the registry + projects directory both exist.
pub fn ensure_store() -> Result<(), String> {
    fs::create_dir_all(projects_dir()).map_err(io)?;
    if !registry_path().exists() {
        write_json(&registry_path(), &Registry::default())?;
    }
    Ok(())
}

pub fn read_registry() -> Result<Registry, String> {
    ensure_store()?;
    read_json::<Registry>(&registry_path())
}

pub fn write_registry(reg: &Registry) -> Result<(), String> {
    write_json(&registry_path(), reg)
}

pub fn read_project_meta(slug: &str) -> Result<ProjectMeta, String> {
    read_json::<ProjectMeta>(&project_dir(slug).join("project.json"))
}

#[allow(dead_code)]
pub fn project_exists(slug: &str) -> bool {
    project_dir(slug).join("project.json").exists()
}

pub fn read_project_bundle(slug: &str) -> Result<ProjectBundle, String> {
    let project = read_project_meta(slug)?;
    let screens = read_json::<Value>(&project_dir(slug).join("screens.json"))?;
    let accounts = read_json::<Value>(&project_dir(slug).join("accounts.json"))?;
    let review = read_review(slug);
    let verdicts = read_verdicts(slug);
    Ok(ProjectBundle { project, screens, accounts, review, verdicts })
}

/// Read `review.json`, tolerating its absence (projects created before the
/// review cockpit shipped) — returns an empty `{ "tickets": [] }` shape.
pub fn read_review(slug: &str) -> Value {
    read_json::<Value>(&review_path(slug))
        .unwrap_or_else(|_| serde_json::json!({ "tickets": [] }))
}

/// Read the append-only verdict log, one parsed JSON object per non-blank
/// line. Missing file or malformed lines are skipped rather than fatal — the
/// log is advisory input to the sidebar's display overlay.
pub fn read_verdicts(slug: &str) -> Vec<Value> {
    let raw = match fs::read_to_string(verdicts_path(slug)) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    raw.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .collect()
}

/// Append one verdict object as a line to `verdicts.jsonl`. The app is the sole
/// writer of this file — mirrors how the CLI is the sole writer of `inbox.jsonl`.
pub fn append_verdict(slug: &str, verdict: &Value) -> Result<(), String> {
    use std::io::Write;
    let path = verdicts_path(slug);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(io)?;
    }
    let line = serde_json::to_string(verdict).map_err(|e| e.to_string())?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(io)?;
    file.write_all(line.as_bytes()).map_err(io)?;
    file.write_all(b"\n").map_err(io)?;
    Ok(())
}

pub fn list_projects() -> Result<Vec<ProjectMeta>, String> {
    let reg = read_registry()?;
    let mut out = Vec::with_capacity(reg.projects.len());
    for slug in &reg.projects {
        if let Ok(meta) = read_project_meta(slug) {
            out.push(meta);
        }
    }
    Ok(out)
}

pub fn set_current(slug: &str) -> Result<(), String> {
    let mut reg = read_registry()?;
    if !reg.projects.contains(&slug.to_string()) {
        return Err(format!("unknown project: \"{}\"", slug));
    }
    reg.current = Some(slug.to_string());
    write_registry(&reg)
}

pub fn create_project(
    slug: &str,
    name: Option<&str>,
    base_url: &str,
) -> Result<ProjectMeta, String> {
    if !is_valid_slug(slug) {
        return Err(format!("invalid project slug: \"{}\"", slug));
    }
    if base_url.is_empty() {
        return Err("baseUrl is required".into());
    }
    ensure_store()?;
    let dir = project_dir(slug);
    if dir.exists() {
        return Err(format!("project \"{}\" already exists", slug));
    }
    fs::create_dir_all(screenshots_dir(slug)).map_err(io)?;
    let meta = ProjectMeta {
        slug: slug.to_string(),
        name: name
            .map(|s| s.to_string())
            .unwrap_or_else(|| title_case(slug)),
        base_url: base_url.trim_end_matches('/').to_string(),
        default_account_id: None,
        created_at: Some(chrono_iso_now()),
    };
    write_json(&dir.join("project.json"), &meta)?;
    write_json(
        &dir.join("screens.json"),
        &serde_json::json!({ "groups": [], "screens": [], "edges": [] }),
    )?;
    write_json(
        &dir.join("accounts.json"),
        &serde_json::json!({ "defaultAccountId": null, "accounts": [] }),
    )?;
    let mut reg = read_registry()?;
    if !reg.projects.contains(&slug.to_string()) {
        reg.projects.push(slug.to_string());
    }
    if reg.current.is_none() {
        reg.current = Some(slug.to_string());
    }
    write_registry(&reg)?;
    Ok(meta)
}

pub fn delete_project(slug: &str) -> Result<(), String> {
    let mut reg = read_registry()?;
    if !reg.projects.contains(&slug.to_string()) {
        return Err(format!("unknown project: \"{}\"", slug));
    }
    let _ = fs::remove_dir_all(project_dir(slug));
    reg.projects.retain(|s| s != slug);
    if reg.current.as_deref() == Some(slug) {
        reg.current = reg.projects.first().cloned();
    }
    write_registry(&reg)
}

pub fn update_project_meta(slug: &str, patch: Value) -> Result<ProjectMeta, String> {
    let path = project_dir(slug).join("project.json");
    let mut cur: Value = read_json(&path)?;
    let obj = cur
        .as_object_mut()
        .ok_or_else(|| "project.json is not an object".to_string())?;
    if let Some(p) = patch.as_object() {
        for (k, v) in p {
            obj.insert(k.clone(), v.clone());
        }
    }
    // Tidy baseUrl.
    if let Some(b) = obj.get_mut("baseUrl") {
        if let Some(s) = b.as_str() {
            *b = Value::String(s.trim_end_matches('/').to_string());
        }
    }
    write_json(&path, &cur)?;
    Ok(serde_json::from_value(cur).map_err(|e| e.to_string())?)
}

pub fn write_screens_value(slug: &str, value: Value) -> Result<(), String> {
    write_json(&project_dir(slug).join("screens.json"), &value)
}

pub fn write_accounts_value(slug: &str, value: Value) -> Result<(), String> {
    write_json(&project_dir(slug).join("accounts.json"), &value)
}

// ─── helpers ───────────────────────────────────────────────────────────────

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let raw = fs::read_to_string(path)
        .map_err(|e| format!("read {}: {}", path.display(), e))?;
    serde_json::from_str(&raw)
        .map_err(|e| format!("parse {}: {}", path.display(), e))
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(io)?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp-");
    tmp.push(std::process::id().to_string());
    let tmp_path = PathBuf::from(tmp);
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    fs::write(&tmp_path, &bytes).map_err(io)?;
    fs::rename(&tmp_path, path).map_err(io)?;
    Ok(())
}

fn io(e: std::io::Error) -> String { e.to_string() }

fn is_valid_slug(s: &str) -> bool {
    if s.is_empty() || s.len() > 64 {
        return false;
    }
    let mut chars = s.chars();
    let first = chars.next().unwrap();
    if !(first.is_ascii_alphanumeric()) {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn title_case(s: &str) -> String {
    s.split(|c: char| c == '-' || c == '_')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let mut chars = p.chars();
            match chars.next() {
                None => String::new(),
                Some(c) => c.to_ascii_uppercase().to_string() + chars.as_str(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn chrono_iso_now() -> String {
    // Tiny RFC 3339 formatter; avoids pulling in the chrono crate.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{}", now) // seconds-since-epoch is enough for "createdAt" — caller can re-derive ISO if needed
}
