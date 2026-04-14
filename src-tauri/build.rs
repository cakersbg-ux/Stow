use std::env;
use std::path::PathBuf;

fn parse_truthy_flag(value: Option<String>) -> bool {
    matches!(
        value.as_deref().map(str::trim),
        Some("1") | Some("true") | Some("TRUE") | Some("yes") | Some("YES")
    )
}

fn main() {
    tauri_build::build();

    if env::var("PROFILE").ok().as_deref() != Some("release") {
        return;
    }

    let allow_untrusted_override =
        parse_truthy_flag(env::var("STOW_ALLOW_UNTRUSTED_NODE_OVERRIDE").ok());
    let allow_system_node_fallback =
        parse_truthy_flag(env::var("STOW_ALLOW_SYSTEM_NODE_FALLBACK").ok());

    if allow_untrusted_override {
        println!(
            "cargo:warning=STOW_ALLOW_UNTRUSTED_NODE_OVERRIDE is enabled; release build/runtime can use untrusted Node override/fallback"
        );
    }

    if allow_system_node_fallback && !allow_untrusted_override {
        panic!(
            "STOW_ALLOW_SYSTEM_NODE_FALLBACK=1 requires STOW_ALLOW_UNTRUSTED_NODE_OVERRIDE=1 in release builds so runtime fallback stays consistent with startup validation."
        );
    }

    if allow_system_node_fallback {
        println!(
            "cargo:warning=STOW_ALLOW_SYSTEM_NODE_FALLBACK is enabled; release build will allow system Node fallback"
        );
        return;
    }

    let manifest_dir = match env::var("CARGO_MANIFEST_DIR") {
        Ok(path) => PathBuf::from(path),
        Err(_) => return,
    };
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let node_file = if target_os == "windows" {
        "node.exe"
    } else {
        "node"
    };

    let staged_runtime = manifest_dir
        .join("resources")
        .join("node-runtime")
        .join(node_file);
    let staged_metadata = manifest_dir
        .join("resources")
        .join("node-runtime")
        .join("runtime-metadata.json");

    if !staged_runtime.exists() {
        panic!(
            "Bundled Node runtime missing at {}. Run `npm run prepare:runtime-node` before `tauri build`, or explicitly set both STOW_ALLOW_SYSTEM_NODE_FALLBACK=1 and STOW_ALLOW_UNTRUSTED_NODE_OVERRIDE=1 for temporary fallback builds.",
            staged_runtime.display()
        );
    }

    if !staged_metadata.exists() {
        panic!(
            "Bundled Node runtime metadata missing at {}. Run `npm run prepare:runtime-node` before `tauri build`.",
            staged_metadata.display()
        );
    }
}
