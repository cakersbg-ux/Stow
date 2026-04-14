import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, MouseEvent, RefObject, SetStateAction } from "react";
import type {
  AppShellState,
  ArchiveEntryDetail,
  ArchiveEntryListItem,
  ArchiveStats,
  PreviewDescriptor
} from "../../types";
import {
  LIST_PAGE_SIZE,
  baseNameSelectionEnd,
  clearEntryPageCache,
  createEntryPageCache,
  folderEntryId,
  getLoadedEntryCount,
  getLoadedOffsets,
  getNextMissingOffset,
  getSelectedSizeTotal,
  getVisibleEntries,
  isModKey,
  joinArchivePath,
  resolveDetailRevision,
  resolveRangeSelection,
  type ArchiveDragPayload,
  type EntryPageCache,
  type SortColumn,
  type SortDirection
} from "./archiveModel";
import { resolveRefreshSelection } from "./archiveSessionModel";
import type { ArchiveEntriesInvalidatedPayload } from "../app/useShellStore";

type RunTask = (label: string, task: () => Promise<AppShellState | void>) => Promise<void>;

type UseArchiveSessionArgs = {
  archiveUnlocked: boolean;
  archiveExists: boolean;
  archiveId: string | null;
  entriesInvalidated: ArchiveEntriesInvalidatedPayload | null;
  isBusy: boolean;
  runTask: RunTask;
  setStatus: Dispatch<SetStateAction<string>>;
};

export type ArchiveSession = {
  currentDirectory: string;
  selectedIds: Set<string>;
  focusedId: string | null;
  lastClickedId: string | null;
  pageCache: EntryPageCache;
  entries: Array<ArchiveEntryListItem | undefined>;
  loadedEntryCount: number;
  loadedOffsets: Set<number>;
  entryTotal: number;
  stats: ArchiveStats | null;
  selectedEntry: ArchiveEntryDetail | null;
  preview: PreviewDescriptor | null;
  renamingEntryId: string | null;
  renameDraft: string;
  renameInputRef: RefObject<HTMLInputElement | null>;
  sortColumn: SortColumn;
  sortDirection: SortDirection;
  singleSelectedId: string | null;
  detailRevision: ArchiveEntryDetail["revisions"][number] | null;
  selectedSizeTotal: number;
  emptyState: "empty" | "locked" | "no-archive";
  clearSelection: () => void;
  navigateToDirectory: (path: string) => void;
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>;
  setFocusedId: Dispatch<SetStateAction<string | null>>;
  setLastClickedId: Dispatch<SetStateAction<string | null>>;
  setRenameDraft: Dispatch<SetStateAction<string>>;
  setRenamingEntryId: Dispatch<SetStateAction<string | null>>;
  handleClickEntry: (entry: ArchiveEntryListItem, e: MouseEvent) => void;
  handleDoubleClickEntry: (entry: ArchiveEntryListItem) => void;
  handleSort: (col: SortColumn) => void;
  beginRename: (entryId?: string | null) => void;
  cancelRename: () => void;
  submitRename: () => Promise<void>;
  refreshEntries: (offset?: number, reset?: boolean) => Promise<void>;
  refreshArchiveData: (nextSelectedId?: string | null) => Promise<void>;
  handleEntriesInvalidated: (payload: ArchiveEntriesInvalidatedPayload) => void;
  handleNeedMore: () => void;
  createFolder: (name: string) => Promise<void>;
  moveArchiveEntries: (payload: ArchiveDragPayload, destinationDirectory: string) => Promise<void>;
  openEntryExternally: (entryId: string) => Promise<void>;
  deleteEntry: (entryId: string) => Promise<void>;
  deleteFolder: (relativePath: string) => Promise<void>;
  deleteEntries: (entryIds: string[]) => Promise<void>;
  moveEntry: (entryId: string, destinationDirectory: string) => Promise<void>;
  moveEntries: (payload: { entryIds: string[]; destinationDirectory: string }) => Promise<void>;
  exportEntry: (entryId: string, variant: "original" | "optimized") => Promise<void>;
  exportEntries: (entryIds: string[], variant: "original" | "optimized") => Promise<void>;
  reprocessEntry: (entryId: string, overrideMode: "lossless" | "visually_lossless") => Promise<void>;
};

function clearSelectionState(setSelectedIds: Dispatch<SetStateAction<Set<string>>>, setFocusedId: Dispatch<SetStateAction<string | null>>, setLastClickedId: Dispatch<SetStateAction<string | null>>) {
  setSelectedIds(new Set());
  setFocusedId(null);
  setLastClickedId(null);
}

