#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

const BUNDLED_RUNTIME_METADATA_NAME: &str = "runtime-metadata.json";
const BUNDLED_RUNTIME_METADATA_VERSION: u32 = 1;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BundledNodeRuntimeMetadata {
    metadata_version: u32,
    binary_name: String,
    node_version: String,
    sha256: String,
}

struct BackendBridge {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>>,
    next_id: AtomicU64,
}

struct PendingRequestGuard {
    pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>>,
    id: u64,
    completed: bool,
}

impl PendingRequestGuard {
    fn new(
        pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>>,
        id: u64,
    ) -> Self {
        Self {
            pending,
            id,
            completed: false,
        }
    }

    fn complete(&mut self) {
        self.completed = true;
    }
}

impl Drop for PendingRequestGuard {
    fn drop(&mut self) {
        if self.completed {
            return;
        }

        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&self.id);
        }
    }
}

impl BackendBridge {
    fn new(app: &AppHandle) -> Result<Self, String> {
        let node_binary = resolve_node_runtime(app)?;

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
                    "failed to start backend daemon using `{}` at {}: {error}",
                    node_binary.display(),
                    backend_script.display(),
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

        let mut pending_guard = PendingRequestGuard::new(Arc::clone(&self.pending), id);
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

        let result = match rx.recv_timeout(Duration::from_secs(60 * 60)) {
            Ok(result) => {
                pending_guard.complete();
                result
            }
            Err(mpsc::RecvTimeoutError::Timeout) => Err("backend command timed out".to_string()),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err("backend channel disconnected".to_string())
            }
        };
        result
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

fn resolve_node_runtime(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(override_binary) = std::env::var("STOW_NODE_BIN") {
        if !cfg!(debug_assertions) && !allow_untrusted_node_override() {
            return Err(
                "STOW_NODE_BIN override is disabled in release builds unless STOW_ALLOW_UNTRUSTED_NODE_OVERRIDE=1 is set"
                    .to_string(),
            );
        }
        let override_path = PathBuf::from(override_binary);
        validate_node_runtime(&override_path)?;
        return Ok(override_path);
    }

    if cfg!(debug_assertions) {
        return Ok(PathBuf::from("node"));
    }

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("failed to resolve resource dir: {error}"))?;

    resolve_release_node_runtime(
        &resource_dir,
        allow_system_node_fallback(),
        allow_untrusted_node_override(),
    )
}

struct BundledRuntimePaths {
    binary: PathBuf,
    metadata: PathBuf,
}

fn resolve_bundled_node_runtime_in(resource_dir: &Path) -> BundledRuntimePaths {
    let binary_name = bundled_node_binary_name();
    let direct = resource_dir.join("node-runtime").join(binary_name);
    let direct_metadata = resource_dir
        .join("node-runtime")
        .join(BUNDLED_RUNTIME_METADATA_NAME);
    if direct.exists() {
        return BundledRuntimePaths {
            binary: direct,
            metadata: direct_metadata,
        };
    }

    let prefixed = resource_dir
        .join("resources")
        .join("node-runtime")
        .join(binary_name);
    let prefixed_metadata = resource_dir
        .join("resources")
        .join("node-runtime")
        .join(BUNDLED_RUNTIME_METADATA_NAME);
    if prefixed.exists() {
        return BundledRuntimePaths {
            binary: prefixed,
            metadata: prefixed_metadata,
        };
    }

    BundledRuntimePaths {
        binary: direct,
        metadata: direct_metadata,
    }
}

fn resolve_release_node_runtime(
    resource_dir: &Path,
    allow_system_fallback: bool,
    allow_untrusted_override: bool,
) -> Result<PathBuf, String> {
    let bundled_runtime = resolve_bundled_node_runtime_in(resource_dir);
    if bundled_runtime.binary.exists() {
        validate_bundled_node_runtime(&bundled_runtime)?;
        return Ok(bundled_runtime.binary);
    }

    if allow_system_fallback && allow_untrusted_override {
        let system_node = PathBuf::from("node");
        validate_node_runtime(&system_node)?;
        return Ok(system_node);
    }

    Err(format!(
        "bundled Node runtime was not found at {} and untrusted fallback is disabled. Build with `npm run prepare:runtime-node`. For temporary release fallback only, set both STOW_ALLOW_SYSTEM_NODE_FALLBACK=1 and STOW_ALLOW_UNTRUSTED_NODE_OVERRIDE=1.",
        bundled_runtime.binary.display()
    ))
}

