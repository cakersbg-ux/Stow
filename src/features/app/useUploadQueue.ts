import { useCallback, useEffect, useRef } from "react";
import type { AppShellState } from "../../types";

type RunTask = (label: string, task: () => Promise<AppShellState | void>) => Promise<void>;

type UseUploadQueueArgs = {
  uiLocked: boolean;
  runTask: RunTask;
  applyShellState: (next: AppShellState) => void;
  setStatus: (next: string) => void;
};

export function useUploadQueue({ uiLocked, runTask, applyShellState, setStatus }: UseUploadQueueArgs) {
  const queueRef = useRef<Array<[string[], string]>>([]);
  const runningRef = useRef(false);

  const drain = useCallback(async () => {
    if (runningRef.current || !queueRef.current.length) {
      return;
    }
    runningRef.current = true;
    try {
      await runTask("Adding files…", async () => {
        while (queueRef.current.length) {
          const batch = queueRef.current.shift();
          if (!batch) {
            break;
          }
          const [paths, dest] = batch;
          const next = await window.stow.addPaths(paths, dest);
          applyShellState(next);
        }
      });
    } finally {
      runningRef.current = false;
    }
  }, [applyShellState, runTask]);

  const queueUpload = useCallback(
    (paths: string[], dest = "") => {
      queueRef.current.push([paths, dest]);
      if (uiLocked) {
        setStatus(`Queued ${paths.length} file${paths.length === 1 ? "" : "s"}`);
        return;
      }
      void drain();
    },
    [drain, setStatus, uiLocked]
  );

  useEffect(() => {
    if (!uiLocked && queueRef.current.length) {
      void drain();
    }
  }, [drain, uiLocked]);

  return {
    queueUpload
  };
}
