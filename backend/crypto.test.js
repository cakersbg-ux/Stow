const test = require("node:test");
const assert = require("node:assert/strict");
const { mock } = require("node:test");
const hashWasm = require("hash-wasm");
const sodium = require("libsodium-wrappers-sumo");

function loadFreshCrypto() {
  delete require.cache[require.resolve("./crypto")];
  return require("./crypto");
}

test.afterEach(() => {
  mock.restoreAll();
  delete require.cache[require.resolve("./crypto")];
});

test("crypto helpers zeroize shared buffer views", () => {
  const crypto = loadFreshCrypto();
  const source = new Uint8Array([1, 2, 3, 4]);
  const view = crypto.__test__.toBufferView(source);

  assert.ok(Buffer.isBuffer(view));
  view[1] = 9;
  assert.equal(source[1], 9);

  crypto.__test__.zeroizeBuffer(view);

  assert.deepEqual(Array.from(source), [0, 0, 0, 0]);
});

test("createArchiveEncryption zeroizes transient secret buffers", async () => {
  await sodium.ready;
  const saltBytes = new Uint8Array(16).fill(1);
  const archiveKeyBytes = new Uint8Array(32).fill(2);
  const nonceBytes = new Uint8Array(24).fill(3);
  const passwordKeyBytes = new Uint8Array([4, 5, 6, 7]);
  const ciphertextBytes = new Uint8Array([8, 9, 10, 11]);
  const expectedCiphertextBase64 = Buffer.from(ciphertextBytes).toString("base64");
  let randomCall = 0;
  let capturedPasswordKey = null;

  mock.method(hashWasm, "argon2id", async (options) => {
    assert.equal(typeof options.salt, "object");
    assert.ok(ArrayBuffer.isView(options.salt));
    return passwordKeyBytes;
  });
  mock.method(sodium, "randombytes_buf", (length) => {
    randomCall += 1;
    if (randomCall === 1) {
      assert.equal(length, 16);
      return saltBytes;
    }
    if (randomCall === 2) {
      assert.equal(length, 32);
      return archiveKeyBytes;
    }
    if (randomCall === 3) {
      assert.equal(length, 24);
      return nonceBytes;
    }
    throw new Error(`unexpected randombytes_buf call ${randomCall}`);
  });
  mock.method(sodium, "crypto_aead_xchacha20poly1305_ietf_encrypt", (plaintext, _aad, _nsec, nonce, key) => {
    assert.ok(Buffer.isBuffer(plaintext));
    assert.ok(Buffer.isBuffer(nonce));
    capturedPasswordKey = key;
    return ciphertextBytes;
  });

  const crypto = loadFreshCrypto();
  const encryption = await crypto.createArchiveEncryption("password", "balanced");

  assert.equal(encryption.header.wrap.ciphertext, expectedCiphertextBase64);
  assert.deepEqual(Array.from(saltBytes), new Array(saltBytes.length).fill(0));
  assert.deepEqual(Array.from(nonceBytes), new Array(nonceBytes.length).fill(0));
  assert.deepEqual(Array.from(passwordKeyBytes), new Array(passwordKeyBytes.length).fill(0));
  assert.deepEqual(Array.from(ciphertextBytes), new Array(ciphertextBytes.length).fill(0));
  assert.ok(capturedPasswordKey);
  assert.deepEqual(Array.from(capturedPasswordKey), new Array(capturedPasswordKey.length).fill(0));
});

test("public encrypt and decrypt APIs still round-trip", async () => {
  await sodium.ready;
  const crypto = loadFreshCrypto();
  const encryption = await crypto.createArchiveEncryption("password", "balanced");
  const unlocked = await crypto.unlockArchiveKey("password", encryption.header);
  const payload = Buffer.from("payload bytes", "utf8");
  const encrypted = await crypto.encryptPayload(payload, encryption.archiveKey);
  const decrypted = await crypto.decryptPayload(encrypted, encryption.archiveKey);

  assert.equal(unlocked.toString("hex"), encryption.archiveKey.toString("hex"));
  assert.equal(decrypted.toString("utf8"), payload.toString("utf8"));
});
