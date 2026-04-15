import React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import packageJson from "../../../package.json";
import type {
  AppShellState,
  ArchiveEntryDetail,
  ArchivePreferences,
  ArchiveEntryListItem,
  ExportRequest
} from "../../types";
import {
  ARCHIVE_ENTRY_DRAG_TYPE,
  archiveBreadcrumbs,
  formatBytes,
  isEditableElement,
  isArchiveEntryDrag,
  isModKey,
  canReprocessLosslessly,
  parentDirectory,
  readArchiveDragPayload,
  resolveTheme,
  toArchivePreferences,
  type ArchiveBrowserItem,
  type ArchiveDragPayload,
  type ContextMenuState
} from "../archive/archiveModel";
import { useArchiveSession } from "../archive/useArchiveSession";
import {
  ArchiveBrowserDialog,
  ArchiveManagerDialog,
  ArchiveUnlockDialog,
  ContextMenuComponent,
  DeleteConfirmationDialog,
  DetailPanel,
  ExportDialog,
  ActivityLogPanel,
  FileList,
  Hub,
  InstallBanner,
  ProgressBar,
  CogIcon,
  IconButton,
  SettingsDialog,
  TreeSidebar
} from "./AppShellComponents";
import { useArchiveBrowser } from "./useArchiveBrowser";
import { useUploadQueue } from "./useUploadQueue";
import { useShellStore } from "./useShellStore";

type AppView = "hub" | "archive";

type ArchiveHistoryState = {
  archiveId: string | null;
  directory: string;
};

type ExportQualityMode = "highest_available" | "smaller_if_available";

type ExportDialogConfig = {
  destination: string;
  preservePaths: boolean;
  removeFromArchive: boolean;
  perFileMode: boolean;
  globalQualityMode: ExportQualityMode;
  batchQualityMode: ExportQualityMode;
  loading: boolean;
  error: string | null;
  entryOrder: string[];
  entryDetails: Record<string, ArchiveEntryDetail>;
  entryConfigs: Record<string, { include: boolean; exportOptionId: string | null; batchSelected: boolean }>;
};

function resolveExportOptionId(detail: ArchiveEntryDetail, mode: ExportQualityMode) {
  if (mode === "smaller_if_available" && detail.exportOptions.length > 1) {
    return detail.exportOptions[detail.exportOptions.length - 1]?.id ?? detail.defaultExportOptionId;
  }
  return detail.defaultExportOptionId ?? detail.exportOptions[0]?.id ?? null;
}

function settingsEqual(a: AppShellState["settings"], b: AppShellState["settings"]) {
  return a.compressionBehavior === b.compressionBehavior &&
    a.optimizationTier === b.optimizationTier &&
    a.optimizationMode === b.optimizationMode &&
    a.stripDerivativeMetadata === b.stripDerivativeMetadata &&
    a.deleteOriginalFilesAfterSuccessfulUpload === b.deleteOriginalFilesAfterSuccessfulUpload &&
    a.argonProfile === b.argonProfile &&
    a.preferredArchiveRoot === b.preferredArchiveRoot &&
    a.themePreference === b.themePreference &&
    a.sessionIdleMinutes === b.sessionIdleMinutes &&
    a.sessionLockOnHide === b.sessionLockOnHide &&
    a.developerActivityLogEnabled === b.developerActivityLogEnabled;
}

function archivePreferencesEqual(a: ArchivePreferences, b: ArchivePreferences) {
  return a.compressionBehavior === b.compressionBehavior &&
    a.optimizationTier === b.optimizationTier &&
    a.optimizationMode === b.optimizationMode &&
    a.stripDerivativeMetadata === b.stripDerivativeMetadata;
}

