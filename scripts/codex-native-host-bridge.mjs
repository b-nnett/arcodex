import crypto from "node:crypto";
import fs from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  createBridgeRequestIdFactory,
  createFrameDecoder,
  encodeFrame,
  isJsonObject,
  normalizeNativeResponse,
} from "./native-protocol.mjs";

const SOCKET_DIR = "/tmp/codex-browser-use";
const HOST_REQUEST_TIMEOUT_MS = 10_000;
const LOG_PATH =
  process.env.ARCODEX_BRIDGE_LOG_PATH ??
  path.join(os.homedir(), ".codex/tmp/arcodex-native-host-bridge.log");

const createBridgeRequestId = createBridgeRequestIdFactory();
const pendingSocketRequests = new Map();
const socketClients = new Set();
const nativeDecoder = createFrameDecoder(handleNativeMessage);
const socketPath = path.join(SOCKET_DIR, `${crypto.randomUUID()}.sock`);

await mkdir(SOCKET_DIR, { recursive: true });

const server = net.createServer((socket) => {
  socketClients.add(socket);
  const decoder = createFrameDecoder((message) => {
    handleSocketMessage(socket, message);
  });

  socket.on("data", (chunk) => {
    try {
      decoder.push(chunk);
    } catch (error) {
      log("socket decode error", errorMessage(error));
      socket.destroy();
    }
  });
  socket.on("error", (error) => {
    log("socket error", error.message);
  });
  socket.on("close", () => {
    socketClients.delete(socket);
    rejectPendingForSocket(socket, new Error("browser client disconnected"));
  });
});

server.on("error", (error) => {
  log("server error", error.message);
  process.exitCode = 1;
});

server.listen(socketPath, () => {
  try {
    fs.chmodSync(socketPath, 0o600);
  } catch {}
  log("listening", socketPath, "origin", process.argv[2] ?? "");
});

process.stdin.on("data", (chunk) => {
  try {
    nativeDecoder.push(chunk);
  } catch (error) {
    log("native decode error", errorMessage(error));
    shutdown(1);
  }
});
process.stdin.on("end", () => {
  log("native stdin ended");
  shutdown(0);
});
process.stdin.on("error", (error) => {
  log("native stdin error", error.message);
  shutdown(1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    log("signal", signal);
    shutdown(0);
  });
}

function handleSocketMessage(socket, message) {
  if (!isJsonObject(message)) {
    sendSocketMessage(socket, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid JSON-RPC message" },
    });
    return;
  }

  if ("id" in message && "method" in message) {
    const forwardedId = createBridgeRequestId();
    pendingSocketRequests.set(forwardedId, {
      method: message.method,
      originalId: message.id,
      socket,
      timeout: setTimeout(() => {
        pendingSocketRequests.delete(forwardedId);
        sendSocketMessage(socket, {
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: 1,
            message: `Extension request "${message.method}" timed out after ${HOST_REQUEST_TIMEOUT_MS}ms`,
          },
        });
      }, HOST_REQUEST_TIMEOUT_MS),
    });
    sendNativeMessage({ ...message, id: forwardedId });
    return;
  }

  sendNativeMessage(message);
}

function handleNativeMessage(message) {
  if (!isJsonObject(message)) {
    return;
  }

  if ("id" in message) {
    const pending = pendingSocketRequests.get(message.id);
    if (pending) {
      pendingSocketRequests.delete(message.id);
      clearTimeout(pending.timeout);
      sendSocketMessage(pending.socket, {
        ...normalizeNativeResponse(message, pending),
        id: pending.originalId,
      });
      return;
    }
  }

  if ("method" in message && "id" in message) {
    handleNativeHostRequest(message);
    return;
  }

  broadcastSocketMessage(message);
}

function handleNativeHostRequest(message) {
  if (message.method === "ensureCodexAppServer") {
    sendNativeMessage({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        connected: true,
        bridge: "arcodex-native-host-bridge",
        localAppServerUrl: null,
      },
    });
    return;
  }

  if (message.method === "ping") {
    sendNativeMessage({
      jsonrpc: "2.0",
      id: message.id,
      result: "pong",
    });
    return;
  }

  sendNativeMessage({
    jsonrpc: "2.0",
    id: message.id,
    error: {
      code: -32601,
      message: `No bridge handler registered for method: ${message.method}`,
    },
  });
}

function rejectPendingForSocket(socket, error) {
  for (const [id, pending] of pendingSocketRequests) {
    if (pending.socket !== socket) {
      continue;
    }
    pendingSocketRequests.delete(id);
    clearTimeout(pending.timeout);
  }
  log("client closed", error.message);
}

function sendNativeMessage(message) {
  process.stdout.write(encodeFrame(message));
}

function sendSocketMessage(socket, message) {
  if (socket.destroyed) {
    return;
  }
  socket.write(encodeFrame(message));
}

function broadcastSocketMessage(message) {
  for (const socket of socketClients) {
    sendSocketMessage(socket, message);
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function log(...parts) {
  if (process.env.ARCODEX_BRIDGE_LOG === "0") {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(
      LOG_PATH,
      `${new Date().toISOString()} ${parts.map(String).join(" ")}\n`,
    );
  } catch {}
}

function shutdown(code) {
  for (const pending of pendingSocketRequests.values()) {
    clearTimeout(pending.timeout);
  }
  pendingSocketRequests.clear();
  for (const socket of socketClients) {
    socket.destroy();
  }
  server.close(() => {});
  rm(socketPath, { force: true }).finally(() => {
    process.exit(code);
  });
}
