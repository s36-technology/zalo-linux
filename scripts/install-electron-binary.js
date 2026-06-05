#!/usr/bin/env node

const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

const electronRoot = path.join(__dirname, "..", "node_modules", "electron");

if (!fs.existsSync(electronRoot)) {
  process.exit(0);
}

const electronPackage = require(path.join(electronRoot, "package.json"));
const distPath = path.join(electronRoot, "dist");
const pathFile = path.join(electronRoot, "path.txt");
const platformPath = getPlatformPath(process.platform);

if (isElectronInstalled()) {
  process.exit(0);
}

installElectron().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});

async function installElectron() {
  const { downloadArtifact } = require("@electron/get");

  const zipPath = await downloadArtifact({
    version: electronPackage.version,
    artifactName: "electron",
    platform: process.platform,
    arch: process.arch,
    checksums: require(path.join(electronRoot, "checksums.json")),
  });

  fs.rmSync(distPath, { recursive: true, force: true });
  fs.mkdirSync(distPath, { recursive: true });
  childProcess.execFileSync("unzip", ["-oq", zipPath, "-d", distPath], {
    stdio: "inherit",
  });
  fs.writeFileSync(pathFile, platformPath);

  if (!isElectronInstalled()) {
    throw new Error("Electron binary install did not produce a runnable dist.");
  }
}

function isElectronInstalled() {
  try {
    const installedVersion = fs
      .readFileSync(path.join(distPath, "version"), "utf8")
      .trim()
      .replace(/^v/, "");
    const installedPath = fs.readFileSync(pathFile, "utf8");

    return (
      installedVersion === electronPackage.version &&
      installedPath === platformPath &&
      fs.existsSync(path.join(distPath, platformPath))
    );
  } catch {
    return false;
  }
}

function getPlatformPath(platform) {
  switch (platform) {
    case "darwin":
      return "Electron.app/Contents/MacOS/Electron";
    case "linux":
      return "electron";
    case "win32":
      return "electron.exe";
    default:
      throw new Error(`Electron builds are not available for ${platform}.`);
  }
}
