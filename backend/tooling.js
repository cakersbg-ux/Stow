const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const { spawn } = require("node:child_process");
const ffmpegStatic = require("ffmpeg-static");
const ffprobeStatic = require("ffprobe-static");
const { detectAv1Encoder } = require("./mediaTools");

const BUNDLED_UPSCALE_ROUTER_MODEL_PATH = path.join(__dirname, "generated", "model_quantized.onnx");
const REAL_ESRGAN_COMMANDS = ["realesrgan-ncnn-vulkan", "real-esrgan-ncnn-vulkan"];
const REAL_CUGAN_COMMANDS = ["realcugan-ncnn-vulkan"];
const WAIFU2X_COMMANDS = ["waifu2x-ncnn-vulkan"];

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
    key: "realEsrgan",
    label: "Real-ESRGAN",
    probes: REAL_ESRGAN_COMMANDS.map((command) => ({ command, args: ["-h"] })),
    managedExecutable: process.platform === "win32" ? "realesrgan-ncnn-vulkan.exe" : "realesrgan-ncnn-vulkan",
    installCandidates: ["managed:realEsrgan"],
    reason: "realesrgan-ncnn-vulkan not detected"
  },
  {
    key: "realCugan",
    label: "Real-CUGAN",
    probes: REAL_CUGAN_COMMANDS.map((command) => ({ command, args: ["-h"] })),
    managedExecutable: process.platform === "win32" ? "realcugan-ncnn-vulkan.exe" : "realcugan-ncnn-vulkan",
    installCandidates: ["managed:realCugan"],
    reason: "realcugan-ncnn-vulkan not detected"
  },
  {
    key: "waifu2x",
    label: "waifu2x",
    probes: WAIFU2X_COMMANDS.map((command) => ({ command, args: ["-h"] })),
    managedExecutable: process.platform === "win32" ? "waifu2x-ncnn-vulkan.exe" : "waifu2x-ncnn-vulkan",
    installCandidates: ["managed:waifu2x"],
    reason: "waifu2x-ncnn-vulkan not detected"
  },
  {
    key: "upscaleRouterModel",
    label: "Upscale Router Model",
    probes: [],
    managedAsset: "model_quantized.onnx",
    managedVersion: "Xenova/resnet-18 quantized",
    installCandidates: ["managed:resnet18Classifier"],
    reason: "distilled classifier backbone not detected"
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

function isToolAutoInstallSupported(tool) {
  return Boolean(tool?.key) && ["darwin", "win32"].includes(process.platform);
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
    }
  };
}

async function runCommandDetailed(command, args = [], options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, makeSpawnOptions(options));
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) =>
      resolve({
        ok: false,
        code: null,
        stdout,
        stderr: error.message || stderr
      })
    );
    child.on("close", (code) =>
      resolve({
        ok: code === 0,
        code,
        stdout,
        stderr
      })
    );
  });
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

function managedAssetPath(tool, options = {}) {
  if (!tool?.managedAsset) {
    return null;
  }
  const packageDir = managedPackageDir(tool.key, options);
  if (!packageDir) {
    return null;
  }
  return path.join(packageDir, tool.managedAsset);
}

