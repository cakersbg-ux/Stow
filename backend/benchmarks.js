const { performance } = require("node:perf_hooks");
const path = require("node:path");
const { ArchiveQueryIndex } = require("./archiveQueryIndex");

function makeEntry(index) {
  const folder = index % 8 === 0 ? "projects/assets" : index % 8 === 1 ? "projects" : "";
  const name = `file-${String(index).padStart(5, "0")}.txt`;
  const relativePath = folder ? path.join(folder, name) : name;

  return {
    id: `entry-${index}`,
    name,
    relativePath,
    fileKind: "text",
    mime: "text/plain",
    size: 1024 + (index % 256),
    sourceSize: 1024 + (index % 256),
    latestRevisionId: `rev-${index}`,
    overrideMode: null,
    previewable: false
  };
}

function buildBenchmarkIndex(fileCount) {
  const folders = ["projects", path.join("projects", "assets"), "archive", path.join("archive", "2024")];
  const entries = [];

  for (let index = 0; index < fileCount; index += 1) {
    entries.push(makeEntry(index));
  }

  return new ArchiveQueryIndex({ folders, entries });
}

async function main() {
  const fileCount = Number(process.env.STOW_BENCH_FILES || 1000);

  const buildStart = performance.now();
  const index = buildBenchmarkIndex(fileCount);
  const buildMs = performance.now() - buildStart;

  const listStart = performance.now();
  const firstPage = index.listEntries({ directory: "", offset: 0, limit: 100 });
  const listMs = performance.now() - listStart;

  const warmListStart = performance.now();
  index.listEntries({ directory: "", offset: 0, limit: 100 });
  const warmListMs = performance.now() - warmListStart;

  const folderListStart = performance.now();
  const folderListing = index.listEntries({ directory: "projects", offset: 0, limit: 100 });
  const folderListMs = performance.now() - folderListStart;

  const warmFolderListStart = performance.now();
  index.listEntries({ directory: "projects", offset: 0, limit: 100 });
  const warmFolderListMs = performance.now() - warmFolderListStart;

  const mutationStart = performance.now();
  index.upsertEntry({
    id: "benchmark-mutation",
    name: "benchmark-mutation.txt",
    relativePath: "benchmark-mutation.txt",
    fileKind: "text",
    mime: "text/plain",
    size: 2048,
    sourceSize: 2048,
    latestRevisionId: "rev-benchmark-mutation",
    overrideMode: null,
    previewable: false
  });
  const mutationMs = performance.now() - mutationStart;

  const postMutationStart = performance.now();
  index.listEntries({ directory: "", offset: 0, limit: 100 });
  const postMutationListMs = performance.now() - postMutationStart;

  console.log(
    JSON.stringify(
      {
        fileCount,
        buildMs: Number(buildMs.toFixed(2)),
        listFirstPageMs: Number(listMs.toFixed(2)),
        listWarmFirstPageMs: Number(warmListMs.toFixed(2)),
        listProjectsMs: Number(folderListMs.toFixed(2)),
        listWarmProjectsMs: Number(warmFolderListMs.toFixed(2)),
        mutationMs: Number(mutationMs.toFixed(2)),
        postMutationListMs: Number(postMutationListMs.toFixed(2)),
        firstPageTotal: firstPage.total,
        projectsTotal: folderListing.total
      },
      null,
      2
    )
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
