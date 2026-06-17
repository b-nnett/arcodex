import { describe, expect, it } from "vitest";
import {
  createBridgeRequestIdFactory,
  createFrameDecoder,
  EXTENSION_ID,
  encodeFrame,
  normalizeNativeResponse,
} from "../scripts/native-protocol.mjs";

describe("native bridge protocol helpers", () => {
  it("encodes and decodes native-message frames", () => {
    const messages = [];
    const decoder = createFrameDecoder((message) => messages.push(message));
    const first = encodeFrame({ jsonrpc: "2.0", id: 1, method: "getInfo" });
    const second = encodeFrame({ jsonrpc: "2.0", id: 2, result: "ok" });

    decoder.push(Buffer.concat([first.subarray(0, 3)]));
    expect(messages).toEqual([]);

    decoder.push(Buffer.concat([first.subarray(3), second]));
    expect(messages).toEqual([
      { jsonrpc: "2.0", id: 1, method: "getInfo" },
      { jsonrpc: "2.0", id: 2, result: "ok" },
    ]);
  });

  it("rejects oversized frames before allocating a body", () => {
    const decoder = createFrameDecoder(() => {}, { maxFrameBytes: 4 });
    const header = Buffer.alloc(4);
    header.writeUInt32LE(5, 0);

    expect(() => decoder.push(header)).toThrow("Frame length 5 exceeds limit");
    expect(() =>
      encodeFrame({ payload: "12345" }, { maxFrameBytes: 4 }),
    ).toThrow("JSON-RPC frame is too large");
  });

  it("creates stable bridge request ids", () => {
    const nextId = createBridgeRequestIdFactory();

    expect(nextId()).toBe("arcodex-bridge:1");
    expect(nextId()).toBe("arcodex-bridge:2");
  });

  it("adds browser_id to getInfo responses for browser-client compatibility", () => {
    const response = normalizeNativeResponse(
      {
        jsonrpc: "2.0",
        id: "arcodex-bridge:1",
        result: {
          metadata: {
            extensionInstanceId: "instance-123",
          },
          version: "1.1.13",
        },
      },
      { method: "getInfo" },
    );

    expect(response.result).toMatchObject({
      browser_id: "instance-123",
      version: "1.1.13",
    });
  });

  it("falls back to the extension id when getInfo metadata has no instance id", () => {
    const response = normalizeNativeResponse(
      {
        jsonrpc: "2.0",
        id: "arcodex-bridge:1",
        result: {
          metadata: {},
        },
      },
      { method: "getInfo" },
    );

    expect(response.result.browser_id).toBe(EXTENSION_ID);
  });

  it("leaves non-getInfo responses untouched", () => {
    const message = {
      jsonrpc: "2.0",
      id: "arcodex-bridge:2",
      result: { metadata: { extensionInstanceId: "ignored" } },
    };

    expect(normalizeNativeResponse(message, { method: "getTabs" })).toBe(
      message,
    );
  });
});
