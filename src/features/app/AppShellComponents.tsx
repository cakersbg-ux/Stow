import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type {
  AppShellState,
  ArchivePreferences,
  ArchiveEntryDetail,
  ArchiveEntryListItem,
  ArchiveProgress,
  ArchiveStats,
  DetectedArchive,
  InstallStatus,
  PreviewDescriptor,
  Settings
} from "../../types";
import {
  LIST_PAGE_SIZE,
  ROW_HEIGHT,
  IS_MAC,
  archiveBreadcrumbs,
  baseNameSelectionEnd,
  buildFolderTree,
  clearEntryPageCache,
  compareArchiveItems,
  createEntryPageCache,
  defaultArchivePreferences,
  defaultSettings,
  defaultShellState,
  collectDroppedPaths,
  formatArchiveSize,
  formatBytes,
  formatDateTime,
  folderEntryId,
  getLoadedEntryCount,
  getLoadedOffsets,
  getNextMissingOffset,
  getSelectedSizeTotal,
  getVisibleEntries,
  isArchiveEntryDrag,
  isEditableElement,
  isModKey,
  joinArchivePath,
  mergeArchiveItems,
  mergePrefs,
  parentDirectory,
  readArchiveDragPayload,
  resolveDetailRevision,
  resolveClosestStandardResolutionLabel,
  resolveRangeSelection,
  resolveTheme,
  toArchivePreferences,
  type ArchiveBrowserItem,
  type ArchiveDragPayload,
  type ArchiveSortMode,
  type ContextMenuState,
  type EntryPageCache,
  type FolderTreeNode,
  type SortColumn,
  type SortDirection
} from "../archive/archiveModel";

// ─── EntryThumbnail ────────────────────────────────────
export function EntryThumbnail({
  entry,
  resolveThumbnail
}: {
  entry: ArchiveEntryListItem;
  resolveThumbnail: (entryId: string) => Promise<PreviewDescriptor | null>;
}) {
  const [thumb, setThumb] = useState<PreviewDescriptor | null>(null);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setThumb(null);
    setResolved(false);
    if (entry.entryType !== "file" || !entry.previewable || !entry.latestRevisionId) return () => { cancelled = true; };
    void resolveThumbnail(entry.id)
      .then(d => {
        if (!cancelled) {
          setThumb(d);
          setResolved(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setThumb(null);
          setResolved(true);
        }
      });
    return () => { cancelled = true; };
  }, [entry.id, entry.latestRevisionId, entry.optimizationState, entry.previewable, entry.size, resolveThumbnail]);

  if (thumb) return <span className="entry-thumbnail"><img className="entry-thumbnail-media" src={thumb.path} alt="" /></span>;
  return <span className="entry-thumbnail">{entry.previewable && !resolved ? "…" : entry.fileKind.slice(0, 3).toUpperCase()}</span>;
}

// ─── ProgressBar ───────────────────────────────────────
export function ProgressBar({ progress }: { progress: ArchiveProgress | null }) {
  if (!progress?.active) return null;
  const ratio = progress.totalFiles && progress.totalFiles > 0 ? progress.completedFiles / progress.totalFiles : 0;
  const label = progress.totalFiles
    ? `${progress.completedFiles}/${progress.totalFiles}`
    : `${progress.completedFiles} done`;
  return (
    <div className="topbar-progress">
      <div className="topbar-progress-track">
        <div className="topbar-progress-fill" style={{ width: progress.totalFiles ? `${Math.round(ratio * 100)}%` : undefined }} />
      </div>
      <span className="topbar-progress-label">
        {progress.phase === "preparing" ? "Preparing" : "Processing"} · {label}
      </span>
    </div>
  );
}

// ─── InstallBanner ─────────────────────────────────────
export function InstallBanner({ installStatus }: { installStatus: InstallStatus }) {
  const ratio = installStatus.totalSteps > 0 ? installStatus.completedSteps / installStatus.totalSteps : 0;
  return (
    <div className="install-banner" role="status" aria-live="polite">
      <div className="install-card">
        <div className="install-kicker">Local Tooling</div>
        <h2>{installStatus.message}</h2>
        <div className="progress-track"><div className="progress-fill" style={{ width: `${Math.round(ratio * 100)}%` }} /></div>
        <div className="install-meta">
          <span>{installStatus.currentTarget ?? "Preparing runtime"}</span>
          <span>{installStatus.completedSteps}/{installStatus.totalSteps}</span>
        </div>
      </div>
    </div>
  );
}

const AUTO_INSTALLABLE_TOOL_KEYS = ["zstd", "cjxl", "lzma2Offline"] as const;

function hasMissingInstallableTools(capabilities: AppShellState["capabilities"]) {
  return AUTO_INSTALLABLE_TOOL_KEYS.some((key) => !capabilities[key]?.available);
}

