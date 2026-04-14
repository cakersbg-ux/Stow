import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppShellState, DetectedArchive } from "../../types";
import {
  compareArchiveItems,
  mergeArchiveItems,
  type ArchiveBrowserItem,
  type ArchiveSortMode
} from "../archive/archiveModel";

type UseArchiveBrowserArgs = {
  shellState: AppShellState;
  activeView: "hub" | "archive";
};

export function useArchiveBrowser({ shellState, activeView }: UseArchiveBrowserArgs) {
  const [archiveBrowserOpen, setArchiveBrowserOpen] = useState(false);
  const [archiveBrowserLoading, setArchiveBrowserLoading] = useState(false);
  const [archiveBrowserError, setArchiveBrowserError] = useState<string | null>(null);
  const [archiveBrowserSortMode, setArchiveBrowserSortMode] = useState<ArchiveSortMode>("recent_desc");
  const [detectedArchives, setDetectedArchives] = useState<DetectedArchive[]>([]);
  const [selectedArchiveBrowserPath, setSelectedArchiveBrowserPath] = useState("");

  const browserArchives = useMemo(() => {
    const merged = mergeArchiveItems(detectedArchives, shellState.recentArchives, shellState.archive);
    return merged.sort((a, b) => compareArchiveItems(a, b, archiveBrowserSortMode));
  }, [archiveBrowserSortMode, detectedArchives, shellState.archive, shellState.recentArchives]);

  const browserSelectedArchivePath =
    selectedArchiveBrowserPath && browserArchives.some((archive) => archive.path === selectedArchiveBrowserPath)
      ? selectedArchiveBrowserPath
      : browserArchives[0]?.path ?? "";

  const refreshDetectedArchives = useCallback(async () => {
    setArchiveBrowserLoading(true);
    setArchiveBrowserError(null);
    try {
      const detected = await window.stow.listDetectedArchives();
      setDetectedArchives(detected);
      if (!selectedArchiveBrowserPath) {
        setSelectedArchiveBrowserPath(
          shellState.archive?.path ?? detected[0]?.path ?? shellState.recentArchives[0]?.path ?? ""
        );
      }
    } catch (error) {
      setArchiveBrowserError(error instanceof Error ? error.message : "Failed to load archives");
    } finally {
      setArchiveBrowserLoading(false);
    }
  }, [selectedArchiveBrowserPath, shellState.archive?.path, shellState.recentArchives]);

  useEffect(() => {
    const nextPath = shellState.archive?.path ?? shellState.recentArchives[0]?.path ?? "";
    if (!nextPath) {
      return;
    }
    if (!selectedArchiveBrowserPath) {
      setSelectedArchiveBrowserPath(nextPath);
    }
  }, [selectedArchiveBrowserPath, shellState.archive?.path, shellState.recentArchives]);

  useEffect(() => {
    if (activeView !== "hub" && !archiveBrowserOpen) {
      return;
    }
    void refreshDetectedArchives();
  }, [activeView, archiveBrowserOpen, refreshDetectedArchives]);

  const openArchiveBrowser = useCallback(() => {
    setArchiveBrowserOpen(true);
    void refreshDetectedArchives();
  }, [refreshDetectedArchives]);

  const closeArchiveBrowser = useCallback(() => {
    setArchiveBrowserOpen(false);
  }, []);

  return {
    archiveBrowserOpen,
    archiveBrowserLoading,
    archiveBrowserError,
    archiveBrowserSortMode,
    selectedArchiveBrowserPath,
    browserArchives,
    browserSelectedArchivePath,
    setArchiveBrowserSortMode,
    setSelectedArchiveBrowserPath,
    refreshDetectedArchives,
    openArchiveBrowser,
    closeArchiveBrowser
  };
}
