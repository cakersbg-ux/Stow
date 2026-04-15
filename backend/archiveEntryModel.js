const path = require("node:path");
const mime = require("mime-types");
const { normalizeEntrySummary } = require("./archiveQueryIndex");
const { normalizeArchiveDirectoryPath } = require("./archiveNamePolicy");

function entryFileName(entry, descriptor) {
  const baseName = entry.name.replace(path.extname(entry.name), "");
  const extension =
    descriptor.extension ||
    path.extname(entry.name) ||
    (mime.extension(descriptor.mime || "") ? `.${mime.extension(descriptor.mime)}` : "");
  return `${baseName}${extension}`;
}

function parentArchivePath(relativePath) {
  const parent = path.dirname(relativePath);
  return parent === "." ? "" : parent;
}

function folderName(relativePath) {
  const normalized = normalizeArchiveDirectoryPath(relativePath);
  return path.basename(normalized);
}

function parseFolderEntryId(entryId) {
  if (typeof entryId !== "string" || !entryId.startsWith("folder:")) {
    return null;
  }
  return entryId.slice("folder:".length);
}

function getLatestRevision(entry) {
  return entry.revisions.find((candidate) => candidate.id === entry.latestRevisionId) ?? entry.revisions[0] ?? null;
}

function artifactSignature(artifact) {
  if (!artifact) {
    return null;
  }
  return [artifact.contentHash, artifact.size, artifact.label, artifact.extension].join(":");
}

function artifactsEquivalent(left, right) {
  const leftSignature = artifactSignature(left);
  const rightSignature = artifactSignature(right);
  return Boolean(leftSignature && rightSignature && leftSignature === rightSignature);
}

function getRevisionSourceArtifact(revision) {
  if (revision?.sourceArtifact) {
    return revision.sourceArtifact;
  }
  if (revision?.originalArtifact && !artifactsEquivalent(revision.originalArtifact, revision.preferredArtifact)) {
    return revision.originalArtifact;
  }
  return null;
}

function getRevisionPreferredArtifact(revision) {
  return revision?.preferredArtifact ?? revision?.optimizedArtifact ?? revision?.originalArtifact ?? null;
}

function artifactExportOptionId(role, artifact) {
  return `${role}:${artifact?.label || "artifact"}:${artifact?.contentHash || ""}:${artifact?.size || 0}`;
}

function findArtifactCandidateMetric(revision, artifact) {
  const metrics = Array.isArray(revision?.optimizationDecision?.candidateMetrics)
    ? revision.optimizationDecision.candidateMetrics
    : [];
  return metrics.find((candidate) => candidate.label === artifact?.label) || null;
}

function buildExportOptionLabel(role, artifact, metric, isDefault) {
  if (isDefault) {
    return "Archived quality";
  }
  if (metric?.reversible) {
    return "Lower lossless variant";
  }
  return artifact?.label ? `Lower ${artifact.label} variant` : "Lower archived quality";
}

function buildExportOptionDescription(artifact, metric) {
  const parts = [];
  if (artifact?.extension) {
    parts.push(artifact.extension.replace(/^\./, "").toUpperCase());
  }
  if (typeof artifact?.size === "number" && Number.isFinite(artifact.size)) {
    parts.push(`${artifact.size} bytes`);
  }
  if (metric?.reversible) {
    parts.push("lossless");
  } else if (typeof metric?.estimatedQuality === "number" && Number.isFinite(metric.estimatedQuality)) {
    parts.push(`quality ${Math.round(metric.estimatedQuality)}`);
  }
  return parts.join(" · ");
}

