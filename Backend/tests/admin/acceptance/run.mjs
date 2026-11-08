import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const android = process.argv.includes("--android");
const selected = process.argv
  .find((value) => value.startsWith("--only="))
  ?.slice(7)
  .split(",");
const env = { ...process.env, NO_COLOR: "1", CI: "true" };
for (const key of [
  "GOOGLE_APPLICATION_CREDENTIALS",
  "FIREBASE_CONFIG",
  "FIREBASE_PROJECT_ID",
  "FIREBASE_DATABASE_URL",
  "FIREBASE_AUTH_EMULATOR_HOST",
  "FIREBASE_DATABASE_EMULATOR_HOST",
  "FIREBASE_EMULATOR_HUB",
  "GCLOUD_PROJECT",
  "GOOGLE_CLOUD_PROJECT",
  "LEARNING_WORKER_LOCAL",
  "FUNCTIONS_EMULATOR",
  "FORCE_COLOR",
])
  delete env[key];
const stages = [
  {
    name: "admin",
    cwd: root,
    args: ["Backend/functions/tools/run-admin-tests.mjs"],
  },
  {
    name: "server",
    cwd: root,
    args: [
      "--test",
      "Backend/server/test/http.test.mjs",
      "Backend/server/test/firebase.test.mjs",
    ],
  },
  {
    name: "contracts",
    cwd: join(root, "frontend/verification"),
    args: ["--test", "test/contracts.test.mjs", "test/export.test.mjs"],
  },
  {
    name: "web-unit",
    cwd: join(root, "frontend/admin-web"),
    args: ["node_modules/vitest/vitest.mjs", "run"],
  },
  {
    name: "web-types",
    cwd: join(root, "frontend/admin-web"),
    args: ["node_modules/typescript/bin/tsc", "-b"],
  },
  {
    name: "web-demo-build",
    cwd: join(root, "frontend/admin-web"),
    args: ["node_modules/vite/bin/vite.js", "build"],
    env: { VITE_ADMIN_DATA_MODE: "demo" },
  },
  {
    name: "web-build",
    cwd: join(root, "frontend/admin-web"),
    args: ["node_modules/vite/bin/vite.js", "build"],
    env: { VITE_ADMIN_DATA_MODE: "firebase" },
  },
  {
    name: "web-firebase",
    cwd: root,
    args: ["Backend/functions/tools/run-admin-tests.mjs", "--web"],
  },
  {
    name: "web-demo",
    cwd: join(root, "frontend/admin-web"),
    args: ["node_modules/@playwright/test/cli.js", "test"],
  },
  {
    name: "user-backend",
    cwd: root,
    args: [
      "Backend/functions/tools/run-acceptance.mjs",
      ...(android ? ["--android"] : []),
    ],
  },
];
if (selected)
  for (const name of selected)
    assert.ok(
      stages.some((stage) => stage.name === name),
      "Unknown acceptance stage",
    );
if (android) {
  assert.ok(
    env.ANDROID_HOME || env.ANDROID_SDK_ROOT,
    "Set ANDROID_HOME for --android",
  );
  assert.match(
    env.ANDROID_SERIAL || "",
    /^emulator-\d+$/,
    "Use a dedicated Android Emulator",
  );
}
const stamp = new Date()
  .toISOString()
  .replaceAll(":", "-")
  .replaceAll(".", "-");
const output = resolve(root, ".firebase/admin-acceptance", stamp);
assert.ok(!relative(root, output).startsWith(".."));
mkdirSync(output, { recursive: true });
const result = {
  startedAt: new Date().toISOString(),
  commit: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  }).trim(),
  trackedChanges: Boolean(
    execFileSync("git", ["diff", "--name-only"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    }).trim(),
  ),
  scope:
    "Isolated emulator acceptance; no live credentials or live fixture imports",
  android,
  output: relative(root, output).replaceAll("\\", "/"),
  stages: [],
};
const save = () =>
  writeFileSync(
    join(output, "result.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
save();
let current;
const stop = () => {
  if (!current?.pid) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill.exe", ["/PID", String(current.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {}
  } else current.kill("SIGTERM");
};
process.once("SIGINT", () => {
  stop();
  process.exitCode = 130;
});
process.once("SIGTERM", () => {
  stop();
  process.exitCode = 143;
});
for (const stage of stages.filter(
  (stage) => !selected || selected.includes(stage.name),
)) {
  if (process.exitCode) break;
  const started = Date.now(),
    filename = stage.name + ".log";
  const log = createWriteStream(join(output, filename));
  const summaries = [],
    decoder = new StringDecoder("utf8");
  let partial = "",
    nodeCounts = {};
  const line = (value) => {
    const clean = value.replace(/\x1b\[[0-9;]*m/g, "");
    const node = /^(?:ℹ|#)\s*(tests|pass|fail)\s+(\d+)/.exec(clean);
    if (node) {
      nodeCounts[node[1]] = Number(node[2]);
      if (node[1] === "fail") {
        summaries.push({ kind: "node", ...nodeCounts });
        nodeCounts = {};
      }
    }
    const vitest = /^\s*Tests\s+(\d+) passed\s+\((\d+)\)/.exec(clean);
    if (vitest)
      summaries.push({
        kind: "vitest",
        pass: Number(vitest[1]),
        tests: Number(vitest[2]),
        fail: 0,
      });
    const browser = /^\s*(\d+) passed\s+\(/.exec(clean);
    if (browser)
      summaries.push({ kind: "playwright", pass: Number(browser[1]) });
    const instrument = /OK \((\d+) tests?\)/.exec(clean);
    if (instrument)
      summaries.push({ kind: "android", pass: Number(instrument[1]) });
  };
  const collect = (chunk) => {
    log.write(chunk);
    partial += decoder.write(chunk);
    let at;
    while ((at = partial.indexOf("\n")) >= 0) {
      line(partial.slice(0, at));
      partial = partial.slice(at + 1);
    }
    if (partial.length > 32768) partial = partial.slice(-32768);
  };
  console.log("START " + stage.name);
  const exitCode = await new Promise((resolveExit) => {
    current = spawn(process.execPath, stage.args, {
      cwd: stage.cwd,
      env: { ...env, ...stage.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    current.stdout.on("data", collect);
    current.stderr.on("data", collect);
    current.once("error", (error) => {
      log.write("Launch failed: " + error.code + "\n");
      resolveExit(1);
    });
    current.once("exit", (code) => resolveExit(code ?? 1));
  });
  current = undefined;
  line(partial + decoder.end());
  await new Promise((resolveLog) => log.end(resolveLog));
  result.stages.push({
    name: stage.name,
    exitCode,
    durationMs: Date.now() - started,
    log: filename,
    summaries,
  });
  save();
  console.log(
    (exitCode === 0 ? "PASS " : "FAIL ") +
      stage.name +
      " " +
      JSON.stringify(summaries),
  );
  if (exitCode !== 0) {
    process.exitCode = 1;
    break;
  }
  if (stage.name === "web-build") {
    // The Vite plugin rejects mock/seed modules. Also retain an artifact-level check.
    const { readdirSync } = await import("node:fs");
    assert.ok(
      !readdirSync(join(stage.cwd, "dist/assets")).some((name) =>
        name.startsWith("mock-service-"),
      ),
    );
  }
}
result.completedAt = new Date().toISOString();
result.passed =
  result.stages.length ===
    stages.filter((stage) => !selected || selected.includes(stage.name))
      .length && result.stages.every((stage) => stage.exitCode === 0);
save();
console.log(
  "RESULT " + relative(root, join(output, "result.json")).replaceAll("\\", "/"),
);