fn bundled_node_binary_name() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

fn allow_system_node_fallback() -> bool {
    parse_truthy_flag(std::env::var("STOW_ALLOW_SYSTEM_NODE_FALLBACK").ok())
}

fn allow_untrusted_node_override() -> bool {
    parse_truthy_flag(std::env::var("STOW_ALLOW_UNTRUSTED_NODE_OVERRIDE").ok())
}

fn parse_truthy_flag(value: Option<String>) -> bool {
    matches!(
        value.as_deref().map(str::trim),
        Some("1") | Some("true") | Some("TRUE") | Some("yes") | Some("YES")
    )
}

fn validate_bundled_node_runtime(paths: &BundledRuntimePaths) -> Result<(), String> {
    if !paths.metadata.exists() {
        return Err(format!(
            "bundled Node runtime metadata was not found at {}. Run `npm run prepare:runtime-node` before packaging.",
            paths.metadata.display()
        ));
    }

    let metadata = read_bundled_runtime_metadata(&paths.metadata)?;
    if metadata.metadata_version != BUNDLED_RUNTIME_METADATA_VERSION {
        return Err(format!(
            "bundled Node runtime metadata at {} has unsupported metadataVersion {} (expected {})",
            paths.metadata.display(),
            metadata.metadata_version,
            BUNDLED_RUNTIME_METADATA_VERSION
        ));
    }

    if metadata.binary_name != bundled_node_binary_name() {
        return Err(format!(
            "bundled Node runtime metadata at {} expected binary `{}` but this build requires `{}`",
            paths.metadata.display(),
            metadata.binary_name,
            bundled_node_binary_name()
        ));
    }

    let actual_sha256 = sha256_file(&paths.binary).map_err(|error| {
        format!(
            "failed to hash bundled Node runtime `{}`: {error}",
            paths.binary.display()
        )
    })?;

    if !eq_ascii_case(&actual_sha256, metadata.sha256.trim()) {
        return Err(format!(
            "bundled Node runtime hash mismatch for `{}`: expected {} from {}, got {}",
            paths.binary.display(),
            metadata.sha256,
            paths.metadata.display(),
            actual_sha256
        ));
    }

    let version_output = validate_node_runtime(&paths.binary)?;
    if version_output.trim() != metadata.node_version.trim() {
        return Err(format!(
            "bundled Node runtime version mismatch for `{}`: expected `{}` from {}, got `{}`",
            paths.binary.display(),
            metadata.node_version,
            paths.metadata.display(),
            version_output
        ));
    }

    Ok(())
}

fn validate_node_runtime(node_binary: &Path) -> Result<String, String> {
    let output = Command::new(node_binary)
        .arg("--version")
        .output()
        .map_err(|error| {
            format!(
                "configured Node runtime `{}` is not available or not executable: {error}",
                node_binary.display()
            )
        })?;

    if !output.status.success() {
        return Err(format!(
            "configured Node runtime `{}` failed the version check with exit status {}",
            node_binary.display(),
            output.status
        ));
    }

    let version_output = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let version_output = if version_output.is_empty() {
        String::from_utf8_lossy(&output.stderr).trim().to_string()
    } else {
        version_output
    };

    validate_node_version_string(&version_output).map_err(|error| {
        format!(
            "configured Node runtime `{}` reported an unexpected version string `{version_output}`: {error}",
            node_binary.display()
        )
    })?;

    Ok(version_output)
}

fn read_bundled_runtime_metadata(path: &Path) -> Result<BundledNodeRuntimeMetadata, String> {
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("failed to read bundled runtime metadata `{}`: {error}", path.display()))?;
    serde_json::from_str::<BundledNodeRuntimeMetadata>(&raw).map_err(|error| {
        format!(
            "failed to parse bundled runtime metadata `{}`: {error}",
            path.display()
        )
    })
}

fn eq_ascii_case(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

fn sha256_file(path: &Path) -> Result<String, std::io::Error> {
    let contents = fs::read(path)?;
    Ok(sha256_hex(&contents))
}

fn sha256_hex(input: &[u8]) -> String {
    let digest = sha256_digest(input);
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push(nibble_to_hex(byte >> 4));
        out.push(nibble_to_hex(byte & 0x0f));
    }
    out
}

fn nibble_to_hex(n: u8) -> char {
    match n {
        0..=9 => (b'0' + n) as char,
        _ => (b'a' + (n - 10)) as char,
    }
}

