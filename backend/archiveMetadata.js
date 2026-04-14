const { validate: isUuid } = require("uuid");
const {
  assertValidStorageId
} = require("./archivePathSafety");
const {
  normalizeArchiveRelativePath,
  validateArchiveNameSegment
} = require("./archiveNamePolicy");

const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/;
const CHUNK_HASH_PATTERN = CONTENT_HASH_PATTERN;

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function assertOptionalString(value, label) {
  if (value === null || typeof value === "undefined") {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function assertNonNegativeNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return value;
}

function validateChunkReference(chunk, index, artifactLabel) {
  assertPlainObject(chunk, `${artifactLabel} chunk ${index}`);
  if (!CHUNK_HASH_PATTERN.test(assertNonEmptyString(chunk.hash, `${artifactLabel} chunk ${index} hash`))) {
    throw new Error(`${artifactLabel} chunk ${index} hash is invalid`);
  }
  assertNonNegativeNumber(chunk.size, `${artifactLabel} chunk ${index} size`);
  return {
    hash: chunk.hash,
    size: chunk.size
  };
}

function validateArtifactDescriptor(descriptor, label) {
  const artifact = assertPlainObject(descriptor, label);
  const mime = assertNonEmptyString(artifact.mime, `${label} mime`);
  const extension = assertOptionalString(artifact.extension, `${label} extension`) ?? "";
  const actions = Array.isArray(artifact.actions) ? artifact.actions.map((action, index) => assertNonEmptyString(action, `${label} action ${index}`)) : undefined;

  if (!CONTENT_HASH_PATTERN.test(assertNonEmptyString(artifact.contentHash, `${label} content hash`))) {
    throw new Error(`${label} content hash is invalid`);
  }
  if (!Array.isArray(artifact.chunks) || artifact.chunks.length === 0) {
    throw new Error(`${label} chunks must be a non-empty array`);
  }

  return {
    ...artifact,
    label: assertNonEmptyString(artifact.label, `${label} label`),
    extension,
    mime,
    size: assertNonNegativeNumber(artifact.size, `${label} size`),
    contentHash: artifact.contentHash,
    chunks: artifact.chunks.map((chunk, index) => validateChunkReference(chunk, index, label)),
    ...(actions ? { actions } : {})
  };
}

function validateRevisionRecord(revision, index) {
  const normalizedRevision = assertPlainObject(revision, `revision ${index}`);
  if (!isUuid(assertNonEmptyString(normalizedRevision.id, `revision ${index} id`))) {
    throw new Error(`revision ${index} id must be a UUID`);
  }
  const source =
    normalizedRevision.source === null
      ? null
      : {
          relativePath: normalizeArchiveRelativePath(assertNonEmptyString(normalizedRevision.source?.relativePath, `revision ${index} source path`)),
          size: assertNonNegativeNumber(normalizedRevision.source?.size, `revision ${index} source size`)
        };
  const overrideMode =
    normalizedRevision.overrideMode === null || typeof normalizedRevision.overrideMode === "undefined"
      ? null
      : (() => {
          const value = assertNonEmptyString(normalizedRevision.overrideMode, `revision ${index} override mode`);
          if (!["lossless", "visually_lossless", "lossy_balanced", "lossy_aggressive"].includes(value)) {
            throw new Error(`revision ${index} override mode is invalid`);
          }
          return value;
        })();
  const optimizationTier =
    normalizedRevision.optimizationTier === null || typeof normalizedRevision.optimizationTier === "undefined"
      ? overrideMode
      : (() => {
          const value = assertNonEmptyString(normalizedRevision.optimizationTier, `revision ${index} optimization tier`);
          if (!["lossless", "visually_lossless", "lossy_balanced", "lossy_aggressive"].includes(value)) {
            throw new Error(`revision ${index} optimization tier is invalid`);
          }
          return value;
        })();
  const artifactRetentionPolicy =
    normalizedRevision.artifactRetentionPolicy === null || typeof normalizedRevision.artifactRetentionPolicy === "undefined"
      ? null
      : (() => {
          const value = assertNonEmptyString(normalizedRevision.artifactRetentionPolicy, `revision ${index} artifact retention policy`);
          if (!["keep_source", "drop_source_after_optimize"].includes(value)) {
            throw new Error(`revision ${index} artifact retention policy is invalid`);
          }
          return value;
        })();
  const optimizationState =
    normalizedRevision.optimizationState === null || typeof normalizedRevision.optimizationState === "undefined"
      ? null
      : (() => {
          const value = assertNonEmptyString(normalizedRevision.optimizationState, `revision ${index} optimization state`);
          if (!["pending_optimization", "optimized", "failed"].includes(value)) {
            throw new Error(`revision ${index} optimization state is invalid`);
          }
          return value;
        })();
  const sourceArtifact =
    normalizedRevision.sourceArtifact === null || typeof normalizedRevision.sourceArtifact === "undefined"
      ? null
      : validateArtifactDescriptor(normalizedRevision.sourceArtifact, `revision ${index} source artifact`);
  const preferredArtifact =
    normalizedRevision.preferredArtifact === null || typeof normalizedRevision.preferredArtifact === "undefined"
      ? null
      : validateArtifactDescriptor(normalizedRevision.preferredArtifact, `revision ${index} preferred artifact`);
  const legacyOriginalArtifact =
    normalizedRevision.originalArtifact === null || typeof normalizedRevision.originalArtifact === "undefined"
      ? null
      : validateArtifactDescriptor(normalizedRevision.originalArtifact, `revision ${index} original artifact`);
  const legacyOptimizedArtifact =
    normalizedRevision.optimizedArtifact === null || typeof normalizedRevision.optimizedArtifact === "undefined"
      ? null
      : validateArtifactDescriptor(normalizedRevision.optimizedArtifact, `revision ${index} optimized artifact`);
  const resolvedSourceArtifact = sourceArtifact || null;
  const resolvedPreferredArtifact =
    preferredArtifact || legacyOptimizedArtifact || legacyOriginalArtifact || null;
  const actions = Array.isArray(normalizedRevision.actions)
    ? normalizedRevision.actions.map((action, actionIndex) => assertNonEmptyString(action, `revision ${index} action ${actionIndex}`))
    : [];

  return {
    ...normalizedRevision,
    id: normalizedRevision.id,
    addedAt: assertNonEmptyString(normalizedRevision.addedAt, `revision ${index} addedAt`),
    source,
    media: normalizedRevision.media && typeof normalizedRevision.media === "object" && !Array.isArray(normalizedRevision.media)
      ? normalizedRevision.media
      : {},
    overrideMode,
    optimizationTier,
    artifactRetentionPolicy,
    optimizationState,
    summary: assertNonEmptyString(normalizedRevision.summary, `revision ${index} summary`),
    actions,
    sourceArtifact: resolvedSourceArtifact,
    preferredArtifact: resolvedPreferredArtifact,
    derivativeArtifacts: Array.isArray(normalizedRevision.derivativeArtifacts)
      ? normalizedRevision.derivativeArtifacts.map((artifact, artifactIndex) =>
          validateArtifactDescriptor(artifact, `revision ${index} derivative artifact ${artifactIndex}`)
        )
      : [],
    originalArtifact: resolvedSourceArtifact || legacyOriginalArtifact || resolvedPreferredArtifact,
    optimizedArtifact: resolvedSourceArtifact && resolvedPreferredArtifact && resolvedPreferredArtifact !== resolvedSourceArtifact
      ? resolvedPreferredArtifact
      : null
  };
}

function validateEntryRecord(entry) {
  const normalizedEntry = assertPlainObject(entry, "archive entry");
  const id = assertNonEmptyString(normalizedEntry.id, "archive entry id");
  if (!isUuid(id)) {
    throw new Error("archive entry id must be a UUID");
  }
  const relativePath = normalizeArchiveRelativePath(assertNonEmptyString(normalizedEntry.relativePath, "archive entry relativePath"));
  const name = validateArchiveNameSegment(assertNonEmptyString(normalizedEntry.name, "archive entry name"), "File");
  if (!relativePath.endsWith(name)) {
    throw new Error("archive entry relativePath must end with the entry name");
  }
  if (!Array.isArray(normalizedEntry.revisions) || normalizedEntry.revisions.length === 0) {
    throw new Error("archive entry revisions must be a non-empty array");
  }
  const latestRevisionId = assertNonEmptyString(normalizedEntry.latestRevisionId, "archive entry latestRevisionId");
  const revisions = normalizedEntry.revisions.map((revision, index) => validateRevisionRecord(revision, index));
  if (!revisions.some((revision) => revision.id === latestRevisionId)) {
    throw new Error("archive entry latestRevisionId must match one of the stored revisions");
  }

  return {
    ...normalizedEntry,
    id,
    name,
    relativePath,
    fileKind: assertNonEmptyString(normalizedEntry.fileKind, "archive entry fileKind"),
    mime: assertOptionalString(normalizedEntry.mime, "archive entry mime"),
    size: assertNonNegativeNumber(normalizedEntry.size, "archive entry size"),
    createdAt: assertNonEmptyString(normalizedEntry.createdAt, "archive entry createdAt"),
    latestRevisionId,
    revisions
  };
}

function validateObjectRecord(object, hash) {
  const normalizedObject = assertPlainObject(object, `archive object ${hash}`);
  if (!CONTENT_HASH_PATTERN.test(hash)) {
    throw new Error(`archive object hash ${hash} is invalid`);
  }
  if (normalizedObject.hash && normalizedObject.hash !== hash) {
    throw new Error(`archive object ${hash} hash does not match its bucket key`);
  }

  return {
    ...normalizedObject,
    hash,
    storageId: assertValidStorageId(normalizedObject.storageId),
    size: assertNonNegativeNumber(normalizedObject.size, `archive object ${hash} size`),
    storedSize: assertNonNegativeNumber(normalizedObject.storedSize, `archive object ${hash} storedSize`),
    refCount: assertNonNegativeNumber(normalizedObject.refCount, `archive object ${hash} refCount`),
    compression: assertPlainObject(normalizedObject.compression, `archive object ${hash} compression`),
    crypto: assertPlainObject(normalizedObject.crypto, `archive object ${hash} crypto`)
  };
}

function validateObjectBucketCatalog(bucket, expectedPrefix) {
  const normalizedBucket = assertPlainObject(bucket, `object bucket ${expectedPrefix}`);
  const objects = assertPlainObject(normalizedBucket.objects || {}, `object bucket ${expectedPrefix} objects`);
  const normalizedObjects = {};
  for (const [hash, object] of Object.entries(objects)) {
    normalizedObjects[hash] = validateObjectRecord(object, hash);
  }

  return {
    version: normalizedBucket.version ?? 1,
    prefix: expectedPrefix,
    objects: normalizedObjects
  };
}

module.exports = {
  validateEntryRecord,
  validateObjectBucketCatalog
};
