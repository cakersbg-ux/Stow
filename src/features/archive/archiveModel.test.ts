import assert from "node:assert/strict";
import test from "node:test";
import type { AppShellState, ArchiveEntryDetail, ArchiveEntryListItem, DetectedArchive, RecentArchive } from "../../types";
import {
  ARCHIVE_ENTRY_DRAG_TYPE,
  canReprocessLosslessly,
  buildFolderTree,
  compareArchiveItems,
  createEntryPageCache,
  getLoadedEntryCount,
  getNextMissingOffset,
  getSelectedSizeTotal,
  getVisibleEntries,
  mergeArchiveItems,
  isArchiveEntryDrag,
  isFileDrop,
  resolveClosestStandardResolutionLabel,
  resolveRangeSelection,
  writeEntryPage
} from "./archiveModel";
import { resolveRefreshSelection } from "./archiveSessionModel";

function makeEntry(overrides: Partial<ArchiveEntryListItem> = {}): ArchiveEntryListItem {
  return {
    id: overrides.id ?? "id",
    entryType: overrides.entryType ?? "file",
    name: overrides.name ?? "example.jpg",
    relativePath: overrides.relativePath ?? "example.jpg",
    fileKind: overrides.fileKind ?? "image",
    mime: overrides.mime ?? "image/jpeg",
    size: overrides.size ?? 100,
    sourceSize: overrides.sourceSize ?? 100,
    latestRevisionId: overrides.latestRevisionId ?? "rev-1",
    overrideMode: overrides.overrideMode ?? null,
    previewable: overrides.previewable ?? false,
    childCount: overrides.childCount ?? null
  };
}

function makeDetail(overrides: Partial<ArchiveEntryDetail> = {}): ArchiveEntryDetail {
  const revision = overrides.revisions?.[0] ?? {
    id: "rev-1",
    addedAt: "2025-01-01T00:00:00.000Z",
    source: {
      relativePath: "example",
      size: 100
    },
    media: {
      width: 100,
      height: 100,
      codec: null
    },
    overrideMode: null,
    summary: "example",
    actions: [],
    originalArtifact: {
      label: "original",
      extension: ".jpg",
      mime: "image/jpeg",
      size: 100,
      contentHash: "a".repeat(64),
      chunks: [{ hash: "b".repeat(64), size: 100 }]
    },
    optimizedArtifact: null
  };

  return {
    id: overrides.id ?? "id",
    name: overrides.name ?? "example.jpg",
    relativePath: overrides.relativePath ?? "example.jpg",
    fileKind: overrides.fileKind ?? "image",
    mime: overrides.mime ?? "image/jpeg",
    size: overrides.size ?? 100,
    sourceSize: overrides.sourceSize ?? 100,
    createdAt: overrides.createdAt ?? "2025-01-01T00:00:00.000Z",
    latestRevisionId: overrides.latestRevisionId ?? revision.id,
    revisions: overrides.revisions ?? [revision],
    exportableVariants: overrides.exportableVariants ?? {
      original: true,
      optimized: false
    }
  };
}

test("mergeArchiveItems keeps archive state and stable precedence", () => {
  const detected: DetectedArchive[] = [
    { path: "/detected.stow", name: "Detected", lastModifiedAt: "2025-01-02T00:00:00.000Z", sizeBytes: 20 }
  ];
  const recent: RecentArchive[] = [
    { path: "/recent.stow", name: "Recent", lastOpenedAt: "2025-01-03T00:00:00.000Z" }
  ];
  const current: AppShellState["archive"] = {
    path: "/current.stow",
    unlocked: true,
    summary: {
      archiveId: "archive-1",
      name: "Current.stow",
      path: "/current.stow",
      unlocked: true,
      entryCount: 1,
      storedObjectCount: 1,
      logicalBytes: 10,
      storedBytes: 10,
      updatedAt: "2025-01-04T00:00:00.000Z",
      preferences: {
        compressionBehavior: "balanced",
        optimizationMode: "visually_lossless",
        stripDerivativeMetadata: true
      },
      session: null,
      folders: []
    },
    session: null
  };

  const merged = mergeArchiveItems(detected, recent, current);

  assert.equal(merged.length, 3);
  assert.deepEqual(merged.map((item) => item.path), ["/detected.stow", "/recent.stow", "/current.stow"]);
  assert.equal(merged[2].name, "Current");
  assert.equal(merged[2].source, "recent");
});

