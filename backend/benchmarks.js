const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { ArchiveService } = require("./archiveService");
const { createInitialState } = require("./appState");

function createEmitters() {
  return {
    emitShellState: () => {},
    emitProgress: () => {},
    emitEntriesInvalidated: () => {}
  };
}

async function seedFiles(rootDir, fileCount) {
  const sourceDir = path.join(rootDir, "fixtures");
  await fs.mkdir(sourceDir, { recursive: true });
  for (let index = 0; index < fileCount; index += 1) {
    const content = `stow-benchmark-${index % 32}\n`.repeat(64);
    await fs.writeFile(path.join(sourceDir, `file-${String(index).padStart(5, "0")}.txt`), content);
  }
  return sourceDir;
}

async function main() {
  const fileCount = Number(process.env.STOW_BENCH_FILES || 1000);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-bench-"));

  try {
    const state = await createInitialState(path.join(tempDir, "user-data"), tempDir);
    state.installStatus = {
      active: false,
      phase: "complete",
      message: "ready",
      currentTarget: null,
      completedSteps: 1,
      totalSteps: 1,
      installed: [],
      skipped: []
    };

    const service = new ArchiveService(state, createEmitters());
    await service.initialize();

    const createStart = performance.now();
    await service.createArchive({
      parentPath: tempDir,
      name: "benchmark",
      password: "password",
      preferences: state.settings
    });
    const createMs = performance.now() - createStart;

    const sourceDir = await seedFiles(tempDir, fileCount);

    const ingestStart = performance.now();
    await service.addPaths([sourceDir]);
    const ingestMs = performance.now() - ingestStart;

    const listStart = performance.now();
    const firstPage = await service.listEntries({ offset: 0, limit: 100 });
    const listMs = performance.now() - listStart;

    const detailStart = performance.now();
    if (firstPage.items[0]) {
      await service.getEntryDetail(firstPage.items[0].id);
    }
    const detailMs = performance.now() - detailStart;

    console.log(
      JSON.stringify(
        {
          fileCount,
          createMs: Number(createMs.toFixed(2)),
          ingestMs: Number(ingestMs.toFixed(2)),
          listFirstPageMs: Number(listMs.toFixed(2)),
          entryDetailMs: Number(detailMs.toFixed(2))
        },
        null,
        2
      )
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
