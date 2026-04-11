import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AppShellState,
  ArchiveEntryDetail,
  ArchiveEntryListItem,
  ArchiveProgress,
  ArchiveStats,
  DetectedArchive,
  PreviewDescriptor,
  Settings
} from "./types";

type OverrideMode = "lossless" | "visually_lossless";
type ExportVariant = "original" | "optimized";

function createListener<T>(eventName: string, listener: (payload: T) => void) {
  let detach: (() => void) | null = null;
  let disposed = false;

  void listen<T>(eventName, (event) => {
    listener(event.payload);
  }).then((unlisten) => {
    if (disposed) {
      unlisten();
      return;
    }
    detach = unlisten;
  });

  return () => {
    disposed = true;
    if (detach) {
      detach();
      detach = null;
    }
  };
}

const bridge = {
  getShellState: () => invoke<AppShellState>("app_get_shell_state"),
  onShellStateChange: (listener: (state: AppShellState) => void) => createListener("app:shell-state-changed", listener),
  onArchiveProgress: (listener: (progress: ArchiveProgress) => void) => createListener("archive:progress", listener),
  onEntriesInvalidated: (listener: (payload: { archiveId: string; reason: string; selectedEntryId: string | null }) => void) =>
    createListener("archive:entries-invalidated", listener),
  saveSettings: (settings: Settings) => invoke<AppShellState>("settings_save", { settings }),
  resetSettings: () => invoke<AppShellState>("settings_reset"),
  pickDirectory: () => invoke<string | null>("pick_directory"),
  pickFiles: () => invoke<string[]>("pick_files"),
  pickFilesOrFolders: () => invoke<string[]>("pick_files_or_folders"),
  createArchive: (payload: {
    parentPath: string;
    name: string;
    password: string;
    preferences: Settings;
  }) => invoke<AppShellState>("archive_create", { payload }),
  openArchive: (payload: { archivePath: string; password: string }) => invoke<AppShellState>("archive_open", { payload }),
  closeArchive: () => invoke<AppShellState>("archive_close"),
  lockArchive: () => invoke<AppShellState>("archive_lock"),
  setArchiveSessionPolicy: (payload: { idleMinutes: number | null; lockOnHide: boolean | null }) =>
    invoke<AppShellState>("archive_set_session_policy", { payload }),
  removeRecentArchive: (archivePath: string) => invoke<AppShellState>("archives_remove", { payload: { archivePath } }),
  deleteArchive: (archivePath: string) => invoke<AppShellState>("archives_delete", { payload: { archivePath } }),
  listDetectedArchives: () => invoke<DetectedArchive[]>("archives_list_detected"),
  addPaths: (paths: string[]) => invoke<AppShellState>("archive_add_paths", { payload: { paths } }),
  listEntries: (payload: { offset: number; limit: number }) =>
    invoke<{ total: number; items: ArchiveEntryListItem[] }>("archive_list_entries", { payload }),
  getEntryDetail: (entryId: string) => invoke<ArchiveEntryDetail>("archive_get_entry_detail", { payload: { entryId } }),
  getArchiveStats: () => invoke<ArchiveStats>("archive_get_stats"),
  reprocessEntry: (entryId: string, overrideMode: OverrideMode) =>
    invoke<AppShellState>("archive_reprocess_entry", { payload: { entryId, overrideMode } }),
  deleteEntry: (entryId: string) => invoke<AppShellState>("archive_delete_entry", { payload: { entryId } }),
  renameEntry: (entryId: string, name: string) => invoke<AppShellState>("archive_rename_entry", { payload: { entryId, name } }),
  exportEntry: (entryId: string, variant: ExportVariant) =>
    invoke<AppShellState>("archive_export_entry", { payload: { entryId, variant } }),
  openEntryExternally: (entryId: string) => invoke<AppShellState>("archive_open_entry_externally", { payload: { entryId } }),
  resolveEntryPreview: async (entryId: string, previewKind: "thumbnail" | "preview" = "preview") => {
    const descriptor = await invoke<PreviewDescriptor | null>("archive_resolve_entry_preview", { payload: { entryId, previewKind } });
    if (!descriptor) {
      return null;
    }
    return {
      ...descriptor,
      path: convertFileSrc(descriptor.path)
    };
  }
};

export function installStowBridge() {
  window.stow = bridge as typeof window.stow;
}
