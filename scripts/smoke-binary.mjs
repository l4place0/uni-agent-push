import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const directory = await mkdtemp(join(tmpdir(), "uni-push-binary-smoke-"));
const child = spawn(executablePath, ["onboard", "--no-open", "--config", join(directory, "config.json")], {
  stdio: ["ignore", "pipe", "pipe"],
});
const exited = new Promise((resolve) => child.once("exit", resolve));
let output = "";
let errors = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { errors += chunk; });

try {
  const origin = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Onboarding did not start: ${output}${errors}`)), 10000);
    const inspect = () => {
      const match = output.match(/http:\/\/127\.0\.0\.1:[0-9]+/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[0]);
      }
    };
    child.stdout.on("data", inspect);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Onboarding exited early (${code}): ${output}${errors}`));
    });
    inspect();
  });
  const response = await fetch(origin);
  const page = await response.text();
  if (!response.ok || !page.includes("Uni Push 配置")) throw new Error("Embedded Onboarding UI is unavailable");
} finally {
  child.kill("SIGTERM");
  await exited;
  await rm(directory, { recursive: true, force: true });
}

console.log(JSON.stringify({ ...result, onboarding_ui: "ok" }));
