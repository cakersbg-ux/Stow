const path = require("node:path");

const INVALID_WINDOWS_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001F]/;
const RESERVED_WINDOWS_FILENAME_BASENAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9"
]);

function validateArchiveNameSegment(nextName, label) {
  const normalizedName = typeof nextName === "string" ? nextName.trim() : "";
  if (!normalizedName) {
    throw new Error(`${label} name is required`);
  }
  if (normalizedName === "." || normalizedName === "..") {
    throw new Error(`${label} name is invalid`);
  }
  if (normalizedName.includes("/") || normalizedName.includes("\\")) {
    throw new Error(`${label} name cannot include path separators`);
  }
  if (INVALID_WINDOWS_FILENAME_CHARS.test(normalizedName) || normalizedName.endsWith(".") || normalizedName.endsWith(" ")) {
    throw new Error(`${label} name is invalid on Windows`);
  }
  const baseName = normalizedName.split(".")[0].toUpperCase();
  if (RESERVED_WINDOWS_FILENAME_BASENAMES.has(baseName)) {
    throw new Error(`${label} name is reserved on Windows`);
  }
  return normalizedName;
}

function validateEntryRename(nextName) {
  return validateArchiveNameSegment(nextName, "File");
}

function validateArchiveName(name) {
  const normalizedName = validateEntryRename(name);
  if (normalizedName.endsWith(".stow")) {
    throw new Error("Archive name should not include the .stow suffix");
  }
  return normalizedName;
}

function normalizeArchiveRelativePath(relativePath) {
  if (typeof relativePath !== "string") {
    throw new Error("Archive path is required");
  }

  const normalized = path.normalize(relativePath);
  if (!normalized || normalized === "." || path.isAbsolute(normalized)) {
    throw new Error("Archive path is invalid");
  }

  const segments = normalized.split(path.sep);
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Archive path is invalid");
  }

  return normalized;
}

function normalizeArchiveDirectoryPath(directoryPath, { allowRoot = false } = {}) {
  if (directoryPath === "" || directoryPath === null || typeof directoryPath === "undefined") {
    if (allowRoot) {
      return "";
    }
    throw new Error("Folder path is required");
  }

  const normalized = normalizeArchiveRelativePath(directoryPath);
  return normalized === "." ? "" : normalized;
}

function validateArchiveDirectoryNames(directoryPath) {
  const normalized = normalizeArchiveDirectoryPath(directoryPath);
  for (const segment of normalized.split(path.sep)) {
    validateArchiveNameSegment(segment, "Folder");
  }
  return normalized;
}

module.exports = {
  INVALID_WINDOWS_FILENAME_CHARS,
  RESERVED_WINDOWS_FILENAME_BASENAMES,
  normalizeArchiveDirectoryPath,
  normalizeArchiveRelativePath,
  validateArchiveDirectoryNames,
  validateArchiveName,
  validateArchiveNameSegment,
  validateEntryRename
};
