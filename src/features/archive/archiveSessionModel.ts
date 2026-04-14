import type { ArchiveEntryListItem } from "../../types";

export type RefreshSelectionState = {
  selectedIds: Set<string>;
  focusedId: string | null;
  lastClickedId: string | null;
};

export function resolveRefreshSelection(entries: ArchiveEntryListItem[], preferredSelectedId: string | null): RefreshSelectionState {
  const preferred = preferredSelectedId ? entries.find((entry) => entry.id === preferredSelectedId) ?? null : null;
  if (preferred) {
    return {
      selectedIds: new Set([preferred.id]),
      focusedId: preferred.id,
      lastClickedId: preferred.id
    };
  }

  const firstFile = entries.find((entry) => entry.entryType === "file");
  if (firstFile) {
    return {
      selectedIds: new Set([firstFile.id]),
      focusedId: firstFile.id,
      lastClickedId: firstFile.id
    };
  }

  return {
    selectedIds: new Set(),
    focusedId: null,
    lastClickedId: null
  };
}
