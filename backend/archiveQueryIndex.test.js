const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  ArchiveQueryIndex,
  normalizeDirectoryPath,
  normalizeRelativePath
} = require("./archiveQueryIndex");

function makeEntry(overrides) {
  return {
    id: overrides.id,
    name: overrides.name,
    relativePath: overrides.relativePath,
    fileKind: overrides.fileKind || "file",
    mime: overrides.mime || "text/plain",
    size: overrides.size ?? 1,
    sourceSize: overrides.sourceSize ?? overrides.size ?? 1,
    latestRevisionId: overrides.latestRevisionId || null,
    overrideMode: overrides.overrideMode || null,
    previewable: overrides.previewable ?? false,
    ...overrides
  };
}

test("ArchiveQueryIndex builds directory buckets from summaries and folders", () => {
  const index = new ArchiveQueryIndex({
    folders: ["projects", path.join("projects", "assets")],
    entries: [
      makeEntry({ id: "root-entry", name: "alpha.txt", relativePath: "alpha.txt", size: 9 }),
      makeEntry({
        id: "nested-entry",
        name: "notes.txt",
        relativePath: path.join("projects", "assets", "notes.txt"),
        size: 12
      })
    ]
  });

  assert.equal(index.hasFolder(""), true);
  assert.equal(index.hasFolder("projects"), true);
  assert.equal(index.hasFolder(path.join("projects", "assets")), true);
  assert.equal(index.findEntryIdByRelativePath("alpha.txt"), "root-entry");
  assert.equal(index.findEntryIdByRelativePath(path.join("projects", "assets", "notes.txt")), "nested-entry");

  const rootBucket = index.getDirectoryBucket("");
  assert.equal(rootBucket.folders.has("projects"), true);
  const rootListing = index.listEntries({ directory: "", offset: 0, limit: 10 });
  assert.equal(rootListing.total, 2);
  assert.deepEqual(
    rootListing.items.map((item) => item.relativePath),
    ["projects", "alpha.txt"]
  );
  assert.equal(rootListing.items[0].entryType, "folder");
  assert.equal(rootListing.items[0].childCount, 1);

  const projectsListing = index.listEntries({ directory: "projects", offset: 0, limit: 10 });
  assert.equal(projectsListing.total, 1);
  assert.deepEqual(projectsListing.items.map((item) => item.relativePath), [path.join("projects", "assets")]);
  assert.equal(projectsListing.items[0].entryType, "folder");
  assert.equal(projectsListing.items[0].childCount, 1);
});

test("ArchiveQueryIndex supports incremental upsert and remove operations", () => {
  const index = new ArchiveQueryIndex();

  index.upsertFolder("projects");
  index.upsertEntry(makeEntry({ id: "entry-1", name: "alpha.txt", relativePath: "alpha.txt", size: 3 }));
  index.upsertEntry(
    makeEntry({
      id: "entry-1",
      name: "alpha.txt",
      relativePath: path.join("projects", "alpha.txt"),
      size: 3
    })
  );

  assert.equal(index.findEntryIdByRelativePath("alpha.txt"), null);
  assert.equal(index.findEntryIdByRelativePath(path.join("projects", "alpha.txt")), "entry-1");
  assert.deepEqual(index.listEntries({ directory: "", offset: 0, limit: 10 }).items.map((item) => item.relativePath), [
    "projects"
  ]);
  assert.deepEqual(index.listEntries({ directory: "projects", offset: 0, limit: 10 }).items.map((item) => item.relativePath), [
    path.join("projects", "alpha.txt")
  ]);

  index.upsertEntry(
    makeEntry({
      id: "entry-1",
      name: "renamed.txt",
      relativePath: path.join("projects", "renamed.txt"),
      size: 4
    })
  );

  assert.equal(index.findEntryIdByRelativePath(path.join("projects", "alpha.txt")), null);
  assert.equal(index.findEntryIdByRelativePath(path.join("projects", "renamed.txt")), "entry-1");
  assert.equal(index.getEntryById("entry-1").name, "renamed.txt");

  index.removeEntry("entry-1");
  assert.equal(index.findEntryIdByRelativePath(path.join("projects", "renamed.txt")), null);
  assert.equal(index.listEntries({ directory: "projects", offset: 0, limit: 10 }).total, 0);

  index.removeFolder("projects");
  assert.equal(index.hasFolder("projects"), false);
  assert.equal(index.listEntries({ directory: "", offset: 0, limit: 10 }).total, 0);
});