function buildRevisionExportOptions(revision) {
  if (!revision) {
    return [];
  }

  const options = [];
  const preferredArtifact = getRevisionPreferredArtifact(revision);
  if (!preferredArtifact) {
    return [];
  }

  const additionalArtifacts = Array.isArray(revision.derivativeArtifacts) ? revision.derivativeArtifacts : [];
  const preferredMetric = findArtifactCandidateMetric(revision, preferredArtifact);
  const preferredQuality =
    typeof preferredMetric?.estimatedQuality === "number" && Number.isFinite(preferredMetric.estimatedQuality)
      ? preferredMetric.estimatedQuality
      : null;
  const preferredSize =
    typeof preferredArtifact.size === "number" && Number.isFinite(preferredArtifact.size)
      ? preferredArtifact.size
      : null;

  const pushOption = (role, artifact, isDefault = false) => {
    if (!artifact || options.some((candidate) => artifactsEquivalent(candidate.artifact, artifact))) {
      return;
    }
    const metric = findArtifactCandidateMetric(revision, artifact);
    options.push({
      id: artifactExportOptionId(role, artifact),
      role,
      label: buildExportOptionLabel(role, artifact, metric, isDefault),
      description: buildExportOptionDescription(artifact, metric),
      extension: artifact.extension || "",
      mime: artifact.mime || "",
      size: artifact.size,
      estimatedQuality: typeof metric?.estimatedQuality === "number" ? Math.round(metric.estimatedQuality) : null,
      reversible: Boolean(metric?.reversible),
      artifact
    });
  };

  pushOption("preferred", preferredArtifact, true);

  const lowerArtifacts = additionalArtifacts
    .filter((artifact) => !artifactsEquivalent(artifact, preferredArtifact))
    .map((artifact) => ({
      artifact,
      metric: findArtifactCandidateMetric(revision, artifact)
    }))
    .filter(({ artifact, metric }) => {
      const artifactQuality =
        typeof metric?.estimatedQuality === "number" && Number.isFinite(metric.estimatedQuality)
          ? metric.estimatedQuality
          : null;
      const artifactSize =
        typeof artifact.size === "number" && Number.isFinite(artifact.size)
          ? artifact.size
          : null;

      if (preferredQuality !== null && artifactQuality !== null) {
        return artifactQuality <= preferredQuality;
      }
      if (preferredSize !== null && artifactSize !== null) {
        return artifactSize <= preferredSize;
      }
      return true;
    })
    .sort((left, right) => {
      const leftQuality = typeof left.metric?.estimatedQuality === "number" ? left.metric.estimatedQuality : -1;
      const rightQuality = typeof right.metric?.estimatedQuality === "number" ? right.metric.estimatedQuality : -1;
      if (leftQuality !== rightQuality) {
        return rightQuality - leftQuality;
      }
      return (left.artifact.size || 0) - (right.artifact.size || 0);
    });

  for (const { artifact } of lowerArtifacts) {
    if (!artifactsEquivalent(artifact, preferredArtifact)) {
      pushOption("derivative", artifact);
    }
  }

  return options;
}

function buildEntryExportOptions(entry) {
  const latestRevision = getLatestRevision(entry);
  const options = buildRevisionExportOptions(latestRevision);
  return {
    options: options.map(({ artifact, ...option }) => option),
    defaultOptionId: options[0]?.id ?? null
  };
}

function getEntryDisplaySize(entry) {
  const latestRevision = getLatestRevision(entry);
  return getRevisionPreferredArtifact(latestRevision)?.size ?? getRevisionSourceArtifact(latestRevision)?.size ?? entry.size;
}

function getEntryPreviewKind(entry) {
  if (entry.fileKind === "image" || entry.fileKind === "video") {
    return entry.fileKind;
  }
  if (entry.mime === "image/jxl" || path.extname(entry.name).toLowerCase() === ".jxl") {
    return "image";
  }
  return null;
}

function buildLightweightEntry(entry) {
  const latestRevision = getLatestRevision(entry);
  return {
    id: entry.id,
    entryType: "file",
    name: entry.name,
    relativePath: entry.relativePath,
    fileKind: entry.fileKind,
    mime: entry.mime,
    size: getEntryDisplaySize(entry),
    sourceSize: entry.size,
    latestRevisionId: entry.latestRevisionId,
    overrideMode: latestRevision?.overrideMode ?? null,
    optimizationTier: latestRevision?.optimizationTier ?? null,
    optimizationState: latestRevision?.optimizationState ?? null,
    previewable: Boolean(getEntryPreviewKind(entry)),
    childCount: null
  };
}

function buildEntrySummary(entry) {
  const { entryType, childCount, ...summary } = buildLightweightEntry(entry);
  return summary;
}

function normalizePersistedSummaryEntries(summaryIndex) {
  if (!summaryIndex || typeof summaryIndex !== "object" || !summaryIndex.entries || typeof summaryIndex.entries !== "object") {
    return null;
  }
  const normalized = [];
  for (const value of Object.values(summaryIndex.entries)) {
    try {
      normalized.push(normalizeEntrySummary(value));
    } catch (_error) {
      return null;
    }
  }
  return normalized;
}

function buildEntryDetail(entry) {
  const latestRevision = getLatestRevision(entry);
  const sourceArtifact = getRevisionSourceArtifact(latestRevision);
  const preferredArtifact = getRevisionPreferredArtifact(latestRevision);
  const exportOptions = buildEntryExportOptions(entry);
  return {
    ...entry,
    size: getEntryDisplaySize(entry),
    sourceSize: entry.size,
    exportable: Boolean(preferredArtifact || sourceArtifact),
    exportOptions: exportOptions.options,
    defaultExportOptionId: exportOptions.defaultOptionId
  };
}

module.exports = {
  artifactExportOptionId,
  buildEntryDetail,
  buildEntryExportOptions,
  buildEntrySummary,
  buildLightweightEntry,
  entryFileName,
  folderName,
  getEntryDisplaySize,
  getEntryPreviewKind,
  getLatestRevision,
  getRevisionPreferredArtifact,
  getRevisionSourceArtifact,
  normalizePersistedSummaryEntries,
  parentArchivePath,
  parseFolderEntryId
};
