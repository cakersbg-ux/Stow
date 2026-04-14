class ArchiveMutationTransaction {
  constructor({ captureSnapshot, restoreSnapshot, commitBoundary } = {}) {
    if (typeof captureSnapshot !== "function") {
      throw new TypeError("captureSnapshot must be a function");
    }
    if (typeof restoreSnapshot !== "function") {
      throw new TypeError("restoreSnapshot must be a function");
    }
    if (typeof commitBoundary !== "function") {
      throw new TypeError("commitBoundary must be a function");
    }

    this.captureSnapshot = captureSnapshot;
    this.restoreSnapshot = restoreSnapshot;
    this.commitBoundary = commitBoundary;
    this.cleanupSteps = [];
    this.finalizationSteps = [];
    this.snapshot = null;
    this.completed = false;
  }

  stageCleanup(step) {
    if (typeof step !== "function") {
      throw new TypeError("cleanup step must be a function");
    }
    this.cleanupSteps.push(step);
    return this;
  }

  stageFinalizer(step) {
    if (typeof step !== "function") {
      throw new TypeError("finalizer step must be a function");
    }
    this.finalizationSteps.push(step);
    return this;
  }

  async run(mutator) {
    if (this.completed) {
      throw new Error("Archive mutation transaction already completed");
    }
    if (typeof mutator !== "function") {
      throw new TypeError("mutator must be a function");
    }

    this.snapshot = await this.captureSnapshot();

    let result;
    try {
      result = await mutator({
        snapshot: this.snapshot,
        stageCleanup: this.stageCleanup.bind(this),
        stageFinalizer: this.stageFinalizer.bind(this)
      });
    } catch (error) {
      await this.rollback(error);
      throw error;
    }

    try {
      await this.commitBoundary({
        snapshot: this.snapshot,
        result
      });
    } catch (error) {
      await this.rollback(error);
      throw error;
    }

    this.completed = true;
    await this.finalize(result);
    return result;
  }

  async finalize(result) {
    const finalizerErrors = [];
    for (const step of this.finalizationSteps) {
      try {
        await step({
          snapshot: this.snapshot,
          result
        });
      } catch (error) {
        finalizerErrors.push(error);
      }
    }

    if (finalizerErrors.length === 1) {
      throw finalizerErrors[0];
    }
    if (finalizerErrors.length > 1) {
      throw new AggregateError(finalizerErrors, "Archive mutation finalization failed");
    }
  }

  // Rollback runs cleanup callbacks in reverse registration order before restoring the captured snapshot.
  async rollback(error) {
    const rollbackErrors = [];
    for (const step of [...this.cleanupSteps].reverse()) {
      try {
        await step({
          snapshot: this.snapshot,
          error
        });
      } catch (cleanupError) {
        rollbackErrors.push(cleanupError);
      }
    }

    try {
      await this.restoreSnapshot(this.snapshot, {
        error
      });
    } catch (restoreError) {
      rollbackErrors.push(restoreError);
    }

    if (rollbackErrors.length > 0) {
      error.rollbackErrors = rollbackErrors;
    }

    this.completed = true;
  }
}

function createArchiveMutationTransaction(options) {
  return new ArchiveMutationTransaction(options);
}

module.exports = {
  ArchiveMutationTransaction,
  createArchiveMutationTransaction
};
