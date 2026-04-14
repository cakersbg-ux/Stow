import React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import packageJson from "../../../package.json";
import type {
  AppShellState,
  ArchivePreferences,
  ArchiveEntryListItem
} from "../../types";
import {
  ARCHIVE_ENTRY_DRAG_TYPE,
  archiveBreadcrumbs,
  formatBytes,
  isEditableElement,
  isModKey,
  mergePrefs,
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
  ContextMenuComponent,
  DeleteConfirmationDialog,
  DetailPanel,
  FileList,
  Hub,
  InstallBanner,
  LogDrawer,
  ProgressBar,
  SettingsDialog,
  TreeSidebar
} from "./AppShellComponents";
import { useArchiveBrowser } from "./useArchiveBrowser";
import { useUploadQueue } from "./useUploadQueue";
import { useShellStore } from "./useShellStore";

const versionLabel = `Stow v${packageJson.version}`;
type AppView = "hub" | "archive";

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

  // ── Drag
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  // ── Dialogs
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [archiveManagerOpen, setArchiveManagerOpen] = useState(false);
  const [archiveManagerTab, setArchiveManagerTab] = useState<"open" | "create">("open");
  const [archiveDeleteCandidate, setArchiveDeleteCandidate] = useState<ArchiveBrowserItem | null>(null);
  const [deleteDialogState, setDeleteDialogState] = useState<{ title: string; description: string; detail: string; onConfirm: () => void } | null>(null);
  const [detailOpen, setDetailOpen] = useState(true);
  const [logOpen, setLogOpen] = useState(false);

  // ── Archive form state
  const [archiveName, setArchiveName] = useState("Archive");
  const [archiveDirectory, setArchiveDirectory] = useState("");
  const [archivePassword, setArchivePassword] = useState("");
  const [confirmArchivePassword, setConfirmArchivePassword] = useState("");
  const [openArchivePath, setOpenArchivePath] = useState("");
  const [openPassword, setOpenPassword] = useState("");
  const [unlockPassword, setUnlockPassword] = useState("");
  const [overrideMode, setOverrideMode] = useState<"lossless" | "visually_lossless">("visually_lossless");

  // ── Derived state
  const showArchiveView = archiveUnlocked && activeView === "archive";
  const selectedArchiveIsUnlocked = Boolean(shellState.archive?.unlocked && shellState.archive?.path === openArchivePath);
  const uiLocked = isBusy;
  const passwordsMatch = archivePassword.length > 0 && archivePassword === confirmArchivePassword;
  const canOpenArchive = !uiLocked && Boolean(openArchivePath) && (selectedArchiveIsUnlocked || Boolean(openPassword));
  const canCreateArchive = !uiLocked && Boolean(archiveDirectory) && Boolean(archiveName) && passwordsMatch;
  const archiveFolders = shellState.archive?.summary?.folders ?? [];
  const archiveName_ = shellState.archive?.summary?.name ?? "Archive";
  const activeStats = stats ?? shellState.archive?.summary ?? null;
  const selectedCount = selectedIds.size;
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

  function resetDraftSettings() {
    shell.resetDraftSettings();
  }

  function closeSettingsDialog() {
    resetDraftSettings();
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
    setArchiveManagerTab("open");
    setArchiveManagerOpen(true);
    setOpenPassword("");
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
    setArchiveManagerOpen(false);
  }

  async function createSelectedArchive() {
    if (!canCreateArchive) return;
    await shell.runTask("Creating archive", () => window.stow.createArchive({
      parentPath: archiveDirectory, name: archiveName, password: archivePassword, preferences: draftArchivePreferences
    }));
    setActiveView("archive");
    setArchivePassword("");
    setConfirmArchivePassword("");
    setOpenPassword("");
    setArchiveManagerOpen(false);
  }

  async function saveArchivePreferences() {
    if (!archiveUnlocked) return;
    await shell.runTask("Saving archive policy", async () => {
      const next = await window.stow.setArchivePreferences(draftArchivePreferences);
      return { ...next, settings: mergePrefs(next.settings, draftArchivePreferences) };
    });
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

  // Global drag-and-drop — web events for visual overlay + internal entry moves
  useEffect(() => {
    function handleDragEnter(e: DragEvent) { e.preventDefault(); dragCounterRef.current += 1; if (dragCounterRef.current === 1) setIsDragOver(true); }
    function handleDragLeave(e: DragEvent) { e.preventDefault(); dragCounterRef.current -= 1; if (dragCounterRef.current <= 0) { dragCounterRef.current = 0; setIsDragOver(false); } }
    function handleDragOver(e: DragEvent) { e.preventDefault(); }
    function handleDrop(e: DragEvent) {
      e.preventDefault(); dragCounterRef.current = 0; setIsDragOver(false);
      // Only handle internal archive entry moves here — OS file drops are handled by Tauri events below
      if (!showArchiveView || uiLocked) return;
      readArchiveDragPayload(e.dataTransfer);
    }
    window.addEventListener("dragenter", handleDragEnter);
    window.addEventListener("dragleave", handleDragLeave);
    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("drop", handleDrop);
    return () => {
      window.removeEventListener("dragenter", handleDragEnter);
      window.removeEventListener("dragleave", handleDragLeave);
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("drop", handleDrop);
    };
  }, [showArchiveView, currentDirectory, uiLocked]);

  // Tauri native drag-and-drop — handles OS file drops with real paths
  useEffect(() => {
    const detachEnter = window.stow.onDragEnter(() => {
      dragCounterRef.current = 1;
      setIsDragOver(true);
    });
    const detachLeave = window.stow.onDragLeave(() => {
      dragCounterRef.current = 0;
      setIsDragOver(false);
    });
    const detachDrop = window.stow.onDragDrop(({ paths }) => {
      dragCounterRef.current = 0;
      setIsDragOver(false);
      if (!showArchiveView || uiLocked) return;
      if (paths.length > 0) queueUpload(paths, currentDirectory);
    });
    return () => { detachEnter(); detachLeave(); detachDrop(); };
  }, [showArchiveView, currentDirectory, uiLocked]);

  // Keyboard shortcuts
  useEffect(() => {
    if (!showArchiveView || settingsOpen || archiveManagerOpen || deleteDialogState !== null) return;
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
  }, [beginRename, clearSelection, deleteDialogState, entries, archiveManagerOpen, selectedIds, settingsOpen, showArchiveView, singleSelectedId, setFocusedId, setSelectedIds, typeSearch]);

  // ── Render
  const crumbs = archiveBreadcrumbs(currentDirectory);
  const parentDir = parentDirectory(currentDirectory);
  const contextMenuItems = contextMenu
    ? contextMenu.entryIds
      .map((entryId) => entries.find((entry) => entry?.id === entryId))
      .filter((entry): entry is ArchiveEntryListItem => Boolean(entry))
    : [];

  return (
    <div className="app-shell">
      {isDragOver && showArchiveView && (
        <div className="drop-overlay">
          <div className="drop-inner">
            <strong>Drop to add files</strong>
            <span>Release to start ingesting</span>
          </div>
        </div>
      )}
      {shellState.installStatus.active && <InstallBanner installStatus={shellState.installStatus} />}

      {/* ── Topbar */}
      <header className="topbar">
        <div className="topbar-left">
          <strong>{versionLabel}</strong>
          {showArchiveView && (
            <span className="topbar-status">{status === "Ready" ? "" : status}</span>
          )}
          {!showArchiveView && (
            <span className="topbar-status">
              {status !== "Ready"
                ? status
                : archiveUnlocked
                  ? `Hub · ${archiveName_} open`
                  : shellState.archive
                    ? `Hub · ${shellState.archive.path}`
                    : "No archive open"}
            </span>
          )}
          {showArchiveView && <ProgressBar progress={progress} />}
        </div>

        {showArchiveView ? (
          <div className="topbar-center">
            <nav className="breadcrumb" aria-label="Archive path">
              <button
                type="button"
                className="breadcrumb-back"
                disabled={uiLocked || !currentDirectory}
                onClick={() => navigateToDirectory(parentDir)}
                title="Go back"
                aria-label="Go back"
              >
                ←
              </button>
              <button type="button" className={`breadcrumb-segment${currentDirectory === "" ? " breadcrumb-segment-active" : ""}`}
                disabled={uiLocked} onClick={() => navigateToDirectory("")}>
                {archiveName_}
              </button>
              {crumbs.map(crumb => (
                <React.Fragment key={crumb.path}>
                  <span className="breadcrumb-separator" aria-hidden="true">›</span>
                  <button type="button" className={`breadcrumb-segment${currentDirectory === crumb.path ? " breadcrumb-segment-active" : ""}`}
                    disabled={uiLocked || currentDirectory === crumb.path} onClick={() => navigateToDirectory(crumb.path)}>
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
              <button type="button" disabled={uiLocked} onClick={() => setLogOpen(v => !v)}>Log</button>
              <button type="button" disabled={uiLocked} onClick={() => setActiveView("hub")}>Hub</button>
              <button type="button" disabled={uiLocked} onClick={() => void shell.runTask("Locking archive", async () => {
                const next = await window.stow.lockArchive();
                setActiveView("hub");
                return next;
              })}>Lock</button>
              <button type="button" disabled={uiLocked} onClick={() => void shell.runTask("Closing archive", async () => {
                const next = await window.stow.closeArchive();
                setActiveView("hub");
                return next;
              })}>Close</button>
            </>
          )}
          {archiveUnlocked && !showArchiveView && (
            <button type="button" disabled={uiLocked} onClick={() => setActiveView("archive")}>Return to archive</button>
          )}
          {shellState.archive && !archiveUnlocked && (
            <button type="button" disabled={uiLocked} onClick={() => prepareArchiveOpen(shellState.archive?.path ?? openArchivePath)}>Unlock</button>
          )}
          {!shellState.archive && (
            <>
              <button type="button" disabled={uiLocked} onClick={() => { setArchiveManagerTab("open"); setArchiveManagerOpen(true); }}>Open archive</button>
              <button type="button" disabled={uiLocked} onClick={() => { setArchiveManagerTab("create"); setArchiveManagerOpen(true); }}>New archive</button>
            </>
          )}
          <button type="button" disabled={uiLocked} onClick={() => openArchiveBrowser()}>All archives</button>
          <button type="button" disabled={uiLocked} onClick={() => setSettingsOpen(true)}>Settings</button>
        </div>
      </header>

      {/* ── Main layout */}
      <div className="main-layout">
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
            onOpenManager={tab => { setArchiveManagerTab(tab); setArchiveManagerOpen(true); }}
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
            onCloseArchive={() => void shell.runTask("Closing archive", async () => {
                const next = await window.stow.closeArchive();
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
            overrideMode={overrideMode}
            isBusy={isBusy}
            onClose={() => setDetailOpen(false)}
            onOpen={() => { if (singleSelectedId) void openEntryExternally(singleSelectedId); }}
            onExportOriginal={() => { if (singleSelectedId) void exportEntry(singleSelectedId, "original"); }}
            onExportOptimized={() => { if (singleSelectedId) void exportEntry(singleSelectedId, "optimized"); }}
            onReprocess={() => { if (singleSelectedId) void reprocessEntry(singleSelectedId, overrideMode); }}
            onDelete={() => { if (singleSelectedId) requestDelete([singleSelectedId]); }}
            onOverrideModeChange={setOverrideMode}
            onBulkDelete={() => requestDelete([...selectedIds])}
            onBulkExport={variant => void exportEntries([...selectedIds], variant)}
          />
        ) : (
          <div style={{ width: 0 }} />
        )}
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
            onExportOriginal={() => {
              const ids = contextMenu.entryIds;
            if (ids.length === 1) void exportEntry(ids[0], "original");
            else void exportEntries(ids, "original");
            }}
            onExportOptimized={() => {
              const ids = contextMenu.entryIds;
            if (ids.length === 1) void exportEntry(ids[0], "optimized");
            else void exportEntries(ids, "optimized");
            }}
            onDelete={() => requestDelete(contextMenu.entryIds)}
            onNewFolder={() => { setShowCreateFolder(true); setCreateFolderDraft(""); }}
            onAddFiles={async () => {
              const picked = await window.stow.pickFilesOrFolders();
              if (picked.length) queueUpload(picked, currentDirectory);
            }}
          />
      )}

      {/* ── Log drawer */}
      {logOpen && <LogDrawer logs={shellState.logs} onClose={() => setLogOpen(false)} />}

      {/* ── Dialogs */}
      <ArchiveManagerDialog
        open={archiveManagerOpen}
        tab={archiveManagerTab}
        isBusy={isBusy}
        openPath={openArchivePath}
        openPassword={openPassword}
        selectedArchiveIsUnlocked={selectedArchiveIsUnlocked}
        canOpen={canOpenArchive}
        archiveName={archiveName}
        archiveDirectory={archiveDirectory}
        archivePassword={archivePassword}
        confirmArchivePassword={confirmArchivePassword}
        draftPrefs={draftArchivePreferences}
        passwordsMatch={passwordsMatch}
        canCreate={canCreateArchive}
        onClose={() => setArchiveManagerOpen(false)}
        onTabChange={setArchiveManagerTab}
        onOpenPathChange={setOpenArchivePath}
        onBrowseOpen={async () => { const p = await window.stow.pickDirectory(); if (p) setOpenArchivePath(p); }}
        onOpenPasswordChange={setOpenPassword}
        onOpen={() => void openSelectedArchive()}
        onArchiveNameChange={setArchiveName}
        onArchiveDirectoryChange={setArchiveDirectory}
        onBrowseCreate={async () => { const p = await window.stow.pickDirectory(); if (p) setArchiveDirectory(p); }}
        onArchivePasswordChange={setArchivePassword}
        onConfirmArchivePasswordChange={setConfirmArchivePassword}
        onDraftPrefsChange={applyArchivePreferences}
        onCreate={() => void createSelectedArchive()}
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
        archiveUnlocked={archiveUnlocked}
        installStatus={shellState.installStatus}
        onClose={closeSettingsDialog}
        onChange={shell.setDraftSettings}
        onChangePrefs={applyArchivePreferences}
        onSave={() => void shell.runTask("Saving settings", async () => { const next = await window.stow.saveSettings(draftSettings); setSettingsOpen(false); return next; })}
        onReset={() => void shell.runTask("Restoring defaults", async () => { const next = await window.stow.resetSettings(); shell.setDraftArchivePreferences(toArchivePreferences(next.settings)); return next; })}
        onSaveArchivePolicy={() => void saveArchivePreferences()}
        onInstallMissingTools={() => void shell.runTask("Installing missing tools", async () => window.stow.installMissingTools())}
      />
    </div>
  );
}


export default AppShell;