function AppShell() {
  const shell = useShellStore();
  const shellState = shell.shellState;
  const archiveUnlocked = Boolean(shellState.archive?.unlocked && shellState.archive.summary);
  const session = useArchiveSession({
    archiveUnlocked,
    archiveExists: Boolean(shellState.archive),
    archiveId: shellState.archive?.summary?.archiveId ?? null,
    entriesInvalidated: shell.entriesInvalidated,
    isBusy: shell.isBusy,
    runTask: shell.runTask,
    setStatus: shell.setStatus
  });
  const {
    currentDirectory,
    selectedIds,
    focusedId,
    lastClickedId,
    entries,
    loadedEntryCount,
    loadedOffsets,
    entryTotal,
    stats,
    selectedEntry,
    preview,
    renamingEntryId,
    renameDraft,
    renameInputRef,
    sortColumn,
    sortDirection,
    singleSelectedId,
    detailRevision,
    selectedSizeTotal,
    emptyState,
    clearSelection,
    navigateToDirectory,
    setSelectedIds,
    setFocusedId,
    setLastClickedId,
    setRenameDraft,
    handleClickEntry,
    handleDoubleClickEntry,
    handleSort,
    beginRename,
    cancelRename,
    submitRename,
    refreshEntries,
    refreshArchiveData,
    handleNeedMore,
    createFolder,
    moveArchiveEntries,
    openEntryExternally,
    deleteEntry,
    deleteFolder,
    deleteEntries,
    moveEntry,
    moveEntries,
    exportEntry,
    exportEntries,
    reprocessEntry
  } = session;
  const [activeView, setActiveView] = useState<AppView>("hub");

  // ── Context menu
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // ── Type-to-search
  const [typeSearch, setTypeSearch] = useState("");
  const typeSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (typeSearchTimerRef.current) {
      clearTimeout(typeSearchTimerRef.current);
      typeSearchTimerRef.current = null;
    }
  }, []);

  // ── Create folder
  const [createFolderDraft, setCreateFolderDraft] = useState("");
  const [showCreateFolder, setShowCreateFolder] = useState(false);

  // ── Progress & busy
  const progress = shell.progress;
  const isBusy = shell.isBusy;
  const status = shell.status;
  const draftSettings = shell.draftSettings;
  const draftArchivePreferences = shell.draftArchivePreferences;

  // ── Dialogs
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [archiveManagerOpen, setArchiveManagerOpen] = useState(false);
  const [archiveUnlockOpen, setArchiveUnlockOpen] = useState(false);
  const [archiveDeleteCandidate, setArchiveDeleteCandidate] = useState<ArchiveBrowserItem | null>(null);
  const [deleteDialogState, setDeleteDialogState] = useState<{ title: string; description: string; detail: string; onConfirm: () => void } | null>(null);
  const [exportDialog, setExportDialog] = useState<ExportDialogConfig | null>(null);
  const [detailOpen, setDetailOpen] = useState(true);

  // ── Archive form state
  const [archiveName, setArchiveName] = useState("Archive");
  const [archiveDirectory, setArchiveDirectory] = useState("");
  const [archivePassword, setArchivePassword] = useState("");
  const [showArchivePassword, setShowArchivePassword] = useState(false);
  const [openArchivePath, setOpenArchivePath] = useState("");
  const [openPassword, setOpenPassword] = useState("");
  const [unlockPassword, setUnlockPassword] = useState("");
  const [overrideMode, setOverrideMode] = useState<"lossless" | "visually_lossless" | "lossy_balanced" | "lossy_aggressive">("visually_lossless");
  const [breadcrumbDropTarget, setBreadcrumbDropTarget] = useState<string | null>(null);
  const settingsAutosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settingsAutosaveRunningRef = useRef(false);
  const shellStateRef = useRef(shellState);
  const draftSettingsRef = useRef(draftSettings);
  const draftArchivePreferencesRef = useRef(draftArchivePreferences);
  const archiveUnlockedRef = useRef(archiveUnlocked);
  const currentDirectoryRef = useRef(currentDirectory);
  const activeViewRef = useRef(activeView);
  const archiveHistoryStateRef = useRef<ArchiveHistoryState | null>(null);
  const suppressHistorySyncRef = useRef(false);
  const exportDialogLoadIdRef = useRef(0);

  // ── Derived state
  const showArchiveView = archiveUnlocked && activeView === "archive";
  const showActivityLogPanel = shellState.settings.developerActivityLogEnabled;
  const selectedArchiveIsUnlocked = Boolean(shellState.archive?.unlocked && shellState.archive?.path === openArchivePath);
  const canReprocessLossless = canReprocessLosslessly(selectedEntry);
  const effectiveOverrideMode = overrideMode === "lossless" && !canReprocessLossless ? "visually_lossless" : overrideMode;
  const uiLocked = isBusy;
  const canOpenArchive = !uiLocked && Boolean(openArchivePath) && (selectedArchiveIsUnlocked || Boolean(openPassword));
  const canCreateArchive = !uiLocked && Boolean(archiveDirectory) && Boolean(archiveName) && archivePassword.length > 0;
  const archiveFolders = shellState.archive?.summary?.folders ?? [];
  const archiveName_ = shellState.archive?.summary?.name ?? "Archive";
  const activeStats = stats ?? shellState.archive?.summary ?? null;
  const selectedCount = selectedIds.size;
  const selectedFileIds = [...selectedIds].filter((entryId) => {
    const entry = entries.find((candidate) => candidate?.id === entryId);
    return entry?.entryType === "file";
  });
  const {
    archiveBrowserOpen,
    archiveBrowserLoading,
    archiveBrowserError,
    archiveBrowserSortMode,
    selectedArchiveBrowserPath,
    browserArchives,
    browserSelectedArchivePath,
    setArchiveBrowserSortMode,
    setSelectedArchiveBrowserPath,
    refreshDetectedArchives,
    openArchiveBrowser,
    closeArchiveBrowser
  } = useArchiveBrowser({
    shellState,
    activeView
  });
  const resolveThumbnail = useCallback((entryId: string) => window.stow.resolveEntryPreview(entryId, "thumbnail"), []);

  useEffect(() => {
    if (!canReprocessLossless && overrideMode === "lossless") {
      setOverrideMode("visually_lossless");
    }
  }, [canReprocessLossless, overrideMode]);

  shellStateRef.current = shellState;
  draftSettingsRef.current = draftSettings;
  draftArchivePreferencesRef.current = draftArchivePreferences;
  archiveUnlockedRef.current = archiveUnlocked;
  currentDirectoryRef.current = currentDirectory;
  activeViewRef.current = activeView;

  function applyShellState(next: AppShellState) {
    shell.applyShellState(next);
    if (next.archive?.path) {
      setOpenArchivePath(next.archive.path);
      setSelectedArchiveBrowserPath(next.archive.path);
    }
  }

  const { queueUpload } = useUploadQueue({
    uiLocked,
    runTask: shell.runTask,
    applyShellState,
    setStatus: shell.setStatus
  });

  function applyArchivePreferences(next: ArchivePreferences) {
    shell.applyArchivePreferences(next);
  }

  function closeSettingsDialog() {
    setSettingsOpen(false);
  }

  function prepareArchiveOpen(path: string) {
    if (!path) return;
    setOpenArchivePath(path);
    setSelectedArchiveBrowserPath(path);
    if (archiveUnlocked && shellState.archive?.path === path) {
      setActiveView("archive");
      return;
    }
    setOpenPassword("");
    setArchiveUnlockOpen(true);
  }

  function swapSelectedArchive(nextPath?: string) {
    const target = nextPath ?? browserSelectedArchivePath;
    if (!target) return;
    closeArchiveBrowser();
    prepareArchiveOpen(target);
  }

  async function openSelectedArchive() {
    if (!canOpenArchive || selectedArchiveIsUnlocked) return;
    await shell.runTask("Opening archive", () => window.stow.openArchive({ archivePath: openArchivePath, password: openPassword }));
    setActiveView("archive");
    setOpenPassword("");
    setUnlockPassword("");
    setArchiveUnlockOpen(false);
  }

  async function createSelectedArchive() {
    if (!canCreateArchive) return;
    await shell.runTask("Creating archive", () => window.stow.createArchive({
      parentPath: archiveDirectory, name: archiveName, password: archivePassword, preferences: draftArchivePreferences
    }));
    setActiveView("archive");
    setArchivePassword("");
    setShowArchivePassword(false);
    setOpenPassword("");
    setArchiveManagerOpen(false);
  }

  function requestDelete(entryIds: string[]) {
    if (entryIds.length === 0) return;
    const single = entryIds.length === 1;
    const entry = single ? entries.find((en) => en?.id === entryIds[0]) : null;
    const isFolder = entry?.entryType === "folder";
    setDeleteDialogState({
      title: single
        ? `Delete ${isFolder ? "folder" : "file"} "${entry?.name ?? `this ${isFolder ? "folder" : "file"}`}"?`
        : `Delete ${entryIds.length} items?`,
      description: single
        ? isFolder
          ? "Delete this folder and all nested contents"
          : (entry?.name ?? "file")
        : `${entryIds.length} selected items`,
      detail: single ? (entry?.relativePath ?? "") : "",
      onConfirm: async () => {
        setDeleteDialogState(null);
        if (single && isFolder && entry) {
          await deleteFolder(entry.relativePath);
        } else if (single) {
          await deleteEntry(entryIds[0]);
        } else {
          await deleteEntries(entryIds);
        }
        clearSelection();
      }
    });
  }

  function applyGlobalExportQuality(
    details: Record<string, ArchiveEntryDetail>,
    entryOrder: string[],
    mode: ExportQualityMode,
    previousConfigs?: ExportDialogConfig["entryConfigs"]
  ) {
    const nextConfigs: ExportDialogConfig["entryConfigs"] = {};
    for (const entryId of entryOrder) {
      const detail = details[entryId];
      if (!detail) continue;
      nextConfigs[entryId] = {
        include: previousConfigs?.[entryId]?.include ?? true,
        exportOptionId: resolveExportOptionId(detail, mode),
        batchSelected: previousConfigs?.[entryId]?.batchSelected ?? false
      };
    }
    return nextConfigs;
  }

  async function openExportDialog(entryIds: string[]) {
    if (uiLocked) return;
    const uniqueIds = [...new Set(entryIds)].filter(Boolean);
    if (uniqueIds.length === 0) return;

    const requestId = exportDialogLoadIdRef.current + 1;
    exportDialogLoadIdRef.current = requestId;
    setExportDialog({
      destination: shellState.settings.preferredArchiveRoot || "",
      preservePaths: uniqueIds.length > 1,
      removeFromArchive: false,
      perFileMode: false,
      globalQualityMode: "highest_available",
      batchQualityMode: "highest_available",
      loading: true,
      error: null,
      entryOrder: uniqueIds,
      entryDetails: {},
      entryConfigs: {}
    });

    try {
      const details = await Promise.all(uniqueIds.map((entryId) => window.stow.getEntryDetail(entryId)));
      if (exportDialogLoadIdRef.current !== requestId) {
        return;
      }

      const exportableDetails = details.filter((detail) => detail.exportable && detail.exportOptions.length > 0);
      const detailMap = Object.fromEntries(exportableDetails.map((detail) => [detail.id, detail] as const));
      const entryOrder = exportableDetails.map((detail) => detail.id);
      if (entryOrder.length === 0) {
        setExportDialog((current) => current ? { ...current, loading: false, error: "None of the selected files have an exportable archived artifact." } : current);
        return;
      }

      setExportDialog((current) => {
        if (!current || exportDialogLoadIdRef.current !== requestId) {
          return current;
        }
        return {
          ...current,
          loading: false,
          error: null,
          entryOrder,
          entryDetails: detailMap,
          entryConfigs: applyGlobalExportQuality(detailMap, entryOrder, "highest_available")
        };
      });
    } catch (error) {
      if (exportDialogLoadIdRef.current !== requestId) {
        return;
      }
      setExportDialog((current) => current ? {
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : String(error)
      } : current);
    }
  }

  const exportDialogEntries = exportDialog
    ? exportDialog.entryOrder
        .map((entryId) => {
          const detail = exportDialog.entryDetails[entryId];
          const config = exportDialog.entryConfigs[entryId];
          if (!detail || !config) return null;
          return {
            detail,
            include: config.include,
            exportOptionId: config.exportOptionId,
            batchSelected: config.batchSelected
          };
        })
        .filter((entry): entry is {
          detail: ArchiveEntryDetail;
          include: boolean;
          exportOptionId: string | null;
          batchSelected: boolean;
        } => Boolean(entry))
    : [];

  const canExportFromDialog = Boolean(
    exportDialog &&
    !exportDialog.loading &&
    exportDialog.destination.trim() &&
    exportDialogEntries.some((entry) => entry.include && entry.exportOptionId)
  );

  function updateExportDialog(updater: (current: ExportDialogConfig) => ExportDialogConfig) {
    setExportDialog((current) => (current ? updater(current) : current));
  }

  function applyGlobalQualityMode(mode: ExportQualityMode) {
    updateExportDialog((current) => ({
      ...current,
      globalQualityMode: mode,
      entryConfigs: applyGlobalExportQuality(current.entryDetails, current.entryOrder, mode, current.entryConfigs)
    }));
  }

  function applySingleExportOption(optionId: string) {
    updateExportDialog((current) => {
      const entryId = current.entryOrder[0];
      if (!entryId) return current;
      return {
        ...current,
        entryConfigs: {
          ...current.entryConfigs,
          [entryId]: {
            ...current.entryConfigs[entryId],
            exportOptionId: optionId
          }
        }
      };
    });
  }

  function setExportDialogPerFileMode(enabled: boolean) {
    updateExportDialog((current) => ({
      ...current,
      perFileMode: enabled,
      entryConfigs: enabled
        ? current.entryConfigs
        : applyGlobalExportQuality(current.entryDetails, current.entryOrder, current.globalQualityMode, current.entryConfigs)
    }));
  }

  async function submitExportDialog() {
    if (!exportDialog) return;
    const destination = exportDialog.destination.trim();
    const entriesToExport = exportDialog.entryOrder
      .map((entryId) => {
        const config = exportDialog.entryConfigs[entryId];
        if (!config?.include || !config.exportOptionId) {
          return null;
        }
        return {
          entryId,
          exportOptionId: config.exportOptionId
        };
      })
      .filter((entry): entry is ExportRequest["entries"][number] => Boolean(entry));

    if (!destination) {
      setExportDialog((current) => current ? { ...current, error: "Choose an export destination first." } : current);
      return;
    }
    if (entriesToExport.length === 0) {
      setExportDialog((current) => current ? { ...current, error: "Select at least one file to export." } : current);
      return;
    }

    const request: ExportRequest = {
      destination,
      entries: entriesToExport,
      preservePaths: exportDialog.preservePaths,
      removeFromArchive: exportDialog.removeFromArchive
    };

    const runner = entriesToExport.length === 1 ? exportEntry : exportEntries;
    await runner(request);
    setExportDialog(null);
  }

  useEffect(() => {
    if (!archiveUnlocked || !showArchiveView || !shellState.archive?.summary?.archiveId) {
      return;
    }

    const nextState: ArchiveHistoryState = {
      archiveId: shellState.archive.summary.archiveId,
      directory: currentDirectory
    };
    const previousState = archiveHistoryStateRef.current;
    const shouldReplace = !previousState || previousState.archiveId !== nextState.archiveId;

    if (
      previousState &&
      previousState.archiveId === nextState.archiveId &&
      previousState.directory === nextState.directory
    ) {
      return;
    }

    if (suppressHistorySyncRef.current) {
      suppressHistorySyncRef.current = false;
      archiveHistoryStateRef.current = nextState;
      return;
    }

    window.history[shouldReplace ? "replaceState" : "pushState"](nextState, "", window.location.href);
    archiveHistoryStateRef.current = nextState;
  }, [archiveUnlocked, currentDirectory, shellState.archive?.summary?.archiveId, showArchiveView]);

  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      const state = event.state as ArchiveHistoryState | null;
      if (
        !state ||
        typeof state.archiveId !== "string" ||
        typeof state.directory !== "string" ||
        !archiveUnlockedRef.current ||
        state.archiveId !== shellStateRef.current.archive?.summary?.archiveId
      ) {
        return;
      }

      suppressHistorySyncRef.current = true;

      if (activeViewRef.current !== "archive") {
        setActiveView("archive");
      }

      if (currentDirectoryRef.current !== state.directory) {
        navigateToDirectory(state.directory);
      }
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [navigateToDirectory]);

  function requestDeleteArchive(archive: ArchiveBrowserItem) {
    setArchiveDeleteCandidate(archive);
  }

  function handleContextMenu(entry: ArchiveEntryListItem | null, e: React.MouseEvent) {
    e.preventDefault();
    const entryIds = entry
      ? (selectedIds.has(entry.id) ? [...selectedIds] : [entry.id])
      : [];
    setContextMenu({ x: e.clientX, y: e.clientY, entryIds, emptySpace: !entry });
  }

  function handleDragStart(entry: ArchiveEntryListItem, e: React.DragEvent) {
    const payload: ArchiveDragPayload = entry.entryType === "folder"
      ? { entryIds: [], folderPaths: [entry.relativePath] }
      : {
          entryIds: selectedIds.has(entry.id) ? [...selectedIds] : [entry.id],
          folderPaths: []
        };
    e.dataTransfer.setData(ARCHIVE_ENTRY_DRAG_TYPE, JSON.stringify(payload));
    e.dataTransfer.effectAllowed = "move";
  }

  const handleToggleEntrySelection = useCallback((entry: ArchiveEntryListItem) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(entry.id)) {
        next.delete(entry.id);
      } else {
        next.add(entry.id);
      }
      return next;
    });
    setFocusedId(entry.id);
    setLastClickedId(entry.id);
  }, [setFocusedId, setLastClickedId, setSelectedIds]);

  async function confirmDeleteArchive() {
    if (!archiveDeleteCandidate) return;
    const target = archiveDeleteCandidate;
    const deletedCurrentArchive = shellState.archive?.path === target.path;
    const deletedOpenTarget = openArchivePath === target.path;
    await shell.runTask("Deleting archive", async () => {
      const next = await window.stow.deleteArchive(target.path);
      applyShellState(next);
      await refreshDetectedArchives();
      if (deletedCurrentArchive || deletedOpenTarget) {
        setActiveView("hub");
        setOpenArchivePath(next.recentArchives[0]?.path ?? "");
        setOpenPassword("");
        setUnlockPassword("");
      }
      return next;
    });
    setArchiveDeleteCandidate(null);
  }

  // ── Effects
  // Theme application
  useEffect(() => {
    const media = typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)")
      : null;

    const applyTheme = () => {
      const nextTheme = resolveTheme(draftSettings.themePreference, media?.matches ?? true);
      document.documentElement.dataset.theme = nextTheme;
    };

    applyTheme();
    if (!media || draftSettings.themePreference !== "system") {
      return;
    }

    const listener = () => applyTheme();
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", listener);
      return () => media.removeEventListener("change", listener);
    }
    media.addListener(listener);
    return () => media.removeListener(listener);
  }, [draftSettings.themePreference]);

  useEffect(() => {
    if (!archiveUnlocked) {
      setActiveView("hub");
    }
  }, [archiveUnlocked]);

  useEffect(() => {
    if (!archiveDirectory) {
      setArchiveDirectory(shellState.settings.preferredArchiveRoot);
    }
  }, [archiveDirectory, shellState.settings.preferredArchiveRoot]);

  useEffect(() => {
    const nextPath = shellState.archive?.path ?? shellState.recentArchives[0]?.path ?? "";
    if (!nextPath) return;
    if (shellState.archive?.path) {
      setOpenArchivePath(shellState.archive.path);
      setSelectedArchiveBrowserPath(shellState.archive.path);
      return;
    }
    if (!openArchivePath) setOpenArchivePath(nextPath);
    if (!selectedArchiveBrowserPath) setSelectedArchiveBrowserPath(nextPath);
  }, [openArchivePath, selectedArchiveBrowserPath, shellState.archive?.path, shellState.recentArchives]);

  useEffect(() => { setCreateFolderDraft(""); }, [shellState.archive?.summary?.archiveId]);
  useEffect(() => { setCreateFolderDraft(""); }, [currentDirectory]);

  useEffect(() => {
    const currentArchivePreferences = shellState.archive?.summary?.preferences ?? toArchivePreferences(shellState.settings);
    const settingsDirty = !settingsEqual(draftSettings, shellState.settings);
    const archivePreferencesDirty = archiveUnlocked && !archivePreferencesEqual(draftArchivePreferences, currentArchivePreferences);

    if (!settingsDirty && !archivePreferencesDirty) {
      if (settingsAutosaveTimerRef.current) {
        clearTimeout(settingsAutosaveTimerRef.current);
        settingsAutosaveTimerRef.current = null;
      }
      return;
    }

    if (settingsAutosaveRunningRef.current) {
      return;
    }

    if (settingsAutosaveTimerRef.current) {
      clearTimeout(settingsAutosaveTimerRef.current);
    }

    settingsAutosaveTimerRef.current = setTimeout(() => {
      settingsAutosaveTimerRef.current = null;
      if (settingsAutosaveRunningRef.current) return;
      settingsAutosaveRunningRef.current = true;

      void (async () => {
        try {
          while (true) {
            const nextSettings = draftSettingsRef.current;
            const nextArchivePreferences = draftArchivePreferencesRef.current;
            const currentShellState = shellStateRef.current;
            const currentArchivePreferences = currentShellState.archive?.summary?.preferences ?? toArchivePreferences(currentShellState.settings);
            const saveSettingsNeeded = !settingsEqual(nextSettings, currentShellState.settings);
            const saveArchivePreferencesNeeded = archiveUnlockedRef.current &&
              !archivePreferencesEqual(nextArchivePreferences, currentArchivePreferences);

            if (!saveSettingsNeeded && !saveArchivePreferencesNeeded) {
              break;
            }

            if (saveSettingsNeeded) {
              const next = await window.stow.saveSettings(nextSettings);
              shell.applyShellState(next);
              if (saveArchivePreferencesNeeded) {
                shell.setDraftArchivePreferences(nextArchivePreferences);
              }
              continue;
            }

            if (saveArchivePreferencesNeeded) {
              const next = await window.stow.setArchivePreferences(nextArchivePreferences);
              shell.applyShellState(next);
              continue;
            }
          }
        } finally {
          settingsAutosaveRunningRef.current = false;
        }
      })();
    }, 300);

    return () => {
      if (settingsAutosaveTimerRef.current) {
        clearTimeout(settingsAutosaveTimerRef.current);
        settingsAutosaveTimerRef.current = null;
      }
    };
  }, [archiveUnlocked, draftArchivePreferences, draftSettings, shell.applyShellState, shell.setDraftArchivePreferences, shellState.archive?.summary?.preferences, shellState.settings]);

  // Lock on hide
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState !== "hidden") return;
      if (!shellState.archive?.session?.effectivePolicy.lockOnHide) return;
      if (uiLocked) return;
      void shell.runTask("Locking archive", () => window.stow.lockArchive());
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [shell.runTask, shellState.archive?.session?.effectivePolicy.lockOnHide, uiLocked]);

  useEffect(() => {
    const clearBreadcrumbDropTarget = () => setBreadcrumbDropTarget(null);
    window.addEventListener("dragend", clearBreadcrumbDropTarget);
    return () => window.removeEventListener("dragend", clearBreadcrumbDropTarget);
  }, []);

  // Tauri native drag-and-drop — handles OS file drops with real paths
  useEffect(() => {
    const detachDrop = window.stow.onDragDrop(({ paths }) => {
      if (!showArchiveView || uiLocked) return;
      if (paths.length > 0) queueUpload(paths, currentDirectory);
    });
    return () => { detachDrop(); };
  }, [showArchiveView, currentDirectory, queueUpload, uiLocked]);

  // Keyboard shortcuts
  useEffect(() => {
    if (!showArchiveView || settingsOpen || archiveManagerOpen || deleteDialogState !== null || exportDialog !== null) return;
    const handler = (e: KeyboardEvent) => {
      if (isEditableElement(e.target)) return;
      if (e.key === "Escape") { clearSelection(); setContextMenu(null); return; }
      if (e.key === "F2" && singleSelectedId) { e.preventDefault(); beginRename(); return; }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedIds.size > 0) {
        e.preventDefault(); requestDelete([...selectedIds]); return;
      }
      if (isModKey(e) && e.key === "a") {
        e.preventDefault();
        setSelectedIds(new Set(
          entries
            .filter((entry): entry is ArchiveEntryListItem => entry !== undefined && entry.entryType === "file")
            .map((entry) => entry.id)
        ));
        return;
      }
      // Type-to-search
      if (e.key.length === 1 && !isModKey(e) && !e.altKey) {
        const next = typeSearch + e.key;
        setTypeSearch(next);
        if (typeSearchTimerRef.current) clearTimeout(typeSearchTimerRef.current);
        typeSearchTimerRef.current = setTimeout(() => {
          typeSearchTimerRef.current = null;
          setTypeSearch("");
        }, 1500);
        // Jump to first matching entry
        const match = entries.find(en => en && en.entryType === "file" && en.name.toLowerCase().startsWith(next.toLowerCase()));
        if (match) { setSelectedIds(new Set([match.id])); setFocusedId(match.id); }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [beginRename, clearSelection, deleteDialogState, entries, archiveManagerOpen, exportDialog, selectedIds, settingsOpen, showArchiveView, singleSelectedId, setFocusedId, setSelectedIds, typeSearch]);

  // ── Render
  const crumbs = archiveBreadcrumbs(currentDirectory);
  const parentDir = parentDirectory(currentDirectory);
  const contextMenuItems = contextMenu
    ? contextMenu.entryIds
      .map((entryId) => entries.find((entry) => entry?.id === entryId))
      .filter((entry): entry is ArchiveEntryListItem => Boolean(entry))
    : [];

  function handleBreadcrumbDragOver(path: string, e: React.DragEvent) {
    if (!isArchiveEntryDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    setBreadcrumbDropTarget(path);
    e.dataTransfer.dropEffect = "move";
  }

  function handleBreadcrumbDragEnter(path: string, e: React.DragEvent) {
    if (!isArchiveEntryDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    setBreadcrumbDropTarget(path);
    e.dataTransfer.dropEffect = "move";
  }

  async function handleBreadcrumbDrop(path: string, e: React.DragEvent) {
    if (!isArchiveEntryDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    setBreadcrumbDropTarget(null);
    const payload = readArchiveDragPayload(e.dataTransfer);
    if (payload && (payload.entryIds.length > 0 || payload.folderPaths.length > 0)) {
      await moveArchiveEntries(payload, path);
    }
  }

  function handleBreadcrumbDragLeave(path: string, e: React.DragEvent) {
    if (!isArchiveEntryDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    setBreadcrumbDropTarget((current) => (current === path ? null : current));
  }

  return (
    <div className="app-shell">
      {shellState.installStatus.active && <InstallBanner installStatus={shellState.installStatus} />}

      {/* ── Topbar */}
      <header className="topbar">
        <div className="topbar-left">
          <button
            type="button"
            className="topbar-brand"
            disabled={uiLocked}
            onClick={() => setActiveView("hub")}
            title="Return to hub"
            aria-label="Return to hub"
          >
            <span className="topbar-brand-title">Stow</span>
            <span className="topbar-brand-version">v{packageJson.version}</span>
          </button>
          {showArchiveView && <ProgressBar progress={progress} />}
        </div>

        {showArchiveView ? (
          <div className="topbar-center">
            <nav className="breadcrumb" aria-label="Archive path">
              <button
                type="button"
                className={`breadcrumb-back${breadcrumbDropTarget === parentDir && currentDirectory ? " breadcrumb-segment-drop-target" : ""}`}
                disabled={uiLocked || !currentDirectory}
                onClick={() => navigateToDirectory(parentDir)}
                title="Go back"
                aria-label="Go back"
                onDragEnter={(e) => handleBreadcrumbDragEnter(parentDir, e)}
                onDragOver={(e) => handleBreadcrumbDragOver(parentDir, e)}
                onDragLeave={(e) => handleBreadcrumbDragLeave(parentDir, e)}
                onDrop={(e) => { void handleBreadcrumbDrop(parentDir, e); }}
              >
                ←
              </button>
              <button
                type="button"
                className={`breadcrumb-segment${currentDirectory === "" ? " breadcrumb-segment-active" : ""}${breadcrumbDropTarget === "" ? " breadcrumb-segment-drop-target" : ""}`}
                disabled={uiLocked}
                onClick={() => navigateToDirectory("")}
                title={`Drop to move into ${archiveName_}`}
                onDragEnter={(e) => handleBreadcrumbDragEnter("", e)}
                onDragOver={(e) => handleBreadcrumbDragOver("", e)}
                onDragLeave={(e) => handleBreadcrumbDragLeave("", e)}
                onDrop={(e) => { void handleBreadcrumbDrop("", e); }}
              >
                {archiveName_}
              </button>
              {crumbs.map(crumb => (
                <React.Fragment key={crumb.path}>
                  <span className="breadcrumb-separator" aria-hidden="true">›</span>
                  <button
                    type="button"
                    className={`breadcrumb-segment${currentDirectory === crumb.path ? " breadcrumb-segment-active" : ""}${breadcrumbDropTarget === crumb.path ? " breadcrumb-segment-drop-target" : ""}`}
                    disabled={uiLocked}
                    onClick={() => navigateToDirectory(crumb.path)}
                    title={`Drop to move into ${crumb.path}`}
                    onDragEnter={(e) => handleBreadcrumbDragEnter(crumb.path, e)}
                    onDragOver={(e) => handleBreadcrumbDragOver(crumb.path, e)}
                    onDragLeave={(e) => handleBreadcrumbDragLeave(crumb.path, e)}
                    onDrop={(e) => { void handleBreadcrumbDrop(crumb.path, e); }}
                  >
                    {crumb.name}
                  </button>
                </React.Fragment>
              ))}
            </nav>
          </div>
        ) : (
          <div className="topbar-center" aria-hidden="true" />
        )}

        <div className="topbar-right">
          {showArchiveView && (
            <>
              <button type="button" disabled={uiLocked} onClick={async () => {
                const picked = await window.stow.pickFilesOrFolders();
                if (picked.length) queueUpload(picked, currentDirectory);
              }}>Add files</button>
              <button type="button" disabled={uiLocked} onClick={() => setShowCreateFolder(v => !v)}>New folder</button>
              <button type="button" disabled={uiLocked} onClick={() => setDetailOpen(v => !v)} title={detailOpen ? "Hide inspector" : "Show inspector"}>
                {detailOpen ? "Inspector ✓" : "Inspector"}
              </button>
              <button type="button" disabled={uiLocked} onClick={() => setActiveView("hub")}>Hub</button>
              <button type="button" disabled={uiLocked} onClick={() => void shell.runTask("Locking archive", async () => {
                const next = await window.stow.lockArchive();
                setActiveView("hub");
                return next;
              })}>Lock</button>
            </>
          )}
        </div>
        <div className="topbar-settings">
          <IconButton title="Settings" className="icon-button-cog icon-button-plain" disabled={uiLocked} onClick={() => setSettingsOpen(true)}>
            <CogIcon />
          </IconButton>
        </div>
      </header>

      {/* ── Main layout */}
      <div
        className="main-layout"
        style={{
          gridTemplateColumns: showActivityLogPanel ? "auto minmax(0, 1fr) auto auto" : "auto minmax(0, 1fr) auto"
        }}
      >
        {/* Tree sidebar (only when unlocked) — always render a slot to keep file-panel in column 2 */}
        {showArchiveView ? (
          <TreeSidebar
            archiveName={archiveName_}
            folders={archiveFolders}
            currentDirectory={currentDirectory}
            stats={activeStats}
            isBusy={uiLocked}
            onNavigate={navigateToDirectory}
            onDropPaths={(paths, dest) => queueUpload(paths, dest)}
            onMoveEntries={moveArchiveEntries}
          />
        ) : (
          <div style={{ width: 0 }} />
        )}

        {/* File panel */}
        <div className="file-panel">

          {showArchiveView && showCreateFolder && (
            <form style={{ display: "flex", gap: 6, padding: "6px 10px", borderBottom: "1px solid var(--border-subtle)" }}
              onSubmit={async e => {
                e.preventDefault();
                const nextName = createFolderDraft.trim();
                await createFolder(createFolderDraft);
                if (nextName) {
                  setCreateFolderDraft("");
                  setShowCreateFolder(false);
                }
              }}>
              <input autoFocus disabled={uiLocked} value={createFolderDraft} placeholder="Folder name"
                onChange={e => setCreateFolderDraft(e.target.value)}
                onKeyDown={e => { if (e.key === "Escape") { setShowCreateFolder(false); setCreateFolderDraft(""); } }}
                style={{ flex: 1, maxWidth: 240 }} />
              <button type="submit" disabled={uiLocked || !createFolderDraft.trim()}>Create</button>
              <button type="button" onClick={() => { setShowCreateFolder(false); setCreateFolderDraft(""); }}>Cancel</button>
            </form>
          )}

          {!showArchiveView ? (
            <Hub
              currentArchive={shellState.archive}
              archiveUnlocked={archiveUnlocked}
            archives={browserArchives}
            loading={archiveBrowserLoading}
            error={archiveBrowserError}
            sortMode={archiveBrowserSortMode}
            isBusy={isBusy}
            onOpenManager={() => setArchiveManagerOpen(true)}
            onOpenArchiveBrowser={() => openArchiveBrowser()}
            onOpenArchivePath={prepareArchiveOpen}
            onRefreshArchives={() => void refreshDetectedArchives()}
            onSortModeChange={setArchiveBrowserSortMode}
            onDeleteArchive={requestDeleteArchive}
            onReturnToArchive={() => setActiveView("archive")}
            onLockArchive={() => void shell.runTask("Locking archive", async () => {
                const next = await window.stow.lockArchive();
                setActiveView("hub");
                return next;
              })}
          />
          ) : (
          <FileList
              entries={entries}
              total={entryTotal}
              loadedCount={loadedEntryCount}
              currentDirectory={currentDirectory}
              selectedIds={selectedIds}
              focusedId={focusedId}
              renamingEntryId={renamingEntryId}
              renameDraft={renameDraft}
              renameInputRef={renameInputRef}
              emptyState={emptyState}
              unlockPassword={unlockPassword}
              unlockDisabled={uiLocked || !unlockPassword}
              isBusy={isBusy}
              onUnlockPasswordChange={setUnlockPassword}
              onUnlock={() => void shell.runTask("Opening archive", () => window.stow.openArchive({ archivePath: shellState.archive?.path ?? openArchivePath, password: unlockPassword }))}
              onClickEntry={handleClickEntry}
              onToggleEntrySelection={handleToggleEntrySelection}
              onDoubleClickEntry={handleDoubleClickEntry}
              onContextMenu={handleContextMenu}
              onDragStart={handleDragStart}
              onDropPaths={(paths, dest) => queueUpload(paths, dest)}
              onMoveEntries={moveArchiveEntries}
              onNeedMore={handleNeedMore}
              onRenameChange={setRenameDraft}
              onRenameSubmit={submitRename}
              onRenameCancel={cancelRename}
              resolveThumbnail={resolveThumbnail}
              sortColumn={sortColumn}
              sortDirection={sortDirection}
              onSort={handleSort}
            />
          )}

          {typeSearch && <div className="type-search">{typeSearch}</div>}
        </div>

        {/* Detail panel — always render a slot to keep file-panel in column 2 */}
        {showArchiveView && detailOpen ? (
          <DetailPanel
            selectedIds={selectedIds}
            entries={entries}
            selectedEntry={selectedEntry}
            preview={preview}
            detailRevision={detailRevision}
            overrideMode={effectiveOverrideMode}
            canReprocessLossless={canReprocessLossless}
            isBusy={isBusy}
            onClose={() => setDetailOpen(false)}
            onOpen={() => { if (singleSelectedId) void openEntryExternally(singleSelectedId); }}
            onExport={() => { if (selectedFileIds.length > 0) void openExportDialog(selectedFileIds); }}
            onReprocess={() => { if (singleSelectedId) void reprocessEntry(singleSelectedId, effectiveOverrideMode); }}
            onDelete={() => { if (singleSelectedId) requestDelete([singleSelectedId]); }}
            onOverrideModeChange={setOverrideMode}
            onBulkDelete={() => requestDelete([...selectedIds])}
            canExportSelected={selectedFileIds.length > 0}
          />
        ) : (
          <div style={{ width: 0 }} />
        )}

        {showActivityLogPanel ? <ActivityLogPanel logs={shellState.logs} /> : null}
      </div>

      {/* ── Status bar */}
      <footer className="status-bar" role="status" aria-live="polite">
        <div className="status-bar-left">
          {archiveUnlocked && activeStats && (
            <>
              <span>{activeStats.entryCount.toLocaleString()} {activeStats.entryCount === 1 ? "file" : "files"}</span>
              <div className="status-bar-sep" />
              <span>{formatBytes(activeStats.storedBytes)} stored</span>
              <div className="status-bar-sep" />
              <span>{formatBytes(activeStats.logicalBytes)} logical</span>
            </>
          )}
          {!archiveUnlocked && !shellState.archive && <span>No archive open</span>}
          {shellState.archive && !archiveUnlocked && <span>Locked · {shellState.archive.path}</span>}
        </div>
        <div className="status-bar-right">
          {showArchiveView && selectedCount > 0 && (
            <>
              <span>{selectedCount} selected{selectedSizeTotal > 0 ? ` · ${formatBytes(selectedSizeTotal)}` : ""}</span>
              <div className="status-bar-sep" />
            </>
          )}
          {status !== "Ready" && <span>{status}</span>}
          {showArchiveView && currentDirectory && <span title={currentDirectory}>{currentDirectory}</span>}
        </div>
      </footer>

      {/* ── Context menu */}
      {contextMenu && (
          <ContextMenuComponent
            menu={contextMenu}
            items={contextMenuItems}
            folders={archiveFolders}
            isBusy={isBusy}
            onClose={() => setContextMenu(null)}
            onOpen={() => {
              const entry = contextMenuItems[0];
              if (!entry) return;
              if (entry.entryType === "folder") {
              navigateToDirectory(entry.relativePath);
              return;
              }
            void openEntryExternally(entry.id);
            }}
            onRename={() => beginRename(contextMenuItems[0]?.id ?? null)}
            onMoveToFolder={dest => {
              const ids = contextMenu.entryIds;
            if (ids.length === 1) void moveEntry(ids[0], dest);
            else if (ids.length > 1) void moveEntries({ entryIds: ids, destinationDirectory: dest });
            }}
            onExport={() => {
              const ids = contextMenu.entryIds;
            if (ids.length > 0) void openExportDialog(ids);
            }}
            onDelete={() => requestDelete(contextMenu.entryIds)}
            onNewFolder={() => { setShowCreateFolder(true); setCreateFolderDraft(""); }}
            onAddFiles={async () => {
              const picked = await window.stow.pickFilesOrFolders();
              if (picked.length) queueUpload(picked, currentDirectory);
            }}
          />
      )}

      {/* ── Dialogs */}
      <ArchiveManagerDialog
        open={archiveManagerOpen}
        isBusy={isBusy}
        archiveName={archiveName}
        archiveDirectory={archiveDirectory}
        archivePassword={archivePassword}
        showArchivePassword={showArchivePassword}
        draftPrefs={draftArchivePreferences}
        canCreate={canCreateArchive}
        onClose={() => setArchiveManagerOpen(false)}
        onArchiveNameChange={setArchiveName}
        onArchiveDirectoryChange={setArchiveDirectory}
        onBrowseCreate={async () => { const p = await window.stow.pickDirectory(); if (p) setArchiveDirectory(p); }}
        onArchivePasswordChange={setArchivePassword}
        onArchivePasswordVisibilityChange={setShowArchivePassword}
        onDraftPrefsChange={applyArchivePreferences}
        onCreate={() => void createSelectedArchive()}
      />

      <ArchiveUnlockDialog
        open={archiveUnlockOpen}
        archivePath={openArchivePath}
        isBusy={isBusy}
        password={openPassword}
        canUnlock={canOpenArchive && !selectedArchiveIsUnlocked}
        onPasswordChange={setOpenPassword}
        onClose={() => {
          setArchiveUnlockOpen(false);
          setOpenPassword("");
        }}
        onUnlock={() => void openSelectedArchive()}
      />

      <ArchiveBrowserDialog
        open={archiveBrowserOpen}
        archives={browserArchives}
        loading={archiveBrowserLoading}
        error={archiveBrowserError}
        sortMode={archiveBrowserSortMode}
        selectedPath={browserSelectedArchivePath}
        currentArchivePath={shellState.archive?.path ?? null}
        isBusy={isBusy}
        onClose={() => { closeArchiveBrowser(); setArchiveDeleteCandidate(null); }}
        onRefresh={() => void refreshDetectedArchives()}
        onSortModeChange={setArchiveBrowserSortMode}
        onSelect={setSelectedArchiveBrowserPath}
        onSwapSelected={swapSelectedArchive}
        onDeleteSelected={requestDeleteArchive}
      />

      <ExportDialog
        open={Boolean(exportDialog)}
        isBusy={isBusy}
        loading={exportDialog?.loading ?? false}
        error={exportDialog?.error ?? null}
        entries={exportDialogEntries}
        destination={exportDialog?.destination ?? ""}
        preservePaths={exportDialog?.preservePaths ?? true}
        removeFromArchive={exportDialog?.removeFromArchive ?? false}
        perFileMode={exportDialog?.perFileMode ?? false}
        globalQualityMode={exportDialog?.globalQualityMode ?? "highest_available"}
        batchQualityMode={exportDialog?.batchQualityMode ?? "highest_available"}
        canExport={canExportFromDialog}
        resolveThumbnail={resolveThumbnail}
        onClose={() => setExportDialog(null)}
        onDestinationChange={(value) => updateExportDialog((current) => ({ ...current, destination: value, error: null }))}
        onBrowseDestination={async () => {
          const destination = await window.stow.pickDirectory();
          if (!destination) return;
          updateExportDialog((current) => ({ ...current, destination, error: null }));
        }}
        onPreservePathsChange={(value) => updateExportDialog((current) => ({ ...current, preservePaths: value }))}
        onRemoveFromArchiveChange={(value) => updateExportDialog((current) => ({ ...current, removeFromArchive: value }))}
        onPerFileModeChange={setExportDialogPerFileMode}
        onGlobalQualityModeChange={applyGlobalQualityMode}
        onSingleGlobalOptionChange={applySingleExportOption}
        onBatchQualityModeChange={(value) => updateExportDialog((current) => ({ ...current, batchQualityMode: value }))}
        onToggleBatchSelected={(entryId) => updateExportDialog((current) => ({
          ...current,
          entryConfigs: {
            ...current.entryConfigs,
            [entryId]: {
              ...current.entryConfigs[entryId],
              batchSelected: !current.entryConfigs[entryId]?.batchSelected
            }
          }
        }))}
        onToggleAllBatchSelected={(value) => updateExportDialog((current) => ({
          ...current,
          entryConfigs: Object.fromEntries(
            current.entryOrder.map((entryId) => [
              entryId,
              {
                ...current.entryConfigs[entryId],
                batchSelected: value
              }
            ])
          )
        }))}
        onApplyBatchQuality={() => updateExportDialog((current) => ({
          ...current,
          entryConfigs: Object.fromEntries(
            current.entryOrder.map((entryId) => {
              const detail = current.entryDetails[entryId];
              const config = current.entryConfigs[entryId];
              if (!detail || !config) {
                return [entryId, config];
              }
              if (!config.batchSelected) {
                return [entryId, config];
              }
              return [
                entryId,
                {
                  ...config,
                  exportOptionId: resolveExportOptionId(detail, current.batchQualityMode)
                }
              ];
            })
          )
        }))}
        onToggleEntryIncluded={(entryId, value) => updateExportDialog((current) => ({
          ...current,
          entryConfigs: {
            ...current.entryConfigs,
            [entryId]: {
              ...current.entryConfigs[entryId],
              include: value
            }
          },
          error: null
        }))}
        onEntryOptionChange={(entryId, optionId) => updateExportDialog((current) => ({
          ...current,
          entryConfigs: {
            ...current.entryConfigs,
            [entryId]: {
              ...current.entryConfigs[entryId],
              exportOptionId: optionId
            }
          },
          error: null
        }))}
        onSubmit={() => void submitExportDialog()}
      />

      <DeleteConfirmationDialog
        open={archiveDeleteCandidate !== null}
        title={`Delete "${archiveDeleteCandidate?.name}"?`}
        description={archiveDeleteCandidate?.name ?? ""}
        detail={archiveDeleteCandidate?.path ?? ""}
        isBusy={isBusy}
        onCancel={() => setArchiveDeleteCandidate(null)}
        onConfirm={() => void confirmDeleteArchive()}
      />

      <DeleteConfirmationDialog
        open={deleteDialogState !== null}
        title={deleteDialogState?.title ?? ""}
        description={deleteDialogState?.description ?? ""}
        detail={deleteDialogState?.detail ?? ""}
        isBusy={isBusy}
        onCancel={() => setDeleteDialogState(null)}
        onConfirm={() => deleteDialogState?.onConfirm()}
      />

      <SettingsDialog
        open={settingsOpen}
        value={draftSettings}
        draftPrefs={draftArchivePreferences}
        isBusy={isBusy}
        capabilities={shellState.capabilities}
        installStatus={shellState.installStatus}
        onClose={closeSettingsDialog}
        onChange={shell.setDraftSettings}
        onChangePrefs={applyArchivePreferences}
      onReset={() => void shell.runTask("Restoring defaults", async () => { const next = await window.stow.resetSettings(); shell.setDraftArchivePreferences(toArchivePreferences(next.settings)); return next; })}
      onInstallMissingTools={() => void shell.runTask("Installing missing tools", async () => window.stow.installMissingTools())}
    />
  </div>
  );
}


export default AppShell;
