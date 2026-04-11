import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import packageJson from "../package.json";
import type {
  AppShellState,
  ArchiveEntryDetail,
  ArchiveEntryListItem,
  ArchiveProgress,
  ArchiveStats,
  DetectedArchive,
  InstallStatus,
  PreviewDescriptor,
  RecentArchive,
  Settings
} from "./types";

const defaultSettings: Settings = {
  compressionBehavior: "balanced",
  optimizationMode: "visually_lossless",
  stripDerivativeMetadata: true,
  deleteOriginalFilesAfterSuccessfulUpload: true,
  argonProfile: "balanced",
  preferredArchiveRoot: "",
  sessionIdleMinutes: 0,
  sessionLockOnHide: false
};

const defaultShellState: AppShellState = {
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

const settingHints = {
  compressionBehavior: "How aggressively to compress stored chunks.",
  optimizationMode: "Choose between lossless and visually lossless derivatives.",
  argonProfile: "Password derivation cost.",
  preferredArchiveRoot: "Default folder for new archives.",
  sessionIdleMinutes: "Idle minutes before automatic locking. Use 0 to disable.",
  sessionLockOnHide: "Lock the archive when the app is hidden.",
  stripDerivativeMetadata: "Remove non-essential metadata from derivatives.",
  deleteOriginalFilesAfterSuccessfulUpload: "Delete source files after a successful ingest."
} as const;

const versionLabel = `Stow v${packageJson.version}`;
const LIST_PAGE_SIZE = 100;
const ROW_HEIGHT = 58;

type ArchiveSortMode = "recent_desc" | "recent_asc" | "name_asc" | "name_desc" | "size_desc" | "size_asc";

type ArchiveBrowserItem = Omit<DetectedArchive, "sizeBytes"> & {
  source: "detected" | "recent";
  sizeBytes: number | null;
};

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "n/a";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "n/a";
  }
  return parsed.toLocaleString();
}

function baseNameSelectionEnd(value: string) {
  const extensionStart = value.lastIndexOf(".");
  return extensionStart > 0 ? extensionStart : value.length;
}

function isEditableElement(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
}

function isActivationKey(key: string) {
  return key === "Enter" || key === "Return";
}

function formatArchiveSize(bytes: number | null) {
  if (bytes === null) {
    return "size unavailable";
  }
  return formatBytes(bytes);
}

function getArchiveSortLabel(sortMode: ArchiveSortMode) {
  switch (sortMode) {
    case "recent_desc":
      return "Most recent";
    case "recent_asc":
      return "Oldest";
    case "name_asc":
      return "Alphabetical A-Z";
    case "name_desc":
      return "Alphabetical Z-A";
    case "size_desc":
      return "Largest first";
    case "size_asc":
      return "Smallest first";
  }
}

function compareStrings(left: string, right: string) {
  return left.localeCompare(right);
}

function compareDates(left: string, right: string) {
  return new Date(left).getTime() - new Date(right).getTime();
}

function compareArchiveItems(left: ArchiveBrowserItem, right: ArchiveBrowserItem, sortMode: ArchiveSortMode) {
  switch (sortMode) {
    case "recent_desc":
      return compareDates(right.lastModifiedAt, left.lastModifiedAt) || compareStrings(left.name, right.name);
    case "recent_asc":
      return compareDates(left.lastModifiedAt, right.lastModifiedAt) || compareStrings(left.name, right.name);
    case "name_asc":
      return compareStrings(left.name, right.name) || compareStrings(left.path, right.path);
    case "name_desc":
      return compareStrings(right.name, left.name) || compareStrings(left.path, right.path);
    case "size_desc":
      return (right.sizeBytes ?? -1) - (left.sizeBytes ?? -1) || compareStrings(left.name, right.name);
    case "size_asc":
      return (left.sizeBytes ?? Number.POSITIVE_INFINITY) - (right.sizeBytes ?? Number.POSITIVE_INFINITY) || compareStrings(left.name, right.name);
  }
}

function mergeArchiveItems(
  detectedArchives: DetectedArchive[],
  recentArchives: RecentArchive[],
  currentArchive: AppShellState["archive"]
): ArchiveBrowserItem[] {
  const merged = new Map<string, ArchiveBrowserItem>();

  for (const archive of detectedArchives) {
    merged.set(archive.path, {
      ...archive,
      source: "detected"
    });
  }

  for (const archive of recentArchives) {
    if (merged.has(archive.path)) {
      continue;
    }

    merged.set(archive.path, {
      path: archive.path,
      name: archive.name,
      lastModifiedAt: archive.lastOpenedAt,
      sizeBytes: null,
      source: "recent"
    });
  }

  if (currentArchive?.path && !merged.has(currentArchive.path)) {
    const baseName = currentArchive.summary?.name ?? currentArchive.path.split(/[/\\]/).pop() ?? currentArchive.path;
    const sizeBytes = currentArchive.summary?.storedBytes ?? currentArchive.summary?.logicalBytes ?? null;
    merged.set(currentArchive.path, {
      path: currentArchive.path,
      name: baseName.endsWith(".stow") ? baseName.slice(0, -5) : baseName,
      lastModifiedAt: currentArchive.summary?.updatedAt ?? new Date().toISOString(),
      sizeBytes,
      source: "recent"
    });
  }

  return Array.from(merged.values());
}

function Tooltip(props: { text: string; children: React.ReactNode; className?: string }) {
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  useLayoutEffect(() => {
    if (!visible || !triggerRef.current) {
      return;
    }

    const rect = triggerRef.current.getBoundingClientRect();
    const tooltipWidth = 260;
    const tooltipHeight = 64;
    const margin = 10;
    const left = Math.min(rect.right + margin, window.innerWidth - tooltipWidth - margin);
    const top = Math.min(rect.top - 4, window.innerHeight - tooltipHeight - margin);

    setPosition({
      top: Math.max(margin, top),
      left: Math.max(margin, left)
    });
  }, [visible]);

  return (
    <span className="tooltip-wrap">
      <span
        ref={triggerRef}
        className={props.className}
        aria-label={props.text}
        role="button"
        tabIndex={0}
        onMouseEnter={() => setVisible(true)}
        onMouseLeave={() => setVisible(false)}
        onFocus={() => setVisible(true)}
        onBlur={() => setVisible(false)}
      >
        {props.children}
      </span>
      {visible
        ? createPortal(
            <span className="hint-tooltip" role="tooltip" style={{ top: `${position.top}px`, left: `${position.left}px` }}>
              {props.text}
            </span>,
            document.body
          )
        : null}
    </span>
  );
}

function Hint(props: { text: string }) {
  return (
    <Tooltip text={props.text} className="hint">
      ?
    </Tooltip>
  );
}

function SettingField(props: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <label className="setting-field">
      <span className="setting-label">
        <span>{props.label}</span>
        <Hint text={props.hint} />
      </span>
      {props.children}
    </label>
  );
}

function ToggleField(props: { label: string; hint: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return (
    <div className="setting-field toggle-field">
      <span className="setting-label">
        <span>{props.label}</span>
        <Hint text={props.hint} />
      </span>
      <input disabled={props.disabled} type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} />
    </div>
  );
}

