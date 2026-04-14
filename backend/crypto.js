const sodium = require("libsodium-wrappers-sumo");
const { argon2id } = require("hash-wasm");

function toBase64(value) {
  return toBufferView(value).toString("base64");
}

function fromBase64(value) {
  return Buffer.from(value, "base64");
}

function toBufferView(value) {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return Buffer.from(value);
}

function zeroizeBuffer(value) {
  if (value && typeof value.fill === "function") {
    value.fill(0);
  }
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
    salt,
    parallelism: params.parallelism,
    iterations: params.iterations,
    memorySize: params.memorySize,
    hashLength: 32,
    outputType: "binary"
  });

  return {
    key: toBufferView(key),
    params
  };
}

async function createArchiveEncryption(password, profile) {
  await sodium.ready;
  const salt = toBufferView(sodium.randombytes_buf(16));
  const archiveKey = toBufferView(sodium.randombytes_buf(32));
  const nonce = toBufferView(sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES));
  const { key: passwordKey, params } = await derivePasswordKey(password, salt, profile);
  let ciphertext = null;

  try {
    ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
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
  } finally {
    zeroizeBuffer(passwordKey);
    zeroizeBuffer(salt);
    zeroizeBuffer(nonce);
    zeroizeBuffer(ciphertext);
  }
}

async function unlockArchiveKey(password, header) {
  await sodium.ready;
  const salt = fromBase64(header.salt);
  const { key: passwordKey } = await derivePasswordKey(password, salt, header.profile || inferProfile(header.params));
  const nonce = fromBase64(header.wrap.nonce);
  const ciphertext = fromBase64(header.wrap.ciphertext);
  let plaintext = null;

  try {
    plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      null,
      nonce,
      passwordKey
    );

    return Buffer.from(plaintext);
  } finally {
    zeroizeBuffer(passwordKey);
    zeroizeBuffer(salt);
    zeroizeBuffer(nonce);
    zeroizeBuffer(ciphertext);
    zeroizeBuffer(plaintext);
  }
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
  const dataKey = toBufferView(sodium.randombytes_buf(32));
  const wrapNonce = toBufferView(sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES));
  let wrappedKey = null;
  let init = null;
  let cipher = null;

  try {
    wrappedKey = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(dataKey, null, null, wrapNonce, archiveKey);
    init = sodium.crypto_secretstream_xchacha20poly1305_init_push(dataKey);
    cipher = sodium.crypto_secretstream_xchacha20poly1305_push(
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
  } finally {
    zeroizeBuffer(dataKey);
    zeroizeBuffer(wrapNonce);
    zeroizeBuffer(wrappedKey);
    zeroizeBuffer(init?.header);
    zeroizeBuffer(cipher);
  }
}

async function decryptPayload(encrypted, archiveKey) {
  await sodium.ready;
  const wrapNonce = fromBase64(encrypted.wrappedKey.nonce);
  const wrappedKey = fromBase64(encrypted.wrappedKey.ciphertext);
  const header = fromBase64(encrypted.header);
  let dataKey = null;
  let state = null;
  let result = null;

  try {
    dataKey = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      wrappedKey,
      null,
      wrapNonce,
      archiveKey
    );
    state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(header, dataKey);
    result = sodium.crypto_secretstream_xchacha20poly1305_pull(state, encrypted.ciphertext);
    return Buffer.from(result.message);
  } finally {
    zeroizeBuffer(wrapNonce);
    zeroizeBuffer(wrappedKey);
    zeroizeBuffer(header);
    zeroizeBuffer(dataKey);
    zeroizeBuffer(result?.message);
  }
}

module.exports = {
  createArchiveEncryption,
  unlockArchiveKey,
  encryptPayload,
  decryptPayload,
  zeroizeBuffer,
  __test__: {
    toBase64,
    fromBase64,
    toBufferView,
    zeroizeBuffer,
    derivePasswordKey
  }
};
