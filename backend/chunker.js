const crypto = require("node:crypto");
const fs = require("node:fs");

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function* chunkReadable(readable, options = {}) {
  const minSize = options.minSize ?? 256 * 1024;
  const avgSize = options.avgSize ?? 1024 * 1024;
  const maxSize = options.maxSize ?? 4 * 1024 * 1024;
  const mask = avgSize - 1;

  let offset = 0;
  let rolling = 0;
  let currentSize = 0;
  let parts = [];

  const emitChunk = () => {
    const buffer = Buffer.concat(parts, currentSize);
    const chunk = {
      hash: sha256Hex(buffer),
      offset,
      length: buffer.length,
      buffer
    };
    offset += buffer.length;
    rolling = 0;
    currentSize = 0;
    parts = [];
    return chunk;
  };

  for await (const incoming of readable) {
    const buffer = Buffer.isBuffer(incoming) ? incoming : Buffer.from(incoming);
    let sliceStart = 0;

    for (let index = 0; index < buffer.length; index += 1) {
      rolling = ((rolling << 5) - rolling + buffer[index]) >>> 0;
      currentSize += 1;

      if (currentSize < minSize) {
        continue;
      }

      const atBoundary = (rolling & mask) === 0;
      if (!atBoundary && currentSize < maxSize) {
        continue;
      }

      if (sliceStart <= index) {
        parts.push(buffer.subarray(sliceStart, index + 1));
      }

      yield emitChunk();
      sliceStart = index + 1;
    }

    if (sliceStart < buffer.length) {
      parts.push(buffer.subarray(sliceStart));
    }
  }

  if (currentSize > 0) {
    yield emitChunk();
  }
}

function chunkFile(filePath, options = {}) {
  const stream = fs.createReadStream(filePath, {
    highWaterMark: options.readSize ?? 256 * 1024
  });
  return chunkReadable(stream, options);
}

module.exports = {
  chunkFile,
  chunkReadable,
  sha256Hex
};