test("compareArchiveItems sorts deterministic visible order", () => {
  const a = { path: "/a", name: "Alpha", lastModifiedAt: "2025-01-01T00:00:00.000Z", sizeBytes: 50, source: "detected" as const };
  const b = { path: "/b", name: "Beta", lastModifiedAt: "2025-01-02T00:00:00.000Z", sizeBytes: 20, source: "detected" as const };

  assert.ok(compareArchiveItems(a, b, "recent_desc") > 0);
  assert.ok(compareArchiveItems(a, b, "name_asc") < 0);
  assert.ok(compareArchiveItems(a, b, "size_desc") < 0);
});

test("page cache exposes visible order and loaded count", () => {
  const first = makeEntry({ id: "a", name: "a.png", relativePath: "a.png" });
  const second = makeEntry({ id: "b", name: "b.png", relativePath: "b.png" });
  const third = makeEntry({ id: "c", name: "c.png", relativePath: "c.png" });

  const cached = writeEntryPage(createEntryPageCache(), 0, 3, [first, second]);
  const withSecondPage = writeEntryPage(cached, 2, 3, [third]);
  const visible = getVisibleEntries(withSecondPage);

  assert.equal(getLoadedEntryCount(withSecondPage), 3);
  assert.deepEqual(visible.map((entry) => entry?.id), ["a", "b", "c"]);
  assert.equal(getNextMissingOffset(withSecondPage, 2), 4);
});

test("range selection follows visible order and skips folders", () => {
  const entries = [
    makeEntry({ id: "a", name: "a.png", relativePath: "a.png" }),
    makeEntry({ id: "folder-1", entryType: "folder", name: "Folder", relativePath: "Folder", childCount: 1, size: null, sourceSize: null, latestRevisionId: null }),
    makeEntry({ id: "b", name: "b.png", relativePath: "b.png" }),
    makeEntry({ id: "c", name: "c.png", relativePath: "c.png" })
  ];

  assert.deepEqual(resolveRangeSelection(entries, "c", "a"), ["a", "b", "c"]);
  assert.deepEqual(getSelectedSizeTotal(entries, new Set(["a", "b", "c"])), 300);
  assert.deepEqual(buildFolderTree(["z", "a", "a/b"]).map((node) => node.path), ["a", "z"]);
});

test("refresh selection prefers invalidation target then falls back to first file", () => {
  const entries = [
    makeEntry({ id: "folder-1", entryType: "folder", name: "Folder", relativePath: "Folder", childCount: 1, size: null, sourceSize: null, latestRevisionId: null }),
    makeEntry({ id: "b", name: "b.png", relativePath: "b.png" }),
    makeEntry({ id: "c", name: "c.png", relativePath: "c.png" })
  ];

  assert.deepEqual([...resolveRefreshSelection(entries, "c").selectedIds], ["c"]);
  assert.deepEqual([...resolveRefreshSelection(entries, "missing").selectedIds], ["b"]);
  assert.equal(resolveRefreshSelection([], null).selectedIds.size, 0);
});

test("closest standard resolution prefers the nearest common bucket", () => {
  assert.equal(resolveClosestStandardResolutionLabel(1920, 1080), "1080p");
  assert.equal(resolveClosestStandardResolutionLabel(2560, 1600), "1440p");
  assert.equal(resolveClosestStandardResolutionLabel(7680, 4320), "8k");
});

