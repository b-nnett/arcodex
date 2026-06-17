import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_ID = "hehggadaopoacecdllhhajmbjkdcmajg";
const EXTENSION_PUBLIC_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAr5M/DZ28sAuOnk9v8C2IPTLNEZ0F0pv9qwRzMAbGbE0NB6I6T+wS6Na2n0sbQOK98iezN2FX26dsBWMELXtf4YCETdRiFSBOnNhZObZdrxeTTrhk1AhKA/Id5vgDWfSZ3Q+9BjBWHYK9yuTGo3PMK/yOW/CH6cSn07btvn7Aq+t+KrAwGOJewCN7gGojOrshJs/YwdxwxpUnb7s6QbFGkPKg9G6as4y4ipQ8fiQHRAcKm+mUK/CoCVSL+c4Yog0CSJqEEaruOeh8CgM4V0LX4kw5rs/4THAvTwtYRsW0n3faVR7uGj1eadsWuKciQHxpRMI9I4EE7yuaxavv3Agf6QIDAQAB";
const HOST = "127.0.0.1";
const PLAYWRIGHT_CHROME_FOR_TESTING = path.join(
  os.homedir(),
  "Library/Caches/ms-playwright/chromium-1226/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
);
const CHROME_BINARY =
  process.env.CHROME_BINARY ??
  (existsSync(PLAYWRIGHT_CHROME_FOR_TESTING)
    ? PLAYWRIGHT_CHROME_FOR_TESTING
    : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(scriptDir, "..");
const distDir = path.resolve(extensionDir, "dist");
const nativeHostManifestPath = path.join(
  os.homedir(),
  "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.openai.codexextension.json",
);

const checks = [];

async function main() {
  if (!existsSync(CHROME_BINARY)) {
    throw new Error(`Chrome binary not found at ${CHROME_BINARY}`);
  }
  if (!existsSync(distDir)) {
    throw new Error(
      `Build output not found at ${distDir}. Run npm run build first.`,
    );
  }

  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "codex-extension-runtime-"),
  );
  const userDataDir = path.join(tempRoot, "profile");
  const extensionDir = path.join(tempRoot, "extension");
  let chromeProcess;
  let fixtureServer;

  try {
    await cp(distDir, extensionDir, { recursive: true });
    await addManifestKey(extensionDir);
    await seedNativeHostManifest(userDataDir);

    const port = await getFreePort();
    const fixture = await startFixtureServer();
    fixtureServer = fixture.server;

    chromeProcess = spawn(
      CHROME_BINARY,
      [
        `--user-data-dir=${userDataDir}`,
        `--remote-debugging-address=${HOST}`,
        `--remote-debugging-port=${port}`,
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-sync",
        "--disable-features=DialMediaRouteProvider",
        "--enable-unsafe-extension-debugging",
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    let stderr = "";
    chromeProcess.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    try {
      await waitFor(
        async () => fetchJson(`http://${HOST}:${port}/json/version`),
        {
          label: "Chrome remote debugging endpoint",
          timeoutMs: 12_000,
        },
      );
    } catch (error) {
      throw new Error(
        `${error.message}\nChrome stderr:\n${stderr.slice(-4000)}`,
      );
    }

    const browserVersion = await fetchJson(
      `http://${HOST}:${port}/json/version`,
    );
    const browser = await CdpSession.connect(
      browserVersion.webSocketDebuggerUrl,
    );

    const popup = await openTarget(
      browser,
      port,
      `chrome-extension://${EXTENSION_ID}/popup.html`,
    );
    await popup.send("Runtime.enable");

    const popupText = await evaluate(
      popup,
      `new Promise((resolve) => setTimeout(() => resolve(document.body.innerText), 750))`,
    );
    record("Popup shows native host status", () => {
      assertIncludes(popupText, "Codex");
      assertIncludes(popupText, "Version v1.1.13");
      if (!/\b(Connected|Disconnected)\b/u.test(popupText)) {
        throw new Error(
          `Popup text did not include a connected/disconnected state: ${popupText}`,
        );
      }
      return popupText.replace(/\s+/gu, " ").trim();
    });

    const nativeStatus = await evaluate(
      popup,
      `chrome.runtime.sendMessage({ type: "GET_NATIVE_HOST_STATUS" })`,
    );
    record("GET_NATIVE_HOST_STATUS works", () => {
      if (!nativeStatus || typeof nativeStatus !== "object") {
        throw new Error("Missing native host status response");
      }
      if (
        !nativeStatus.status ||
        typeof nativeStatus.status.hostName !== "string"
      ) {
        throw new Error(
          `Invalid native host status response: ${JSON.stringify(nativeStatus)}`,
        );
      }
      if (
        !["connected", "disconnected", "reconnecting"].includes(
          nativeStatus.status.state,
        )
      ) {
        throw new Error(
          `Unexpected native host state: ${nativeStatus.status.state}`,
        );
      }
      return nativeStatus;
    });

    const sidePanelResponse = await evaluate(
      popup,
      `chrome.runtime.sendMessage({ type: "ensure_codex_app_server" })`,
    );
    record("Side panel/app-server message path responds", () => {
      if (!sidePanelResponse || typeof sidePanelResponse !== "object") {
        throw new Error("Missing side panel response");
      }
      if (sidePanelResponse.sidePanelOpen !== false) {
        throw new Error(
          `Expected sidePanelOpen=false in production-gated build: ${JSON.stringify(sidePanelResponse)}`,
        );
      }
      assertIncludes(String(sidePanelResponse.error ?? ""), "side panel");
      return sidePanelResponse;
    });

    let appServerResponse = null;
    if (process.env.VERIFY_APP_SERVER === "1") {
      const sidePanelWindowId = await evaluate(
        popup,
        `chrome.windows.getCurrent().then((window) => window.id)`,
      );
      appServerResponse =
        nativeStatus?.status?.state === "connected" &&
        typeof sidePanelWindowId === "number"
          ? await evaluate(
              popup,
              `(async () => {
              await chrome.storage.session.set({
                codexSidePanelOpenWindowIds: [${sidePanelWindowId}]
              });
              return Promise.race([
                chrome.runtime.sendMessage({
                  type: "ensure_codex_app_server",
                  windowId: ${sidePanelWindowId}
                }),
                new Promise((resolve) => setTimeout(
                  () => resolve({ ok: false, timedOut: true }),
                  15000
                ))
              ]);
            })()`,
            )
          : null;
    }
    record("Connected native host can service app-server request", () => {
      if (process.env.VERIFY_APP_SERVER !== "1") {
        return {
          skipped: true,
          reason:
            "set VERIFY_APP_SERVER=1 to test the Codex app-server handoff",
        };
      }
      if (nativeStatus?.status?.state !== "connected") {
        return { skipped: true, reason: "native host is not connected" };
      }
      if (!appServerResponse || typeof appServerResponse !== "object") {
        throw new Error(
          "Missing app-server response from connected native host",
        );
      }
      if (appServerResponse.sidePanelOpen !== true) {
        throw new Error(
          `Expected sidePanelOpen=true: ${JSON.stringify(appServerResponse)}`,
        );
      }
      if (appServerResponse.ok !== true) {
        throw new Error(
          `Native host app-server request failed: ${JSON.stringify(appServerResponse)}`,
        );
      }
      return appServerResponse;
    });

    const fixtureUrl = `http://${HOST}:${fixture.port}/`;
    await browser.send("Target.createTarget", { url: fixtureUrl });
    const tabId = await waitForTabId(popup, fixtureUrl);
    await evaluate(
      popup,
      `chrome.scripting.executeScript({
      target: { tabId: ${tabId} },
      files: ["content-scripts/codex.js"]
    })`,
    );

    const overlayResult = await evaluate(
      popup,
      `chrome.scripting.executeScript({
      target: { tabId: ${tabId} },
      func: () => {
        const root = document.getElementById("codex-agent-overlay-root");
        return {
          hasRoot: root instanceof HTMLDivElement,
          marker: root?.dataset.codexAgentOverlayRoot ?? null,
          title: document.title
        };
      }
    }).then(([result]) => result.result)`,
    );
    const pingResult = await evaluate(
      popup,
      `chrome.tabs.sendMessage(${tabId}, { type: "CONTENT_PING" })`,
    );
    record("Content overlay injects and responds", () => {
      if (overlayResult?.hasRoot !== true || overlayResult?.marker !== "true") {
        throw new Error(
          `Overlay root missing: ${JSON.stringify(overlayResult)}`,
        );
      }
      if (pingResult?.ok !== true) {
        throw new Error(`Content ping failed: ${JSON.stringify(pingResult)}`);
      }
      return { overlayResult, pingResult };
    });

    const faviconDataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP8z8BQDwAFgwJ/lcHfKAAAAABJRU5ErkJggg==";
    await evaluate(
      popup,
      `chrome.tabs.sendMessage(${tabId}, {
      type: "TAB_FAVICON_BADGE",
      badge: "deliverable",
      faviconDataUrl: ${JSON.stringify(faviconDataUrl)}
    })`,
    );
    const badgedFavicon = await readFaviconState(popup, tabId);
    await evaluate(
      popup,
      `chrome.tabs.sendMessage(${tabId}, {
      type: "TAB_FAVICON_BADGE",
      badge: null,
      faviconDataUrl: null
    })`,
    );
    const restoredFavicon = await readFaviconState(popup, tabId);
    record("Favicon badges apply and restore", () => {
      if (badgedFavicon.pageIcon?.badged != null) {
        throw new Error(
          `Page favicon was rewritten: ${JSON.stringify(badgedFavicon)}`,
        );
      }
      if (badgedFavicon.managedIcon?.badged !== "true") {
        throw new Error(
          `Favicon was not badged: ${JSON.stringify(badgedFavicon)}`,
        );
      }
      if (
        !decodeURIComponent(badgedFavicon.managedIcon.href).includes(
          'fill="#22c55e"',
        )
      ) {
        throw new Error(
          `Deliverable badge color missing: ${badgedFavicon.managedIcon.href}`,
        );
      }
      if (restoredFavicon.managedIcon != null) {
        throw new Error(
          `Favicon badge was not restored: ${JSON.stringify(restoredFavicon)}`,
        );
      }
      if (restoredFavicon.pageIcon?.href !== badgedFavicon.pageIcon?.href) {
        throw new Error(
          `Page favicon changed after restore: ${JSON.stringify(restoredFavicon)}`,
        );
      }
      return { badgedFavicon, restoredFavicon };
    });

    const cdpResult = await evaluate(
      popup,
      `(async () => {
      await chrome.debugger.attach({ tabId: ${tabId} }, "1.3");
      try {
        const result = await chrome.debugger.sendCommand(
          { tabId: ${tabId} },
          "Runtime.evaluate",
          { expression: "21 * 2", returnByValue: true }
        );
        return result;
      } finally {
        await chrome.debugger.detach({ tabId: ${tabId} });
      }
    })()`,
    );
    record("CDP attach/execute/detach works from extension context", () => {
      if (cdpResult?.result?.value !== 42) {
        throw new Error(`Unexpected CDP result: ${JSON.stringify(cdpResult)}`);
      }
      return cdpResult;
    });

    await popup.close();
    await browser.close();

    console.log(JSON.stringify({ ok: true, checks }, null, 2));
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          checks,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  } finally {
    if (chromeProcess && chromeProcess.exitCode == null) {
      chromeProcess.kill("SIGTERM");
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 1500);
        chromeProcess.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      if (chromeProcess.exitCode == null) {
        chromeProcess.kill("SIGKILL");
      }
    }
    if (fixtureServer) {
      await new Promise((resolve) => fixtureServer.close(resolve));
    }
    await rm(tempRoot, { force: true, recursive: true });
  }
}

