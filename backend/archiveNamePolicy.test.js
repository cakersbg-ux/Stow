const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeArchiveDirectoryPath,
  normalizeArchiveRelativePath,
  validateArchiveDirectoryNames,
  validateArchiveName,
  validateEntryRename
} = require("./archiveNamePolicy");

test("archive name policy rejects invalid Windows names and separators", () => {
  assert.equal(validateArchiveName("My Archive"), "My Archive");
  assert.equal(validateEntryRename("photo.jpg"), "photo.jpg");
  assert.equal(normalizeArchiveRelativePath("folder/note.txt"), "folder/note.txt");
  assert.equal(normalizeArchiveDirectoryPath("folder/sub"), "folder/sub");
  assert.equal(validateArchiveDirectoryNames("folder/sub"), "folder/sub");

  assert.throws(() => validateEntryRename("bad<name>.txt"), /Windows/);
  assert.throws(() => validateArchiveName("AUX"), /reserved/);
  assert.throws(() => validateArchiveDirectoryNames("folder/CON"), /reserved/);
  assert.throws(() => normalizeArchiveRelativePath("../escape"), /invalid/);
  assert.throws(() => normalizeArchiveDirectoryPath("/absolute"), /invalid/);
});
