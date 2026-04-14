import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AppShellState,
  ArchivePreferences,
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
  installMissingTools: () => invoke<AppShellState>("install_missing_tools"),
  pickDirectory: () => invoke<string | null>("pick_directory"),
  pickFiles: () => invoke<string[]>("pick_files"),
  pickFilesOrFolders: () => invoke<string[]>("pick_files_or_folders"),
  setArchivePreferences: (preferences: ArchivePreferences) => invoke<AppShellState>("archive_set_preferences", { preferences }),
  createArchive: (payload: {
    parentPath: string;
    name: string;
    password: string;
    preferences: ArchivePreferences;
  }) => invoke<AppShellState>("archive_create", { payload }),
  openArchive: (payload: { archivePath: string; password: string }) => invoke<AppShellState>("archive_open", { payload }),
  closeArchive: () => invoke<AppShellState>("archive_close"),
  lockArchive: () => invoke<AppShellState>("archive_lock"),
  setArchiveSessionPolicy: (payload: { idleMinutes: number | null; lockOnHide: boolean | null }) =>
    invoke<AppShellState>("archive_set_session_policy", { payload }),
  removeRecentArchive: (archivePath: string) => invoke<AppShellState>("archives_remove", { payload: { archivePath } }),
  deleteArchive: (archivePath: string) => invoke<AppShellState>("archives_delete", { payload: { archivePath } }),
  listDetectedArchives: () => invoke<DetectedArchive[]>("archives_list_detected"),
  addPaths: (paths: string[], destinationDirectory?: string) =>
    invoke<AppShellState>("archive_add_paths", { payload: { paths, destinationDirectory } }),
  listEntries: (payload: {
    directory?: string;
    offset: number;
    limit: number;
    sortColumn?: "name" | "type" | "size";
    sortDirection?: "asc" | "desc";
  }) =>
    invoke<{ total: number; items: ArchiveEntryListItem[] }>("archive_list_entries", { payload }),
  getEntryDetail: (entryId: string) => invoke<ArchiveEntryDetail>("archive_get_entry_detail", { payload: { entryId } }),
  getArchiveStats: () => invoke<ArchiveStats>("archive_get_stats"),
  reprocessEntry: (entryId: string, overrideMode: OverrideMode) =>
    invoke<AppShellState>("archive_reprocess_entry", { payload: { entryId, overrideMode } }),
  deleteEntry: (entryId: string) => invoke<AppShellState>("archive_delete_entry", { payload: { entryId } }),
  deleteFolder: (relativePath: string) => invoke<AppShellState>("archive_delete_folder", { payload: { relativePath } }),
  renameEntry: (entryId: string, name: string) => invoke<AppShellState>("archive_rename_entry", { payload: { entryId, name } }),
  createFolder: (payload: { relativePath: string }) => invoke<AppShellState>("archive_create_folder", { payload }),
  moveEntry: (payload: { entryId: string; destinationDirectory: string }) => invoke<AppShellState>("archive_move_entry", { payload }),
  deleteEntries: (entryIds: string[]) => invoke<AppShellState>("archive_delete_entries", { payload: { entryIds } }),
  moveEntries: (payload: { entryIds: string[]; destinationDirectory: string }) =>
    invoke<AppShellState>("archive_move_entries", { payload }),
  exportEntries: (entryIds: string[], variant: ExportVariant) =>
    invoke<AppShellState>("archive_export_entries", { payload: { entryIds, variant } }),
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
  },
  onDragDrop: (listener: (payload: { paths: string[]; position: { x: number; y: number } }) => void) =>
    createListener<{ paths: string[]; position: { x: number; y: number } }>("tauri://drag-drop", listener),
  onDragEnter: (listener: (payload: { paths: string[]; position: { x: number; y: number } }) => void) =>
    createListener<{ paths: string[]; position: { x: number; y: number } }>("tauri://drag-enter", listener),
  onDragLeave: (listener: () => void) =>
    createListener<void>("tauri://drag-leave", listener),
};

export function installStowBridge() {
  window.stow = bridge as typeof window.stow;
}