fn sha256_digest(input: &[u8]) -> [u8; 32] {
    const H0: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];

    let mut state = H0;
    let mut data = input.to_vec();
    let bit_len = (data.len() as u64) * 8;
    data.push(0x80);
    while (data.len() % 64) != 56 {
        data.push(0);
    }
    data.extend_from_slice(&bit_len.to_be_bytes());

    let mut w = [0u32; 64];
    for chunk in data.chunks_exact(64) {
        for (i, word) in w.iter_mut().take(16).enumerate() {
            let j = i * 4;
            *word = u32::from_be_bytes([chunk[j], chunk[j + 1], chunk[j + 2], chunk[j + 3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let mut a = state[0];
        let mut b = state[1];
        let mut c = state[2];
        let mut d = state[3];
        let mut e = state[4];
        let mut f = state[5];
        let mut g = state[6];
        let mut h = state[7];

        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);

            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }

        state[0] = state[0].wrapping_add(a);
        state[1] = state[1].wrapping_add(b);
        state[2] = state[2].wrapping_add(c);
        state[3] = state[3].wrapping_add(d);
        state[4] = state[4].wrapping_add(e);
        state[5] = state[5].wrapping_add(f);
        state[6] = state[6].wrapping_add(g);
        state[7] = state[7].wrapping_add(h);
    }

    let mut out = [0u8; 32];
    for (i, word) in state.iter().enumerate() {
        out[i * 4..(i + 1) * 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

fn validate_node_version_string(version_output: &str) -> Result<(), String> {
    let version = version_output.trim();
    let version = version.strip_prefix('v').ok_or_else(|| {
        "expected a Node version string that starts with `v`, like `v20.11.1`".to_string()
    })?;

    let version_core = version.split(['-', '+', ' ']).next().unwrap_or(version);
    let mut parts = version_core.split('.');
    let major = parts.next().unwrap_or_default();
    let minor = parts.next().unwrap_or_default();
    let patch = parts.next().unwrap_or_default();

    if parts.next().is_some() || major.is_empty() || minor.is_empty() || patch.is_empty() {
        return Err("expected a `major.minor.patch` Node version, like `v20.11.1`".to_string());
    }

    if !major.chars().all(|c| c.is_ascii_digit())
        || !minor.chars().all(|c| c.is_ascii_digit())
        || !patch.chars().all(|c| c.is_ascii_digit())
    {
        return Err("expected each Node version segment to contain only digits".to_string());
    }

    Ok(())
}

struct AppState {
    backend: Arc<BackendBridge>,
}

async fn backend_call(
    backend: Arc<BackendBridge>,
    method: &str,
    params: Value,
) -> Result<Value, String> {
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
    destination_directory: Option<String>,
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
struct DeleteFolderPayload {
    relative_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameEntryPayload {
    entry_id: String,
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateFolderPayload {
    relative_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoveEntryPayload {
    entry_id: String,
    destination_directory: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportPlanEntryPayload {
    entry_id: String,
    export_option_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportEntryPayload {
    entry_id: String,
    export_option_id: Option<String>,
    destination: String,
    preserve_paths: Option<bool>,
    remove_from_archive: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteEntriesPayload {
    entry_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoveEntriesPayload {
    entry_ids: Vec<String>,
    destination_directory: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportEntriesPayload {
    entries: Vec<ExportPlanEntryPayload>,
    destination: String,
    preserve_paths: Option<bool>,
    remove_from_archive: Option<bool>,
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
    directory: Option<String>,
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
    backend_call(
        Arc::clone(&state.backend),
        "app:get-shell-state",
        Value::Null,
    )
    .await
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
async fn install_missing_tools(state: State<'_, AppState>) -> Result<Value, String> {
    backend_call(
        Arc::clone(&state.backend),
        "runtime:install-missing-tools",
        Value::Null,
    )
    .await
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
async fn archive_create(
    state: State<'_, AppState>,
    payload: CreateArchivePayload,
) -> Result<Value, String> {
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
async fn archive_open(
    state: State<'_, AppState>,
    payload: OpenArchivePayload,
) -> Result<Value, String> {
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
async fn archive_set_preferences(
    state: State<'_, AppState>,
    preferences: Value,
) -> Result<Value, String> {
    backend_call(
        Arc::clone(&state.backend),
        "archive:set-preferences",
        preferences,
    )
    .await
}

#[tauri::command]
async fn archives_remove(
    state: State<'_, AppState>,
    payload: RemoveArchivePayload,
) -> Result<Value, String> {
    backend_call(
        Arc::clone(&state.backend),
        "archives:remove",
        json!({ "archivePath": payload.archive_path }),
    )
    .await
}

#[tauri::command]
async fn archives_delete(
    state: State<'_, AppState>,
    payload: DeleteArchivePayload,
) -> Result<Value, String> {
    backend_call(
        Arc::clone(&state.backend),
        "archives:delete",
        json!({ "archivePath": payload.archive_path }),
    )
    .await
}

#[tauri::command]
async fn archives_list_detected(app: AppHandle) -> Result<Value, String> {
    backend_call(
        Arc::clone(&app.state::<AppState>().backend),
        "archives:list-detected",
        Value::Null,
    )
    .await
}

#[tauri::command]
async fn archive_add_paths(
    state: State<'_, AppState>,
    payload: AddPathsPayload,
) -> Result<Value, String> {
    backend_call(
        Arc::clone(&state.backend),
        "archive:add-paths",
        json!({
            "paths": payload.paths,
            "destinationDirectory": payload.destination_directory
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
async fn archive_delete_folder(
    state: State<'_, AppState>,
    payload: DeleteFolderPayload,
) -> Result<Value, String> {
    backend_call(
        Arc::clone(&state.backend),
        "archive:delete-folder",
        json!({
            "relativePath": payload.relative_path
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
async fn archive_create_folder(
    state: State<'_, AppState>,
    payload: CreateFolderPayload,
) -> Result<Value, String> {
    backend_call(
        Arc::clone(&state.backend),
        "archive:create-folder",
        json!({
            "relativePath": payload.relative_path
        }),
    )
    .await
}

#[tauri::command]
async fn archive_move_entry(
    state: State<'_, AppState>,
    payload: MoveEntryPayload,
) -> Result<Value, String> {
    backend_call(
        Arc::clone(&state.backend),
        "archive:move-entry",
        json!({
            "entryId": payload.entry_id,
            "destinationDirectory": payload.destination_directory
        }),
    )
    .await
}

#[tauri::command]
async fn archive_delete_entries(
    state: State<'_, AppState>,
    payload: DeleteEntriesPayload,
) -> Result<Value, String> {
    backend_call(
        Arc::clone(&state.backend),
        "archive:delete-entries",
        json!({
            "entryIds": payload.entry_ids
        }),
    )
    .await
}

#[tauri::command]
async fn archive_move_entries(
    state: State<'_, AppState>,
    payload: MoveEntriesPayload,
) -> Result<Value, String> {
    backend_call(
        Arc::clone(&state.backend),
        "archive:move-entries",
        json!({
            "entryIds": payload.entry_ids,
            "destinationDirectory": payload.destination_directory
        }),
    )
    .await
}

#[tauri::command]
async fn archive_export_entries(
    state: State<'_, AppState>,
    payload: ExportEntriesPayload,
) -> Result<Value, String> {
    backend_call(
        Arc::clone(&state.backend),
        "archive:export-entries",
        json!({
            "entries": payload.entries.into_iter().map(|entry| json!({
                "entryId": entry.entry_id,
                "exportOptionId": entry.export_option_id
            })).collect::<Vec<Value>>(),
            "destination": payload.destination,
            "preservePaths": payload.preserve_paths,
            "removeFromArchive": payload.remove_from_archive
        }),
    )
    .await
}

#[tauri::command]
async fn archive_export_entry(
    state: State<'_, AppState>,
    payload: ExportEntryPayload,
) -> Result<Value, String> {
    backend_call(
        Arc::clone(&state.backend),
        "archive:export-entry",
        json!({
            "entryId": payload.entry_id,
            "exportOptionId": payload.export_option_id,
            "destination": payload.destination,
            "preservePaths": payload.preserve_paths,
            "removeFromArchive": payload.remove_from_archive
        }),
    )
    .await
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
            "directory": payload.directory.unwrap_or_default(),
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
            install_missing_tools,
            pick_directory,
            pick_files,
            pick_files_or_folders,
            archive_create,
            archive_open,
            archive_close,
            archive_lock,
            archive_set_session_policy,
            archive_set_preferences,
            archives_remove,
            archives_delete,
            archives_list_detected,
            archive_add_paths,
            archive_reprocess_entry,
            archive_delete_entry,
            archive_delete_folder,
            archive_rename_entry,
            archive_create_folder,
            archive_move_entry,
            archive_delete_entries,
            archive_move_entries,
            archive_export_entries,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_test_dir(prefix: &str) -> PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock should be after UNIX_EPOCH")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("{prefix}-{unique}-{}", std::process::id()));
        fs::create_dir_all(&dir).expect("failed to create temp test dir");
        dir
    }

    fn node_exec_path() -> PathBuf {
        let output = Command::new("node")
            .arg("-p")
            .arg("process.execPath")
            .output()
            .expect("failed to query node executable path");
        assert!(
            output.status.success(),
            "node -p process.execPath failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let node_path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        assert!(!node_path.is_empty(), "node executable path was empty");
        PathBuf::from(node_path)
    }

    #[test]
    fn pending_request_guard_removes_request_on_drop() {
        let (tx, _rx) = mpsc::channel();
        let pending = Arc::new(Mutex::new(HashMap::new()));
        pending.lock().unwrap().insert(42, tx);

        {
            let _guard = PendingRequestGuard::new(Arc::clone(&pending), 42);
        }

        assert!(!pending.lock().unwrap().contains_key(&42));
    }

    #[test]
    fn validate_node_version_string_accepts_plausible_version_output() {
        assert!(validate_node_version_string("v20.11.1").is_ok());
        assert!(validate_node_version_string("v20.11.1-nightly20240201").is_ok());
    }

    #[test]
    fn validate_node_version_string_rejects_unexpected_output() {
        assert!(validate_node_version_string("node").is_err());
        assert!(validate_node_version_string("v20").is_err());
    }

    #[test]
    fn parse_truthy_flag_accepts_allowed_values() {
        assert!(parse_truthy_flag(Some("1".to_string())));
        assert!(parse_truthy_flag(Some("true".to_string())));
        assert!(parse_truthy_flag(Some("TRUE".to_string())));
        assert!(parse_truthy_flag(Some("yes".to_string())));
        assert!(parse_truthy_flag(Some(" YES ".to_string())));
    }

    #[test]
    fn parse_truthy_flag_rejects_other_values() {
        assert!(!parse_truthy_flag(None));
        assert!(!parse_truthy_flag(Some("0".to_string())));
        assert!(!parse_truthy_flag(Some("false".to_string())));
        assert!(!parse_truthy_flag(Some("y".to_string())));
    }

    #[test]
    fn bundled_node_binary_name_matches_platform() {
        if cfg!(windows) {
            assert_eq!(bundled_node_binary_name(), "node.exe");
        } else {
            assert_eq!(bundled_node_binary_name(), "node");
        }
    }

    #[test]
    fn sha256_hex_matches_known_vector() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn bundled_runtime_metadata_parses_expected_shape() {
        let metadata = serde_json::from_str::<BundledNodeRuntimeMetadata>(
            r#"{
              "metadataVersion": 1,
              "binaryName": "node",
              "nodeVersion": "v20.11.1",
              "sha256": "abc123"
            }"#,
        )
        .unwrap();
        assert_eq!(metadata.metadata_version, 1);
        assert_eq!(metadata.binary_name, "node");
        assert_eq!(metadata.node_version, "v20.11.1");
        assert_eq!(metadata.sha256, "abc123");
    }

    #[test]
    fn resolve_bundled_node_runtime_prefers_prefixed_layout_when_direct_is_missing() {
        let resource_dir = temp_test_dir("stow-runtime-paths");
        let prefixed_dir = resource_dir.join("resources").join("node-runtime");
        fs::create_dir_all(&prefixed_dir).unwrap();

        let binary_name = bundled_node_binary_name();
        let prefixed_binary = prefixed_dir.join(binary_name);
        fs::write(&prefixed_binary, b"placeholder").unwrap();

        let resolved = resolve_bundled_node_runtime_in(&resource_dir);
        assert_eq!(resolved.binary, prefixed_binary);
        assert_eq!(
            resolved.metadata,
            prefixed_dir.join(BUNDLED_RUNTIME_METADATA_NAME)
        );
    }

    #[test]
    fn validate_bundled_node_runtime_accepts_real_node_binary() {
        let node_binary = node_exec_path();
        let resource_dir = temp_test_dir("stow-runtime-validate-ok");
        let runtime_dir = resource_dir.join("node-runtime");
        fs::create_dir_all(&runtime_dir).unwrap();
        let metadata_path = runtime_dir.join(BUNDLED_RUNTIME_METADATA_NAME);
        let metadata = BundledNodeRuntimeMetadata {
            metadata_version: BUNDLED_RUNTIME_METADATA_VERSION,
            binary_name: bundled_node_binary_name().to_string(),
            node_version: validate_node_runtime(&node_binary).unwrap(),
            sha256: sha256_file(&node_binary).unwrap(),
        };

        fs::write(
            &metadata_path,
            format!("{}\n", serde_json::to_string_pretty(&metadata).unwrap()),
        )
        .unwrap();

        let paths = BundledRuntimePaths {
            binary: node_binary,
            metadata: metadata_path,
        };

        assert!(validate_bundled_node_runtime(&paths).is_ok());
    }

    #[test]
    fn validate_bundled_node_runtime_rejects_missing_metadata() {
        let node_binary = node_exec_path();
        let resource_dir = temp_test_dir("stow-runtime-missing-metadata");
        let runtime_dir = resource_dir.join("node-runtime");
        fs::create_dir_all(&runtime_dir).unwrap();

        let paths = BundledRuntimePaths {
            binary: node_binary,
            metadata: runtime_dir.join(BUNDLED_RUNTIME_METADATA_NAME),
        };

        let error = validate_bundled_node_runtime(&paths).unwrap_err();
        assert!(error.contains("metadata was not found"), "{error}");
    }

    #[test]
    fn validate_bundled_node_runtime_rejects_hash_mismatch() {
        let node_binary = node_exec_path();
        let resource_dir = temp_test_dir("stow-runtime-hash-mismatch");
        let runtime_dir = resource_dir.join("node-runtime");
        fs::create_dir_all(&runtime_dir).unwrap();
        let metadata_path = runtime_dir.join(BUNDLED_RUNTIME_METADATA_NAME);
        let metadata = BundledNodeRuntimeMetadata {
            metadata_version: BUNDLED_RUNTIME_METADATA_VERSION,
            binary_name: bundled_node_binary_name().to_string(),
            node_version: validate_node_runtime(&node_binary).unwrap(),
            sha256: "0000000000000000000000000000000000000000000000000000000000000000".to_string(),
        };

        fs::write(
            &metadata_path,
            format!("{}\n", serde_json::to_string_pretty(&metadata).unwrap()),
        )
        .unwrap();

        let paths = BundledRuntimePaths {
            binary: node_binary,
            metadata: metadata_path,
        };

        let error = validate_bundled_node_runtime(&paths).unwrap_err();
        assert!(error.contains("hash mismatch"), "{error}");
    }

    #[test]
    fn validate_bundled_node_runtime_rejects_version_mismatch() {
        let node_binary = node_exec_path();
        let resource_dir = temp_test_dir("stow-runtime-version-mismatch");
        let runtime_dir = resource_dir.join("node-runtime");
        fs::create_dir_all(&runtime_dir).unwrap();
        let metadata_path = runtime_dir.join(BUNDLED_RUNTIME_METADATA_NAME);
        let metadata = BundledNodeRuntimeMetadata {
            metadata_version: BUNDLED_RUNTIME_METADATA_VERSION,
            binary_name: bundled_node_binary_name().to_string(),
            node_version: "v0.0.0".to_string(),
            sha256: sha256_file(&node_binary).unwrap(),
        };

        fs::write(
            &metadata_path,
            format!("{}\n", serde_json::to_string_pretty(&metadata).unwrap()),
        )
        .unwrap();

        let paths = BundledRuntimePaths {
            binary: node_binary,
            metadata: metadata_path,
        };

        let error = validate_bundled_node_runtime(&paths).unwrap_err();
        assert!(error.contains("version mismatch"), "{error}");
    }

    #[test]
    fn resolve_release_node_runtime_requires_both_fallback_flags() {
        let resource_dir = temp_test_dir("stow-runtime-fallback-gating");
        let runtime_dir = resource_dir.join("node-runtime");
        fs::create_dir_all(&runtime_dir).unwrap();

        for (allow_system_fallback, allow_untrusted_override) in [
            (false, false),
            (true, false),
            (false, true),
        ] {
            let error = resolve_release_node_runtime(
                &resource_dir,
                allow_system_fallback,
                allow_untrusted_override,
            )
            .unwrap_err();
            assert!(
                error.contains("untrusted fallback is disabled"),
                "unexpected error: {error}"
            );
        }
    }
}
