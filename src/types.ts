export type UpscaleRoute = "photo_gentle" | "photo_general" | "art_clean" | "art_anime" | "text_ui";

export type Settings = {
  imageTargetResolution: "1080p" | "1440p" | "4k";
  videoTargetResolution: "1080p" | "1440p" | "4k";
  compressionBehavior: "fast" | "balanced" | "max";
  optimizationMode: "lossless" | "visually_lossless" | "pick_per_file";
  upscaleEnabled: boolean;
  videoUpscaleEnabled: boolean;
  videoInterpolationFrameTarget: "off" | "30" | "60" | "120";
  stripDerivativeMetadata: boolean;
  deleteOriginalFilesAfterSuccessfulUpload: boolean;
  argonProfile: "balanced" | "strong" | "constrained";
  preferredArchiveRoot: string;
  sessionIdleMinutes: number;
  sessionLockOnHide: boolean;
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

export type ArchiveRevision = {
  id: string;
  addedAt: string;
  source: {
    absolutePath: string;
    relativePath: string;
    size: number;
  } | null;
  media: {
    width?: number | null;
    height?: number | null;
    codec?: string | null;
  };
  overrideMode?: "lossless" | "visually_lossless" | null;
  routing: {
    route: UpscaleRoute;
    confidence: number;
    provider: string;
    alternatives: Array<{
      route: UpscaleRoute;
      score: number;
    }>;
  } | null;
  summary: string;
  actions: string[];
  originalArtifact: ArtifactDescriptor;
  optimizedArtifact?: ArtifactDescriptor | null;
};

export type ArchiveEntryListItem = {
  id: string;
  name: string;
  relativePath: string;
  fileKind: string;
  mime: string;
  size: number;
  latestRevisionId: string;
  overrideMode: "lossless" | "visually_lossless" | null;
  previewable: boolean;
};

export type ArchiveEntryDetail = {
  id: string;
  name: string;
  relativePath: string;
  fileKind: string;
  mime: string;
  size: number;
  createdAt: string;
  latestRevisionId: string;
  revisions: ArchiveRevision[];
  exportableVariants: {
    original: boolean;
    optimized: boolean;
  };
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
};

export type ManualRoutingItem = {
  absolutePath: string;
  relativePath: string;
  mediaType: "image" | "video";
  failureCode: "runtime_error" | "model_unavailable";
  reason: string;
  suggestedRoute: UpscaleRoute | null;
  choices: UpscaleRoute[];
};

export type ManualRoutingRequest = {
  items: ManualRoutingItem[];
};

export type AddPathsResult = {
  shellState: AppShellState;
  manualRoutingRequest: ManualRoutingRequest | null;
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
  session: ArchiveSessionInfo | null;
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
      pickDirectory: () => Promise<string | null>;
      pickFiles: () => Promise<string[]>;
      pickFilesOrFolders: () => Promise<string[]>;
      createArchive: (payload: {
        parentPath: string;
        name: string;
        password: string;
        preferences: Settings;
      }) => Promise<AppShellState>;
      openArchive: (payload: { archivePath: string; password: string }) => Promise<AppShellState>;
      closeArchive: () => Promise<AppShellState>;
      lockArchive: () => Promise<AppShellState>;
      setArchiveSessionPolicy: (payload: { idleMinutes: number | null; lockOnHide: boolean | null }) => Promise<AppShellState>;
      removeRecentArchive: (archivePath: string) => Promise<AppShellState>;
      deleteArchive: (archivePath: string) => Promise<AppShellState>;
      listDetectedArchives: () => Promise<DetectedArchive[]>;
      addPaths: (paths: string[], manualRoutes?: Record<string, UpscaleRoute>) => Promise<AddPathsResult>;
      listEntries: (payload: { offset: number; limit: number }) => Promise<{ total: number; items: ArchiveEntryListItem[] }>;
      getEntryDetail: (entryId: string) => Promise<ArchiveEntryDetail>;
      getArchiveStats: () => Promise<ArchiveStats>;
      reprocessEntry: (entryId: string, overrideMode: "lossless" | "visually_lossless", routeOverride?: UpscaleRoute | null) => Promise<AppShellState>;
      deleteEntry: (entryId: string) => Promise<AppShellState>;
      renameEntry: (entryId: string, name: string) => Promise<AppShellState>;
      exportEntry: (entryId: string, variant: "original" | "optimized") => Promise<AppShellState>;
      openEntryExternally: (entryId: string) => Promise<AppShellState>;
      resolveEntryPreview: (entryId: string, previewKind?: "thumbnail" | "preview") => Promise<PreviewDescriptor | null>;
    };
  }
}
