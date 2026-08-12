import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { arch, platform } from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";

const exec = promisify(execFile);
const root = new URL("../", import.meta.url);
const outputDirectory = new URL("dist/", root);
const executableName = platform === "win32" ? "uni-push.exe" : "uni-push";
const executable = new URL(executableName, outputDirectory);
const bundle = new URL("uni-push.bundle.mjs", outputDirectory);
const config = new URL("sea-config.json", outputDirectory);
const path = (url) => fileURLToPath(url);

if (!["x64", "arm64"].includes(arch)) throw new Error(`Unsupported architecture: ${arch}`);
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [path(new URL("scripts/sea-entry.mjs", root))],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26",
  outfile: path(bundle),
  external: ["node:sea"],
});
await writeFile(config, `${JSON.stringify({
  main: path(bundle),
  mainFormat: "module",
  executable: process.execPath,
  output: path(executable),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  execArgv: ["--no-warnings"],
  execArgvExtension: "none",
  assets: {
    "ui/index.html": path(new URL("src/ui/public/index.html", root)),
    "ui/app.js": path(new URL("src/ui/public/app.js", root)),
    "ui/style.css": path(new URL("src/ui/public/style.css", root)),
  },
}, null, 2)}\n`);
await exec(process.execPath, ["--build-sea", path(config)], { cwd: path(root) });
if (platform === "darwin") await exec("codesign", ["--sign", "-", "--force", path(executable)]);
if (platform !== "win32") await exec("chmod", ["755", path(executable)]);
console.log(JSON.stringify({ executable: path(executable), platform, arch }));
