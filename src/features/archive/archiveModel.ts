import type {
  AppShellState,
  ArchiveEntryListItem,
  ArchivePreferences,
  DetectedArchive,
  RecentArchive,
  Settings
} from "../../types";

export type SortColumn = "name" | "type" | "size";
export type SortDirection = "asc" | "desc";
export type ArchiveSortMode = "recent_desc" | "recent_asc" | "name_asc" | "name_desc" | "size_desc" | "size_asc";

export type ContextMenuState = {
  x: number;
  y: number;
  entryIds: string[];
  emptySpace: boolean;
};

export type FolderTreeNode = {
  name: string;
  path: string;
  children: FolderTreeNode[];
};

export type ArchiveBrowserItem = Omit<DetectedArchive, "sizeBytes"> & {
  source: "detected" | "recent";
  sizeBytes: number | null;
};

export type ArchiveDragPayload = {
  entryIds: string[];
  folderPaths: string[];
};

export type EntryPageCache = {
  total: number;
  pages: Map<number, ArchiveEntryListItem[]>;
};

export const LIST_PAGE_SIZE = 100;
export const ROW_HEIGHT = 36;
export const ARCHIVE_ENTRY_DRAG_TYPE = "application/x-stow-entry-id";
export const IS_MAC = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

export const defaultArchivePreferences: ArchivePreferences = {
  compressionBehavior: "balanced",
  optimizationMode: "visually_lossless",
  stripDerivativeMetadata: true
};

export const defaultSettings: Settings = {
  ...defaultArchivePreferences,
  deleteOriginalFilesAfterSuccessfulUpload: false,
  argonProfile: "balanced",
  preferredArchiveRoot: "",
  themePreference: "system",
  sessionIdleMinutes: 0,
  sessionLockOnHide: false
};

export const defaultShellState: AppShellState = {
  settings: defaultSettings,
  hasConfiguredDefaults: false,
  capabilities: {},
  installStatus: {
    active: true,
    phase: "checking",
    message: "Checking local tooling",
    currentTarget: null,
    completedSteps: 0,
    totalSteps: 1,
    installed: [],
    skipped: []
  },
  recentArchives: [],
  archive: null,
  logs: []
};

export function isModKey(e: React.MouseEvent | React.KeyboardEvent | KeyboardEvent | MouseEvent) {
  return IS_MAC ? e.metaKey : e.ctrlKey;
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatDateTime(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleString();
}

export function formatArchiveSize(bytes: number | null) {
  return bytes === null ? "—" : formatBytes(bytes);
}

export function resolveTheme(preference: Settings["themePreference"], prefersDark: boolean) {
  if (preference === "system") {
    return prefersDark ? "dark" : "light";
  }
  return preference;
}

export function baseNameSelectionEnd(value: string) {
  const ext = value.lastIndexOf(".");
  return ext > 0 ? ext : value.length;
}

export function isEditableElement(target: EventTarget | null) {
  return target instanceof HTMLElement &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
}

export function parentDirectory(relativePath: string) {
  const segments = relativePath.split(/[\\/]/);
  segments.pop();
  return segments.join("/");
}

export function joinArchivePath(parent: string, name: string) {
  return parent ? `${parent}/${name}` : name;
}

export function folderEntryId(relativePath: string) {
  return `folder:${relativePath}`;
}

export function archiveBreadcrumbs(relativePath: string) {
  if (!relativePath) return [];
  return relativePath.split(/[\\/]/).filter(Boolean).map((name, index, arr) => ({
    name,
    path: arr.slice(0, index + 1).join("/")
  }));
}

export function collectDroppedPaths(dataTransfer: DataTransfer | null | undefined) {
  const files = dataTransfer?.files;
  if (!files || files.length === 0) return [];
  const paths: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i] as File & { path?: string };
    if (file.path) paths.push(file.path);
  }
  return paths;
}

export function readArchiveDragPayload(dataTransfer: DataTransfer | null | undefined): ArchiveDragPayload | null {
  const raw = dataTransfer?.getData(ARCHIVE_ENTRY_DRAG_TYPE);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return {
      entryIds: Array.isArray(parsed?.entryIds) ? parsed.entryIds.filter((value: unknown): value is string => typeof value === "string") : [],
      folderPaths: Array.isArray(parsed?.folderPaths) ? parsed.folderPaths.filter((value: unknown): value is string => typeof value === "string") : []
    };
  } catch {
    return {
      entryIds: [raw],
      folderPaths: []
    };
  }
}

export function toArchivePreferences(s: Settings): ArchivePreferences {
  return { compressionBehavior: s.compressionBehavior, optimizationMode: s.optimizationMode, stripDerivativeMetadata: s.stripDerivativeMetadata };
}

export function mergePrefs(s: Settings, p: ArchivePreferences): Settings {
  return { ...s, compressionBehavior: p.compressionBehavior, optimizationMode: p.optimizationMode, stripDerivativeMetadata: p.stripDerivativeMetadata };
}

