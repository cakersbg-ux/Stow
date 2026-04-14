const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const https = require("node:https");
const { spawn } = require("node:child_process");
const { detectAv1Encoder } = require("./mediaTools");

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

const INSTALLABLE_TOOLS = [
  {
    key: "zstd",
    label: "zstd",
    probes: [{ command: "zstd", args: ["--version"] }],
    installCandidates: ["brew:zstd", "managed:zstd"]
  },
  {
    key: "cjxl",
    label: "JPEG XL",
    probes: [{ command: "cjxl", args: ["--version"] }],
    installCandidates: ["brew:jpeg-xl", "managed:cjxl"]
  },
  {
    key: "djxl",
    label: "JPEG XL Decoder",
    probes: [{ command: "djxl", args: ["--version"] }]
  },
  {
    key: "lzma2Offline",
    label: "7-Zip",
    probes: [
      { command: "7z", args: ["i"] },
      { command: "7zz", args: ["--help"] }
    ],
    installCandidates: ["brew:p7zip", "brew:sevenzip", "winget:7zip.7zip"],
    reason: "7z not detected"
  }
];

const AUTO_INSTALL_TOOLS = [...INSTALLABLE_TOOLS].filter(
  (tool) => Array.isArray(tool.installCandidates) && tool.installCandidates.length
);

const MANAGED_RELEASES = {
  zstd: {
    repo: "facebook/zstd",
    tag: "v1.5.7",
    version: "1.5.7",
    assetName: "zstd-v1.5.7-win64.zip"
  },
  cjxl: {
    repo: "libjxl/libjxl",
    tag: "v0.11.2",
    version: "0.11.2",
    assetName: "jxl-x64-windows-static.zip"
  }
};

let ffmpegStaticPath = null;
let ffmpegStaticLoaded = false;
let ffprobeStatic = null;
let ffprobeStaticLoaded = false;

function loadOptionalModule(moduleName) {
  try {
    return require(moduleName);
  } catch (error) {
    if (error instanceof Error && error.code === "MODULE_NOT_FOUND" && error.message.includes(`'${moduleName}'`)) {
      return null;
    }
    throw error;
  }
}

function getFfmpegStaticPath() {
  if (!ffmpegStaticLoaded) {
    ffmpegStaticPath = loadOptionalModule("ffmpeg-static");
    ffmpegStaticLoaded = true;
  }
  return ffmpegStaticPath;
}

function getFfprobeStatic() {
  if (!ffprobeStaticLoaded) {
    ffprobeStatic = loadOptionalModule("ffprobe-static");
    ffprobeStaticLoaded = true;
  }
  return ffprobeStatic;
}

function getManagedReleaseSpec(name) {
  return MANAGED_RELEASES[name] || null;
}

function normalizeTimeoutMs(timeoutMs) {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return null;
  }

  return Math.floor(timeoutMs);
}

function withTimeout(options = {}, timeoutMs) {
  const normalizedTimeoutMs = normalizeTimeoutMs(timeoutMs);
  return normalizedTimeoutMs ? { ...options, timeoutMs: normalizedTimeoutMs } : { ...options };
}

function isToolAutoInstallSupported() {
  return ["darwin", "win32"].includes(process.platform);
}

function getPathDelimiter() {
  return process.platform === "win32" ? ";" : ":";
}

function mergePath(extraPaths = []) {
  const existingPath = process.env.PATH || "";
  const filtered = extraPaths.filter(Boolean);
  if (!filtered.length) {
    return existingPath;
  }
  return `${filtered.join(getPathDelimiter())}${getPathDelimiter()}${existingPath}`;
}

function makeSpawnOptions(options = {}) {
  return {
    env: {
      ...process.env,
      PATH: mergePath(options.extraPaths || [])
    },
    ...(options.cwd ? { cwd: options.cwd } : {})
  };
}

