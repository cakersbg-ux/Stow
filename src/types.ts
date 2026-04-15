export type Settings = {
  compressionBehavior: "fast" | "balanced" | "max";
  optimizationTier: "lossless" | "visually_lossless" | "lossy_balanced" | "lossy_aggressive";
  optimizationMode?: "lossless" | "visually_lossless" | "lossy_balanced" | "lossy_aggressive" | "pick_per_file";
  stripDerivativeMetadata: boolean;
  deleteOriginalFilesAfterSuccessfulUpload: boolean;
  argonProfile: "balanced" | "strong" | "constrained";
  preferredArchiveRoot: string;
  themePreference: "system" | "light" | "dark";
  sessionIdleMinutes: number;
  sessionLockOnHide: boolean;
  developerActivityLogEnabled: boolean;
};

export type ArchivePreferences = {
  compressionBehavior: Settings["compressionBehavior"];
  optimizationTier?: Settings["optimizationTier"];
  optimizationMode?: Settings["optimizationMode"];
  stripDerivativeMetadata: Settings["stripDerivativeMetadata"];
};

export type RecentArchive = {
  path: string;
  name: string;
  lastOpenedAt: string;
};

export type DetectedArchive = {
  path: string;
  name: string;
  lastModifiedAt: string;
  sizeBytes: number;
};

export type Capability = {
  available: boolean;
  version?: string | null;
  path?: string | null;
  reason?: string;
  value?: string | null;
};

export type InstallStatus = {
  active: boolean;
  phase: "checking" | "installing" | "complete";
  message: string;
  currentTarget: string | null;
  completedSteps: number;
  totalSteps: number;
  installed: string[];
  skipped: string[];
};

export type ArchiveProgress = {
  active: boolean;
  phase: "preparing" | "processing";
  currentFile: string | null;
  completedFiles: number;
  totalFiles: number | null;
};

export type ArtifactDescriptor = {
  label: string;
  extension: string;
  mime: string;
  size: number;
  contentHash: string;
  chunks: Array<{ hash: string; size: number }>;
  actions?: string[];
};

export type ExportArtifactOption = {
  id: string;
  role: "source" | "preferred" | "derivative";
  label: string;
  description: string;
  extension: string;
  mime: string;
  size: number;
  estimatedQuality: number | null;
  reversible: boolean;
};

export type ExportPlanEntry = {
  entryId: string;
  exportOptionId?: string | null;
};

export type ExportRequest = {
  destination: string;
  entries: ExportPlanEntry[];
  preservePaths?: boolean;
  removeFromArchive?: boolean;
};

export type ArchiveRevision = {
  id: string;
  addedAt: string;
  source: {
    relativePath: string;
    size: number;
  } | null;
  media: {
    width?: number | null;
    height?: number | null;
    codec?: string | null;
  };
  overrideMode?: "lossless" | "visually_lossless" | "lossy_balanced" | "lossy_aggressive" | null;
  optimizationTier?: "lossless" | "visually_lossless" | "lossy_balanced" | "lossy_aggressive" | null;
  artifactRetentionPolicy?: "keep_source" | "drop_source_after_optimize" | null;
  optimizationState?: "pending_optimization" | "optimized" | "failed" | null;
  optimizationDecision?: {
    plannerVersion: string;
    selectedCandidateId: string | null;
    candidateMetrics: Array<{
      id: string;
      label: string;
      size: number;
      estimatedQuality: number;
      reversible: boolean;
      accepted: boolean;
      reason?: string;
    }>;
    sourceSummary: string;
  } | null;
  summary: string;
  actions: string[];
  sourceArtifact?: ArtifactDescriptor | null;
  preferredArtifact?: ArtifactDescriptor | null;
  derivativeArtifacts?: ArtifactDescriptor[];
  originalArtifact?: ArtifactDescriptor;
  optimizedArtifact?: ArtifactDescriptor | null;
};

export type ArchiveEntryListItem = {
  id: string;
  entryType: "file" | "folder";
  name: string;
  relativePath: string;
  fileKind: string;
  mime: string | null;
  size: number | null;
  sourceSize: number | null;
  latestRevisionId: string | null;
  overrideMode: "lossless" | "visually_lossless" | "lossy_balanced" | "lossy_aggressive" | null;
  optimizationState?: "pending_optimization" | "optimized" | "failed" | null;
  previewable: boolean;
  childCount: number | null;
};

export type ArchiveEntryDetail = {
  id: string;
  name: string;
  relativePath: string;
  fileKind: string;
  mime: string;
  size: number;
  sourceSize: number;
  createdAt: string;
  latestRevisionId: string;
  revisions: ArchiveRevision[];
  exportable: boolean;
  exportOptions: ExportArtifactOption[];
  defaultExportOptionId: string | null;
  optimizationState?: "pending_optimization" | "optimized" | "failed" | null;
};