async function addManifestKey(extensionPath) {
  const manifestPath = path.join(extensionPath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.key = EXTENSION_PUBLIC_KEY;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function seedNativeHostManifest(profileDir) {
  if (!existsSync(nativeHostManifestPath)) {
    return;
  }

  const manifest = await readFile(nativeHostManifestPath, "utf8");
  for (const dir of [
    path.join(profileDir, "NativeMessagingHosts"),
    path.join(profileDir, "Default/NativeMessagingHosts"),
  ]) {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "com.openai.codexextension.json"), manifest);
  }
}

async function startFixtureServer() {
  const server = createServer((request, response) => {
    if (request.url === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
    });
    response.end(`<!doctype html>
<html>
  <head>
    <title>Codex runtime fixture</title>
    <link rel="icon" href="data:image/png;base64,iVBORw0KGgo=">
  </head>
  <body><h1>Codex runtime fixture</h1></body>
</html>`);
  });
  const port = await getFreePort();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return { port, server };
}

async function waitForTabId(popup, fixtureUrl) {
  return waitFor(
    async () => {
      const tabId = await evaluate(
        popup,
        `(async () => {
          const tabs = await chrome.tabs.query({ url: ${JSON.stringify(`${fixtureUrl}*`)} });
          const tab = tabs.find((candidate) => candidate.url?.startsWith(${JSON.stringify(fixtureUrl)}));
          return tab?.id ?? null;
        })()`,
      );
      return typeof tabId === "number" ? tabId : null;
    },
    { label: "fixture tab id", timeoutMs: 8_000 },
  );
}