function normalizeDigest(digest) {
  if (typeof digest !== "string") {
    return null;
  }

  const normalized = digest.trim().toLowerCase();
  if (/^[a-f0-9]{64}$/.test(normalized)) {
    return `sha256:${normalized}`;
  }

  if (/^sha256:[a-f0-9]{64}$/.test(normalized)) {
    return normalized;
  }

  return null;
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function verifyDigest(buffer, expectedDigest, assetName) {
  const normalizedExpectedDigest = normalizeDigest(expectedDigest);
  if (!normalizedExpectedDigest) {
    return;
  }

  const actualDigest = `sha256:${sha256Hex(buffer)}`;
  if (actualDigest !== normalizedExpectedDigest) {
    throw new Error(
      `Checksum mismatch for ${assetName}: expected ${normalizedExpectedDigest}, got ${actualDigest}`
    );
  }
}

async function runCommandDetailed(command, args = [], options = {}) {
  return new Promise((resolve) => {
    const spawnOptions = makeSpawnOptions(options);
    const runner = typeof options.commandRunner === "function" ? options.commandRunner : spawn;
    let child;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeoutId = null;

    const settle = (result) => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      resolve(result);
    };

    try {
      child = runner(command, args, spawnOptions);
    } catch (error) {
      settle({
        ok: false,
        code: null,
        stdout,
        stderr: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    child.stdout?.on?.("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on?.("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on?.("error", (error) =>
      settle({
        ok: false,
        code: null,
        stdout,
        stderr: error.message || stderr
      })
    );
    child.on?.("close", (code) =>
      settle({
        ok: code === 0,
        code,
        stdout,
        stderr
      })
    );

    const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
    if (timeoutMs) {
      timeoutId = setTimeout(() => {
        if (typeof child.kill === "function") {
          try {
            child.kill("SIGTERM");
          } catch (_error) {
            // Ignore termination errors; the timeout result is still authoritative.
          }
        }

        const timeoutMessage = `${command} timed out after ${timeoutMs}ms`;
        settle({
          ok: false,
          code: null,
          stdout,
          stderr: stderr ? `${stderr}\n${timeoutMessage}` : timeoutMessage
        });
      }, timeoutMs);
    }
  });
}

async function verifyInstalledVersion(binaryPath, expectedVersion, options = {}) {
  const summary = await runCommandSummary(binaryPath, ["--version"], {
    ...options,
    cwd: path.dirname(binaryPath)
  });

  if (!summary) {
    throw new Error(`${path.basename(binaryPath)} did not report a version string`);
  }

  if (!summary.includes(expectedVersion)) {
    throw new Error(
      `${path.basename(binaryPath)} version mismatch: expected ${expectedVersion}, got ${summary}`
    );
  }

  return summary;
}

async function runCommandSummary(command, args = [], options = {}) {
  const result = await runCommandDetailed(command, args, options);
  if (!result.ok && result.code === null) {
    return null;
  }
  if (!result.ok && !result.stdout && !result.stderr) {
    return null;
  }

  const summary = `${result.stdout}\n${result.stderr}`
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);

  if (!summary && !result.ok) {
    return null;
  }

  return summary || command;
}

async function probeTool(probes, options = {}) {
  for (const probe of probes) {
    const summary = await runCommandSummary(probe.command, probe.args, options);
    if (summary) {
      return {
        summary,
        command: probe.command
      };
    }
  }
  return null;
}

function createInstallStatus(overrides = {}) {
  return {
    active: true,
    phase: "checking",
    message: "Checking local tooling",
    currentTarget: null,
    completedSteps: 0,
    totalSteps: 1,
    installed: [],
    skipped: [],
    ...overrides
  };
}

function managedBinDir(options = {}) {
  if (!options.toolsDir) {
    return null;
  }
  return path.join(options.toolsDir, "bin");
}

function managedPackagesDir(options = {}) {
  if (!options.toolsDir) {
    return null;
  }
  return path.join(options.toolsDir, "packages");
}

function managedPackageDir(name, options = {}) {
  const packagesDir = managedPackagesDir(options);
  if (!packagesDir) {
    return null;
  }
  return path.join(packagesDir, name);
}

function managedExecutablePath(tool, options = {}) {
  if (!tool?.managedExecutable) {
    return null;
  }
  const packageDir = managedPackageDir(tool.key, options);
  if (!packageDir) {
    return null;
  }
  return path.join(packageDir, tool.managedExecutable);
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch (_error) {
    return false;
  }
}

function platformAssetMatcher(assetName, patternsByPlatform) {
  const patterns = patternsByPlatform[process.platform] || patternsByPlatform.default || [];
  return patterns.some((pattern) => pattern.test(assetName));
}

function fetchBuffer(url, headers = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "User-Agent": "stow-tooling-installer",
          ...headers
        }
      },
      (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          if (redirects > 6) {
            reject(new Error(`Too many redirects while fetching ${url}`));
            return;
          }
          resolve(fetchBuffer(response.headers.location, headers, redirects + 1));
          return;
        }

        if (response.statusCode !== 200) {
          reject(new Error(`Request failed (${response.statusCode}) for ${url}`));
          return;
        }

        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks)));
      }
    );

    request.on("error", reject);
  });
}

