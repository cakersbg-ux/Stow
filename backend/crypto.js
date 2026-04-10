const sodium = require("libsodium-wrappers-sumo");
const { argon2id } = require("hash-wasm");

function toBase64(value) {
  return Buffer.from(value).toString("base64");
}

function fromBase64(value) {
  return Buffer.from(value, "base64");
}

async function derivePasswordKey(password, salt, profile) {
  const paramsByProfile = {
    balanced: { iterations: 3, memorySize: 65536, parallelism: 1 },
    strong: { iterations: 4, memorySize: 262144, parallelism: 1 },
    constrained: { iterations: 3, memorySize: 19456, parallelism: 1 }
  };
  const params = paramsByProfile[profile] ?? paramsByProfile.balanced;
  const key = await argon2id({
    password,
    salt: salt.toString("hex"),
    parallelism: params.parallelism,
    iterations: params.iterations,
    memorySize: params.memorySize,
    hashLength: 32,
    outputType: "hex"
  });

  return {
    key: Buffer.from(key, "hex"),
    params
  };
}

async function createArchiveEncryption(password, profile) {
  await sodium.ready;
  const salt = Buffer.from(sodium.randombytes_buf(16));
  const archiveKey = Buffer.from(sodium.randombytes_buf(32));
  const { key: passwordKey, params } = await derivePasswordKey(password, salt, profile);
  const nonce = Buffer.from(sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES));
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    archiveKey,
    null,
    null,
    nonce,
    passwordKey
  );

  return {
    archiveKey,
    header: {
      salt: toBase64(salt),
      params,
      wrap: {
        nonce: toBase64(nonce),
        ciphertext: toBase64(ciphertext)
      }
    }
  };
}

async function unlockArchiveKey(password, header) {
  await sodium.ready;
  const salt = fromBase64(header.salt);
  const { key: passwordKey } = await derivePasswordKey(password, salt, header.profile || inferProfile(header.params));
  const nonce = fromBase64(header.wrap.nonce);
  const ciphertext = fromBase64(header.wrap.ciphertext);
  const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    ciphertext,
    null,
    nonce,
    passwordKey
  );

  return Buffer.from(plaintext);
}

function inferProfile(params) {
  if (params.memorySize >= 262144) {
    return "strong";
  }
  if (params.memorySize <= 19456) {
    return "constrained";
  }
  return "balanced";
}

async function encryptPayload(payload, archiveKey) {
  await sodium.ready;
  const dataKey = Buffer.from(sodium.randombytes_buf(32));
  const wrapNonce = Buffer.from(sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES));
  const wrappedKey = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(dataKey, null, null, wrapNonce, archiveKey);
  const init = sodium.crypto_secretstream_xchacha20poly1305_init_push(dataKey);
  const cipher = sodium.crypto_secretstream_xchacha20poly1305_push(
    init.state,
    payload,
    null,
    sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
  );

  return {
    wrappedKey: {
      nonce: toBase64(wrapNonce),
      ciphertext: toBase64(wrappedKey)
    },
    header: toBase64(init.header),
    ciphertext: Buffer.from(cipher)
  };
}

async function decryptPayload(encrypted, archiveKey) {
  await sodium.ready;
  const wrapNonce = fromBase64(encrypted.wrappedKey.nonce);
  const wrappedKey = fromBase64(encrypted.wrappedKey.ciphertext);
  const dataKey = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    wrappedKey,
    null,
    wrapNonce,
    archiveKey
  );
  const state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(
    fromBase64(encrypted.header),
    dataKey
  );
  const result = sodium.crypto_secretstream_xchacha20poly1305_pull(state, encrypted.ciphertext);
  return Buffer.from(result.message);
}

module.exports = {
  createArchiveEncryption,
  unlockArchiveKey,
  encryptPayload,
  decryptPayload
};
