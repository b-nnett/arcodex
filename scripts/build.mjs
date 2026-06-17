import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { build } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const reconstructionImages = resolve(root, "src/images");
const extensionPublicKey =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAr5M/DZ28sAuOnk9v8C2IPTLNEZ0F0pv9qwRzMAbGbE0NB6I6T+wS6Na2n0sbQOK98iezN2FX26dsBWMELXtf4YCETdRiFSBOnNhZObZdrxeTTrhk1AhKA/Id5vgDWfSZ3Q+9BjBWHYK9yuTGo3PMK/yOW/CH6cSn07btvn7Aq+t+KrAwGOJewCN7gGojOrshJs/YwdxwxpUnb7s6QbFGkPKg9G6as4y4ipQ8fiQHRAcKm+mUK/CoCVSL+c4Yog0CSJqEEaruOeh8CgM4V0LX4kw5rs/4THAvTwtYRsW0n3faVR7uGj1eadsWuKciQHxpRMI9I4EE7yuaxavv3Agf6QIDAQAB";
const manifest = JSON.parse(
  readFileSync(resolve(root, "src/manifest.json"), "utf8"),
);
const backgroundFileName = `background-${manifest.version}.js`;

rmSync(dist, { force: true, recursive: true });
mkdirSync(dist, { recursive: true });

await build({
  root,
  configFile: false,
  plugins: [react()],
  build: {
    outDir: dist,
    emptyOutDir: false,
    sourcemap: true,
    rollupOptions: {
      input: resolve(root, "popup.html"),
      output: {
        entryFileNames: "chunks/[name]-[hash].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});

await buildStandaloneEntry({
  entry: resolve(root, "src/background/index.ts"),
  fileName: backgroundFileName,
  globalName: "background",
});

await buildStandaloneEntry({
  entry: resolve(root, "src/content/codex.ts"),
  fileName: "content-scripts/codex.js",
  globalName: "codex",
});

manifest.background.service_worker = backgroundFileName;
manifest.key = extensionPublicKey;
writeFileSync(
  resolve(dist, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

mkdirSync(resolve(dist, "images"), { recursive: true });
for (const image of [
  "cursor-chat.png",
  "icon16.png",
  "icon32.png",
  "icon48.png",
  "icon128.png",
]) {
  cpSync(resolve(reconstructionImages, image), resolve(dist, "images", image), {
    force: true,
    recursive: true,
  });
}

async function buildStandaloneEntry({ entry, fileName, globalName }) {
  await build({
    root,
    configFile: false,
    build: {
      outDir: dist,
      emptyOutDir: false,
      sourcemap: true,
      rollupOptions: {
        input: entry,
        output: {
          format: "iife",
          name: globalName,
          inlineDynamicImports: true,
          entryFileNames: fileName,
        },
      },
    },
  });
}
