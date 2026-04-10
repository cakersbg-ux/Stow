#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

struct BackendBridge {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>>,
    next_id: AtomicU64,
}

impl BackendBridge {
    fn new(app: &AppHandle) -> Result<Self, String> {
        let node_binary = std::env::var("STOW_NODE_BIN").unwrap_or_else(|_| "node".to_string());
        let backend_script = resolve_backend_script(app)?;
        let user_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("failed to resolve app data dir: {error}"))?;

        fs::create_dir_all(&user_data_dir)
            .map_err(|error| format!("failed to create app data dir: {error}"))?;

        let mut child = Command::new(&node_binary)
            .arg(&backend_script)
            .arg("--user-data-path")
            .arg(&user_data_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| {
                format!(
                    "failed to start backend daemon using `{node_binary}` at {}: {error}",
                    backend_script.display()
                )
            })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "failed to capture backend stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "failed to capture backend stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "failed to capture backend stderr".to_string())?;

        let pending = Arc::new(Mutex::new(HashMap::<
            u64,
            mpsc::Sender<Result<Value, String>>,
        >::new()));

        let app_handle = app.clone();
        let pending_for_stdout = Arc::clone(&pending);
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line_result in reader.lines() {
                let Ok(line) = line_result else {
                    break;
                };

                if line.trim().is_empty() {
                    continue;
                }

                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };

                let Some(message_type) = message.get("type").and_then(Value::as_str) else {
                    continue;
                };

                match message_type {
                    "response" => {
                        let Some(id) = message.get("id").and_then(Value::as_u64) else {
                            continue;
                        };

                        let sender = {
                            let mut pending_map = match pending_for_stdout.lock() {
                                Ok(lock) => lock,
                                Err(_) => continue,
                            };
                            pending_map.remove(&id)
                        };

                        if let Some(tx) = sender {
                            let ok = message.get("ok").and_then(Value::as_bool).unwrap_or(false);
                            if ok {
                                let payload = message.get("result").cloned().unwrap_or(Value::Null);
                                let _ = tx.send(Ok(payload));
                            } else {
                                let error = message
                                    .get("error")
                                    .and_then(Value::as_str)
                                    .unwrap_or("Backend command failed")
                                    .to_string();
                                let _ = tx.send(Err(error));
                            }
                        }
                    }
                    "event" => {
                        let Some(event_name) = message.get("event").and_then(Value::as_str) else {
                            continue;
                        };
                        let payload = message.get("payload").cloned().unwrap_or(Value::Null);
                        let _ = app_handle.emit(event_name, payload);
                    }
                    _ => {}
                }
            }
        });

        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line_result in reader.lines() {
                if let Ok(line) = line_result {
                    eprintln!("[stow-backend] {line}");
                }
            }
        });

        Ok(Self {
            child: Arc::new(Mutex::new(child)),
            stdin: Arc::new(Mutex::new(stdin)),
            pending,
            next_id: AtomicU64::new(1),
        })
    }

    fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();

        {
            let mut pending = self
                .pending
                .lock()
                .map_err(|_| "backend pending map is poisoned".to_string())?;
            pending.insert(id, tx);
        }

        let line = json!({
            "id": id,
            "method": method,
            "params": params
        })
        .to_string();

        {
            let mut stdin = self
                .stdin
                .lock()
                .map_err(|_| "backend stdin lock is poisoned".to_string())?;
            stdin
                .write_all(line.as_bytes())
                .map_err(|error| format!("failed to write to backend: {error}"))?;
            stdin
                .write_all(b"\n")
                .map_err(|error| format!("failed to write newline to backend: {error}"))?;
            stdin
                .flush()
                .map_err(|error| format!("failed to flush backend request: {error}"))?;
        }

        match rx.recv_timeout(Duration::from_secs(60 * 60)) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => Err("backend command timed out".to_string()),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err("backend channel disconnected".to_string())
            }
        }
    }
}

impl Drop for BackendBridge {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn resolve_backend_script(app: &AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("backend")
            .join("daemon.cjs");
        if dev_path.exists() {
            return Ok(dev_path);
        }
    }

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("failed to resolve resource dir: {error}"))?;
    let resource_path = resource_dir.join("backend").join("daemon.cjs");

    if resource_path.exists() {
        return Ok(resource_path);
    }

    Err("backend daemon script was not found".to_string())
}

struct AppState {
    backend: Arc<BackendBridge>,
}

async fn backend_call(backend: Arc<BackendBridge>, method: &str, params: Value) -> Result<Value, String> {
    let method_name = method.to_string();
    tauri::async_runtime::spawn_blocking(move || backend.request(&method_name, params))
        .await
        .map_err(|error| format!("backend task join failed: {error}"))?
}