test("closest standard resolution returns null without dimensions", () => {
  assert.equal(resolveClosestStandardResolutionLabel(null, 1080), null);
  assert.equal(resolveClosestStandardResolutionLabel(1920, undefined), null);
});

test("canReprocessLosslessly hides lossless for lossy sources", () => {
  assert.equal(
    canReprocessLosslessly(makeDetail({
      fileKind: "image",
      revisions: [{
        id: "rev-1",
        addedAt: "2025-01-01T00:00:00.000Z",
        source: { relativePath: "photo.jpg", size: 100 },
        media: { width: 100, height: 100, codec: null },
        overrideMode: "visually_lossless",
        summary: "example",
        actions: [],
        originalArtifact: {
          label: "original",
          extension: ".jpg",
          mime: "image/jpeg",
          size: 100,
          contentHash: "a".repeat(64),
          chunks: [{ hash: "b".repeat(64), size: 100 }]
        },
        optimizedArtifact: null
      }]
    })),
    false
  );

  assert.equal(
    canReprocessLosslessly(makeDetail({
      fileKind: "image",
      revisions: [{
        id: "rev-2",
        addedAt: "2025-01-01T00:00:00.000Z",
        source: { relativePath: "photo.png", size: 100 },
        media: { width: 100, height: 100, codec: null },
        overrideMode: "visually_lossless",
        summary: "example",
        actions: [],
        originalArtifact: {
          label: "original",
          extension: ".png",
          mime: "image/png",
          size: 100,
          contentHash: "c".repeat(64),
          chunks: [{ hash: "d".repeat(64), size: 100 }]
        },
        optimizedArtifact: null
      }]
    })),
    true
  );
});

test("canReprocessLosslessly checks known lossless video codecs", () => {
  assert.equal(
    canReprocessLosslessly(makeDetail({
      fileKind: "video",
      mime: "video/mp4",
      revisions: [{
        id: "rev-3",
        addedAt: "2025-01-01T00:00:00.000Z",
        source: { relativePath: "clip.mp4", size: 100 },
        media: { width: 1920, height: 1080, codec: "h264" },
        overrideMode: "visually_lossless",
        summary: "example",
        actions: [],
        originalArtifact: {
          label: "original",
          extension: ".mp4",
          mime: "video/mp4",
          size: 100,
          contentHash: "e".repeat(64),
          chunks: [{ hash: "f".repeat(64), size: 100 }]
        },
        optimizedArtifact: null
      }]
    })),
    false
  );

  assert.equal(
    canReprocessLosslessly(makeDetail({
      fileKind: "video",
      mime: "video/x-matroska",
      revisions: [{
        id: "rev-4",
        addedAt: "2025-01-01T00:00:00.000Z",
        source: { relativePath: "clip.mkv", size: 100 },
        media: { width: 1920, height: 1080, codec: "ffv1" },
        overrideMode: "lossless",
        summary: "example",
        actions: [],
        originalArtifact: {
          label: "original",
          extension: ".mkv",
          mime: "video/x-matroska",
          size: 100,
          contentHash: "1".repeat(64),
          chunks: [{ hash: "2".repeat(64), size: 100 }]
        },
        optimizedArtifact: null
      }]
    })),
    true
  );
});

test("drag source helpers distinguish archive entry moves from file imports", () => {
  const archiveDrag = {
    types: [ARCHIVE_ENTRY_DRAG_TYPE],
    files: []
  } as unknown as DataTransfer;
  const fileDrop = {
    types: ["Files"],
    files: [{ path: "/tmp/example.png" }]
  } as unknown as DataTransfer;

  assert.equal(isArchiveEntryDrag(archiveDrag), true);
  assert.equal(isArchiveEntryDrag(fileDrop), false);
  assert.equal(isFileDrop(archiveDrag), false);
  assert.equal(isFileDrop(fileDrop), true);
});