function bundledAssetPath(tool) {
  if (tool?.key === "upscaleRouterModel") {
    return BUNDLED_UPSCALE_ROUTER_MODEL_PATH;
  }
  return null;
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

async function downloadToFile(url, filePath) {
  const data = await fetchBuffer(url);
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

async function fetchLatestRelease(repo) {
  return fetchJson(`https://api.github.com/repos/${repo}/releases/latest`);
}

function pickAsset(release, patternsByPlatform) {
  const assets = Array.isArray(release.assets) ? release.assets : [];
  return assets.find((asset) => platformAssetMatcher(asset.name || "", patternsByPlatform)) || null;
}

async function installManagedZstd(options = {}) {
  if (process.platform !== "win32") {
    throw new Error("Managed zstd installer is currently only used on Windows");
  }

  const release = await fetchLatestRelease("facebook/zstd");
  const asset = pickAsset(release, {
    win32: [/-win64\.zip$/i, /-win32\.zip$/i]
  });

  if (!asset?.browser_download_url) {
    throw new Error("No matching zstd release asset found for this platform");
  }

  const targetPath = path.join(managedBinDir(options), "zstd.exe");
  await withTempDir("stow-zstd-", async (tempDir) => {
    const archivePath = path.join(tempDir, asset.name);
    const extractDir = path.join(tempDir, "extract");
    await downloadToFile(asset.browser_download_url, archivePath);
    await extractZip(archivePath, extractDir, options);

    const binaryPath = await findFileRecursive(extractDir, (name) => /^zstd\.exe$/i.test(name));
    if (!binaryPath) {
      throw new Error(`zstd binary not found in ${asset.name}`);
    }

    await installExecutable({ sourcePath: binaryPath, targetPath });
  });

  return `installed zstd (${release.tag_name})`;
}

async function installManagedCjxl(options = {}) {
  if (process.platform !== "win32") {
    throw new Error("Managed JPEG XL installer is currently only used on Windows");
  }

  const release = await fetchLatestRelease("libjxl/libjxl");
  const asset = pickAsset(release, {
    win32: [/jxl-x64-windows-static\.zip$/i, /jxl-x64-windows\.zip$/i]
  });

  if (!asset?.browser_download_url) {
    throw new Error("No matching JPEG XL release asset found for this platform");
  }

  const targetPath = path.join(managedBinDir(options), "cjxl.exe");
  await withTempDir("stow-cjxl-", async (tempDir) => {
    const archivePath = path.join(tempDir, asset.name);
    const extractDir = path.join(tempDir, "extract");
    await downloadToFile(asset.browser_download_url, archivePath);
    await extractZip(archivePath, extractDir, options);

    const binaryPath = await findFileRecursive(extractDir, (name) => /^cjxl\.exe$/i.test(name));
    if (!binaryPath) {
      throw new Error(`cjxl binary not found in ${asset.name}`);
    }

    await installExecutable({ sourcePath: binaryPath, targetPath });
  });

  return `installed JPEG XL (${release.tag_name})`;
}

async function installManagedBundledNcnnTool({ name, repo, executableName, assetPatternsByPlatform }, options = {}) {
  const release = await fetchLatestRelease(repo);
  const asset = pickAsset(release, assetPatternsByPlatform);

  if (!asset?.browser_download_url) {
    throw new Error(`No matching ${name} release asset found for this platform`);
  }

  const targetRoot = managedPackageDir(name, options);
  if (!targetRoot) {
    throw new Error(`Cannot determine install directory for ${name}`);
  }

  await withTempDir(`stow-${name}-`, async (tempDir) => {
    const archivePath = path.join(tempDir, asset.name);
    const extractDir = path.join(tempDir, "extract");
    await downloadToFile(asset.browser_download_url, archivePath);
    await extractZip(archivePath, extractDir, options);

    const binaryPath = await findFileRecursive(extractDir, (entryName) => entryName.toLowerCase() === executableName.toLowerCase());
    if (!binaryPath) {
      throw new Error(`${executableName} not found in ${asset.name}`);
    }

    const extractedRoot = path.dirname(binaryPath);
    await fs.rm(targetRoot, { recursive: true, force: true });
    await ensureDir(path.dirname(targetRoot));
    await fs.cp(extractedRoot, targetRoot, { recursive: true });

    if (process.platform !== "win32") {
      await fs.chmod(path.join(targetRoot, executableName), 0o755);
    }
  });

  return `installed ${name} (${release.tag_name})`;
}

async function installManagedRealEsrgan(options = {}) {
  return installManagedBundledNcnnTool(
    {
      name: "realEsrgan",
      repo: "xinntao/Real-ESRGAN-ncnn-vulkan",
      executableName: process.platform === "win32" ? "realesrgan-ncnn-vulkan.exe" : "realesrgan-ncnn-vulkan",
      assetPatternsByPlatform: {
        darwin: [/-macos\.zip$/i],
        win32: [/-windows\.zip$/i]
      }
    },
    options
  );
}

async function installManagedRealCugan(options = {}) {
  return installManagedBundledNcnnTool(
    {
      name: "realCugan",
      repo: "nihui/realcugan-ncnn-vulkan",
      executableName: process.platform === "win32" ? "realcugan-ncnn-vulkan.exe" : "realcugan-ncnn-vulkan",
      assetPatternsByPlatform: {
        darwin: [/-macos\.zip$/i],
        win32: [/-windows\.zip$/i]
      }
    },
    options
  );
}

async function installManagedWaifu2x(options = {}) {
  return installManagedBundledNcnnTool(
    {
      name: "waifu2x",
      repo: "nihui/waifu2x-ncnn-vulkan",
      executableName: process.platform === "win32" ? "waifu2x-ncnn-vulkan.exe" : "waifu2x-ncnn-vulkan",
      assetPatternsByPlatform: {
        darwin: [/-macos\.zip$/i],
        win32: [/-windows\.zip$/i]
      }
    },
    options
  );
}

async function installManagedResnet18Classifier(options = {}) {
  const targetRoot = managedPackageDir("upscaleRouterModel", options);
  if (!targetRoot) {
    throw new Error("Cannot determine install directory for upscale router model");
  }

  await ensureDir(targetRoot);
  const targetPath = path.join(targetRoot, "model_quantized.onnx");
  if (await pathExists(BUNDLED_UPSCALE_ROUTER_MODEL_PATH)) {
    await fs.copyFile(BUNDLED_UPSCALE_ROUTER_MODEL_PATH, targetPath);
    return "installed distilled router backbone from bundled asset";
  }
  await downloadToFile("https://huggingface.co/Xenova/resnet-18/resolve/main/onnx/model_quantized.onnx", targetPath);
  return "installed distilled router backbone (Xenova/resnet-18 quantized)";
}

async function installManagedTool(name, options = {}) {
  const installers = {
    zstd: installManagedZstd,
    cjxl: installManagedCjxl,
    realEsrgan: installManagedRealEsrgan,
    realCugan: installManagedRealCugan,
    waifu2x: installManagedWaifu2x,
    resnet18Classifier: installManagedResnet18Classifier
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

  return { type: "brew", name: candidate };
}

function candidateAppliesToPlatform(candidate) {
  if (candidate.type === "brew" || candidate.type === "cask") {
    return process.platform === "darwin";
  }
  if (candidate.type === "winget") {
    return process.platform === "win32";
  }
  if (candidate.type === "managed") {
    return ["darwin", "win32"].includes(process.platform);
  }
  return false;
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
  let attempted = 0;

  for (const rawCandidate of tool.installCandidates) {
    const candidate = normalizeInstallCandidate(rawCandidate);
    if (!candidate) {
      continue;
    }
    if (!candidateAppliesToPlatform(candidate)) {
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
    return {
      ok: false,
      message: `no supported installers configured for ${tool.label} on ${process.platform}`
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
  const bundledPath = bundledAssetPath(tool);
  if (bundledPath && (await pathExists(bundledPath))) {
    return {
      summary: `${tool.managedVersion || path.basename(bundledPath)} (bundled)`,
      command: bundledPath
    };
  }

  const executablePath = managedExecutablePath(tool, options);
  if (executablePath && (await pathExists(executablePath))) {
    const summary = await runCommandSummary(executablePath, ["-h"], options);
    if (!summary) {
      return null;
    }

    return {
      summary,
      command: executablePath
    };
  }

  const assetPath = managedAssetPath(tool, options);
  if (assetPath && (await pathExists(assetPath))) {
    return {
      summary: tool.managedVersion || path.basename(assetPath),
      command: assetPath
    };
  }

  return null;
}

function isUpscalerTool(tool) {
  return ["realEsrgan", "realCugan", "waifu2x", "upscaleRouterModel"].includes(tool?.key);
}

async function detectTooling(options = {}) {
  const results = {};
  const extraPaths = [managedBinDir(options)].filter(Boolean);
  const probeOptions = { extraPaths };

  for (const tool of [...INSTALLABLE_TOOLS]) {
    const detected = (await probeManagedTool(tool, options)) || (await probeTool(tool.probes, probeOptions));
    results[tool.key] = {
      available: Boolean(detected),
      version: detected?.summary ?? null,
      path: detected?.command ?? null,
      ...(detected ? {} : tool.reason ? { reason: tool.reason } : {})
    };
  }

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
  const toolsBin = managedBinDir(options);
  const toolsPackages = managedPackagesDir(options);
  const extraPaths = [toolsBin].filter(Boolean);
  const installOptions = { ...options, extraPaths };

  if (toolsBin) {
    await ensureDir(toolsBin);
    await ensureDir(toolsPackages);
    process.env.PATH = mergePath(extraPaths);
  }

  publishInstallState(onProgress, installStatus);

  if (!["darwin", "win32"].includes(process.platform)) {
    installStatus.active = false;
    installStatus.phase = "complete";
    installStatus.message = "Automatic tooling install is currently available on macOS and Windows";
    installStatus.completedSteps = 1;
    installStatus.skipped = ["automatic tooling install is currently wired for macOS and Windows"];
    publishInstallState(onProgress, installStatus);
    return {
      attempted: false,
      installed: [],
      skipped: installStatus.skipped
    };
  }

  const current = await detectTooling(installOptions);
  const installPlan = AUTO_INSTALL_TOOLS.filter(
    (tool) =>
      !current[tool.key]?.available &&
      isToolAutoInstallSupported(tool) &&
      (options.enableUpscaling !== false || !isUpscalerTool(tool))
  );

  if (!installPlan.length) {
    installStatus.active = false;
    installStatus.phase = "complete";
    installStatus.message = "Local tooling is ready";
    installStatus.completedSteps = 1;
    publishInstallState(onProgress, installStatus);
    return {
      attempted: false,
      installed: [],
      skipped: []
    };
  }

  installStatus.phase = "installing";
  installStatus.totalSteps = installPlan.length;
  installStatus.completedSteps = 0;
  installStatus.currentTarget = installPlan[0].label;
  installStatus.message = `Installing ${installPlan[0].label}`;
  publishInstallState(onProgress, installStatus);

  const installed = [];
  const skipped = [];

  for (const tool of installPlan) {
    installStatus.currentTarget = tool.label;
    installStatus.message = `Installing ${tool.label} (${installStatus.completedSteps + 1}/${installStatus.totalSteps})`;
    publishInstallState(onProgress, installStatus);

    const result = await installFirstAvailableFormula(tool, installOptions);
    if (result.ok) {
      installed.push(result.message);
      installStatus.installed = [...installed];
    } else {
      skipped.push(result.message);
      installStatus.skipped = [...skipped];
    }

    installStatus.completedSteps += 1;
    publishInstallState(onProgress, installStatus);
  }

  installStatus.active = false;
  installStatus.phase = "complete";
  installStatus.currentTarget = null;
  installStatus.message = skipped.length ? "Tooling install finished with warnings" : "Local tooling is ready";
  publishInstallState(onProgress, installStatus);

  return {
    attempted: installPlan.length > 0,
    installed,
    skipped
  };
}

module.exports = {
  createInstallStatus,
  detectTooling,
  ensureRuntimeTools
};