function SettingsForm(props: {
  value: Settings;
  onChange: (next: Settings) => void;
  disabled: boolean;
}) {
  const { disabled, value, onChange } = props;
  const set = <K extends keyof Settings>(key: K, next: Settings[K]) => onChange({ ...value, [key]: next });

  return (
    <div className="settings-grid">
      <SettingField label="Compression behavior" hint={settingHints.compressionBehavior}>
        <select disabled={disabled} value={value.compressionBehavior} onChange={(event) => set("compressionBehavior", event.target.value as Settings["compressionBehavior"])}>
          <option value="fast">fast</option>
          <option value="balanced">balanced</option>
          <option value="max">max</option>
        </select>
      </SettingField>
      <SettingField label="Optimization mode" hint={settingHints.optimizationMode}>
        <select disabled={disabled} value={value.optimizationMode} onChange={(event) => set("optimizationMode", event.target.value as Settings["optimizationMode"])}>
          <option value="lossless">lossless</option>
          <option value="visually_lossless">visually lossless</option>
          <option value="pick_per_file">pick per file</option>
        </select>
      </SettingField>
      <SettingField label="Password profile" hint={settingHints.argonProfile}>
        <select disabled={disabled} value={value.argonProfile} onChange={(event) => set("argonProfile", event.target.value as Settings["argonProfile"])}>
          <option value="constrained">constrained</option>
          <option value="balanced">balanced</option>
          <option value="strong">strong</option>
        </select>
      </SettingField>
      <SettingField label="Preferred archive root" hint={settingHints.preferredArchiveRoot}>
        <input disabled={disabled} value={value.preferredArchiveRoot} onChange={(event) => set("preferredArchiveRoot", event.target.value)} />
      </SettingField>
      <SettingField label="Idle lock minutes" hint={settingHints.sessionIdleMinutes}>
        <input
          disabled={disabled}
          type="number"
          min={0}
          step={1}
          value={value.sessionIdleMinutes}
          onChange={(event) => set("sessionIdleMinutes", Math.max(0, Number(event.target.value || 0)))}
        />
      </SettingField>
      <ToggleField
        label="Strip derivative metadata"
        hint={settingHints.stripDerivativeMetadata}
        checked={value.stripDerivativeMetadata}
        disabled={disabled}
        onChange={(checked) => set("stripDerivativeMetadata", checked)}
      />
      <ToggleField
        label="Delete originals after upload"
        hint={settingHints.deleteOriginalFilesAfterSuccessfulUpload}
        checked={value.deleteOriginalFilesAfterSuccessfulUpload}
        disabled={disabled}
        onChange={(checked) => set("deleteOriginalFilesAfterSuccessfulUpload", checked)}
      />
      <ToggleField label="Lock on hide" hint={settingHints.sessionLockOnHide} checked={value.sessionLockOnHide} disabled={disabled} onChange={(checked) => set("sessionLockOnHide", checked)} />
    </div>
  );
}

function ArchiveProgressStrip(props: { progress: ArchiveProgress | null }) {
  const progress = props.progress;
  if (!progress?.active) {
    return null;
  }

  const ratio = progress.totalFiles && progress.totalFiles > 0 ? progress.completedFiles / progress.totalFiles : 0;
  return (
    <div className="archive-progress">
      <div className="archive-progress-row">
        <strong>{progress.phase === "preparing" ? "Preparing ingest" : "Processing archive"}</strong>
        <span>{progress.totalFiles ? `${progress.completedFiles}/${progress.totalFiles}` : `${progress.completedFiles} processed`}</span>
      </div>
      <div className="archive-progress-row">
        <span className="archive-progress-label">{progress.currentFile ?? "Waiting for files"}</span>
      </div>
      {progress.totalFiles ? (
        <div className="progress-track progress-track-compact">
          <div className="progress-fill" style={{ width: `${Math.round(ratio * 100)}%` }} />
        </div>
      ) : null}
    </div>
  );
}