async function fetchJson(url) {
  const buffer = await fetchBuffer(url, {
    Accept: "application/vnd.github+json"
  });
  return JSON.parse(buffer.toString("utf8"));
}

async function downloadToFile(url, filePath, options = {}, expectedDigest = null) {
  const fetchBufferImpl = typeof options.fetchBuffer === "function" ? options.fetchBuffer : fetchBuffer;
  const data = await fetchBufferImpl(url);
  verifyDigest(data, expectedDigest, path.basename(filePath));
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, data);
}

async function withTempDir(prefix, callback) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await callback(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function extractZip(archivePath, destinationPath, options = {}) {
  await ensureDir(destinationPath);
  if (process.platform === "win32") {
    const escapedArchive = archivePath.replace(/'/g, "''");
    const escapedDestination = destinationPath.replace(/'/g, "''");
    const result = await runCommandDetailed(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Expand-Archive -Path '${escapedArchive}' -DestinationPath '${escapedDestination}' -Force`
      ],
      options
    );
    if (!result.ok) {
      throw new Error(result.stderr || "Failed to extract zip archive");
    }
    return;
  }

  const result = await runCommandDetailed("unzip", ["-o", archivePath, "-d", destinationPath], options);
  if (!result.ok) {
    throw new Error(result.stderr || "Failed to extract zip archive");
  }
}

async function findFileRecursive(rootPath, predicate) {
  const queue = [rootPath];
  while (queue.length) {
    const current = queue.shift();
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolute);
      } else if (predicate(entry.name, absolute)) {
        return absolute;
      }
    }
  }
  return null;
}

async function installExecutable({ sourcePath, targetPath }) {
  await ensureDir(path.dirname(targetPath));
  await fs.copyFile(sourcePath, targetPath);
  if (process.platform !== "win32") {
    await fs.chmod(targetPath, 0o755);
  }
}

async function fetchReleaseByTag(repo, tag, options = {}) {
  const fetchJsonImpl = typeof options.fetchJson === "function" ? options.fetchJson : fetchJson;
  const release = await fetchJsonImpl(`https://api.github.com/repos/${repo}/releases/tags/${tag}`);

  if (!release || release.tag_name !== tag) {
    throw new Error(`Expected ${repo} release ${tag} but received ${release?.tag_name || "unknown"}`);
  }

  return release;
}

function pickExactAsset(release, assetName) {
  const assets = Array.isArray(release.assets) ? release.assets : [];
  return assets.find((asset) => asset.name === assetName) || null;
}

async function installManagedZstd(options = {}) {
  if (process.platform !== "win32") {
    throw new Error("Managed zstd installer is currently only used on Windows");
  }

  const spec = getManagedReleaseSpec("zstd");
  const release = await fetchReleaseByTag(spec.repo, spec.tag, options);
  const asset = pickExactAsset(release, spec.assetName);

  if (!asset?.browser_download_url) {
    throw new Error(`No matching zstd release asset found for ${spec.tag}`);
  }

  const targetPath = path.join(managedBinDir(options), "zstd.exe");
  await withTempDir("stow-zstd-", async (tempDir) => {
    const archivePath = path.join(tempDir, asset.name);
    const extractDir = path.join(tempDir, "extract");
    await downloadToFile(asset.browser_download_url, archivePath, options, asset.digest);
    await extractZip(archivePath, extractDir, options);

    const binaryPath = await findFileRecursive(extractDir, (name) => /^zstd\.exe$/i.test(name));
    if (!binaryPath) {
      throw new Error(`zstd binary not found in ${asset.name}`);
    }

    await installExecutable({ sourcePath: binaryPath, targetPath });
  });

  await verifyInstalledVersion(targetPath, spec.version, options);

  return `installed zstd (${release.tag_name})`;
}

async function installManagedCjxl(options = {}) {
  if (process.platform !== "win32") {
    throw new Error("Managed JPEG XL installer is currently only used on Windows");
  }

  const spec = getManagedReleaseSpec("cjxl");
  const release = await fetchReleaseByTag(spec.repo, spec.tag, options);
  const asset = pickExactAsset(release, spec.assetName);

  if (!asset?.browser_download_url) {
    throw new Error(`No matching JPEG XL release asset found for ${spec.tag}`);
  }

  const cjxlTargetPath = path.join(managedBinDir(options), "cjxl.exe");
  const djxlTargetPath = path.join(managedBinDir(options), "djxl.exe");
  await withTempDir("stow-cjxl-", async (tempDir) => {
    const archivePath = path.join(tempDir, asset.name);
    const extractDir = path.join(tempDir, "extract");
    await downloadToFile(asset.browser_download_url, archivePath, options, asset.digest);
    await extractZip(archivePath, extractDir, options);

    const cjxlBinaryPath = await findFileRecursive(extractDir, (name) => /^cjxl\.exe$/i.test(name));
    const djxlBinaryPath = await findFileRecursive(extractDir, (name) => /^djxl\.exe$/i.test(name));
    if (!cjxlBinaryPath) {
      throw new Error(`cjxl binary not found in ${asset.name}`);
    }
    if (!djxlBinaryPath) {
      throw new Error(`djxl binary not found in ${asset.name}`);
    }

    await installExecutable({ sourcePath: cjxlBinaryPath, targetPath: cjxlTargetPath });
    await installExecutable({ sourcePath: djxlBinaryPath, targetPath: djxlTargetPath });
  });

  await verifyInstalledVersion(cjxlTargetPath, spec.version, options);
  await verifyInstalledVersion(djxlTargetPath, spec.version, options);

  return `installed JPEG XL tools (${release.tag_name})`;
}

async function installManagedTool(name, options = {}) {
  const installers = {
    zstd: installManagedZstd,
    cjxl: installManagedCjxl
  };

  const installer = installers[name];
  if (!installer) {
    throw new Error(`Unknown managed installer target: ${name}`);
  }

  const result = await installer(options);
  return {
    ok: true,
    message: result
  };
}

function normalizeInstallCandidate(candidate) {
  if (typeof candidate !== "string") {
    return null;
  }

  if (candidate.startsWith("managed:")) {
    return { type: "managed", name: candidate.slice("managed:".length) };
  }
  if (candidate.startsWith("winget:")) {
    return { type: "winget", name: candidate.slice("winget:".length) };
  }
  if (candidate.startsWith("brew:")) {
    return { type: "brew", name: candidate.slice("brew:".length) };
  }
  if (candidate.startsWith("cask:")) {
    return { type: "cask", name: candidate.slice("cask:".length) };
  }

  return null;
}

function candidateIsTrustedAutomaticInstall(candidate) {
  return candidate?.type === "managed" && process.platform === "win32";
}

function describeInstallCandidate(candidate) {
  return `${candidate.type}:${candidate.name}`;
}

function describeBlockedInstallCandidates(tool, blockedCandidates) {
  const blockedList = blockedCandidates.map(describeInstallCandidate).join(", ");
  const platformLabel = process.platform === "win32" ? "Windows" : process.platform;
  return `automatic installation for ${tool.label} is disabled on ${platformLabel}; ${blockedList} require manual installation and are not part of the trusted automatic path`;
}

async function installBrewPackage(formula, options = {}) {
  const args = ["install", formula];
  const result = await runCommandDetailed("brew", args, options);
  if (!result.ok) {
    const summary = `${result.stdout}\n${result.stderr}`
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    return {
      ok: false,
      message: summary || `brew ${args.join(" ")} failed`
    };
  }
  return { ok: true, message: `installed ${formula}` };
}

async function installBrewCask(cask, options = {}) {
  const args = ["install", "--cask", cask];
  const result = await runCommandDetailed("brew", args, options);
  if (!result.ok) {
    const summary = `${result.stdout}\n${result.stderr}`
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    return {
      ok: false,
      message: summary || `brew ${args.join(" ")} failed`
    };
  }
  return { ok: true, message: `installed cask ${cask}` };
}

async function installWithWinget(packageId, options = {}) {
  const args = [
    "install",
    "--id",
    packageId,
    "--exact",
    "--accept-package-agreements",
    "--accept-source-agreements",
    "--silent"
  ];
  const result = await runCommandDetailed("winget", args, options);
  if (!result.ok) {
    const summary = `${result.stdout}\n${result.stderr}`
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    return {
      ok: false,
      message: summary || `winget ${args.join(" ")} failed`
    };
  }
  return { ok: true, message: `installed ${packageId} via winget` };
}

async function installCandidate(candidate, options = {}) {
  if (candidate.type === "brew") {
    return installBrewPackage(candidate.name, options);
  }
  if (candidate.type === "cask") {
    return installBrewCask(candidate.name, options);
  }
  if (candidate.type === "winget") {
    return installWithWinget(candidate.name, options);
  }
  if (candidate.type === "managed") {
    return installManagedTool(candidate.name, options);
  }
  return { ok: false, message: `Unsupported installer type ${candidate.type}` };
}

async function installFirstAvailableFormula(tool, options = {}) {
  const errors = [];
  const blockedCandidates = [];
  let attempted = 0;

  for (const rawCandidate of tool.installCandidates) {
    const candidate = normalizeInstallCandidate(rawCandidate);
    if (!candidate) {
      continue;
    }
    if (!candidateIsTrustedAutomaticInstall(candidate)) {
      blockedCandidates.push(candidate);
      continue;
    }

    attempted += 1;
    const result = await installCandidate(candidate, options);
    if (result.ok) {
      return result;
    }
    const label = `${candidate.type}:${candidate.name}`;
    errors.push(`${label}: ${result.message}`);
  }

  if (!attempted) {
    if (blockedCandidates.length) {
      return {
        ok: false,
        message: describeBlockedInstallCandidates(tool, blockedCandidates)
      };
    }

    return {
      ok: false,
      message: `no trusted installers configured for ${tool.label} on ${process.platform}`
    };
  }

  return {
    ok: false,
    message: `failed to install ${tool.label}: ${errors.join("; ")}`
  };
}

function publishInstallState(onProgress, installStatus) {
  if (typeof onProgress === "function") {
    onProgress({ ...installStatus });
  }
}

async function probeManagedTool(tool, options = {}) {
  const executablePath = managedExecutablePath(tool, options);
  if (executablePath && (await pathExists(executablePath))) {
    const summary = await runCommandSummary(executablePath, ["-h"], {
      ...options,
      cwd: path.dirname(executablePath)
    });
    if (!summary) {
      return null;
    }

    return {
      summary,
      command: executablePath
    };
  }

  return null;
}

async function detectTooling(options = {}) {
  const results = {};
  const extraPaths = [managedBinDir(options)].filter(Boolean);
  const probeOptions = withTimeout(
    { ...options, extraPaths },
    normalizeTimeoutMs(options.probeTimeoutMs) || DEFAULT_PROBE_TIMEOUT_MS
  );

  for (const tool of [...INSTALLABLE_TOOLS]) {
    const detected = (await probeManagedTool(tool, probeOptions)) || (await probeTool(tool.probes, probeOptions));
    results[tool.key] = {
      available: Boolean(detected),
      version: detected?.summary ?? null,
      path: detected?.command ?? null,
      ...(detected ? {} : tool.reason ? { reason: tool.reason } : {})
    };
  }

  const ffmpegStatic = getFfmpegStaticPath();
  const ffprobeStatic = getFfprobeStatic();
  const ffmpeg = ffmpegStatic ? await runCommandSummary(ffmpegStatic, ["-version"], probeOptions) : null;
  const av1Encoder = await detectAv1Encoder();

  return {
    ...results,
    ffmpeg: { available: Boolean(ffmpegStatic), version: ffmpeg, path: ffmpegStatic || null },
    ffprobe: { available: Boolean(ffprobeStatic?.path), path: ffprobeStatic?.path || null },
    av1Encoder: {
      available: Boolean(av1Encoder),
      value: av1Encoder
    }
  };
}

async function ensureRuntimeTools(options = {}) {
  const { onProgress } = options;
  const installStatus = createInstallStatus();

  publishInstallState(onProgress, installStatus);

  const capabilities = await detectTooling(options);
  installStatus.active = false;
  installStatus.phase = "complete";
  installStatus.message = "Tooling detection complete";
  installStatus.completedSteps = 1;
  installStatus.installed = [];
  installStatus.skipped = [];
  publishInstallState(onProgress, installStatus);

  return {
    attempted: false,
    installed: [],
    skipped: [],
    capabilities
  };
}

async function installMissingRuntimeTools(options = {}) {
  const { onProgress } = options;
  const installStatus = createInstallStatus();
  const toolsBin = managedBinDir(options);
  const toolsPackages = managedPackagesDir(options);
  const extraPaths = [toolsBin].filter(Boolean);
  const installOptions = withTimeout(
    { ...options, extraPaths },
    normalizeTimeoutMs(options.installTimeoutMs) || DEFAULT_INSTALL_TIMEOUT_MS
  );

  if (toolsBin) {
    await ensureDir(toolsBin);
    await ensureDir(toolsPackages);
    process.env.PATH = mergePath(extraPaths);
  }

  publishInstallState(onProgress, installStatus);

  const current = await detectTooling(installOptions);
  const installPlan = AUTO_INSTALL_TOOLS.filter((tool) => {
    if (current[tool.key]?.available) {
      return false;
    }
    return tool.installCandidates.some((rawCandidate) => {
      const candidate = normalizeInstallCandidate(rawCandidate);
      return candidateIsTrustedAutomaticInstall(candidate);
    });
  });
  const blockedTools = AUTO_INSTALL_TOOLS.filter((tool) => {
    if (current[tool.key]?.available) {
      return false;
    }
    const hasBlockedCandidate = tool.installCandidates.some((rawCandidate) => {
      const candidate = normalizeInstallCandidate(rawCandidate);
      return candidate && !candidateIsTrustedAutomaticInstall(candidate);
    });
    return hasBlockedCandidate && !installPlan.includes(tool);
  });

  if (!installPlan.length) {
    installStatus.active = false;
    installStatus.phase = "complete";
    installStatus.message = blockedTools.length
      ? "Automatic tooling install is limited to trusted managed installers"
      : "Local tooling is ready";
    installStatus.completedSteps = 1;
    installStatus.skipped = blockedTools.map((tool) =>
      describeBlockedInstallCandidates(
        tool,
        tool.installCandidates
          .map((rawCandidate) => normalizeInstallCandidate(rawCandidate))
          .filter((candidate) => candidate && !candidateIsTrustedAutomaticInstall(candidate))
      )
    );
    publishInstallState(onProgress, installStatus);
    return {
      attempted: false,
      installed: [],
      skipped: installStatus.skipped
    };
  }

  installStatus.phase = "installing";
  installStatus.totalSteps = installPlan.length;
  installStatus.currentTarget = installPlan[0]?.label || null;
  publishInstallState(onProgress, installStatus);

  const installed = [];
  const skipped = blockedTools.map((tool) =>
    describeBlockedInstallCandidates(
      tool,
      tool.installCandidates
        .map((rawCandidate) => normalizeInstallCandidate(rawCandidate))
        .filter((candidate) => candidate && !candidateIsTrustedAutomaticInstall(candidate))
    )
  );
  for (let index = 0; index < installPlan.length; index += 1) {
    const tool = installPlan[index];
    installStatus.currentTarget = tool.label;
    installStatus.completedSteps = index;
    publishInstallState(onProgress, installStatus);

    try {
      const result = await installFirstAvailableFormula(tool, installOptions);
      if (result.ok) {
        installed.push(result.message);
      } else {
        skipped.push(result.message);
      }
    } catch (error) {
      skipped.push(`${tool.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  installStatus.completedSteps = installPlan.length;
  installStatus.phase = "complete";
  installStatus.active = false;
  installStatus.currentTarget = null;
  installStatus.message = installed.length || skipped.length ? "Local tooling install finished" : "Local tooling is ready";
  installStatus.installed = installed;
  installStatus.skipped = skipped;
  publishInstallState(onProgress, installStatus);

  return {
    attempted: true,
    installed,
    skipped
  };
}

module.exports = {
  createInstallStatus,
  detectTooling,
  ensureRuntimeTools,
  installMissingRuntimeTools,
  __testing: {
    normalizeInstallCandidate,
    candidateIsTrustedAutomaticInstall
  }
};
