import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { platform } from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const executable = new URL(platform === "win32" ? "../dist/uni-push.exe" : "../dist/uni-push", import.meta.url);
const executablePath = fileURLToPath(executable);
await access(executablePath);
const { stdout } = await exec(executablePath, ["--version"]);
const result = JSON.parse(stdout.trim());
if (result.status !== "ok" || result.command !== "version" || result.version !== "0.1.0") {
  throw new Error(`Unexpected binary response: ${stdout}`);
}
console.log(stdout.trim());
