import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_ID = "hehggadaopoacecdllhhajmbjkdcmajg";
const HOST_NAME = "com.openai.codexextension";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const wrapperSourcePath = path.join(
  scriptDir,
  "codex-native-host-bridge-wrapper.c",
);
const wrapperPath = path.join(scriptDir, "codex-native-host-bridge-bin");
const manifestPaths = [
  path.join(
    os.homedir(),
    "Library/Application Support/Google/Chrome/NativeMessagingHosts",
    `${HOST_NAME}.json`,
  ),
  path.join(
    os.homedir(),
    "Library/Application Support/Arc/User Data/NativeMessagingHosts",
    `${HOST_NAME}.json`,
  ),
];

await compileWrapper();
await chmod(wrapperPath, 0o755);

const manifest = {
  allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  description: "Arcodex Codex chrome native messaging host bridge",
  name: HOST_NAME,
  path: wrapperPath,
  type: "stdio",
};

const installed = [];
for (const manifestPath of manifestPaths) {
  await mkdir(path.dirname(manifestPath), { recursive: true });

  const backupPath = `${manifestPath}.bak.${new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14)}`;

  try {
    await copyFile(manifestPath, backupPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  installed.push({ manifestPath, backupPath });
}

console.log(
  JSON.stringify(
    {
      ok: true,
      hostPath: wrapperPath,
      installed,
    },
    null,
    2,
  ),
);

async function compileWrapper() {
  await new Promise((resolve, reject) => {
    const child = spawn(
      "/usr/bin/clang",
      [wrapperSourcePath, "-o", wrapperPath],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`clang exited ${code}: ${stderr}`));
      }
    });
  });
}