export type ArchiveStats = {
  entryCount: number;
  storedObjectCount: number;
  logicalBytes: number;
  storedBytes: number;
  updatedAt: string;
};

export type PreviewDescriptor = {
  path: string;
  mime: string;
  revisionId: string;
  kind: "thumbnail" | "preview";
  updatedAt?: string;
};

export type ArchiveSessionInfo = {
  startedAt: string;
  lastActivityAt: string;
  expiresAt: string | null;
  archivePolicy: {
    idleMinutes: number | null;
    lockOnHide: boolean | null;
  };
  effectivePolicy: {
    idleMinutes: number;
    lockOnHide: boolean;
  };
};

export type ArchiveSummary = {
  archiveId: string;
  name: string;
  path: string;
  unlocked: boolean;
  entryCount: number;
  storedObjectCount: number;
  logicalBytes: number;
  storedBytes: number;
  updatedAt: string;
  preferences: ArchivePreferences;
  session: ArchiveSessionInfo | null;
  folders: string[];
};

export type AppShellState = {
  settings: Settings;
  hasConfiguredDefaults: boolean;
  capabilities: Record<string, Capability>;
  installStatus: InstallStatus;
  recentArchives: RecentArchive[];
  archive: {
    path: string;
    unlocked: boolean;
    summary: ArchiveSummary | null;
    session: ArchiveSessionInfo | null;
  } | null;
  logs: string[];
};

declare global {
  interface Window {
    stow: {
      getShellState: () => Promise<AppShellState>;
      onShellStateChange: (listener: (state: AppShellState) => void) => () => void;
      onArchiveProgress: (listener: (progress: ArchiveProgress) => void) => () => void;
      onEntriesInvalidated: (listener: (payload: { archiveId: string; reason: string; selectedEntryId: string | null }) => void) => () => void;
      saveSettings: (settings: Settings) => Promise<AppShellState>;
      resetSettings: () => Promise<AppShellState>;
      installMissingTools: () => Promise<AppShellState>;
      pickDirectory: () => Promise<string | null>;
      pickFiles: () => Promise<string[]>;
      pickFilesOrFolders: () => Promise<string[]>;
      setArchivePreferences: (preferences: ArchivePreferences) => Promise<AppShellState>;
      createArchive: (payload: {
        parentPath: string;
        name: string;
        password: string;
        preferences: ArchivePreferences;
      }) => Promise<AppShellState>;
      openArchive: (payload: { archivePath: string; password: string }) => Promise<AppShellState>;
      closeArchive: () => Promise<AppShellState>;
      lockArchive: () => Promise<AppShellState>;
      setArchiveSessionPolicy: (payload: { idleMinutes: number | null; lockOnHide: boolean | null }) => Promise<AppShellState>;
      removeRecentArchive: (archivePath: string) => Promise<AppShellState>;
      deleteArchive: (archivePath: string) => Promise<AppShellState>;
      listDetectedArchives: () => Promise<DetectedArchive[]>;
      addPaths: (paths: string[], destinationDirectory?: string) => Promise<AppShellState>;
      listEntries: (payload: {
        directory?: string;
        offset: number;
        limit: number;
        sortColumn?: "name" | "type" | "size";
        sortDirection?: "asc" | "desc";
      }) => Promise<{ total: number; items: ArchiveEntryListItem[] }>;
      getEntryDetail: (entryId: string) => Promise<ArchiveEntryDetail>;
      getArchiveStats: () => Promise<ArchiveStats>;
      reprocessEntry: (entryId: string, overrideMode: "lossless" | "visually_lossless" | "lossy_balanced" | "lossy_aggressive") => Promise<AppShellState>;
      deleteEntry: (entryId: string) => Promise<AppShellState>;
      deleteFolder: (relativePath: string) => Promise<AppShellState>;
      renameEntry: (entryId: string, name: string) => Promise<AppShellState>;
      createFolder: (payload: { relativePath: string }) => Promise<AppShellState>;
      moveEntry: (payload: { entryId: string; destinationDirectory: string }) => Promise<AppShellState>;
      deleteEntries: (entryIds: string[]) => Promise<AppShellState>;
      moveEntries: (payload: { entryIds: string[]; destinationDirectory: string }) => Promise<AppShellState>;
      exportEntries: (request: ExportRequest) => Promise<AppShellState>;
      exportEntry: (request: ExportRequest) => Promise<AppShellState>;
      openEntryExternally: (entryId: string) => Promise<AppShellState>;
      resolveEntryPreview: (entryId: string, previewKind?: "thumbnail" | "preview") => Promise<PreviewDescriptor | null>;
      onDragDrop: (listener: (payload: { paths: string[]; position: { x: number; y: number } }) => void) => () => void;
      onDragEnter: (listener: (payload: { paths: string[]; position: { x: number; y: number } }) => void) => () => void;
      onDragLeave: (listener: () => void) => () => void;
    };
  }
}