async function readFaviconState(popup, tabId) {
  return evaluate(
    popup,
    `chrome.scripting.executeScript({
      target: { tabId: ${tabId} },
      func: () => {
        const pageIcon = document.head.querySelector('link[rel="icon"]:not([data-codex-favicon-badge="true"])');
        const managedIcon = document.head.querySelector('link[data-codex-favicon-badge="true"]');
        const serialize = (link) => link == null ? null : ({
          badged: link.dataset.codexFaviconBadge ?? null,
          managed: link.dataset.codexFaviconBadgeManaged ?? null,
          href: link.getAttribute("href") ?? "",
        });
        return {
          pageIcon: serialize(pageIcon),
          managedIcon: serialize(managedIcon),
        };
      }
    }).then(([result]) => result.result)`,
  );
}

async function openTarget(browser, port, url) {
  const { targetId } = await browser.send("Target.createTarget", { url });
  const target = await waitFor(
    async () => {
      const targets = await fetchJson(`http://${HOST}:${port}/json/list`);
      return targets.find((candidate) => candidate.id === targetId) ?? null;
    },
    { label: `target ${url}`, timeoutMs: 8_000 },
  );
  return CdpSession.connect(target.webSocketDebuggerUrl);
}

async function evaluate(session, expression) {
  const response = await session.send("Runtime.evaluate", {
    awaitPromise: true,
    expression,
    returnByValue: true,
    userGesture: true,
  });
  if (response.exceptionDetails) {
    throw new Error(
      `Evaluation failed: ${response.exceptionDetails.text ?? JSON.stringify(response.exceptionDetails)}`,
    );
  }
  return response.result.value;
}

function record(name, callback) {
  try {
    const details = callback();
    checks.push({ name, ok: true, details });
  } catch (error) {
    checks.push({
      name,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function assertIncludes(value, expected) {
  if (!String(value).includes(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(value)} to include ${JSON.stringify(expected)}`,
    );
  }
}

async function waitFor(callback, { label, timeoutMs }) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await callback();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(
    `Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`,
  );
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  return response.json();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (!address || typeof address === "string") {
    throw new Error("Unable to allocate a TCP port");
  }
  return address.port;
}

class CdpSession {
  static async connect(wsUrl) {
    const socket = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return new CdpSession(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) {
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result ?? {});
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`Timed out waiting for CDP method ${method}`));
        }
      }, 60_000).unref?.();
    });
  }

  close() {
    this.socket.close();
  }
}

await main();
