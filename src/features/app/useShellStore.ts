import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { AppShellState, ArchiveProgress, ArchivePreferences, Settings } from "../../types";
import {
  defaultArchivePreferences,
  defaultSettings,
  defaultShellState,
  mergePrefs,
  toArchivePreferences
} from "../archive/archiveModel";

export type ArchiveEntriesInvalidatedPayload = {
  archiveId: string;
  reason: string;
  selectedEntryId: string | null;
};

type RunTask = (label: string, task: () => Promise<AppShellState | void>) => Promise<void>;

export type ShellStore = {
  shellState: AppShellState;
  draftSettings: Settings;
  draftArchivePreferences: ArchivePreferences;
  progress: ArchiveProgress | null;
  status: string;
  isBusy: boolean;
  entriesInvalidated: ArchiveEntriesInvalidatedPayload | null;
  applyShellState: (next: AppShellState) => void;
  applyArchivePreferences: (next: ArchivePreferences) => void;
  setDraftSettings: Dispatch<SetStateAction<Settings>>;
  setDraftArchivePreferences: Dispatch<SetStateAction<ArchivePreferences>>;
  setStatus: Dispatch<SetStateAction<string>>;
  runTask: RunTask;
};

export function useShellStore(): ShellStore {
  const [shellState, setShellState] = useState<AppShellState>(defaultShellState);
  const [draftSettings, setDraftSettings] = useState<Settings>(defaultSettings);
  const [draftArchivePreferences, setDraftArchivePreferences] = useState<ArchivePreferences>(defaultArchivePreferences);
  const [progress, setProgress] = useState<ArchiveProgress | null>(null);
  const [status, setStatus] = useState("Ready");
  const [isBusy, setIsBusy] = useState(false);
  const [entriesInvalidated, setEntriesInvalidated] = useState<ArchiveEntriesInvalidatedPayload | null>(null);
  const wasInstallActiveRef = useRef(shellState.installStatus.active);

  const applyShellState = useCallback((next: AppShellState) => {
    setShellState(next);
    setDraftSettings(next.settings);
    if (next.archive?.summary?.preferences) {
      setDraftArchivePreferences(next.archive.summary.preferences);
    }
  }, []);

  const applyArchivePreferences = useCallback((next: ArchivePreferences) => {
    setDraftArchivePreferences(next);
    setDraftSettings((current) => mergePrefs(current, next));
  }, []);

  const runTask = useCallback<RunTask>(async (label, task) => {
    setIsBusy(true);
    setStatus(label);
    try {
      const maybeState = await task();
      if (maybeState) {
        applyShellState(maybeState);
      }
      setStatus("Ready");
    } catch (error) {
      const detail =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "";
      setStatus(detail ? `${label.replace(/…$/, "")} failed: ${detail}` : `${label} failed`);
    } finally {
      setIsBusy(false);
    }
  }, [applyShellState]);

  useEffect(() => {
    let cancelled = false;
    const unsubShell = window.stow.onShellStateChange((next) => {
      if (!cancelled) {
        applyShellState(next);
      }
    });
    const unsubProgress = window.stow.onArchiveProgress((next) => {
      if (!cancelled) {
        setProgress(next.active ? next : null);
      }
    });
    const unsubInvalidated = window.stow.onEntriesInvalidated((payload) => {
      if (!cancelled) {
        setEntriesInvalidated(payload);
      }
    });

    void window.stow.getShellState().then((next) => {
      if (cancelled) return;
      applyShellState(next);
      setDraftSettings(next.settings);
      setDraftArchivePreferences(toArchivePreferences(next.settings));
      wasInstallActiveRef.current = next.installStatus.active;
    });

    return () => {
      cancelled = true;
      unsubShell();
      unsubProgress();
      unsubInvalidated();
    };
  }, [applyShellState]);

  useEffect(() => {
    if (shellState.installStatus.active) {
      setStatus(shellState.installStatus.message);
      wasInstallActiveRef.current = true;
      return;
    }

    if (wasInstallActiveRef.current) {
      setStatus(shellState.installStatus.skipped.length ? "Tooling setup finished with warnings" : "Ready");
      wasInstallActiveRef.current = false;
    }
  }, [shellState.installStatus.active, shellState.installStatus.message, shellState.installStatus.skipped.length]);

  return {
    shellState,
    draftSettings,
    draftArchivePreferences,
    progress,
    status,
    isBusy,
    entriesInvalidated,
    applyShellState,
    applyArchivePreferences,
    setDraftSettings,
    setDraftArchivePreferences,
    setStatus,
    runTask
  };
}