function EntryThumbnail(props: { entry: ArchiveEntryListItem }) {
  const [thumbnail, setThumbnail] = useState<PreviewDescriptor | null>(null);

  useEffect(() => {
    let cancelled = false;
    setThumbnail(null);

    if (!props.entry.previewable) {
      return () => {
        cancelled = true;
      };
    }

    void window.stow.resolveEntryPreview(props.entry.id, "thumbnail").then((next) => {
      if (!cancelled) {
        setThumbnail(next);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [props.entry.id, props.entry.latestRevisionId, props.entry.previewable]);

  if (thumbnail) {
    return (
      <span className="entry-thumbnail" aria-hidden="true">
        <img className="entry-thumbnail-media" src={thumbnail.path} alt="" />
      </span>
    );
  }

  return <span className="entry-thumbnail entry-thumbnail-placeholder">{props.entry.previewable ? "..." : "FILE"}</span>;
}

function EmptyEntryState(props: {
  emptyState: "empty" | "locked" | "no-archive";
  unlockPassword: string;
  unlockDisabled: boolean;
  onUnlockPasswordChange: (password: string) => void;
  onUnlock: () => void;
}) {
  const copy =
    props.emptyState === "locked"
      ? {
          title: "This archive is locked.",
          message: "Enter its password to view the contents."
        }
      : props.emptyState === "no-archive"
        ? {
            title: "No archive is open.",
            message: "Open or create an archive to browse its contents."
          }
        : {
            title: "No files in this archive yet.",
            message: "Use Add files or folders to start filling it."
          };

  return (
    <div className="entry-list-empty">
      <strong>{copy.title}</strong>
      <span>{copy.message}</span>
      {props.emptyState === "locked" ? (
        <form
          className="inline"
          onSubmit={(event) => {
            event.preventDefault();
            if (!props.unlockDisabled) {
              props.onUnlock();
            }
          }}
        >
          <input type="password" value={props.unlockPassword} placeholder="Archive password" autoComplete="current-password" onChange={(event) => props.onUnlockPasswordChange(event.target.value)} />
          <button type="submit" disabled={props.unlockDisabled}>
            Unlock
          </button>
        </form>
      ) : null}
    </div>
  );
}

function EntryList(props: {
  entries: Array<ArchiveEntryListItem | undefined>;
  total: number;
  loadedCount: number;
  selectedId: string | null;
  emptyState: "empty" | "locked" | "no-archive";
  unlockPassword: string;
  unlockDisabled: boolean;
  openDisabled: boolean;
  onUnlockPasswordChange: (password: string) => void;
  onUnlock: () => void;
  onSelect: (entryId: string) => void;
  onOpenExternally: (entryId: string) => void;
  onNeedMore: () => void;
}) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: props.total || props.entries.length || 0,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10
  });

  const virtualItems = virtualizer.getVirtualItems();

  useEffect(() => {
    const last = virtualItems[virtualItems.length - 1];
    if (!last) {
      return;
    }

    if (last.index >= props.loadedCount - 20 && props.loadedCount < props.total) {
      props.onNeedMore();
    }
  }, [props.loadedCount, props.onNeedMore, props.total, virtualItems]);

  if (!props.total && !props.entries.length) {
    return (
      <EmptyEntryState
        emptyState={props.emptyState}
        unlockPassword={props.unlockPassword}
        unlockDisabled={props.unlockDisabled}
        onUnlockPasswordChange={props.onUnlockPasswordChange}
        onUnlock={props.onUnlock}
      />
    );
  }

  return (
    <div ref={parentRef} className="table-wrap table-virtual">
      <div className="entries-header">
        <span>Name</span>
        <span>Kind</span>
        <span>Path</span>
        <span>Size</span>
      </div>
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
        {virtualItems.map((virtualRow) => {
          const entry = props.entries[virtualRow.index];
          if (!entry) {
            return (
              <div
                key={virtualRow.key}
                className="entry-row entry-row-loading"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                <span>Loading…</span>
              </div>
            );
          }

          return (
            <button
              type="button"
              key={entry.id}
              className={`entry-row ${props.selectedId === entry.id ? "entry-row-selected" : ""}`}
              style={{ transform: `translateY(${virtualRow.start}px)` }}
              onClick={() => props.onSelect(entry.id)}
              onDoubleClick={() => {
                if (!props.openDisabled) {
                  props.onOpenExternally(entry.id);
                }
              }}
            >
              <div className="entry-name-cell">
                <EntryThumbnail entry={entry} />
                <div className="entry-name-text">
                  <div className="entry-name-title">
                    <strong>{entry.name}</strong>
                    {entry.overrideMode ? <span className="entry-override-badge">{entry.overrideMode === "lossless" ? "lossless" : "visual"}</span> : null}
                  </div>
                  <span>{entry.relativePath}</span>
                </div>
              </div>
              <span>{entry.fileKind}</span>
              <span>{entry.relativePath}</span>
              <span>{formatBytes(entry.size)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CapabilityList(props: { capabilities: AppShellState["capabilities"] }) {
  return (
    <div className="settings-grid capability-list">
      {Object.entries(props.capabilities).map(([key, capability]) => (
        <div key={key} className="capability-row">
          <strong>{key}</strong>
          <span className="muted">
            {capability.available ? capability.value ?? capability.version ?? capability.path ?? "available" : capability.reason ?? "unavailable"}
          </span>
        </div>
      ))}
    </div>
  );
}

function ArchiveBrowserDialog(props: {
  open: boolean;
  archives: ArchiveBrowserItem[];
  loading: boolean;
  error: string | null;
  sortMode: ArchiveSortMode;
  selectedPath: string;
  currentArchivePath: string | null;
  disabled: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onSortModeChange: (sortMode: ArchiveSortMode) => void;
  onSelect: (path: string) => void;
  onSwapSelected: (path?: string) => void;
  onDeleteSelected: (archive: ArchiveBrowserItem) => void;
}) {
  if (!props.open) {
    return null;
  }

  const selectedArchive = props.archives.find((archive) => archive.path === props.selectedPath) ?? props.archives[0] ?? null;

  function handleDialogKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!isActivationKey(event.key) || event.defaultPrevented || isEditableElement(event.target)) {
      return;
    }

    if (event.target instanceof HTMLButtonElement) {
      return;
    }

    if (selectedArchive && props.currentArchivePath !== selectedArchive.path) {
      event.preventDefault();
      props.onSwapSelected();
    }
  }

  return createPortal(
    <div className="archive-browser-layer" role="presentation" onClick={props.onClose}>
      <div
        className="archive-browser-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="archive-browser-title"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
      >
        <div className="archive-browser-header">
          <div>
            <h2 id="archive-browser-title">View all archives</h2>
            <p className="muted">Browse detected archives on this machine and swap the open target without relying on the recent list.</p>
          </div>
          <div className="actions">
            <button type="button" onClick={props.onRefresh} disabled={props.loading}>
              Refresh
            </button>
            <button type="button" onClick={props.onClose}>
              Close
            </button>
          </div>
        </div>

        <div className="archive-browser-toolbar">
          <label className="setting-field archive-sort-field">
            <span className="setting-label">
              <span>Sort by</span>
            </span>
            <select value={props.sortMode} onChange={(event) => props.onSortModeChange(event.target.value as ArchiveSortMode)}>
              <option value="recent_desc">Most recent</option>
              <option value="recent_asc">Oldest</option>
              <option value="name_asc">Alphabetical A-Z</option>
              <option value="name_desc">Alphabetical Z-A</option>
              <option value="size_desc">Largest first</option>
              <option value="size_asc">Smallest first</option>
            </select>
          </label>
          <div className="muted archive-browser-count">
            {props.loading ? "Scanning for archives..." : `${props.archives.length} archive${props.archives.length === 1 ? "" : "s"} detected`}
          </div>
        </div>

        {props.error ? <div className="warning">{props.error}</div> : null}

        <div className="archive-browser-body">
          <div className="archive-browser-list table-wrap">
            {props.loading && props.archives.length === 0 ? (
              <div className="entry-list-empty">
                <strong>Scanning this machine for archives.</strong>
                <span>This may take a moment if you have a large home folder.</span>
              </div>
            ) : props.archives.length > 0 ? (
              props.archives.map((archive) => {
                const isSelected = props.selectedPath === archive.path;
                const isCurrent = props.currentArchivePath === archive.path;
                return (
                  <button
                    key={archive.path}
                    type="button"
                    className={`archive-browser-row ${isSelected ? "archive-browser-row-selected" : ""} ${isCurrent ? "archive-browser-row-current" : ""}`}
                    onClick={() => props.onSelect(archive.path)}
                    onKeyDown={(event) => {
                      if (!isActivationKey(event.key) || event.defaultPrevented) {
                        return;
                      }
                      event.preventDefault();
                      props.onSelect(archive.path);
                      if (!isCurrent) {
                        props.onSwapSelected(archive.path);
                      }
                    }}
                    onDoubleClick={() => {
                      if (!isCurrent) {
                        props.onSwapSelected(archive.path);
                      }
                    }}
                  >
                    <div className="archive-browser-row-main">
                      <div className="archive-browser-row-title">
                        <strong>{archive.name}</strong>
                        {isCurrent ? <span className="archive-browser-badge">open</span> : null}
                        {archive.source === "recent" ? <span className="archive-browser-badge archive-browser-badge-muted">recent</span> : null}
                      </div>
                      <span>{archive.path}</span>
                    </div>
                    <span>{formatDateTime(archive.lastModifiedAt)}</span>
                    <span>{formatArchiveSize(archive.sizeBytes)}</span>
                  </button>
                );
              })
            ) : (
              <div className="entry-list-empty">
                <strong>No archives detected.</strong>
                <span>There are no `.stow` archives in the scanned locations yet.</span>
              </div>
            )}
          </div>

          <aside className="archive-browser-detail">
            {selectedArchive ? (
              <>
                <div className="detail-row">
                  <strong>{selectedArchive.name}</strong>
                  <span>{selectedArchive.path}</span>
                </div>
                <div className="detail-row">
                  <span>Modified: {formatDateTime(selectedArchive.lastModifiedAt)}</span>
                  <span>Size: {formatArchiveSize(selectedArchive.sizeBytes)}</span>
                </div>
                <div className="detail-row">
                  <span>Sort mode: {getArchiveSortLabel(props.sortMode)}</span>
                  <span>{props.currentArchivePath === selectedArchive.path ? "Current archive" : "Ready to swap"}</span>
                </div>
                <div className="actions">
                  <button type="button" disabled={props.disabled || props.currentArchivePath === selectedArchive.path} onClick={() => props.onSwapSelected()}>
                    Swap to selected
                  </button>
                  <button type="button" className="delete-confirm-danger" disabled={props.disabled} onClick={() => props.onDeleteSelected(selectedArchive)}>
                    Delete archive
                  </button>
                </div>
                <div className="muted">
                  Clicking a row selects it. Press Enter or use the swap button to point the open-archive form at that archive, then enter the password if needed.
                </div>
              </>
            ) : (
              <div className="entry-list-empty">
                <strong>No archive selected.</strong>
                <span>Pick an archive from the list to see details.</span>
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>,
    document.body
  );
}

function ArchiveDeleteConfirmationDialog(props: {
  open: boolean;
  archive: ArchiveBrowserItem | null;
  currentArchivePath: string | null;
  disabled: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!props.open || !props.archive) {
    return null;
  }

  const isCurrent = props.currentArchivePath === props.archive.path;

  function handleDialogKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onCancel();
      return;
    }

    if (!isActivationKey(event.key) || event.defaultPrevented || event.target !== event.currentTarget || isEditableElement(event.target)) {
      return;
    }

    event.preventDefault();
    props.onConfirm();
  }

  return createPortal(
    <div className="archive-delete-layer" role="presentation" onClick={props.onCancel}>
      <div
        className="archive-delete-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="archive-delete-title"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
      >
        <div className="archive-delete-header">
          <div>
            <div className="archive-delete-kicker">Delete archive</div>
            <h2 id="archive-delete-title">Remove this archive from disk?</h2>
          </div>
          <button type="button" onClick={props.onCancel}>
            Close
          </button>
        </div>

        <div className="archive-delete-body">
          <div className="archive-delete-card">
            <strong>{props.archive.name}</strong>
            <span>{props.archive.path}</span>
            <span>Modified: {formatDateTime(props.archive.lastModifiedAt)}</span>
            <span>Size: {formatArchiveSize(props.archive.sizeBytes)}</span>
          </div>

          <div className="warning archive-delete-warning">
            <strong>This action is permanent.</strong>
            <span>The archive directory and all of its contents will be deleted from disk.</span>
            {isCurrent ? <span>This is the archive currently open in the app, so it will be closed first.</span> : null}
          </div>
        </div>

        <div className="archive-delete-footer">
          <button type="button" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="button" className="delete-confirm-danger" disabled={props.disabled} onClick={props.onConfirm}>
            Delete archive
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function EntryDeleteConfirmationDialog(props: {
  open: boolean;
  entry: ArchiveEntryDetail | null;
  disabled: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!props.open || !props.entry) {
    return null;
  }

  function handleDialogKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onCancel();
      return;
    }

    if (event.key !== "Enter" || event.defaultPrevented || event.target !== event.currentTarget || isEditableElement(event.target)) {
      return;
    }

    event.preventDefault();
    props.onConfirm();
  }

  return createPortal(
    <div className="archive-delete-layer" role="presentation" onClick={props.onCancel}>
      <div
        className="archive-delete-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="entry-delete-title"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
      >
        <div className="archive-delete-header">
          <div>
            <div className="archive-delete-kicker">Delete file</div>
            <h2 id="entry-delete-title">Remove this file from the archive?</h2>
          </div>
          <button type="button" onClick={props.onCancel}>
            Close
          </button>
        </div>

        <div className="archive-delete-body">
          <div className="archive-delete-card">
            <strong>{props.entry.name}</strong>
            <span>{props.entry.relativePath}</span>
            <span>Type: {props.entry.fileKind}</span>
            <span>Size: {formatBytes(props.entry.size)}</span>
          </div>

          <div className="warning archive-delete-warning">
            <strong>This action is permanent.</strong>
            <span>The file and all of its stored revisions will be removed from the archive.</span>
          </div>
        </div>

        <div className="archive-delete-footer">
          <button type="button" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="button" className="delete-confirm-danger" disabled={props.disabled} onClick={props.onConfirm}>
            Delete file
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function InstallOverlay(props: { installStatus: InstallStatus }) {
  const progress = props.installStatus.totalSteps > 0 ? props.installStatus.completedSteps / props.installStatus.totalSteps : 0;
  return (
    <div className="install-overlay">
      <div className="install-card">
        <div className="install-kicker">Local Tooling</div>
        <h2>{props.installStatus.message}</h2>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        <div className="detail-row install-meta">
          <span>{props.installStatus.currentTarget ?? "Preparing runtime tools"}</span>
          <span>
            {props.installStatus.completedSteps}/{props.installStatus.totalSteps}
          </span>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [shellState, setShellState] = useState<AppShellState>(defaultShellState);
  const [draftSettings, setDraftSettings] = useState<Settings>(defaultSettings);
  const [stats, setStats] = useState<ArchiveStats | null>(null);
  const [entries, setEntries] = useState<Array<ArchiveEntryListItem | undefined>>([]);
  const [entryTotal, setEntryTotal] = useState(0);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<ArchiveEntryDetail | null>(null);
  const [preview, setPreview] = useState<PreviewDescriptor | null>(null);
  const [progress, setProgress] = useState<ArchiveProgress | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const [archivePanel, setArchivePanel] = useState<"open" | "create">("open");
  const [status, setStatus] = useState("Ready");
  const [archiveName, setArchiveName] = useState("Archive");
  const [archiveDirectory, setArchiveDirectory] = useState("");
  const [archivePassword, setArchivePassword] = useState("");
  const [confirmArchivePassword, setConfirmArchivePassword] = useState("");
  const [openArchivePath, setOpenArchivePath] = useState("");
  const [openPassword, setOpenPassword] = useState("");
  const [unlockPassword, setUnlockPassword] = useState("");
  const [overrideMode, setOverrideMode] = useState<"lossless" | "visually_lossless">("visually_lossless");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [archiveBrowserOpen, setArchiveBrowserOpen] = useState(false);
  const [archiveBrowserLoading, setArchiveBrowserLoading] = useState(false);
  const [archiveBrowserError, setArchiveBrowserError] = useState<string | null>(null);
  const [archiveBrowserSortMode, setArchiveBrowserSortMode] = useState<ArchiveSortMode>("recent_desc");
  const [detectedArchives, setDetectedArchives] = useState<DetectedArchive[]>([]);
  const [selectedArchiveBrowserPath, setSelectedArchiveBrowserPath] = useState("");
  const [archiveDeleteCandidate, setArchiveDeleteCandidate] = useState<ArchiveBrowserItem | null>(null);
  const [entryDeleteCandidate, setEntryDeleteCandidate] = useState<ArchiveEntryDetail | null>(null);
  const [loadedOffsets, setLoadedOffsets] = useState<Set<number>>(new Set());
  const [renamingEntryId, setRenamingEntryId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const uploadQueueRef = useRef<string[][]>([]);
  const uploadQueueRunningRef = useRef(false);
  const wasInstallActiveRef = useRef(shellState.installStatus.active);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  const archiveUnlocked = Boolean(shellState.archive?.unlocked && shellState.archive.summary);
  const selectedArchiveIsUnlocked = Boolean(shellState.archive?.unlocked && shellState.archive?.path === openArchivePath);
  const uiLocked = isBusy || shellState.installStatus.active;
  const passwordsMatch = archivePassword.length > 0 && archivePassword === confirmArchivePassword;
  const canOpenArchive = !uiLocked && Boolean(openArchivePath) && (selectedArchiveIsUnlocked || Boolean(openPassword));
  const canCreateArchive = !uiLocked && Boolean(archiveDirectory) && Boolean(archiveName) && passwordsMatch;
  const emptyState: "empty" | "locked" | "no-archive" = !shellState.archive ? "no-archive" : archiveUnlocked ? "empty" : "locked";

  function applyShellState(next: AppShellState) {
    setShellState(next);
    setDraftSettings(next.settings);
    if (next.archive?.path) {
      setOpenArchivePath(next.archive.path);
      setSelectedArchiveBrowserPath(next.archive.path);
    }
  }

  async function runTask(label: string, task: () => Promise<AppShellState | void>) {
    setIsBusy(true);
    setStatus(label);
    try {
      const maybeState = await task();
      if (maybeState) {
        applyShellState(maybeState);
      }
      setStatus("Ready");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : `${label} failed`);
    } finally {
      setIsBusy(false);
    }
  }

  async function refreshEntries(offset = 0, reset = false) {
    if (!archiveUnlocked) {
      return;
    }
    if (!reset && loadedOffsets.has(offset)) {
      return;
    }

    const page = await window.stow.listEntries({ offset, limit: LIST_PAGE_SIZE });
    setEntryTotal(page.total);
    setEntries((current) => {
      const next = reset ? Array<ArchiveEntryListItem | undefined>(page.total).fill(undefined) : current.slice();
      if (next.length < page.total) {
        next.length = page.total;
      }
      for (let index = 0; index < page.items.length; index += 1) {
        next[offset + index] = page.items[index];
      }
      return next;
    });
    setLoadedOffsets((current) => {
      const next = reset ? new Set<number>() : new Set(current);
      next.add(offset);
      return next;
    });
  }

  async function refreshArchiveData(selectedId?: string | null) {
    if (!archiveUnlocked) {
      setEntries([]);
      setEntryTotal(0);
      setSelectedEntryId(null);
      setSelectedEntry(null);
      setPreview(null);
      setStats(null);
      setLoadedOffsets(new Set());
      return;
    }

    setEntries([]);
    setEntryTotal(0);
    setLoadedOffsets(new Set());
    const [firstPage, nextStats] = await Promise.all([window.stow.listEntries({ offset: 0, limit: LIST_PAGE_SIZE }), window.stow.getArchiveStats()]);
    setStats(nextStats);
    setEntryTotal(firstPage.total);
    const initial = Array<ArchiveEntryListItem | undefined>(firstPage.total).fill(undefined);
    for (let index = 0; index < firstPage.items.length; index += 1) {
      initial[index] = firstPage.items[index];
    }
    setEntries(initial);
    setLoadedOffsets(new Set([0]));
    const nextSelectedId = selectedId ?? firstPage.items[0]?.id ?? null;
    setSelectedEntryId(nextSelectedId);
  }

  async function refreshDetectedArchives() {
    setArchiveBrowserLoading(true);
    setArchiveBrowserError(null);
    try {
      const detected = await window.stow.listDetectedArchives();
      setDetectedArchives(detected);
      if (!selectedArchiveBrowserPath) {
        setSelectedArchiveBrowserPath(shellState.archive?.path ?? detected[0]?.path ?? shellState.recentArchives[0]?.path ?? "");
      }
    } catch (error) {
      setArchiveBrowserError(error instanceof Error ? error.message : "Failed to load archives");
    } finally {
      setArchiveBrowserLoading(false);
    }
  }

  function openArchiveBrowser() {
    setArchiveBrowserOpen(true);
    if (!selectedArchiveBrowserPath && (shellState.archive?.path || shellState.recentArchives[0]?.path)) {
      setSelectedArchiveBrowserPath(shellState.archive?.path ?? shellState.recentArchives[0]?.path ?? "");
    }
    void refreshDetectedArchives();
  }

  function closeArchiveBrowser() {
    setArchiveBrowserOpen(false);
    setArchiveDeleteCandidate(null);
  }

  function swapSelectedArchive(nextPath?: string) {
    const targetPath = nextPath ?? browserSelectedArchivePath;
    if (!targetPath) {
      return;
    }
    setOpenArchivePath(targetPath);
    setSelectedArchiveBrowserPath(targetPath);
    setArchivePanel("open");
    setArchiveBrowserOpen(false);
    setOpenPassword("");
  }

  function requestDeleteArchive(archive: ArchiveBrowserItem) {
    setArchiveDeleteCandidate(archive);
  }

  async function confirmDeleteArchive() {
    if (!archiveDeleteCandidate) {
      return;
    }

    const target = archiveDeleteCandidate;
    const deletedCurrentArchive = shellState.archive?.path === target.path;
    const deletedOpenTarget = openArchivePath === target.path;

    await runTask("Deleting archive", async () => {
      const next = await window.stow.deleteArchive(target.path);
      applyShellState(next);
      await refreshDetectedArchives();
      if (deletedCurrentArchive || deletedOpenTarget) {
        setOpenArchivePath(next.recentArchives[0]?.path ?? "");
        setOpenPassword("");
        setUnlockPassword("");
      }
      return next;
    });

    setArchiveDeleteCandidate(null);
  }

  function requestDeleteEntry(entry: ArchiveEntryDetail) {
    setEntryDeleteCandidate(entry);
  }

  async function confirmDeleteEntry() {
    if (!entryDeleteCandidate) {
      return;
    }

    const target = entryDeleteCandidate;

    await runTask("Deleting entry", async () => {
      const next = await window.stow.deleteEntry(target.id);
      applyShellState(next);
      return next;
    });

    setEntryDeleteCandidate(null);
  }

  useEffect(() => {
    let cancelled = false;
    const unsubscribeShell = window.stow.onShellStateChange((next) => {
      if (!cancelled) {
        applyShellState(next);
      }
    });
    const unsubscribeProgress = window.stow.onArchiveProgress((next) => {
      if (!cancelled) {
        setProgress(next.active ? next : null);
      }
    });
    const unsubscribeInvalidated = window.stow.onEntriesInvalidated((payload) => {
      if (cancelled || payload.archiveId !== shellState.archive?.summary?.archiveId) {
        return;
      }
      void refreshArchiveData(payload.selectedEntryId ?? selectedEntryId);
    });

    void window.stow.getShellState().then((next) => {
      if (!cancelled) {
        applyShellState(next);
        setArchiveDirectory(next.settings.preferredArchiveRoot);
        setOpenArchivePath(next.archive?.path ?? next.recentArchives[0]?.path ?? "");
        setSelectedArchiveBrowserPath(next.archive?.path ?? next.recentArchives[0]?.path ?? "");
      }
    });

    return () => {
      cancelled = true;
      unsubscribeShell();
      unsubscribeProgress();
      unsubscribeInvalidated();
    };
  }, [selectedEntryId, shellState.archive?.summary?.archiveId]);

  useEffect(() => {
    if (shellState.installStatus.active) {
      setStatus(shellState.installStatus.message);
      wasInstallActiveRef.current = true;
      return;
    }

    if (wasInstallActiveRef.current) {
      setStatus(shellState.installStatus.skipped.length ? "Tooling setup finished with warnings" : "Ready");
      wasInstallActiveRef.current = false;
    }
  }, [shellState.installStatus.active, shellState.installStatus.message, shellState.installStatus.skipped.length]);

  useEffect(() => {
    if (!archiveUnlocked) {
      void refreshArchiveData(null);
      return;
    }

    void refreshArchiveData(selectedEntryId);
  }, [archiveUnlocked, shellState.archive?.summary?.archiveId]);

  useEffect(() => {
    if (!archiveUnlocked || !selectedEntryId) {
      setSelectedEntry(null);
      setPreview(null);
      return;
    }

    let cancelled = false;
    void window.stow.getEntryDetail(selectedEntryId).then((detail) => {
      if (!cancelled) {
        setSelectedEntry(detail);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [archiveUnlocked, selectedEntryId]);

  useEffect(() => {
    if (!archiveUnlocked || !selectedEntryId || (renamingEntryId && renamingEntryId !== selectedEntryId)) {
      setRenamingEntryId(null);
      setRenameDraft("");
    }
  }, [archiveUnlocked, renamingEntryId, selectedEntryId]);

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
    if (!selectedEntry || renamingEntryId !== selectedEntry.id || !renameInputRef.current) {
      return;
    }

    const input = renameInputRef.current;
    const frame = window.requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(0, baseNameSelectionEnd(renameDraft || selectedEntry.name));
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [renamingEntryId, selectedEntry]);

  useEffect(() => {
    if (!selectedArchiveBrowserPath && shellState.recentArchives[0]) {
      setSelectedArchiveBrowserPath(shellState.recentArchives[0].path);
    }
  }, [selectedArchiveBrowserPath, shellState.recentArchives]);

  useEffect(() => {
    const firstLoadedEntry = entries.find(Boolean) ?? null;
    if (!selectedEntryId && firstLoadedEntry) {
      setSelectedEntryId(firstLoadedEntry.id);
      return;
    }

    if (selectedEntryId && !entries.some((entry) => entry?.id === selectedEntryId)) {
      setSelectedEntryId(firstLoadedEntry?.id ?? null);
    }
  }, [entries, selectedEntryId]);

  useEffect(() => {
    if (!uiLocked && uploadQueueRef.current.length) {
      void drainUploadQueue();
    }
  }, [uiLocked]);

  useEffect(() => {
    if (!selectedEntry || uiLocked || settingsOpen || renamingEntryId) {
      return;
    }

    const handler = (event: KeyboardEvent) => {
      if (event.key !== "F2" || isEditableElement(event.target)) {
        return;
      }
      event.preventDefault();
      setRenamingEntryId(selectedEntry.id);
      setRenameDraft(selectedEntry.name);
    };

    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
    };
  }, [renamingEntryId, selectedEntry, settingsOpen, uiLocked]);

  useEffect(() => {
    const handler = () => {
      if (document.visibilityState !== "hidden") {
        return;
      }
      if (!shellState.archive?.session?.effectivePolicy.lockOnHide) {
        return;
      }
      if (uiLocked) {
        return;
      }
      void runTask("Locking archive", () => window.stow.lockArchive());
    };

    document.addEventListener("visibilitychange", handler);
    return () => {
      document.removeEventListener("visibilitychange", handler);
    };
  }, [shellState.archive?.session?.effectivePolicy.lockOnHide, uiLocked]);

  useEffect(() => {
    function handleDragEnter(event: DragEvent) {
      event.preventDefault();
      dragCounterRef.current += 1;
      if (dragCounterRef.current === 1) {
        setIsDragOver(true);
      }
    }

    function handleDragLeave(event: DragEvent) {
      event.preventDefault();
      dragCounterRef.current -= 1;
      if (dragCounterRef.current <= 0) {
        dragCounterRef.current = 0;
        setIsDragOver(false);
      }
    }

    function handleDragOver(event: DragEvent) {
      event.preventDefault();
    }

    function handleDrop(event: DragEvent) {
      event.preventDefault();
      dragCounterRef.current = 0;
      setIsDragOver(false);

      if (!archiveUnlocked || uiLocked) {
        return;
      }

      const files = event.dataTransfer?.files;
      if (!files || files.length === 0) {
        return;
      }

      const paths: string[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if ((file as unknown as { path?: string }).path) {
          paths.push((file as unknown as { path: string }).path);
        }
      }

      if (paths.length > 0) {
        queueUpload(paths);
      }
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
  }, [archiveUnlocked, uiLocked]);

  async function drainUploadQueue() {
    if (uploadQueueRunningRef.current || uiLocked || !uploadQueueRef.current.length) {
      return;
    }

    uploadQueueRunningRef.current = true;
    setIsBusy(true);
    try {
      while (uploadQueueRef.current.length) {
        const batch = uploadQueueRef.current.shift();
        if (!batch) {
          break;
        }
        setStatus("Uploading files");
        const next = await window.stow.addPaths(batch);
        applyShellState(next);
      }
      setStatus("Ready");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Upload failed");
    } finally {
      uploadQueueRunningRef.current = false;
      setIsBusy(false);
    }
  }

  function queueUpload(paths: string[]) {
    uploadQueueRef.current.push(paths);
    if (uiLocked) {
      setStatus(`Queued ${paths.length} file${paths.length === 1 ? "" : "s"} for upload`);
      return;
    }
    void drainUploadQueue();
  }

  async function openSelectedArchive() {
    if (!canOpenArchive || selectedArchiveIsUnlocked) {
      return;
    }
    await runTask("Opening archive", () => window.stow.openArchive({ archivePath: openArchivePath, password: openPassword }));
    setOpenPassword("");
    setUnlockPassword("");
  }

  async function createSelectedArchive() {
    if (!canCreateArchive) {
      return;
    }
    await runTask("Creating archive", () =>
      window.stow.createArchive({
        parentPath: archiveDirectory,
        name: archiveName,
        password: archivePassword,
        preferences: draftSettings
      })
    );
    setArchivePassword("");
    setConfirmArchivePassword("");
    setOpenPassword("");
  }

  function beginRename() {
    if (!selectedEntry || uiLocked) {
      return;
    }
    setRenamingEntryId(selectedEntry.id);
    setRenameDraft(selectedEntry.name);
  }

  function cancelRename() {
    setRenamingEntryId(null);
    setRenameDraft("");
  }

  async function submitRename() {
    if (!selectedEntry || renamingEntryId !== selectedEntry.id) {
      return;
    }

    const nextName = renameDraft.trim();
    if (!nextName) {
      setStatus("File name is required");
      return;
    }
    if (nextName === selectedEntry.name) {
      cancelRename();
      return;
    }

    await runTask("Renaming entry", async () => {
      const next = await window.stow.renameEntry(selectedEntry.id, nextName);
      cancelRename();
      return next;
    });
  }

  const activeStats = stats ?? shellState.archive?.summary ?? null;
  const detailRevision = useMemo(() => {
    if (!selectedEntry) {
      return null;
    }
    return selectedEntry.revisions.find((revision) => revision.id === selectedEntry.latestRevisionId) ?? selectedEntry.revisions[0] ?? null;
  }, [selectedEntry]);
  const loadedEntryCount = useMemo(() => entries.filter(Boolean).length, [entries]);
  const browserArchives = useMemo(() => {
    const merged = mergeArchiveItems(detectedArchives, shellState.recentArchives, shellState.archive);
    return merged.sort((left, right) => compareArchiveItems(left, right, archiveBrowserSortMode));
  }, [archiveBrowserSortMode, detectedArchives, shellState.archive, shellState.recentArchives]);
  const browserSelectedArchivePath = selectedArchiveBrowserPath && browserArchives.some((archive) => archive.path === selectedArchiveBrowserPath) ? selectedArchiveBrowserPath : browserArchives[0]?.path ?? "";

  return (
    <div className="app-shell">
      {isDragOver && archiveUnlocked ? (
        <div className="drop-zone-overlay">
          <div className="drop-zone-inner">
            <strong>Drop files to add</strong>
            <span>Release to start ingesting into this archive</span>
          </div>
        </div>
      ) : null}
      {shellState.installStatus.active ? <InstallOverlay installStatus={shellState.installStatus} /> : null}
      <header className="topbar">
        <div>
          <strong>{versionLabel}</strong>
          <div className="status" role="status" aria-live="polite">{status === "Ready" ? "Local-first archive utility" : status}</div>
        </div>
        <div className="topbar-actions">
          <button type="button" disabled={uiLocked} onClick={() => setSettingsOpen(true)}>
            Settings
          </button>
          <button type="button" disabled={uiLocked || !archiveUnlocked} onClick={() => void runTask("Locking archive", () => window.stow.lockArchive())}>
            Lock
          </button>
          <button type="button" disabled={uiLocked || !archiveUnlocked} onClick={() => void runTask("Closing archive", () => window.stow.closeArchive())}>
            Close
          </button>
        </div>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <section className="panel">
            <div className="panel-tabs" role="tablist" aria-label="Archive actions">
              <button type="button" className={archivePanel === "open" ? "panel-tab panel-tab-active" : "panel-tab"} onClick={() => setArchivePanel("open")}>
                Open archive
              </button>
              <button type="button" className={archivePanel === "create" ? "panel-tab panel-tab-active" : "panel-tab"} onClick={() => setArchivePanel("create")}>
                Create archive
              </button>
            </div>

            <form
              className="panel-tab-body"
              hidden={archivePanel !== "open"}
              onSubmit={(event) => {
                event.preventDefault();
                void openSelectedArchive();
              }}
            >
              <h2>Open archive</h2>
              <SettingField label="Archive path" hint="Open an existing .stow archive directory from disk.">
                <div className="inline">
                  <input disabled={uiLocked} value={openArchivePath} onChange={(event) => setOpenArchivePath(event.target.value)} />
                  <button
                    type="button"
                    disabled={uiLocked}
                    onClick={async () => {
                      const picked = await window.stow.pickDirectory();
                      if (picked) setOpenArchivePath(picked);
                    }}
                  >
                    Browse
                  </button>
                </div>
              </SettingField>
              {!selectedArchiveIsUnlocked ? (
                <SettingField label="Password" hint="Enter the archive password to unlock it.">
                  <input disabled={uiLocked} type="password" value={openPassword} onChange={(event) => setOpenPassword(event.target.value)} />
                </SettingField>
              ) : (
                <div className="muted">This archive is already open.</div>
              )}
              <div className="actions">
                <button type="submit" disabled={!canOpenArchive || selectedArchiveIsUnlocked}>
                  Open
                </button>
              </div>
            </form>

            <form
              className="panel-tab-body"
              hidden={archivePanel !== "create"}
              onSubmit={(event) => {
                event.preventDefault();
                void createSelectedArchive();
              }}
            >
              <h2>Create archive</h2>
              <SettingField label="Archive name" hint="Name of the archive directory that will be created on disk.">
                <input disabled={uiLocked} value={archiveName} onChange={(event) => setArchiveName(event.target.value)} />
              </SettingField>
              <SettingField label="Directory" hint="Where the new .stow archive directory will be created.">
                <div className="inline">
                  <input disabled={uiLocked} value={archiveDirectory} onChange={(event) => setArchiveDirectory(event.target.value)} />
                  <button
                    type="button"
                    disabled={uiLocked}
                    onClick={async () => {
                      const picked = await window.stow.pickDirectory();
                      if (picked) setArchiveDirectory(picked);
                    }}
                  >
                    Browse
                  </button>
                </div>
              </SettingField>
              <SettingField label="Password" hint="This password encrypts the archive catalog and object metadata.">
                <input disabled={uiLocked} type="password" value={archivePassword} onChange={(event) => setArchivePassword(event.target.value)} />
              </SettingField>
              <SettingField label="Confirm password" hint="Re-enter the password to avoid creating an archive with the wrong key.">
                <input disabled={uiLocked} type="password" value={confirmArchivePassword} onChange={(event) => setConfirmArchivePassword(event.target.value)} />
              </SettingField>
              {!passwordsMatch && archivePassword.length > 0 && confirmArchivePassword.length > 0 ? <div className="warning">Passwords do not match.</div> : null}
              <div className="actions">
                <button type="submit" disabled={!canCreateArchive}>
                  Create
                </button>
              </div>
            </form>
          </section>

          <section className="panel archive-browser-launch">
            <div>
              <h2>Archives</h2>
              <span className="muted">Browse every detected archive on this machine and swap the open target from one place.</span>
            </div>
            <button type="button" disabled={uiLocked} onClick={openArchiveBrowser}>
              View all archives
            </button>
          </section>
        </aside>

        <main className="content">
          <ArchiveProgressStrip progress={progress} />
          <section className="panel content-panel">
            <div className="content-header">
              <strong>
                {shellState.archive?.summary ? `${shellState.archive.summary.name} • ${shellState.archive.path}` : shellState.archive?.path ?? "Archive browser"}
              </strong>
              <div className="actions">
                <button
                  type="button"
                  disabled={uiLocked || !archiveUnlocked}
                  onClick={async () => {
                    const picked = await window.stow.pickFilesOrFolders();
                    if (picked.length) {
                      queueUpload(picked);
                    }
                  }}
                >
                  Add files or folders
                </button>
              </div>
            </div>

            {activeStats ? (
              <div className="stats-strip">
                <span>{activeStats.entryCount} entries</span>
                <span>{formatBytes(activeStats.logicalBytes)} logical</span>
                <span>{formatBytes(activeStats.storedBytes)} stored</span>
                <span>{activeStats.storedObjectCount} objects</span>
              </div>
            ) : null}

            <EntryList
              entries={entries}
              total={entryTotal}
              loadedCount={loadedEntryCount}
              selectedId={selectedEntryId}
              emptyState={emptyState}
              unlockPassword={unlockPassword}
              unlockDisabled={uiLocked || !openArchivePath || !unlockPassword}
              openDisabled={uiLocked}
              onUnlockPasswordChange={setUnlockPassword}
              onUnlock={() => void runTask("Opening archive", () => window.stow.openArchive({ archivePath: shellState.archive?.path ?? openArchivePath, password: unlockPassword }))}
              onSelect={setSelectedEntryId}
              onOpenExternally={(entryId) => void runTask("Opening in native view", () => window.stow.openEntryExternally(entryId))}
              onNeedMore={() => {
                let nextOffset = 0;
                while (loadedOffsets.has(nextOffset) && nextOffset < entryTotal) {
                  nextOffset += LIST_PAGE_SIZE;
                }
                if (nextOffset < entryTotal) {
                  void refreshEntries(nextOffset);
                }
              }}
            />
          </section>

          <div className="detail-grid">
            <section className="panel detail-panel">
              <h2>Entry detail</h2>
              <div className="detail-panel-scroll">
                {selectedEntry && detailRevision ? (
                  <>
                    {preview ? <img className="preview" src={preview.path} alt={selectedEntry.name} /> : null}
                    {renamingEntryId === selectedEntry.id ? (
                      <form
                        className="entry-rename-form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void submitRename();
                        }}
                      >
                        <input
                          ref={renameInputRef}
                          value={renameDraft}
                          aria-label="Rename file"
                          onChange={(event) => setRenameDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              event.preventDefault();
                              cancelRename();
                            }
                          }}
                        />
                        <div className="detail-row entry-rename-meta">
                          <span>Rename this file inside the archive. Press Enter to save or Escape to cancel.</span>
                          <span>{selectedEntry.relativePath}</span>
                        </div>
                        <div className="actions">
                          <button type="submit" disabled={uiLocked}>
                            Save name
                          </button>
                          <button type="button" disabled={uiLocked} onClick={cancelRename}>
                            Cancel
                          </button>
                        </div>
                      </form>
                    ) : (
                      <div className="detail-row">
                        <strong>{selectedEntry.name}</strong>
                        <span>{selectedEntry.relativePath}</span>
                      </div>
                    )}
                    <div className="detail-row">
                      <span>Type: {selectedEntry.fileKind}</span>
                      <span>Size: {formatBytes(selectedEntry.size)}</span>
                    </div>
                    <div className="detail-row">
                      <span>Summary: {detailRevision.summary}</span>
                    </div>
                    <div className="detail-row">
                      <span>Updated: {formatDateTime(detailRevision.addedAt)}</span>
                      <span>Mode: {detailRevision.overrideMode ?? "archive default"}</span>
                    </div>
                    <div className="actions">
                      <button type="button" disabled={uiLocked} onClick={() => void runTask("Opening in native view", () => window.stow.openEntryExternally(selectedEntry.id))}>
                        Open
                      </button>
                      <button type="button" disabled={uiLocked} onClick={beginRename}>
                        Rename
                      </button>
                      <button type="button" disabled={uiLocked} onClick={() => void runTask("Exporting original", () => window.stow.exportEntry(selectedEntry.id, "original"))}>
                        Export original
                      </button>
                      <button
                        type="button"
                        disabled={uiLocked || !selectedEntry.exportableVariants.optimized}
                        onClick={() => void runTask("Exporting optimized", () => window.stow.exportEntry(selectedEntry.id, "optimized"))}
                      >
                        Export optimized
                      </button>
                    </div>
                    <div className="actions">
                      <select disabled={uiLocked} value={overrideMode} onChange={(event) => setOverrideMode(event.target.value as "lossless" | "visually_lossless")}>
                        <option value="visually_lossless">visually lossless</option>
                        <option value="lossless">lossless</option>
                      </select>
                      <button
                        type="button"
                        disabled={uiLocked}
                        onClick={() => void runTask("Reprocessing entry", () => window.stow.reprocessEntry(selectedEntry.id, overrideMode))}
                      >
                        Reprocess
                      </button>
                      <button type="button" className="delete-confirm-danger" disabled={uiLocked} onClick={() => requestDeleteEntry(selectedEntry)}>
                        Delete
                      </button>
                    </div>
                    <ul className="flat-list">
                      {detailRevision.actions.map((action) => (
                        <li key={action}>{action}</li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <span className="muted">Select an entry to inspect it.</span>
                )}
              </div>
            </section>

            <section className="panel log-panel">
              <h2>Logs</h2>
              <div className="log-list">
                {shellState.logs.map((line) => (
                  <div key={line}>{line}</div>
                ))}
              </div>
            </section>
          </div>
        </main>
      </div>

      <ArchiveBrowserDialog
        open={archiveBrowserOpen}
        archives={browserArchives}
        loading={archiveBrowserLoading}
        error={archiveBrowserError}
        sortMode={archiveBrowserSortMode}
        selectedPath={browserSelectedArchivePath}
        currentArchivePath={shellState.archive?.path ?? null}
        disabled={uiLocked}
        onClose={closeArchiveBrowser}
        onRefresh={() => {
          void refreshDetectedArchives();
        }}
        onSortModeChange={setArchiveBrowserSortMode}
        onSelect={setSelectedArchiveBrowserPath}
        onSwapSelected={swapSelectedArchive}
        onDeleteSelected={requestDeleteArchive}
      />

      <ArchiveDeleteConfirmationDialog
        open={archiveDeleteCandidate !== null}
        archive={archiveDeleteCandidate}
        currentArchivePath={shellState.archive?.path ?? null}
        disabled={uiLocked}
        onCancel={() => setArchiveDeleteCandidate(null)}
        onConfirm={() => void confirmDeleteArchive()}
      />

      <EntryDeleteConfirmationDialog
        open={entryDeleteCandidate !== null}
        entry={entryDeleteCandidate}
        disabled={uiLocked}
        onCancel={() => setEntryDeleteCandidate(null)}
        onConfirm={() => void confirmDeleteEntry()}
      />

      {settingsOpen ? (
        <div className="settings-dialog-layer" role="presentation" onClick={() => setSettingsOpen(false)}>
          <div className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={(event) => event.stopPropagation()}>
            <div className="settings-dialog-header">
              <h2 id="settings-title">Settings</h2>
              <button type="button" onClick={() => setSettingsOpen(false)}>
                Close
              </button>
            </div>
            <div className="settings-dialog-body">
              <SettingsForm value={draftSettings} disabled={uiLocked} onChange={setDraftSettings} />
              <div className="settings-divider" />
              <section className="settings-info-section">
                <h3 className="settings-info-title">Installed Tooling</h3>
                <CapabilityList capabilities={shellState.capabilities} />
              </section>
            </div>
            <div className="settings-dialog-footer">
              <button type="button" disabled={uiLocked} onClick={() => void runTask("Restoring defaults", () => window.stow.resetSettings())}>
                Reset
              </button>
              <div className="actions">
                <button type="button" onClick={() => setSettingsOpen(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={uiLocked}
                  onClick={() =>
                    void runTask("Saving settings", async () => {
                      const next = await window.stow.saveSettings(draftSettings);
                      setSettingsOpen(false);
                      return next;
                    })
                  }
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;