export function buildFolderTree(folders: string[]): FolderTreeNode[] {
  const nodes = new Map<string, FolderTreeNode>();
  const roots: FolderTreeNode[] = [];

  for (const folderPath of [...folders].sort()) {
    const parts = folderPath.replace(/\\/g, "/").split("/");
    const name = parts[parts.length - 1];
    const node: FolderTreeNode = { name, path: folderPath, children: [] };
    nodes.set(folderPath, node);
    const parentPath = parts.slice(0, -1).join("/");
    const parent = parentPath ? nodes.get(parentPath) : null;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

export function compareArchiveItems(a: ArchiveBrowserItem, b: ArchiveBrowserItem, mode: ArchiveSortMode): number {
  switch (mode) {
    case "recent_desc": return new Date(b.lastModifiedAt).getTime() - new Date(a.lastModifiedAt).getTime() || a.name.localeCompare(b.name);
    case "recent_asc": return new Date(a.lastModifiedAt).getTime() - new Date(b.lastModifiedAt).getTime() || a.name.localeCompare(b.name);
    case "name_asc": return a.name.localeCompare(b.name);
    case "name_desc": return b.name.localeCompare(a.name);
    case "size_desc": return (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1) || a.name.localeCompare(b.name);
    case "size_asc": return (a.sizeBytes ?? Infinity) - (b.sizeBytes ?? Infinity) || a.name.localeCompare(b.name);
  }
}

export function mergeArchiveItems(detected: DetectedArchive[], recent: RecentArchive[], current: AppShellState["archive"]): ArchiveBrowserItem[] {
  const merged = new Map<string, ArchiveBrowserItem>();
  for (const a of detected) merged.set(a.path, { ...a, source: "detected" });
  for (const a of recent) {
    if (!merged.has(a.path)) merged.set(a.path, { path: a.path, name: a.name, lastModifiedAt: a.lastOpenedAt, sizeBytes: null, source: "recent" });
  }
  if (current?.path && !merged.has(current.path)) {
    const name = current.summary?.name ?? current.path.split(/[/\\]/).pop() ?? current.path;
    merged.set(current.path, {
      path: current.path,
      name: name.endsWith(".stow") ? name.slice(0, -5) : name,
      lastModifiedAt: current.summary?.updatedAt ?? new Date().toISOString(),
      sizeBytes: current.summary?.storedBytes ?? null,
      source: "recent"
    });
  }
  return Array.from(merged.values());
}

export function createEntryPageCache(total = 0): EntryPageCache {
  return { total, pages: new Map() };
}

export function writeEntryPage(cache: EntryPageCache, offset: number, total: number, items: ArchiveEntryListItem[]) {
  const pages = new Map(cache.pages);
  pages.set(offset, items.slice());
  return { total, pages };
}

export function clearEntryPageCache() {
  return createEntryPageCache();
}

export function getVisibleEntries(cache: EntryPageCache) {
  const entries = Array<ArchiveEntryListItem | undefined>(cache.total).fill(undefined);
  for (const [offset, items] of [...cache.pages.entries()].sort((a, b) => a[0] - b[0])) {
    for (let i = 0; i < items.length; i++) {
      entries[offset + i] = items[i];
    }
  }
  return entries;
}

export function getLoadedEntryCount(cache: EntryPageCache) {
  let count = 0;
  for (const items of cache.pages.values()) {
    count += items.length;
  }
  return count;
}

export function getLoadedOffsets(cache: EntryPageCache) {
  return [...cache.pages.keys()].sort((a, b) => a - b);
}

export function getNextMissingOffset(cache: EntryPageCache, pageSize: number) {
  let next = 0;
  while (next < cache.total && cache.pages.has(next)) {
    next += pageSize;
  }
  return next;
}

export function resolveRangeSelection(entries: Array<ArchiveEntryListItem | undefined>, fromId: string, toId: string) {
  const fromIdx = entries.findIndex((entry) => entry?.id === fromId);
  const toIdx = entries.findIndex((entry) => entry?.id === toId);
  if (fromIdx === -1 || toIdx === -1) return [];
  const start = Math.min(fromIdx, toIdx);
  const end = Math.max(fromIdx, toIdx);
  return entries
    .slice(start, end + 1)
    .filter((entry): entry is ArchiveEntryListItem => entry !== undefined && entry.entryType === "file")
    .map((entry) => entry.id);
}

export function getSelectedSizeTotal(entries: Array<ArchiveEntryListItem | undefined>, selectedIds: ReadonlySet<string>) {
  let sum = 0;
  for (const entry of entries) {
    if (entry && selectedIds.has(entry.id) && entry.size !== null) sum += entry.size;
  }
  return sum;
}

export function resolveDetailRevision<T extends { id: string }>(
  selectedEntry: { latestRevisionId: string | null; revisions: T[] } | null
) {
  if (!selectedEntry) return null;
  return selectedEntry.revisions.find((revision) => revision.id === selectedEntry.latestRevisionId) ?? selectedEntry.revisions[0] ?? null;
}
