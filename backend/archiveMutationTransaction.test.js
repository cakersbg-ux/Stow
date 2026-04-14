const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ArchiveMutationTransaction,
  createArchiveMutationTransaction
} = require("./archiveMutationTransaction");

test("ArchiveMutationTransaction commits once and runs finalizers in registration order", async () => {
  const events = [];
  const transaction = createArchiveMutationTransaction({
    captureSnapshot: async () => {
      events.push("capture");
      return { rootUpdatedAt: "snapshot" };
    },
    restoreSnapshot: async () => {
      events.push("restore");
    },
    commitBoundary: async ({ snapshot, result }) => {
      events.push(`commit:${snapshot.rootUpdatedAt}:${result}`);
    }
  });

  const result = await transaction.run(async ({ snapshot, stageCleanup, stageFinalizer }) => {
    events.push(`mutate:${snapshot.rootUpdatedAt}`);
    stageCleanup(async () => {
      events.push("cleanup");
    });
    stageFinalizer(async () => {
      events.push("finalizer-1");
    });
    stageFinalizer(async () => {
      events.push("finalizer-2");
    });
    return "ok";
  });

  assert.equal(result, "ok");
  assert.deepEqual(events, ["capture", "mutate:snapshot", "commit:snapshot:ok", "finalizer-1", "finalizer-2"]);
});

test("ArchiveMutationTransaction rolls back cleanup steps in reverse order before restoring snapshot", async () => {
  const events = [];
  const transaction = new ArchiveMutationTransaction({
    captureSnapshot: async () => {
      events.push("capture");
      return { rootUpdatedAt: "snapshot" };
    },
    restoreSnapshot: async (snapshot) => {
      events.push(`restore:${snapshot.rootUpdatedAt}`);
    },
    commitBoundary: async () => {
      events.push("commit");
      throw new Error("persist failed");
    }
  });

  await assert.rejects(
    () =>
      transaction.run(async ({ stageCleanup, stageFinalizer }) => {
        events.push("mutate");
        stageCleanup(async () => {
          events.push("cleanup-1");
        });
        stageCleanup(async () => {
          events.push("cleanup-2");
        });
        stageFinalizer(async () => {
          events.push("finalizer");
        });
      }),
    /persist failed/
  );

  assert.deepEqual(events, ["capture", "mutate", "commit", "cleanup-2", "cleanup-1", "restore:snapshot"]);
});