test("ArchiveQueryIndex sorts and paginates merged folder and file listings", () => {
  const index = new ArchiveQueryIndex({
    folders: ["beta", "alpha", "gamma"],
    entries: [
      makeEntry({ id: "file-1", name: "delta.txt", relativePath: "delta.txt", size: 40 }),
      makeEntry({ id: "file-2", name: "charlie.txt", relativePath: "charlie.txt", size: 30 }),
      makeEntry({ id: "file-3", name: "echo.txt", relativePath: "echo.txt", size: 50 })
    ]
  });

  const pageOne = index.listEntries({ directory: "", offset: 0, limit: 2, sortColumn: "name", sortDirection: "asc" });
  const pageTwo = index.listEntries({ directory: "", offset: 2, limit: 2, sortColumn: "name", sortDirection: "asc" });
  const pageThree = index.listEntries({ directory: "", offset: 4, limit: 2, sortColumn: "name", sortDirection: "asc" });

  assert.equal(pageOne.total, 6);
  assert.deepEqual(pageOne.items.map((item) => item.relativePath), ["alpha", "beta"]);
  assert.deepEqual(pageTwo.items.map((item) => item.relativePath), ["gamma", "charlie.txt"]);
  assert.deepEqual(pageThree.items.map((item) => item.relativePath), ["delta.txt", "echo.txt"]);

  const sizeSorted = index.listEntries({ directory: "", offset: 0, limit: 6, sortColumn: "size", sortDirection: "desc" });
  assert.deepEqual(sizeSorted.items.slice(0, 3).map((item) => item.entryType), ["folder", "folder", "folder"]);
  assert.deepEqual(sizeSorted.items.slice(3).map((item) => item.relativePath), ["echo.txt", "delta.txt", "charlie.txt"]);
});

test("ArchiveQueryIndex caches warm listings and invalidates on folder and file mutations", () => {
  const index = new ArchiveQueryIndex({
    folders: ["alpha", "beta"],
    entries: [
      makeEntry({ id: "file-1", name: "delta.txt", relativePath: "delta.txt", size: 40 }),
      makeEntry({ id: "file-2", name: "charlie.txt", relativePath: "charlie.txt", size: 30 })
    ]
  });

  const originalSort = Array.prototype.sort;
  let sortCalls = 0;

  try {
    Array.prototype.sort = function patchedSort(...args) {
      sortCalls += 1;
      return originalSort.apply(this, args);
    };

    const coldListing = index.listEntries({ directory: "", offset: 0, limit: 10, sortColumn: "name", sortDirection: "asc" });
    assert.ok(sortCalls > 0);
    assert.deepEqual(coldListing.items.map((item) => item.relativePath), ["alpha", "beta", "charlie.txt", "delta.txt"]);

    sortCalls = 0;
    const warmListing = index.listEntries({ directory: "", offset: 0, limit: 10, sortColumn: "name", sortDirection: "asc" });
    assert.equal(sortCalls, 0);
    assert.deepEqual(warmListing.items.map((item) => item.relativePath), coldListing.items.map((item) => item.relativePath));

    sortCalls = 0;
    index.upsertEntry(makeEntry({ id: "file-3", name: "echo.txt", relativePath: "echo.txt", size: 20 }));
    const fileInvalidatedListing = index.listEntries({
      directory: "",
      offset: 0,
      limit: 10,
      sortColumn: "name",
      sortDirection: "asc"
    });
    assert.ok(sortCalls > 0);
    assert.equal(fileInvalidatedListing.total, 5);
    assert.equal(fileInvalidatedListing.items.some((item) => item.relativePath === "echo.txt"), true);

    sortCalls = 0;
    index.upsertFolder("gamma");
    const folderInvalidatedListing = index.listEntries({
      directory: "",
      offset: 0,
      limit: 10,
      sortColumn: "name",
      sortDirection: "asc"
    });
    assert.ok(sortCalls > 0);
    assert.equal(folderInvalidatedListing.total, 6);
    assert.equal(folderInvalidatedListing.items.some((item) => item.relativePath === "gamma"), true);
  } finally {
    Array.prototype.sort = originalSort;
  }
});

test("ArchiveQueryIndex bounds warm listing cache growth", () => {
  const index = new ArchiveQueryIndex({
    folders: Array.from({ length: 200 }, (_, folderIndex) => `folder-${folderIndex}`)
  });
  const originalSort = Array.prototype.sort;
  let sortCalls = 0;

  try {
    Array.prototype.sort = function patchedSort(...args) {
      sortCalls += 1;
      return originalSort.apply(this, args);
    };

    index.listEntries({ directory: "folder-0", offset: 0, limit: 10, sortColumn: "name", sortDirection: "asc" });

    for (let directoryIndex = 1; directoryIndex < 200; directoryIndex += 1) {
      const directory = `folder-${directoryIndex}`;
      index.listEntries({ directory, offset: 0, limit: 10, sortColumn: "name", sortDirection: "asc" });
    }

    assert.equal(index.listingCache.size <= 128, true);

    sortCalls = 0;
    index.listEntries({ directory: "folder-199", offset: 0, limit: 10, sortColumn: "name", sortDirection: "asc" });
    assert.equal(sortCalls, 0, "the most recently used listing should stay warm");

    sortCalls = 0;
    index.listEntries({ directory: "folder-0", offset: 0, limit: 10, sortColumn: "name", sortDirection: "asc" });
    assert.ok(sortCalls > 0, "older listings should be evicted once the cache cap is exceeded");
  } finally {
    Array.prototype.sort = originalSort;
  }
});

test("ArchiveQueryIndex rejects unsafe paths during normalization", () => {
  assert.throws(() => normalizeRelativePath("../escape"), /invalid/);
  assert.throws(() => normalizeDirectoryPath(""), /required/);
  assert.throws(() => new ArchiveQueryIndex({ entries: [makeEntry({ id: "bad", relativePath: "../escape" })] }), /invalid/);
});