export function useArchiveSession({
  archiveUnlocked,
  archiveExists,
  archiveId,
  entriesInvalidated,
  isBusy,
  runTask,
  setStatus
}: UseArchiveSessionArgs): ArchiveSession {
  const [currentDirectory, setCurrentDirectory] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [lastClickedId, setLastClickedId] = useState<string | null>(null);
  const [pageCache, setPageCache] = useState<EntryPageCache>(createEntryPageCache());
  const [stats, setStats] = useState<ArchiveStats | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<ArchiveEntryDetail | null>(null);
  const [preview, setPreview] = useState<PreviewDescriptor | null>(null);
  const [renamingEntryId, setRenamingEntryId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [sortColumn, setSortColumn] = useState<SortColumn>("name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const lastArchiveIdRef = useRef<string | null>(null);
  const hasInitializedRef = useRef(false);
  const skipNextRefreshRef = useRef(false);
  const singleSelectedIdRef = useRef<string | null>(null);

  const entries = useMemo(() => getVisibleEntries(pageCache), [pageCache]);
  const loadedEntryCount = useMemo(() => getLoadedEntryCount(pageCache), [pageCache]);
  const loadedOffsets = useMemo(() => new Set(getLoadedOffsets(pageCache)), [pageCache]);
  const entryTotal = pageCache.total;
  const singleSelectedId = selectedIds.size === 1 ? [...selectedIds][0] : null;
  const detailRevision = useMemo(() => resolveDetailRevision(selectedEntry), [selectedEntry]);
  const selectedSizeTotal = useMemo(() => getSelectedSizeTotal(entries, selectedIds), [entries, selectedIds]);
  const emptyState: "empty" | "locked" | "no-archive" = !archiveExists ? "no-archive" : archiveUnlocked ? "empty" : "locked";

  useEffect(() => {
    singleSelectedIdRef.current = singleSelectedId;
  }, [singleSelectedId]);

  const clearSelection = useCallback(() => {
    clearSelectionState(setSelectedIds, setFocusedId, setLastClickedId);
  }, []);

  const cancelRename = useCallback(() => {
    setRenamingEntryId(null);
    setRenameDraft("");
  }, []);

  const navigateToDirectory = useCallback((path: string) => {
    setCurrentDirectory(path);
    clearSelection();
    cancelRename();
  }, [cancelRename, clearSelection]);

  const refreshEntries = useCallback(async (offset = 0, reset = false) => {
    if (!archiveUnlocked) {
      return;
    }
    if (!reset && loadedOffsets.has(offset)) {
      return;
    }

    let page: { total: number; items: ArchiveEntryListItem[] };
    try {
      page = await window.stow.listEntries({
        directory: currentDirectory,
        offset,
        limit: LIST_PAGE_SIZE,
        sortColumn,
        sortDirection
      });
    } catch (error) {
      if (currentDirectory && error instanceof Error && error.message.includes("Folder not found")) {
        navigateToDirectory("");
        return;
      }
      throw error;
    }

    setPageCache((current) => {
      const base = reset ? clearEntryPageCache() : current;
      return {
        total: page.total,
        pages: new Map(base.pages).set(offset, page.items.slice())
      };
    });
  }, [archiveUnlocked, currentDirectory, loadedOffsets, navigateToDirectory, sortColumn, sortDirection]);

  const refreshArchiveData = useCallback(async (nextSelectedId?: string | null, directoryOverride?: string) => {
    const directory = directoryOverride ?? currentDirectory;
    if (!archiveUnlocked) {
      setPageCache(clearEntryPageCache());
      clearSelection();
      cancelRename();
      setSelectedEntry(null);
      setPreview(null);
      setStats(null);
      navigateToDirectory("");
      return;
    }

    setPageCache(clearEntryPageCache());

    let firstPage: { total: number; items: ArchiveEntryListItem[] };
    let nextStats: ArchiveStats;
    try {
      [firstPage, nextStats] = await Promise.all([
        window.stow.listEntries({
          directory,
          offset: 0,
          limit: LIST_PAGE_SIZE,
          sortColumn,
          sortDirection
        }),
        window.stow.getArchiveStats()
      ]);
    } catch (error) {
      if (directory && error instanceof Error && error.message.includes("Folder not found")) {
        navigateToDirectory("");
        return;
      }
      throw error;
    }

    setStats(nextStats);
    setPageCache({
      total: firstPage.total,
      pages: new Map([[0, firstPage.items.slice()]])
    });

    const selection = resolveRefreshSelection(firstPage.items, nextSelectedId ?? singleSelectedIdRef.current);
    setSelectedIds(selection.selectedIds);
    setFocusedId(selection.focusedId);
    setLastClickedId(selection.lastClickedId);
  }, [archiveUnlocked, cancelRename, currentDirectory, navigateToDirectory, sortColumn, sortDirection]);

  const handleEntriesInvalidated = useCallback((payload: ArchiveEntriesInvalidatedPayload) => {
    if (!archiveUnlocked || payload.archiveId !== archiveId) {
      return;
    }
    void refreshArchiveData(payload.selectedEntryId ?? singleSelectedIdRef.current);
  }, [archiveId, archiveUnlocked, refreshArchiveData]);

  useEffect(() => {
    if (!archiveUnlocked) {
      lastArchiveIdRef.current = archiveId;
      hasInitializedRef.current = false;
      skipNextRefreshRef.current = false;
      setPageCache(clearEntryPageCache());
      clearSelection();
      cancelRename();
      setSelectedEntry(null);
      setPreview(null);
      setStats(null);
      setCurrentDirectory("");
      return;
    }

    if (!hasInitializedRef.current) {
      hasInitializedRef.current = true;
      lastArchiveIdRef.current = archiveId;
      return;
    }

    if (lastArchiveIdRef.current !== archiveId) {
      lastArchiveIdRef.current = archiveId;
      if (currentDirectory !== "") {
        skipNextRefreshRef.current = true;
        setCurrentDirectory("");
      } else {
        skipNextRefreshRef.current = false;
      }
      clearSelection();
      cancelRename();
      void refreshArchiveData(singleSelectedIdRef.current, "");
    }
  }, [archiveId, archiveUnlocked, cancelRename, clearSelection, currentDirectory, refreshArchiveData]);

  useEffect(() => {
    if (!archiveUnlocked) {
      return;
    }
    if (skipNextRefreshRef.current) {
      skipNextRefreshRef.current = false;
      return;
    }
    void refreshArchiveData(singleSelectedIdRef.current);
  }, [archiveUnlocked, currentDirectory, refreshArchiveData, sortColumn, sortDirection]);

  useEffect(() => {
    if (!entriesInvalidated) {
      return;
    }
    handleEntriesInvalidated(entriesInvalidated);
  }, [entriesInvalidated, handleEntriesInvalidated]);

  useEffect(() => {
    if (!archiveUnlocked || !singleSelectedId) {
      setSelectedEntry(null);
      setPreview(null);
      return;
    }
    let cancelled = false;
    void window.stow.getEntryDetail(singleSelectedId).then((detail) => {
      if (!cancelled) {
        setSelectedEntry(detail);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [archiveUnlocked, singleSelectedId]);

  useEffect(() => {
    if (!selectedEntry) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    void window.stow.resolveEntryPreview(selectedEntry.id, "preview").then((descriptor) => {
      if (!cancelled) {
        setPreview(descriptor);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [selectedEntry?.id, selectedEntry?.latestRevisionId]);

  useEffect(() => {
    if (!renamingEntryId || !renameInputRef.current) {
      return;
    }
    const input = renameInputRef.current;
    const frame = window.requestAnimationFrame(() => {
      input.focus();
      const entry = entries.find((item) => item?.id === renamingEntryId);
      input.setSelectionRange(0, baseNameSelectionEnd(renameDraft || entry?.name || ""));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [entries, renameDraft, renamingEntryId]);

  useEffect(() => {
    if (!renamingEntryId) {
      return;
    }
    const renamingEntry = entries.find((entry) => entry?.id === renamingEntryId);
    if (renamingEntry?.entryType === "folder") {
      return;
    }
    if (!selectedIds.has(renamingEntryId)) {
      cancelRename();
    }
  }, [cancelRename, entries, renamingEntryId, selectedIds]);

  const handleClickEntry = useCallback((entry: ArchiveEntryListItem, e: React.MouseEvent) => {
    if (entry.entryType === "folder") {
      navigateToDirectory(entry.relativePath);
      return;
    }
    const id = entry.id;
    if (e.shiftKey && lastClickedId) {
      const rangeIds = resolveRangeSelection(entries, lastClickedId, id);
      if (rangeIds.length > 0) {
        setSelectedIds(new Set(rangeIds));
        setFocusedId(id);
        return;
      }
    }
    if (isModKey(e)) {
      setSelectedIds((previous) => {
        const next = new Set(previous);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return next;
      });
    } else {
      setSelectedIds(new Set([id]));
    }
    setLastClickedId(id);
    setFocusedId(id);
  }, [entries, lastClickedId, navigateToDirectory]);

  const openEntryExternally = useCallback(async (entryId: string) => {
    if (isBusy) return;
    await runTask("Opening file", () => window.stow.openEntryExternally(entryId));
  }, [isBusy, runTask]);

  const handleDoubleClickEntry = useCallback((entry: ArchiveEntryListItem) => {
    if (entry.entryType === "folder") {
      navigateToDirectory(entry.relativePath);
      return;
    }
    void openEntryExternally(entry.id);
  }, [navigateToDirectory, openEntryExternally]);

  const handleSort = useCallback((col: SortColumn) => {
    if (sortColumn === col) {
      setSortDirection((direction) => (direction === "asc" ? "desc" : "asc"));
      return;
    }
    setSortColumn(col);
    setSortDirection("asc");
  }, [sortColumn]);

  const beginRename = useCallback((entryId: string | null = singleSelectedId) => {
    if (!entryId || isBusy) return;
    const entry = entries.find((item) => item?.id === entryId);
    if (!entry) return;
    if (entry.entryType === "file") {
      setSelectedIds(new Set([entryId]));
      setFocusedId(entryId);
    }
    setRenamingEntryId(entryId);
    setRenameDraft(entry.name);
  }, [entries, isBusy, singleSelectedId]);

  const submitRename = useCallback(async () => {
    if (!renamingEntryId || isBusy) return;
    const nextName = renameDraft.trim();
    if (!nextName) {
      setStatus("File name is required");
      return;
    }
    const entry = entries.find((item) => item?.id === renamingEntryId);
    if (entry && nextName === entry.name) {
      cancelRename();
      return;
    }
    await runTask("Renaming", async () => {
      const next = await window.stow.renameEntry(renamingEntryId, nextName);
      cancelRename();
      return next;
    });
  }, [cancelRename, entries, isBusy, renameDraft, renamingEntryId, runTask, setStatus]);

  const createFolder = useCallback(async (name: string) => {
    if (!archiveUnlocked || isBusy) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setStatus("Folder name is required");
      return;
    }
    await runTask("Creating folder", async () => window.stow.createFolder({ relativePath: joinArchivePath(currentDirectory, trimmed) }));
  }, [archiveUnlocked, currentDirectory, isBusy, runTask, setStatus]);

  const moveArchiveEntries = useCallback(async (payload: ArchiveDragPayload, destinationDirectory: string) => {
    if (isBusy) return;
    const entryIds = [
      ...payload.entryIds,
      ...payload.folderPaths.map((path) => folderEntryId(path))
    ];
    if (entryIds.length === 0) return;
    if (entryIds.length === 1) {
      const label = payload.folderPaths.length === 1 ? "Moving folder" : "Moving file";
      await runTask(label, () => window.stow.moveEntry({ entryId: entryIds[0], destinationDirectory }));
      return;
    }
    await runTask("Moving items", () => window.stow.moveEntries({ entryIds, destinationDirectory }));
  }, [isBusy, runTask]);

  const deleteEntry = useCallback(async (entryId: string) => {
    if (isBusy) return;
    await runTask("Deleting file", () => window.stow.deleteEntry(entryId));
  }, [isBusy, runTask]);

  const deleteFolder = useCallback(async (relativePath: string) => {
    if (isBusy) return;
    await runTask("Deleting folder", () => window.stow.deleteFolder(relativePath));
  }, [isBusy, runTask]);

  const deleteEntries = useCallback(async (entryIds: string[]) => {
    if (isBusy) return;
    await runTask("Deleting files", () => window.stow.deleteEntries(entryIds));
  }, [isBusy, runTask]);

  const moveEntry = useCallback(async (entryId: string, destinationDirectory: string) => {
    if (isBusy) return;
    await runTask("Moving file", () => window.stow.moveEntry({ entryId, destinationDirectory }));
  }, [isBusy, runTask]);

  const moveEntries = useCallback(async (payload: { entryIds: string[]; destinationDirectory: string }) => {
    if (isBusy) return;
    await runTask("Moving items", () => window.stow.moveEntries(payload));
  }, [isBusy, runTask]);

  const exportEntry = useCallback(async (entryId: string, variant: "original" | "optimized") => {
    if (isBusy) return;
    const label = variant === "original" ? "Exporting original" : "Exporting optimized";
    await runTask(label, () => window.stow.exportEntry(entryId, variant));
  }, [isBusy, runTask]);

  const exportEntries = useCallback(async (entryIds: string[], variant: "original" | "optimized") => {
    if (isBusy) return;
    await runTask("Exporting files", () => window.stow.exportEntries(entryIds, variant));
  }, [isBusy, runTask]);

  const reprocessEntry = useCallback(async (entryId: string, overrideMode: "lossless" | "visually_lossless") => {
    if (isBusy) return;
    await runTask("Reprocessing", () => window.stow.reprocessEntry(entryId, overrideMode));
  }, [isBusy, runTask]);

  const handleNeedMore = useCallback(() => {
    const next = getNextMissingOffset(pageCache, LIST_PAGE_SIZE);
    if (next < entryTotal) {
      void refreshEntries(next);
    }
  }, [entryTotal, pageCache, refreshEntries]);

  return {
    currentDirectory,
    selectedIds,
    focusedId,
    lastClickedId,
    pageCache,
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
    setRenamingEntryId,
    handleClickEntry,
    handleDoubleClickEntry,
    handleSort,
    beginRename,
    cancelRename,
    submitRename,
    refreshEntries,
    refreshArchiveData,
    handleEntriesInvalidated,
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
  };
}
