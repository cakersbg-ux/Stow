import assert from "node:assert/strict";
import test from "node:test";
import type { AppShellState, ArchiveEntryListItem, DetectedArchive, RecentArchive } from "../../types";
import {
  buildFolderTree,
  compareArchiveItems,
  createEntryPageCache,
  getLoadedEntryCount,
  getNextMissingOffset,
  getSelectedSizeTotal,
  getVisibleEntries,
  mergeArchiveItems,
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
