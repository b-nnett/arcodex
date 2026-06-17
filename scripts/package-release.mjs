import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const packageJson = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
);
const manifestPath = resolve(dist, "manifest.json");

if (!existsSync(manifestPath)) {
  throw new Error("dist/manifest.json is missing; run npm run build first");
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const releaseDir = resolve(root, "releases", manifest.version);
if (manifest.version !== packageJson.version) {
  throw new Error(
    `Version mismatch: package.json=${packageJson.version}, dist/manifest.json=${manifest.version}`,
  );
}

const worker = manifest.background?.service_worker;
if (worker !== `background-${manifest.version}.js`) {
  throw new Error(`Unexpected background worker name: ${worker}`);
}
if (!existsSync(resolve(dist, worker))) {
  throw new Error(`Background worker does not exist: ${worker}`);
}

mkdirSync(releaseDir, { recursive: true });

const artifactName = `codex-os-extension-${manifest.version}.zip`;
const artifactPath = resolve(releaseDir, artifactName);
const checksumPath = resolve(releaseDir, `${artifactName}.sha256`);
rmSync(artifactPath, { force: true });
rmSync(checksumPath, { force: true });

const zip = spawnSync("zip", ["-qry", artifactPath, "."], {
  cwd: dist,
  stdio: "inherit",
});
if (zip.error != null) {
  throw zip.error;
}
if (zip.status !== 0) {
  throw new Error(`zip exited with status ${zip.status}`);
}

const digest = createHash("sha256")
  .update(readFileSync(artifactPath))
  .digest("hex");
writeFileSync(checksumPath, `${digest}  ${artifactName}\n`);

console.log(
  JSON.stringify(
    {
      ok: true,
      version: manifest.version,
      artifact: artifactPath,
      sha256: digest,
    },
    null,
    2,
  ),
);
