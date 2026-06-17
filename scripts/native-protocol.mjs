export const EXTENSION_ID = "hehggadaopoacecdllhhajmbjkdcmajg";
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export function createBridgeRequestIdFactory(prefix = "arcodex-bridge") {
  let nextBridgeRequestId = 0;
  return () => {
    nextBridgeRequestId += 1;
    return `${prefix}:${nextBridgeRequestId}`;
  };
}

export function normalizeNativeResponse(
  message,
  pending,
  { defaultExtensionId = EXTENSION_ID } = {},
) {
  if (
    pending.method !== "getInfo" ||
    !isJsonObject(message.result) ||
    typeof message.result.browser_id === "string"
  ) {
    return message;
  }

  const metadata = isJsonObject(message.result.metadata)
    ? message.result.metadata
    : null;
  const browserId =
    typeof metadata?.extensionInstanceId === "string"
      ? metadata.extensionInstanceId
      : typeof metadata?.extensionId === "string"
        ? metadata.extensionId
        : defaultExtensionId;

  return {
    ...message,
    result: {
      browser_id: browserId,
      ...message.result,
    },
  };
}

export function encodeFrame(message, { maxFrameBytes = MAX_FRAME_BYTES } = {}) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.byteLength > maxFrameBytes) {
    throw new Error("JSON-RPC frame is too large");
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.byteLength, 0);
  return Buffer.concat([header, body]);
}

export function createFrameDecoder(
  onMessage,
  { maxFrameBytes = MAX_FRAME_BYTES } = {},
) {
  let buffer = Buffer.alloc(0);
  return {
    push(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.byteLength >= 4) {
        const length = buffer.readUInt32LE(0);
        if (length > maxFrameBytes) {
          throw new Error(`Frame length ${length} exceeds limit`);
        }
        if (buffer.byteLength < 4 + length) {
          return;
        }
        const body = buffer.subarray(4, 4 + length).toString("utf8");
        buffer = buffer.subarray(4 + length);
        onMessage(JSON.parse(body));
      }
    },
  };
}

export function isJsonObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
