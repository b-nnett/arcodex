import { describe, expect, it } from "vitest";
import { JsonRpcPeer, type RpcTransport } from "../src/background/rpc";
import type { JsonRpcMessage } from "../src/shared/protocol";

class FakeTransport implements RpcTransport {
  messages: JsonRpcMessage[] = [];
  callback: ((message: JsonRpcMessage) => void) | null = null;

  sendMessage(message: JsonRpcMessage): void {
    this.messages.push(message);
  }

  setMessageCallback(callback: (message: JsonRpcMessage) => void): void {
    this.callback = callback;
  }

  receive(message: JsonRpcMessage): void {
    this.callback?.(message);
  }
}

describe("JsonRpcPeer", () => {
  it("dispatches incoming requests to registered handlers", async () => {
    const transport = new FakeTransport();
    const peer = new JsonRpcPeer(transport);
    peer.registerRequestHandler("ping", () => "pong");

    transport.receive({ jsonrpc: "2.0", id: 1, method: "ping" });
    await Promise.resolve();

    expect(transport.messages).toEqual([
      { jsonrpc: "2.0", id: 1, result: "pong" },
    ]);
  });

  it("returns the observed error shape for unknown methods", async () => {
    const transport = new FakeTransport();
    new JsonRpcPeer(transport);

    transport.receive({ jsonrpc: "2.0", id: 2, method: "missing" });
    await Promise.resolve();

    expect(transport.messages).toEqual([
      {
        jsonrpc: "2.0",
        id: 2,
        error: {
          code: -1,
          message: "No handler registered for method: missing",
        },
      },
    ]);
  });

  it("dispatches notifications to event listeners without replying", async () => {
    const transport = new FakeTransport();
    const peer = new JsonRpcPeer(transport);
    const received: unknown[] = [];
    peer.addEventListener("moveMouse", (params) => {
      received.push(params);
    });

    transport.receive({
      jsonrpc: "2.0",
      method: "moveMouse",
      params: { x: 1 },
      id: undefined as never,
    });
    await Promise.resolve();

    expect(received).toEqual([{ x: 1 }]);
    expect(transport.messages).toEqual([]);
  });

  it("resolves outgoing requests from incoming responses", async () => {
    const transport = new FakeTransport();
    const peer = new JsonRpcPeer(transport);
    const request = peer.sendRequest("ping");

    expect(transport.messages[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
    });

    transport.receive({ jsonrpc: "2.0", id: 1, result: "pong" });

    await expect(request).resolves.toBe("pong");
  });
});
