import { spawn } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";

const extensionId = "hehggadaopoacecdllhhajmbjkdcmajg";
const hostPath =
  process.env.CODEX_EXTENSION_HOST_PATH ??
  path.join(
    os.homedir(),
    ".codex/plugins/cache/openai-bundled/chrome/latest/extension-host/macos/arm64/extension-host",
  );
const origin =
  process.env.CODEX_EXTENSION_ORIGIN ?? `chrome-extension://${extensionId}/`;
const timeoutMs = Number(process.env.PROBE_TIMEOUT_MS ?? 15000);

const request = {
  jsonrpc: "2.0",
  id: process.env.PROBE_ID ?? "native-host:probe",
  method: process.env.PROBE_METHOD ?? "ensureCodexAppServer",
};

if (process.env.PROBE_PARAMS) {
  request.params = JSON.parse(process.env.PROBE_PARAMS);
}

const child = spawn(hostPath, [origin], {
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});

const stdoutChunks = [];
const stderrChunks = [];
child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

child.stdin.end(encodeNativeMessage(request));

const timeout = setTimeout(() => {
  child.kill("SIGTERM");
}, timeoutMs);

let exit;
try {
  exit = await once(child, "exit");
} finally {
  clearTimeout(timeout);
}

const stdout = Buffer.concat(stdoutChunks);
const stderr = Buffer.concat(stderrChunks).toString("utf8");

const decodedMessages = [];
let offset = 0;
while (offset + 4 <= stdout.length) {
  const length = stdout.readUInt32LE(offset);
  offset += 4;
  if (offset + length > stdout.length) {
    decodedMessages.push({
      incomplete: true,
      length,
      available: stdout.length - offset,
    });
    break;
  }
  const body = stdout.subarray(offset, offset + length).toString("utf8");
  offset += length;
  try {
    decodedMessages.push(JSON.parse(body));
  } catch {
    decodedMessages.push({ invalidJson: body });
  }
}

console.log(
  JSON.stringify(
    {
      hostPath,
      origin,
      request,
      timeoutMs,
      exit: { code: exit[0], signal: exit[1] },
      stdoutBytes: stdout.length,
      decodedMessages,
      stderr,
    },
    null,
    2,
  ),
);

function encodeNativeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}