// ─── ContextMenuComponent ──────────────────────────────
export function ContextMenuComponent({
  menu, items, folders, onClose, onOpen, onRename, onExportOriginal, onExportOptimized, onDelete,
  onNewFolder, onAddFiles, onMoveToFolder, isBusy
}: {
  menu: ContextMenuState;
  items: ArchiveEntryListItem[];
  folders: string[];
  onClose: () => void;
  onOpen: () => void;
  onRename: () => void;
  onExportOriginal: () => void;
  onExportOptimized: () => void;
  onDelete: () => void;
  onNewFolder: () => void;
  onAddFiles: () => void;
  onMoveToFolder: (folder: string) => void;
  isBusy: boolean;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const el = menuRef.current;
    if (rect.right > window.innerWidth) el.style.left = `${menu.x - rect.width}px`;
    if (rect.bottom > window.innerHeight) el.style.top = `${menu.y - rect.height}px`;
  }, [menu.x, menu.y]);

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose(); };
    const keyHandler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", keyHandler);
    return () => { document.removeEventListener("mousedown", handler); document.removeEventListener("keydown", keyHandler); };
  }, [onClose]);

  const hasSelection = menu.entryIds.length > 0;
  const single = menu.entryIds.length === 1;
  const [showMoveSub, setShowMoveSub] = useState(false);
  const singleFolder = single && items[0]?.entryType === "folder";
  const allFiles = hasSelection && items.every((item) => item.entryType === "file");

  return createPortal(
    <div ref={menuRef} className="context-menu" style={{ top: menu.y, left: menu.x }}>
      {menu.emptySpace ? (
        <>
          <button type="button" className="context-menu-item" disabled={isBusy} onClick={() => { onNewFolder(); onClose(); }}>
            New folder <span className="context-menu-shortcut" />
          </button>
          <button type="button" className="context-menu-item" disabled={isBusy} onClick={() => { onAddFiles(); onClose(); }}>
            Add files…
          </button>
        </>
      ) : (
        <>
          {single && (
            <button type="button" className="context-menu-item" disabled={isBusy} onClick={() => { onOpen(); onClose(); }}>
              {singleFolder ? "Open folder" : "Open"} <span className="context-menu-shortcut">↵</span>
            </button>
          )}
          {single && (
            <button type="button" className="context-menu-item" disabled={isBusy} onClick={() => { onRename(); onClose(); }}>
              {singleFolder ? "Rename folder" : "Rename"} <span className="context-menu-shortcut">F2</span>
            </button>
          )}
          {allFiles && folders.length > 0 && (
            <div style={{ position: "relative" }}
              onMouseEnter={() => setShowMoveSub(true)}
              onMouseLeave={() => setShowMoveSub(false)}
            >
              <button type="button" className="context-menu-item" disabled={isBusy}>
                Move to… <span className="context-menu-shortcut">▶</span>
              </button>
              {showMoveSub && (
                <div className="context-menu" style={{ position: "absolute", left: "100%", top: 0, minWidth: 180 }}>
                  <button type="button" className="context-menu-item" disabled={isBusy} onClick={() => { onMoveToFolder(""); onClose(); }}>
                    Archive root
                  </button>
                  {folders.map(f => (
                    <button key={f} type="button" className="context-menu-item" disabled={isBusy} onClick={() => { onMoveToFolder(f); onClose(); }}>
                      {f}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {allFiles && (
            <>
              <div className="context-menu-separator" />
              <button type="button" className="context-menu-item" disabled={isBusy} onClick={() => { onExportOriginal(); onClose(); }}>
                Export stored
              </button>
              <button type="button" className="context-menu-item" disabled={isBusy} onClick={() => { onExportOptimized(); onClose(); }}>
                Export optimized
              </button>
              <div className="context-menu-separator" />
            </>
          )}
          <button type="button" className="context-menu-item context-menu-item-danger" disabled={isBusy} onClick={() => { onDelete(); onClose(); }}>
            Delete <span className="context-menu-shortcut">{IS_MAC ? "⌫" : "Del"}</span>
          </button>
        </>
      )}
    </div>,
    document.body
  );
}

// ─── TreeSidebarNode ───────────────────────────────────
export function TreeSidebarNode({
  node, depth, currentDirectory, expanded, dropTarget,
  onNavigate, onToggle, onDragOver, onDragLeave, onDrop
}: {
  node: FolderTreeNode;
  depth: number;
  currentDirectory: string;
  expanded: ReadonlySet<string>;
  dropTarget: string | null;
  onNavigate: (path: string) => void;
  onToggle: (path: string) => void;
  onDragOver: (path: string, e: React.DragEvent) => void;
  onDragLeave: (path: string) => void;
  onDrop: (path: string, e: React.DragEvent) => void;
}) {
  const isOpen = expanded.has(node.path);
  const isActive = currentDirectory === node.path;
  const isDrop = dropTarget === node.path;

  return (
    <>
      <button
        type="button"
        className={`tree-node${isActive ? " tree-node-active" : ""}${isDrop ? " tree-node-drop-target" : ""}`}
        style={{ paddingLeft: 12 + depth * 14 }}
        onClick={() => onNavigate(node.path)}
        onDragOver={(e) => onDragOver(node.path, e)}
        onDragLeave={() => onDragLeave(node.path)}
        onDrop={(e) => onDrop(node.path, e)}
      >
        {node.children.length > 0 && (
          <span
            className={`tree-node-chevron${isOpen ? " tree-node-chevron-open" : ""}`}
            role="button"
            tabIndex={-1}
            onClick={(e) => { e.stopPropagation(); onToggle(node.path); }}
          >▶</span>
        )}
        {node.children.length === 0 && <span className="tree-node-chevron" />}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{node.name}</span>
      </button>
      {isOpen && node.children.map(child => (
        <TreeSidebarNode
          key={child.path}
          node={child}
          depth={depth + 1}
          currentDirectory={currentDirectory}
          expanded={expanded}
          dropTarget={dropTarget}
          onNavigate={onNavigate}
          onToggle={onToggle}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        />
      ))}
    </>
  );
}

// ─── TreeSidebar ───────────────────────────────────────
export function TreeSidebar({
  archiveName, folders, currentDirectory, stats, isBusy,
  onNavigate, onDropPaths, onMoveEntries
}: {
  archiveName: string;
  folders: string[];
  currentDirectory: string;
  stats: ArchiveStats | null;
  isBusy: boolean;
  onNavigate: (path: string) => void;
  onDropPaths: (paths: string[], dest: string) => void;
  onMoveEntries: (payload: ArchiveDragPayload, dest: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const tree = useMemo(() => buildFolderTree(folders), [folders]);

  function handleToggle(path: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }

  function handleDragOver(path: string, e: React.DragEvent) {
    e.preventDefault();
    setDropTarget(path);
    e.dataTransfer.dropEffect = isArchiveEntryDrag(e.dataTransfer) ? "move" : "copy";
  }

  function handleDrop(path: string, e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    const payload = readArchiveDragPayload(e.dataTransfer);
    if (payload && (payload.entryIds.length > 0 || payload.folderPaths.length > 0)) {
      onMoveEntries(payload, path);
      return;
    }
    const paths = collectDroppedPaths(e.dataTransfer);
    if (paths.length) onDropPaths(paths, path);
  }

  return (
    <div className="tree-sidebar">
      <div className="tree-section-label">Archive</div>
      <button
        type="button"
        className={`tree-node${currentDirectory === "" ? " tree-node-active" : ""}`}
        style={{ paddingLeft: 12 }}
        onClick={() => onNavigate("")}
        onDragOver={(e) => { e.preventDefault(); setDropTarget("__root__"); e.dataTransfer.dropEffect = "move"; }}
        onDragLeave={() => setDropTarget(null)}
        onDrop={(e) => handleDrop("", e)}
      >
        <span className="tree-node-chevron" />
        <span>{archiveName}</span>
      </button>
      {tree.map(node => (
        <TreeSidebarNode
          key={node.path}
          node={node}
          depth={1}
          currentDirectory={currentDirectory}
          expanded={expanded}
          dropTarget={dropTarget}
          onNavigate={onNavigate}
          onToggle={handleToggle}
          onDragOver={handleDragOver}
          onDragLeave={() => setDropTarget(null)}
          onDrop={handleDrop}
        />
      ))}
      {stats && (
        <div className="tree-stats">
          <span>{stats.entryCount.toLocaleString()} files</span>
          <span>{formatBytes(stats.storedBytes)} stored</span>
        </div>
      )}
    </div>
  );
}

// ─── ColumnHeader ──────────────────────────────────────
export function ColumnHeader({
  sortColumn, sortDirection, onSort
}: {
  sortColumn: SortColumn;
  sortDirection: SortDirection;
  onSort: (col: SortColumn) => void;
}) {
  function sortIndicator(col: SortColumn) {
    if (sortColumn !== col) return null;
    return <span className="col-sort-indicator">{sortDirection === "asc" ? "↑" : "↓"}</span>;
  }
  return (
    <div className="col-header">
      <div />
      <div className={`col-header-cell${sortColumn === "name" ? " col-header-cell-active" : ""}`} onClick={() => onSort("name")}>
        Name {sortIndicator("name")}
      </div>
      <div className={`col-header-cell${sortColumn === "type" ? " col-header-cell-active" : ""}`} onClick={() => onSort("type")}>
        Kind {sortIndicator("type")}
      </div>
      <div className={`col-header-cell${sortColumn === "size" ? " col-header-cell-active" : ""}`} onClick={() => onSort("size")}>
        Size {sortIndicator("size")}
      </div>
    </div>
  );
}

// ─── FileList ──────────────────────────────────────────
export function FileList({
  entries, total, loadedCount, currentDirectory, selectedIds, focusedId,
  renamingEntryId, renameDraft, renameInputRef,
  emptyState, unlockPassword, unlockDisabled, isBusy,
  onUnlockPasswordChange, onUnlock, onClickEntry, onToggleEntrySelection, onDoubleClickEntry, onContextMenu,
  onDragStart, onDropPaths, onMoveEntries, onNeedMore,
  onRenameChange, onRenameSubmit, onRenameCancel, resolveThumbnail,
  sortColumn, sortDirection, onSort
}: {
  entries: Array<ArchiveEntryListItem | undefined>;
  total: number;
  loadedCount: number;
  currentDirectory: string;
  selectedIds: ReadonlySet<string>;
  focusedId: string | null;
  renamingEntryId: string | null;
  renameDraft: string;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  emptyState: "empty" | "locked" | "no-archive";
  unlockPassword: string;
  unlockDisabled: boolean;
  isBusy: boolean;
  onUnlockPasswordChange: (v: string) => void;
  onUnlock: () => void;
  onClickEntry: (entry: ArchiveEntryListItem, e: React.MouseEvent) => void;
  onToggleEntrySelection: (entry: ArchiveEntryListItem) => void;
  onDoubleClickEntry: (entry: ArchiveEntryListItem) => void;
  onContextMenu: (entry: ArchiveEntryListItem | null, e: React.MouseEvent) => void;
  onDragStart: (entry: ArchiveEntryListItem, e: React.DragEvent) => void;
  onDropPaths: (paths: string[], dest: string) => void;
  onMoveEntries: (payload: ArchiveDragPayload, dest: string) => void;
  onNeedMore: () => void;
  onRenameChange: (v: string) => void;
  onRenameSubmit: () => void;
  onRenameCancel: () => void;
  resolveThumbnail: (entryId: string) => Promise<PreviewDescriptor | null>;
  sortColumn: SortColumn;
  sortDirection: SortDirection;
  onSort: (col: SortColumn) => void;
}) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const virtualizer = useVirtualizer({
    count: total || entries.length || 0,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12
  });

  const virtualItems = virtualizer.getVirtualItems();

  useEffect(() => {
    const last = virtualItems[virtualItems.length - 1];
    if (!last) return;
    if (last.index >= loadedCount - 20 && loadedCount < total) onNeedMore();
  }, [loadedCount, onNeedMore, total, virtualItems]);

  if (!total && !entries.length) {
    const copy =
      emptyState === "locked" ? { title: "Archive is locked.", msg: "Enter the password to view contents." }
      : emptyState === "no-archive" ? { title: "No archive open.", msg: "Open or create an archive to get started." }
      : { title: currentDirectory ? "Empty folder." : "No files yet.", msg: currentDirectory ? "Drop files here or use Add files." : "Use Add files or drop files anywhere." };
    return (
      <div className="empty-state">
        <strong>{copy.title}</strong>
        <span>{copy.msg}</span>
        {emptyState === "locked" && (
          <form onSubmit={(e) => { e.preventDefault(); if (!unlockDisabled) onUnlock(); }}>
            <input type="password" value={unlockPassword} placeholder="Archive password" autoComplete="current-password" onChange={e => onUnlockPasswordChange(e.target.value)} />
            <button type="submit" disabled={unlockDisabled}>Unlock</button>
          </form>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      <ColumnHeader sortColumn={sortColumn} sortDirection={sortDirection} onSort={onSort} />
      <div
        ref={parentRef}
        className="file-list-wrap"
        onContextMenu={(e) => { if (e.target === e.currentTarget) onContextMenu(null, e); }}
      >
        <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
          {virtualItems.map(vrow => {
            const entry = entries[vrow.index];
            if (!entry) {
              return (
                <div key={vrow.key} className="file-row file-row-loading" style={{ transform: `translateY(${vrow.start}px)` }}>
                  <div /><div>Loading…</div>
                </div>
              );
            }
            const isFolder = entry.entryType === "folder";
            const isSelected = selectedIds.has(entry.id);
            const isFocused = focusedId === entry.id;
            const isRenaming = renamingEntryId === entry.id;

            const sizeLabel = isFolder
              ? (entry.childCount !== null ? `${entry.childCount} item${entry.childCount === 1 ? "" : "s"}` : "—")
              : entry.size !== null ? formatBytes(entry.size) : "—";

            return (
              <div
                key={entry.id}
                className={`file-row${isSelected ? " file-row-selected" : ""}${isFocused ? " file-row-focused" : ""}${dropTarget === entry.relativePath ? " file-row-drop-target" : ""}${isRenaming ? " file-row-rename-active" : ""}`}
                style={{ transform: `translateY(${vrow.start}px)` }}
                draggable={!isBusy && !isRenaming}
                onClick={e => onClickEntry(entry, e)}
                onDoubleClick={() => onDoubleClickEntry(entry)}
                onContextMenu={e => onContextMenu(entry, e)}
                onDragStart={e => onDragStart(entry, e)}
                onDragEnd={() => setDropTarget(null)}
                onDragOver={e => {
                  if (!isFolder) return;
                  e.preventDefault();
                  setDropTarget(entry.relativePath);
                  e.dataTransfer.dropEffect = isArchiveEntryDrag(e.dataTransfer) ? "move" : "copy";
                }}
                onDragLeave={() => { if (dropTarget === entry.relativePath) setDropTarget(null); }}
                onDrop={e => {
                  if (!isFolder) return;
                  e.preventDefault(); e.stopPropagation();
                  setDropTarget(null);
                  const payload = readArchiveDragPayload(e.dataTransfer);
                  if (payload && (payload.entryIds.length > 0 || payload.folderPaths.length > 0)) {
                    onMoveEntries(payload, entry.relativePath);
                    return;
                  }
                  const paths = collectDroppedPaths(e.dataTransfer);
                  if (paths.length) onDropPaths(paths, entry.relativePath);
                }}
              >
                <div className="file-check">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    readOnly
                    onClick={e => { e.stopPropagation(); onToggleEntrySelection(entry); }}
                  />
                </div>
                <div className={`file-cell file-cell-name${isFolder ? " file-cell-name-folder" : ""}`}>
                  {!isFolder && <EntryThumbnail entry={entry} resolveThumbnail={resolveThumbnail} />}
                  {isRenaming ? (
                    <input
                      ref={renameInputRef}
                      className="inline-rename-input"
                      value={renameDraft}
                      aria-label="Rename"
                      onChange={e => onRenameChange(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === "Enter") { e.preventDefault(); onRenameSubmit(); }
                        if (e.key === "Escape") { e.preventDefault(); onRenameCancel(); }
                      }}
                      onBlur={() => { void onRenameSubmit(); }}
                      onClick={e => e.stopPropagation()}
                    />
                  ) : (
                    <span className={`file-cell-name-text${isFolder ? " file-cell-folder" : ""}`}>{entry.name}</span>
                  )}
                  {!isFolder && entry.overrideMode && !isRenaming && (
                    <span className="override-badge">
                      {entry.overrideMode === "lossless"
                        ? "L"
                        : entry.overrideMode === "visually_lossless"
                          ? "V"
                          : entry.overrideMode === "lossy_balanced"
                            ? "B"
                            : "A"}
                    </span>
                  )}
                </div>
                <div className="file-cell file-cell-muted">{isFolder ? "folder" : entry.fileKind}</div>
                <div
                  className="file-cell file-cell-muted"
                  title={!isFolder && entry.sourceSize !== entry.size ? `Source: ${formatBytes(entry.sourceSize ?? 0)}` : undefined}
                >
                  {sizeLabel}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── DetailPanel ───────────────────────────────────────
export function DetailPanel({
  selectedIds, entries, selectedEntry, preview, detailRevision,
  overrideMode, canReprocessLossless, isBusy, onClose,
  onOpen, onExportOriginal, onExportOptimized, onReprocess, onDelete,
  onOverrideModeChange, onBulkDelete, onBulkExport
}: {
  selectedIds: ReadonlySet<string>;
  entries: Array<ArchiveEntryListItem | undefined>;
  selectedEntry: ArchiveEntryDetail | null;
  preview: PreviewDescriptor | null;
  detailRevision: ArchiveEntryDetail["revisions"][number] | null;
  overrideMode: "lossless" | "visually_lossless" | "lossy_balanced" | "lossy_aggressive";
  canReprocessLossless: boolean;
  isBusy: boolean;
  onClose: () => void;
  onOpen: () => void;
  onExportOriginal: () => void;
  onExportOptimized: () => void;
  onReprocess: () => void;
  onDelete: () => void;
  onOverrideModeChange: (v: "lossless" | "visually_lossless" | "lossy_balanced" | "lossy_aggressive") => void;
  onBulkDelete: () => void;
  onBulkExport: (variant: "original" | "optimized") => void;
}) {
  const count = selectedIds.size;
  const multiSelect = count > 1;

  const totalSize = useMemo(() => {
    if (!multiSelect) return null;
    return getSelectedSizeTotal(entries, selectedIds);
  }, [entries, multiSelect, selectedIds]);
  const closestStandardResolution = selectedEntry && detailRevision
    ? resolveClosestStandardResolutionLabel(detailRevision.media.width, detailRevision.media.height)
    : null;

  return (
    <div className="detail-panel">
      <div className="detail-panel-header">
        <h2>Inspector</h2>
        <button type="button" style={{ border: 0, background: "transparent", fontSize: 14, color: "var(--text-secondary)", padding: "0 4px" }} onClick={onClose} title="Close inspector">✕</button>
      </div>

      {(count === 0 || (count === 1 && !selectedEntry)) && (
        <div className="detail-panel-empty">Select a file to inspect it</div>
      )}

      {multiSelect && (
        <div className="detail-panel-body">
          <div className="detail-bulk-summary">
            <strong>{count} items selected</strong>
            {totalSize !== null && <span className="muted">{formatBytes(totalSize)} stored total</span>}
          </div>
          <div className="detail-actions">
            <button type="button" className="detail-action detail-action-neutral" disabled={isBusy || !(selectedEntry?.exportableVariants.original ?? false)} onClick={() => onBulkExport("original")}>Export original</button>
            <button type="button" className="detail-action detail-action-neutral" disabled={isBusy} onClick={() => onBulkExport("optimized")}>Export optimized</button>
          </div>
          <div className="detail-actions">
            <button type="button" className="detail-action detail-action-danger" disabled={isBusy} onClick={onBulkDelete}>Delete {count} items</button>
          </div>
        </div>
      )}

      {count === 1 && selectedEntry && detailRevision && (
        <div className="detail-panel-body">
          {preview && <img className="detail-preview" src={preview.path} alt={selectedEntry.name} />}
          <div className="detail-meta">
            <div className="detail-meta-row">
              <span className="detail-meta-label">Name</span>
              <span className="detail-meta-value" title={selectedEntry.name}>{selectedEntry.name}</span>
            </div>
            <div className="detail-meta-row">
              <span className="detail-meta-label">Kind</span>
              <span className="detail-meta-value">{selectedEntry.fileKind}</span>
            </div>
            <div className="detail-meta-row">
              <span className="detail-meta-label">Stored size</span>
              <span className="detail-meta-value">{formatBytes(selectedEntry.size)}</span>
            </div>
            {selectedEntry.sourceSize !== selectedEntry.size && (
              <div className="detail-meta-row">
                <span className="detail-meta-label">Source size</span>
                <span className="detail-meta-value">{formatBytes(selectedEntry.sourceSize)}</span>
              </div>
            )}
            <div className="detail-meta-row">
              <span className="detail-meta-label">Modified</span>
              <span className="detail-meta-value">{formatDateTime(detailRevision.addedAt)}</span>
            </div>
            {detailRevision.media.width && (
              <div className="detail-meta-row">
                <span className="detail-meta-label">Dimensions</span>
                <span className="detail-meta-value">{detailRevision.media.width}×{detailRevision.media.height}</span>
              </div>
            )}
            {closestStandardResolution && (
              <div className="detail-meta-row">
                <span className="detail-meta-label">Closest standard</span>
                <span className="detail-meta-value" title="Based on total pixels">{closestStandardResolution}</span>
              </div>
            )}
            <div className="detail-meta-row">
              <span className="detail-meta-label">Tier</span>
              <span className="detail-meta-value">{detailRevision.optimizationTier ?? detailRevision.overrideMode ?? "default"}</span>
            </div>
            <div className="detail-meta-row">
              <span className="detail-meta-label">Optimization</span>
              <span className="detail-meta-value">{detailRevision.optimizationState ?? "pending_optimization"}</span>
            </div>
            <div className="detail-meta-row">
              <span className="detail-meta-label">Source</span>
              <span className="detail-meta-value">{detailRevision.sourceArtifact ? "retained" : "dropped"}</span>
            </div>
            {detailRevision.optimizationDecision?.selectedCandidateId && (
              <div className="detail-meta-row">
                <span className="detail-meta-label">Selected</span>
                <span className="detail-meta-value">{detailRevision.optimizationDecision.selectedCandidateId}</span>
              </div>
            )}
            {detailRevision.summary && (
              <div className="detail-meta-row">
                <span className="detail-meta-label">Summary</span>
                <span className="detail-meta-value" title={detailRevision.summary}>{detailRevision.summary}</span>
              </div>
            )}
          </div>
          <div className="detail-actions detail-actions-primary">
            <button type="button" className="detail-action detail-action-accent" disabled={isBusy} onClick={onOpen}>Open</button>
            <button type="button" className="detail-action detail-action-neutral" disabled={isBusy || !selectedEntry.exportableVariants.original} onClick={onExportOriginal}>Export original</button>
            <button type="button" className="detail-action detail-action-neutral" disabled={isBusy || !selectedEntry.exportableVariants.optimized} onClick={onExportOptimized}>Export optimized</button>
          </div>
          <div className="detail-actions">
            <select disabled={isBusy} value={overrideMode} onChange={e => onOverrideModeChange(e.target.value as "lossless" | "visually_lossless" | "lossy_balanced" | "lossy_aggressive")} style={{ flex: 1 }}>
              <option value="visually_lossless">visually lossless</option>
              {canReprocessLossless && <option value="lossless">lossless</option>}
              <option value="lossy_balanced">lossy balanced</option>
              <option value="lossy_aggressive">lossy aggressive</option>
            </select>
            <button type="button" className="detail-action detail-action-neutral" disabled={isBusy} onClick={onReprocess}>Reprocess</button>
          </div>
          <div className="detail-actions">
            <button type="button" className="detail-action detail-action-danger" disabled={isBusy} onClick={onDelete}>Delete file</button>
          </div>
          {detailRevision.actions.length > 0 && (
            <ul className="detail-revision-list" style={{ margin: 0, paddingLeft: 14 }}>
              {detailRevision.actions.map(a => <li key={a}>{a}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ─── SettingsDialog ────────────────────────────────────
export function SettingsDialog({
  open, value, draftPrefs, isBusy, capabilities, installStatus,
  onClose, onChange, onChangePrefs, onReset, onInstallMissingTools
}: {
  open: boolean;
  value: Settings;
  draftPrefs: ArchivePreferences;
  isBusy: boolean;
  capabilities: AppShellState["capabilities"];
  installStatus: InstallStatus;
  onClose: () => void;
  onChange: (s: Settings) => void;
  onChangePrefs: (p: ArchivePreferences) => void;
  onReset: () => void;
  onInstallMissingTools: () => void;
}) {
  if (!open) return null;
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => onChange({ ...value, [k]: v });
  const setP = <K extends keyof ArchivePreferences>(k: K, v: ArchivePreferences[K]) => onChangePrefs({ ...draftPrefs, [k]: v });
  const showInstallMissingTools = installStatus.active || hasMissingInstallableTools(capabilities);

  return createPortal(
    <div className="dialog-overlay" role="presentation" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={e => e.stopPropagation()}>
        <div className="dialog-header">
          <h2 id="settings-title">Settings</h2>
        </div>
        <div className="dialog-body">
          <div className="settings-section">
            <div className="settings-section-title">General</div>
            <div className="settings-grid">
              <div className="setting-field">
                <label className="setting-label" htmlFor="archive-root">Archive location</label>
                <input id="archive-root" disabled={isBusy} value={value.preferredArchiveRoot} onChange={e => set("preferredArchiveRoot", e.target.value)} />
              </div>
              <div className="setting-field">
                <label className="setting-label" htmlFor="theme-preference">Theme</label>
                <select id="theme-preference" disabled={isBusy} value={value.themePreference} onChange={e => set("themePreference", e.target.value as Settings["themePreference"])}>
                  <option value="system">system</option>
                  <option value="light">light</option>
                  <option value="dark">dark</option>
                </select>
              </div>
              <div className="toggle-field">
                <span className="setting-label">Delete originals after import</span>
                <input type="checkbox" className="toggle-switch" checked={value.deleteOriginalFilesAfterSuccessfulUpload} disabled={isBusy}
                  onChange={e => set("deleteOriginalFilesAfterSuccessfulUpload", e.target.checked)} />
              </div>
            </div>
          </div>
          <div className="settings-divider" />
          <div className="settings-section">
            <div className="settings-section-title">Security & Session</div>
            <div className="settings-grid">
              <div className="setting-field">
                <label className="setting-label" htmlFor="argon-profile">Password profile</label>
                <select id="argon-profile" disabled={isBusy} value={value.argonProfile} onChange={e => set("argonProfile", e.target.value as Settings["argonProfile"])}>
                  <option value="constrained">constrained</option>
                  <option value="balanced">balanced</option>
                  <option value="strong">strong</option>
                </select>
                <span className="setting-hint">Applies to new archives.</span>
              </div>
              <div className="setting-field">
                <label className="setting-label" htmlFor="idle-lock">Auto-lock after</label>
                <input id="idle-lock" disabled={isBusy} type="number" min={0} step={1} value={value.sessionIdleMinutes}
                  onChange={e => set("sessionIdleMinutes", Math.max(0, Number(e.target.value || 0)))} />
                <span className="setting-hint">Minutes. Use 0 to disable.</span>
              </div>
              <div className="toggle-field">
                <span className="setting-label">Lock when hidden</span>
                <input type="checkbox" className="toggle-switch" checked={value.sessionLockOnHide} disabled={isBusy}
                  onChange={e => set("sessionLockOnHide", e.target.checked)} />
              </div>
            </div>
          </div>
          <div className="settings-divider" />
          <div className="settings-section">
            <div className="settings-section-title">Archive Defaults</div>
            <div className="settings-grid">
              <div className="setting-field">
                <label className="setting-label">Optimization tier</label>
                <select disabled={isBusy} value={draftPrefs.optimizationTier} onChange={e => setP("optimizationTier", e.target.value as ArchivePreferences["optimizationTier"])}>
                  <option value="lossless">lossless</option>
                  <option value="visually_lossless">visually lossless</option>
                  <option value="lossy_balanced">lossy balanced</option>
                  <option value="lossy_aggressive">lossy aggressive</option>
                </select>
              </div>
              <div className="setting-hint">Compression and metadata policy are now handled automatically by the backend planner.</div>
            </div>
          </div>
          <div className="settings-divider" />
          <details className="settings-tools">
            <summary>Installed tooling</summary>
            <div className="inline" style={{ justifyContent: "space-between", alignItems: "center", margin: "12px 0" }}>
              <span className="muted">
                {installStatus.active
                  ? installStatus.message
                  : showInstallMissingTools
                    ? "Trigger a manual install pass for missing runtime tools."
                    : "All installable runtime tools are available."}
              </span>
              {showInstallMissingTools && (
                <button type="button" disabled={isBusy || installStatus.active} onClick={onInstallMissingTools}>
                  {installStatus.active ? "Installing…" : "Install missing tools"}
                </button>
              )}
            </div>
            <div className="settings-grid">
              {Object.entries(capabilities).map(([key, cap]) => (
                <div key={key} className="capability-row">
                  <strong>{key}</strong>
                  <span className="muted">{cap.available ? cap.value ?? cap.version ?? cap.path ?? "available" : cap.reason ?? "unavailable"}</span>
                </div>
              ))}
            </div>
          </details>
          <details className="settings-tools">
            <summary>Developer settings</summary>
            <div className="settings-grid" style={{ marginTop: 12 }}>
              <div className="toggle-field">
                <span className="setting-label">Activity log panel</span>
                <input
                  type="checkbox"
                  className="toggle-switch"
                  checked={value.developerActivityLogEnabled}
                  disabled={isBusy}
                  onChange={e => set("developerActivityLogEnabled", e.target.checked)}
                />
              </div>
              <div className="setting-hint">
                Shows a persistent terminal-style activity log panel on the right side of the app.
              </div>
            </div>
          </details>
        </div>
        <div className="dialog-footer">
          <button type="button" disabled={isBusy} onClick={onReset}>Reset defaults</button>
          <div className="actions">
            <button type="button" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ─── ArchiveManagerDialog ──────────────────────────────
export function ArchiveManagerDialog({
  open, tab, isBusy,
  openPath, openPassword, selectedArchiveIsUnlocked, canOpen,
  archiveName, archiveDirectory, archivePassword, confirmArchivePassword,
  draftPrefs, passwordsMatch, canCreate,
  onClose, onTabChange,
  onOpenPathChange, onBrowseOpen, onOpenPasswordChange, onOpen,
  onArchiveNameChange, onArchiveDirectoryChange, onBrowseCreate,
  onArchivePasswordChange, onConfirmArchivePasswordChange,
  onDraftPrefsChange, onCreate
}: {
  open: boolean; tab: "open" | "create"; isBusy: boolean;
  openPath: string; openPassword: string; selectedArchiveIsUnlocked: boolean; canOpen: boolean;
  archiveName: string; archiveDirectory: string; archivePassword: string; confirmArchivePassword: string;
  draftPrefs: ArchivePreferences; passwordsMatch: boolean; canCreate: boolean;
  onClose: () => void; onTabChange: (t: "open" | "create") => void;
  onOpenPathChange: (v: string) => void; onBrowseOpen: () => void; onOpenPasswordChange: (v: string) => void; onOpen: () => void;
  onArchiveNameChange: (v: string) => void; onArchiveDirectoryChange: (v: string) => void; onBrowseCreate: () => void;
  onArchivePasswordChange: (v: string) => void; onConfirmArchivePasswordChange: (v: string) => void;
  onDraftPrefsChange: (p: ArchivePreferences) => void; onCreate: () => void;
}) {
  if (!open) return null;
  const setP = <K extends keyof ArchivePreferences>(k: K, v: ArchivePreferences[K]) => onDraftPrefsChange({ ...draftPrefs, [k]: v });

  return createPortal(
    <div className="dialog-overlay" role="presentation" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
        <div className="archive-manager-tabs">
          <button type="button" className={`archive-manager-tab${tab === "open" ? " archive-manager-tab-active" : ""}`} onClick={() => onTabChange("open")}>Open archive</button>
          <button type="button" className={`archive-manager-tab${tab === "create" ? " archive-manager-tab-active" : ""}`} onClick={() => onTabChange("create")}>New archive</button>
        </div>

        {tab === "open" && (
          <div className="dialog-body">
            <form className="archive-form" onSubmit={e => { e.preventDefault(); onOpen(); }}>
              <div className="setting-field">
                <label className="setting-label">Archive path</label>
                <div className="inline">
                  <input disabled={isBusy} value={openPath} onChange={e => onOpenPathChange(e.target.value)} placeholder="/path/to/archive.stow" />
                  <button type="button" disabled={isBusy} onClick={onBrowseOpen}>Browse</button>
                </div>
              </div>
              {!selectedArchiveIsUnlocked && (
                <div className="setting-field">
                  <label className="setting-label">Password</label>
                  <input disabled={isBusy} type="password" value={openPassword} onChange={e => onOpenPasswordChange(e.target.value)} autoComplete="current-password" />
                </div>
              )}
              {selectedArchiveIsUnlocked && <span className="muted">This archive is already open.</span>}
              <div className="actions">
                <button type="submit" className="btn-primary" disabled={!canOpen || selectedArchiveIsUnlocked}>Open</button>
                <button type="button" onClick={onClose}>Cancel</button>
              </div>
            </form>
          </div>
        )}

        {tab === "create" && (
          <div className="dialog-body">
            <form className="archive-form" onSubmit={e => { e.preventDefault(); onCreate(); }}>
              <div className="setting-field">
                <label className="setting-label">Archive name</label>
                <input disabled={isBusy} value={archiveName} onChange={e => onArchiveNameChange(e.target.value)} />
              </div>
              <div className="setting-field">
                <label className="setting-label">Location</label>
                <div className="inline">
                  <input disabled={isBusy} value={archiveDirectory} onChange={e => onArchiveDirectoryChange(e.target.value)} placeholder="Parent directory" />
                  <button type="button" disabled={isBusy} onClick={onBrowseCreate}>Browse</button>
                </div>
              </div>
              <div className="setting-field">
                <label className="setting-label">Password</label>
                <input disabled={isBusy} type="password" value={archivePassword} onChange={e => onArchivePasswordChange(e.target.value)} autoComplete="new-password" />
              </div>
              <div className="setting-field">
                <label className="setting-label">Confirm password</label>
                <input disabled={isBusy} type="password" value={confirmArchivePassword} onChange={e => onConfirmArchivePasswordChange(e.target.value)} autoComplete="new-password" />
              </div>
              {!passwordsMatch && archivePassword.length > 0 && confirmArchivePassword.length > 0 && (
                <div className="warning">Passwords do not match.</div>
              )}
              <div className="settings-section">
                <div className="settings-section-title">Optimization</div>
                <div className="settings-grid">
                  <div className="setting-field">
                    <label className="setting-label">Optimization tier</label>
                    <select disabled={isBusy} value={draftPrefs.optimizationTier} onChange={e => setP("optimizationTier", e.target.value as ArchivePreferences["optimizationTier"])}>
                      <option value="lossless">lossless</option>
                      <option value="visually_lossless">visually lossless</option>
                      <option value="lossy_balanced">lossy balanced</option>
                      <option value="lossy_aggressive">lossy aggressive</option>
                    </select>
                  </div>
                  <div className="setting-hint">The backend now auto-selects codec and compression policy per file.</div>
                </div>
              </div>
              <div className="actions">
                <button type="submit" className="btn-primary" disabled={!canCreate}>Create</button>
                <button type="button" onClick={onClose}>Cancel</button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

// ─── ArchiveBrowserDialog ──────────────────────────────
export function ArchiveBrowserDialog({
  open, archives, loading, error, sortMode, selectedPath, currentArchivePath, isBusy,
  onClose, onRefresh, onSortModeChange, onSelect, onSwapSelected, onDeleteSelected
}: {
  open: boolean; archives: ArchiveBrowserItem[]; loading: boolean; error: string | null;
  sortMode: ArchiveSortMode; selectedPath: string; currentArchivePath: string | null; isBusy: boolean;
  onClose: () => void; onRefresh: () => void; onSortModeChange: (m: ArchiveSortMode) => void;
  onSelect: (path: string) => void; onSwapSelected: (path?: string) => void;
  onDeleteSelected: (a: ArchiveBrowserItem) => void;
}) {
  if (!open) return null;
  const selected = archives.find(a => a.path === selectedPath) ?? archives[0] ?? null;

  return createPortal(
    <div className="dialog-overlay" role="presentation" onClick={onClose}>
      <div className="dialog dialog-wide" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}
        style={{ maxHeight: "min(90vh, 900px)", gridTemplateRows: "auto auto minmax(0,1fr)" }}>
        <div className="dialog-header">
          <div>
            <h2>All Archives</h2>
            <p className="muted" style={{ margin: "2px 0 0", fontSize: 11 }}>Browse detected archives on this machine.</p>
          </div>
          <div className="actions">
            <button type="button" onClick={onRefresh} disabled={loading}>Refresh</button>
            <button type="button" onClick={onClose}>Close</button>
          </div>
        </div>
        <div style={{ padding: "8px 16px", borderBottom: "1px solid var(--border-subtle)" }}>
          <div className="browser-toolbar">
            <div className="setting-field" style={{ minWidth: 200 }}>
              <label className="setting-label">Sort</label>
              <select value={sortMode} onChange={e => onSortModeChange(e.target.value as ArchiveSortMode)}>
                <option value="recent_desc">Most recent</option>
                <option value="recent_asc">Oldest</option>
                <option value="name_asc">A–Z</option>
                <option value="name_desc">Z–A</option>
                <option value="size_desc">Largest first</option>
                <option value="size_asc">Smallest first</option>
              </select>
            </div>
            <span className="muted" style={{ fontSize: 11 }}>
              {loading ? "Scanning…" : `${archives.length} archive${archives.length === 1 ? "" : "s"}`}
            </span>
          </div>
          {error && <div className="warning">{error}</div>}
        </div>
        <div className="dialog-body" style={{ padding: 16 }}>
          <div className="browser-body" style={{ height: "100%" }}>
            <div className="browser-list">
              {loading && archives.length === 0 ? (
                <div className="empty-state"><strong>Scanning for archives…</strong></div>
              ) : archives.length > 0 ? (
                archives.map(a => {
                  const isSel = selectedPath === a.path;
                  const isCur = currentArchivePath === a.path;
                  return (
                    <button key={a.path} type="button"
                      className={`browser-row${isSel ? " browser-row-selected" : ""}${isCur ? " browser-row-current" : ""}`}
                      onClick={() => onSelect(a.path)}
                      onDoubleClick={() => { if (!isCur) onSwapSelected(a.path); }}>
                      <div className="browser-row-main">
                        <div className="browser-row-title">
                          <strong>{a.name}</strong>
                          {a.source === "recent" && <span className="browser-badge browser-badge-muted">recent</span>}
                        </div>
                        <span>{a.path}</span>
                      </div>
                      <span>{formatDateTime(a.lastModifiedAt)}</span>
                      <span>{formatArchiveSize(a.sizeBytes)}</span>
                    </button>
                  );
                })
              ) : (
                <div className="empty-state"><strong>No archives detected.</strong><span>No .stow archives found.</span></div>
              )}
            </div>
            <div className="browser-detail">
              {selected ? (
                <>
                  <strong>{selected.name}</strong>
                  <span className="muted" style={{ fontSize: 11, wordBreak: "break-all" }}>{selected.path}</span>
                  <div className="detail-meta">
                    <div className="detail-meta-row"><span className="detail-meta-label">Modified</span><span className="detail-meta-value">{formatDateTime(selected.lastModifiedAt)}</span></div>
                    <div className="detail-meta-row"><span className="detail-meta-label">Size</span><span className="detail-meta-value">{formatArchiveSize(selected.sizeBytes)}</span></div>
                  </div>
                  <div className="actions">
                    <button type="button" className="btn-primary" disabled={isBusy || currentArchivePath === selected.path} onClick={() => onSwapSelected()}>
                      {currentArchivePath === selected.path ? "Currently open" : "Open this archive"}
                    </button>
                  </div>
                  <div className="actions">
                    <button type="button" className="btn-danger" disabled={isBusy} onClick={() => onDeleteSelected(selected)}>Delete archive</button>
                  </div>
                </>
              ) : (
                <span className="muted">Select an archive for details.</span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ─── DeleteConfirmationDialog ──────────────────────────
export function DeleteConfirmationDialog({
  open, title, description, detail, isBusy, onCancel, onConfirm
}: {
  open: boolean; title: string; description: string; detail: string; isBusy: boolean;
  onCancel: () => void; onConfirm: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      else if (e.key === "Enter" && !isEditableElement(e.target)) { e.preventDefault(); onConfirm(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onCancel, onConfirm]);

  if (!open) return null;

  return createPortal(
    <div className="dialog-overlay" role="presentation" onClick={onCancel}>
      <div className="dialog delete-dialog" role="alertdialog" aria-modal="true" onClick={e => e.stopPropagation()}>
        <div className="dialog-header">
          <div>
            <h2>{title}</h2>
          </div>
          <div className="actions">
            <button type="button" onClick={onCancel}>Close</button>
            <button type="button" className="btn-danger" disabled={isBusy} onClick={onConfirm}>Delete</button>
          </div>
        </div>
        <div className="dialog-body">
          <div className="delete-card">
            <strong>{description}</strong>
            {detail && <span className="muted">{detail}</span>}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

type ActivityLogTone = "neutral" | "success" | "warning" | "danger" | "info";

function classifyActivityLogLine(message: string): ActivityLogTone {
  const lower = message.toLowerCase();
  if (lower.includes("failed") || lower.includes("error") || lower.includes("corrupt") || lower.includes("unsupported")) {
    return "danger";
  }
  if (lower.includes("warning") || lower.includes("skipped") || lower.includes("unable") || lower.includes("missing")) {
    return "warning";
  }
  if (lower.includes("created") || lower.includes("opened") || lower.includes("exported") || lower.includes("installed") || lower.includes("restored")) {
    return "success";
  }
  if (lower.includes("deleted") || lower.includes("locked") || lower.includes("unlocked") || lower.includes("closed") || lower.includes("recovered")) {
    return "info";
  }
  return "neutral";
}

function splitActivityLogLine(line: string) {
  const match = line.match(/^(\S+)\s+(.*)$/);
  if (!match) {
    return {
      timestamp: "",
      message: line
    };
  }

  return {
    timestamp: match[1],
    message: match[2]
  };
}

// ─── ActivityLogPanel ─────────────────────────────────
export function ActivityLogPanel({ logs }: { logs: string[] }) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [logs]);

  return (
    <aside className="activity-log-panel" aria-label="Developer activity log">
      <div className="activity-log-header">
        <div>
          <div className="activity-log-kicker">Developer</div>
          <h2>Activity log</h2>
        </div>
        <span className="activity-log-count">{logs.length.toLocaleString()} lines</span>
      </div>
      <div ref={bodyRef} className="activity-log-body">
        {logs.length === 0 ? (
          <div className="activity-log-empty">No activity yet.</div>
        ) : logs.map((line, index) => {
          const { timestamp, message } = splitActivityLogLine(line);
          const tone = classifyActivityLogLine(message);
          return (
            <div key={`${index}-${line}`} className={`activity-log-line activity-log-line-${tone}`}>
              <span className="activity-log-time">{timestamp}</span>
              <span className="activity-log-text">{message}</span>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

// ─── Hub ───────────────────────────────────────────────
export function Hub({
  currentArchive,
  archiveUnlocked,
  archives,
  loading,
  error,
  sortMode,
  isBusy,
  onOpenManager,
  onOpenArchivePath,
  onRefreshArchives,
  onSortModeChange,
  onDeleteArchive,
  onReturnToArchive,
  onLockArchive,
  onCloseArchive
}: {
  currentArchive: AppShellState["archive"];
  archiveUnlocked: boolean;
  archives: ArchiveBrowserItem[];
  loading: boolean;
  error: string | null;
  sortMode: ArchiveSortMode;
  isBusy: boolean;
  onOpenManager: (tab: "open" | "create") => void;
  onOpenArchivePath: (path: string) => void;
  onRefreshArchives: () => void;
  onSortModeChange: (mode: ArchiveSortMode) => void;
  onDeleteArchive: (archive: ArchiveBrowserItem) => void;
  onReturnToArchive: () => void;
  onLockArchive: () => void;
  onCloseArchive: () => void;
}) {
  const currentPath = currentArchive?.path ?? null;
  const currentSummary = currentArchive?.summary ?? null;

  return (
    <div className="hub">
      {currentArchive && (
        <div className="hub-session">
          <div className="hub-session-info">
            <strong>{currentSummary?.name ?? currentPath?.split(/[/\\]/).pop() ?? "Archive"}</strong>
            {currentSummary && (
              <span className="hub-session-meta">
                {currentSummary.entryCount.toLocaleString()} files &middot; {formatBytes(currentSummary.storedBytes)}
              </span>
            )}
          </div>
          <div className="actions">
            <button type="button" className="btn-primary" disabled={isBusy} onClick={archiveUnlocked ? onReturnToArchive : () => onOpenArchivePath(currentPath ?? "")}>
              {archiveUnlocked ? "Return" : "Unlock"}
            </button>
            {archiveUnlocked && <button type="button" disabled={isBusy} onClick={onLockArchive}>Lock</button>}
            <button type="button" disabled={isBusy} onClick={onCloseArchive}>Close</button>
          </div>
        </div>
      )}

      <div className="hub-toolbar">
        <div className="hub-toolbar-left">
          <select value={sortMode} onChange={e => onSortModeChange(e.target.value as ArchiveSortMode)}>
            <option value="recent_desc">Most recent</option>
            <option value="recent_asc">Oldest</option>
            <option value="name_asc">A–Z</option>
            <option value="name_desc">Z–A</option>
            <option value="size_desc">Largest</option>
            <option value="size_asc">Smallest</option>
          </select>
          <button type="button" disabled={loading} onClick={onRefreshArchives}>Refresh</button>
        </div>
        <div className="hub-toolbar-right">
          <button type="button" className="btn-primary" disabled={isBusy} onClick={() => onOpenManager("open")}>Open archive</button>
          <button type="button" disabled={isBusy} onClick={() => onOpenManager("create")}>New archive</button>
        </div>
      </div>

      {error && <div className="warning">{error}</div>}

      <div className="hub-col-header">
        <span>Name</span>
        <span>Modified</span>
        <span>Size</span>
        <span />
      </div>

      <div className="hub-list">
        {archives.length > 0 ? archives.map((archive) => {
          const isCurrent = currentPath === archive.path;
          return (
            <button
              type="button"
              key={archive.path}
              className={`hub-row${isCurrent ? " hub-row-current" : ""}`}
              disabled={isBusy}
              onClick={() => onOpenArchivePath(archive.path)}
            >
              <div className="hub-row-name">
                <strong>{archive.name}</strong>
                <span className="hub-row-path">{archive.path}</span>
              </div>
              <span className="hub-row-cell">{formatDateTime(archive.lastModifiedAt)}</span>
              <span className="hub-row-cell">{formatArchiveSize(archive.sizeBytes)}</span>
              <span className="hub-row-actions" onClick={e => e.stopPropagation()}>
                <button type="button" className="btn-danger" disabled={isBusy} onClick={e => { e.stopPropagation(); onDeleteArchive(archive); }}>Delete</button>
              </span>
            </button>
          );
        }) : (
          <div className="hub-empty">
            {loading ? "Scanning for archives…" : "No archives found. Open or create one to get started."}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── App ───────────────────────────────────────────────