fn pick_directory_sync() -> Option<String> {
    rfd::FileDialog::new()
        .pick_folder()
        .map(|path| path.to_string_lossy().to_string())
}

fn pick_files_sync() -> Vec<String> {
    rfd::FileDialog::new()
        .pick_files()
        .unwrap_or_default()
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateArchivePayload {
    parent_path: String,
    name: String,
    password: String,
    preferences: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenArchivePayload {
    archive_path: String,
    password: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveArchivePayload {
    archive_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteArchivePayload {
    archive_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddPathsPayload {
    paths: Vec<String>,
    manual_classifications: Option<HashMap<String, String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReprocessEntryPayload {
    entry_id: String,
    override_mode: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteEntryPayload {
    entry_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameEntryPayload {
    entry_id: String,
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportEntryPayload {
    entry_id: String,
    variant: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenEntryExternallyPayload {
    entry_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveEntryPreviewPayload {
    entry_id: String,
    preview_kind: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListEntriesPayload {
    offset: Option<usize>,
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntryIdPayload {
    entry_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetSessionPolicyPayload {
    idle_minutes: Option<i64>,
    lock_on_hide: Option<bool>,
}

#[tauri::command]
async fn app_get_shell_state(state: State<'_, AppState>) -> Result<Value, String> {
    backend_call(Arc::clone(&state.backend), "app:get-shell-state", Value::Null).await
}

#[tauri::command]
async fn settings_save(state: State<'_, AppState>, settings: Value) -> Result<Value, String> {
    backend_call(Arc::clone(&state.backend), "settings:save", settings).await
}

#[tauri::command]
async fn settings_reset(state: State<'_, AppState>) -> Result<Value, String> {
    backend_call(Arc::clone(&state.backend), "settings:reset", Value::Null).await
}

#[tauri::command]
async fn pick_directory() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(pick_directory_sync)
        .await
        .map_err(|error| format!("failed to open directory dialog: {error}"))
}

#[tauri::command]
async fn pick_files() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(pick_files_sync)
        .await
        .map_err(|error| format!("failed to open files dialog: {error}"))
}

#[tauri::command]
async fn pick_files_or_folders() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let files = pick_files_sync();
        if !files.is_empty() {
            return files;
        }

        if let Some(folder) = pick_directory_sync() {
            return vec![folder];
        }

        Vec::new()
    })
    .await
    .map_err(|error| format!("failed to open files/folders dialog: {error}"))
}

#[tauri::command]
async fn archive_create(state: State<'_, AppState>, payload: CreateArchivePayload) -> Result<Value, String> {
    backend_call(
        Arc::clone(&state.backend),
        "archive:create",
        json!({
            "parentPath": payload.parent_path,
            "name": payload.name,
            "password": payload.password,
            "preferences": payload.preferences
        }),
    )
    .await
}

#[tauri::command]
async fn archive_open(state: State<'_, AppState>, payload: OpenArchivePayload) -> Result<Value, String> {
    backend_call(
        Arc::clone(&state.backend),
        "archive:open",
        json!({
            "archivePath": payload.archive_path,
            "password": payload.password
        }),
    )
    .await
}

#[tauri::command]
async fn archive_close(state: State<'_, AppState>) -> Result<Value, String> {
    backend_call(Arc::clone(&state.backend), "archive:close", Value::Null).await
}

#[tauri::command]
async fn archive_lock(state: State<'_, AppState>) -> Result<Value, String> {
    backend_call(Arc::clone(&state.backend), "archive:lock", Value::Null).await
}

#[tauri::command]
async fn archive_set_session_policy(
    state: State<'_, AppState>,
    payload: SetSessionPolicyPayload,
) -> Result<Value, String> {
    backend_call(
        Arc::clone(&state.backend),
        "archive:set-session-policy",
        json!({
            "idleMinutes": payload.idle_minutes,
            "lockOnHide": payload.lock_on_hide
        }),
    )
    .await
}

#[tauri::command]
async fn archives_remove(state: State<'_, AppState>, payload: RemoveArchivePayload) -> Result<Value, String> {
    backend_call(
        Arc::clone(&state.backend),
        "archives:remove",
        json!({ "archivePath": payload.archive_path }),
    )
    .await
}

#[tauri::command]
async fn archives_delete(state: State<'_, AppState>, payload: DeleteArchivePayload) -> Result<Value, String> {
    backend_call(
        Arc::clone(&state.backend),
        "archives:delete",
        json!({ "archivePath": payload.archive_path }),
    )
    .await
}

#[tauri::command]
async fn archives_list_detected(state: State<'_, AppState>) -> Result<Value, String> {
    backend_call(Arc::clone(&state.backend), "archives:list-detected", Value::Null).await
}

#[tauri::command]
async fn archive_add_paths(state: State<'_, AppState>, payload: AddPathsPayload) -> Result<Value, String> {
    backend_call(
        Arc::clone(&state.backend),
        "archive:add-paths",
        json!({
            "paths": payload.paths,
            "manualClassifications": payload.manual_classifications
        }),
    )
    .await
}

#[tauri::command]
async fn archive_reprocess_entry(
    state: State<'_, AppState>,
    payload: ReprocessEntryPayload,
) -> Result<Value, String> {
    backend_call(
        Arc::clone(&state.backend),
        "archive:reprocess-entry",
        json!({
            "entryId": payload.entry_id,
            "overrideMode": payload.override_mode
        }),
    )
    .await
}

#[tauri::command]
async fn archive_delete_entry(
    state: State<'_, AppState>,
    payload: DeleteEntryPayload,
) -> Result<Value, String> {
    backend_call(
        Arc::clone(&state.backend),
        "archive:delete-entry",
        json!({
            "entryId": payload.entry_id
        }),
    )
    .await
}

#[tauri::command]
async fn archive_rename_entry(
    state: State<'_, AppState>,
    payload: RenameEntryPayload,
) -> Result<Value, String> {
    backend_call(
        Arc::clone(&state.backend),
        "archive:rename-entry",
        json!({
            "entryId": payload.entry_id,
            "name": payload.name
        }),
    )
    .await
}

#[tauri::command]
async fn archive_export_entry(
    state: State<'_, AppState>,
    payload: ExportEntryPayload,
) -> Result<Value, String> {
    let destination = tauri::async_runtime::spawn_blocking(pick_directory_sync)
        .await
        .map_err(|error| format!("failed to open export dialog: {error}"))?;

    let backend = Arc::clone(&state.backend);

    if let Some(destination) = destination {
        backend_call(
            backend,
            "archive:export-entry",
            json!({
                "entryId": payload.entry_id,
                "variant": payload.variant,
                "destination": destination
            }),
        )
        .await
    } else {
        backend_call(backend, "app:get-shell-state", Value::Null).await
    }
}

#[tauri::command]
async fn archive_open_entry_externally(
    state: State<'_, AppState>,
    payload: OpenEntryExternallyPayload,
) -> Result<Value, String> {
    backend_call(
        Arc::clone(&state.backend),
        "archive:open-entry-externally",
        json!({
            "entryId": payload.entry_id
        }),
    )
    .await
}

#[tauri::command]
async fn archive_resolve_entry_preview(
    state: State<'_, AppState>,
    payload: ResolveEntryPreviewPayload,
) -> Result<Value, String> {
    backend_call(
        Arc::clone(&state.backend),
        "archive:resolve-entry-preview",
        json!({
            "entryId": payload.entry_id,
            "previewKind": payload.preview_kind.unwrap_or_else(|| "preview".to_string())
        }),
    )
    .await
}

#[tauri::command]
async fn archive_list_entries(
    state: State<'_, AppState>,
    payload: ListEntriesPayload,
) -> Result<Value, String> {
    backend_call(
        Arc::clone(&state.backend),
        "archive:list-entries",
        json!({
            "offset": payload.offset.unwrap_or(0),
            "limit": payload.limit.unwrap_or(100)
        }),
    )
    .await
}

#[tauri::command]
async fn archive_get_entry_detail(
    state: State<'_, AppState>,
    payload: EntryIdPayload,
) -> Result<Value, String> {
    backend_call(
        Arc::clone(&state.backend),
        "archive:get-entry-detail",
        json!({
            "entryId": payload.entry_id
        }),
    )
    .await
}

#[tauri::command]
async fn archive_get_stats(state: State<'_, AppState>) -> Result<Value, String> {
    backend_call(Arc::clone(&state.backend), "archive:get-stats", Value::Null).await
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let backend = BackendBridge::new(app.handle())?;
            app.manage(AppState {
                backend: Arc::new(backend),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_get_shell_state,
            settings_save,
            settings_reset,
            pick_directory,
            pick_files,
            pick_files_or_folders,
            archive_create,
            archive_open,
            archive_close,
            archive_lock,
            archive_set_session_policy,
            archives_remove,
            archives_delete,
            archives_list_detected,
            archive_add_paths,
            archive_reprocess_entry,
            archive_delete_entry,
            archive_rename_entry,
            archive_export_entry,
            archive_open_entry_externally,
            archive_resolve_entry_preview,
            archive_list_entries,
            archive_get_entry_detail,
            archive_get_stats,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
