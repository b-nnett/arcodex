import { describe, expect, it, vi } from "vitest";
import { createRuntimeMessageHandler } from "../src/background/runtimeMessages";
import type { NativeHostStatus } from "../src/shared/protocol";

function status(state: NativeHostStatus["state"]): NativeHostStatus {
  return {
    state,
    hostName: "com.openai.codexextension",
    lastChecked: 1,
    reconnectAttempt: 0,
  };
}

describe("runtime message handler", () => {
  it("handles GET_NATIVE_HOST_STATUS with observed response shape", () => {
    const sendResponse = vi.fn();
    const handler = createRuntimeMessageHandler({
      nativeTransport: {} as never,
      refreshAndStoreStatus: () => status("connected"),
      sidePanelTracker: {} as never,
      browserControl: { notifyCursorArrived: vi.fn() },
    });

    expect(handler({ type: "GET_NATIVE_HOST_STATUS" }, {}, sendResponse)).toBe(
      true,
    );

    expect(sendResponse).toHaveBeenCalledWith({
      ok: true,
      status: status("connected"),
      error: undefined,
    });
  });

  it("returns the empty cursor state for GET_AGENT_CURSOR_STATE", () => {
    const sendResponse = vi.fn();
    const handler = createRuntimeMessageHandler({
      nativeTransport: {} as never,
      refreshAndStoreStatus: () => status("connected"),
      sidePanelTracker: {} as never,
      browserControl: { notifyCursorArrived: vi.fn() },
    });

    expect(handler({ type: "GET_AGENT_CURSOR_STATE" }, {}, sendResponse)).toBe(
      true,
    );

    expect(sendResponse).toHaveBeenCalledWith({
      ok: true,
      state: {
        cursor: null,
        isVisible: false,
        sessionId: null,
        turnId: null,
      },
    });
  });

  it("forwards AGENT_CURSOR_ARRIVED to browser control", () => {
    const notifyCursorArrived = vi.fn();
    const sendResponse = vi.fn();
    const handler = createRuntimeMessageHandler({
      nativeTransport: {} as never,
      refreshAndStoreStatus: () => status("connected"),
      sidePanelTracker: {} as never,
      browserControl: { notifyCursorArrived },
    });

    expect(
      handler(
        {
          type: "AGENT_CURSOR_ARRIVED",
          sessionId: "session",
          turnId: "turn",
          moveSequence: 3,
        },
        { tab: { id: 10 } as chrome.tabs.Tab },
        sendResponse,
      ),
    ).toBe(true);

    expect(notifyCursorArrived).toHaveBeenCalledWith({
      type: "AGENT_CURSOR_ARRIVED",
      sessionId: "session",
      turnId: "turn",
      moveSequence: 3,
    });
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });

  it("returns false for unrelated messages", () => {
    const handler = createRuntimeMessageHandler({
      nativeTransport: {} as never,
      refreshAndStoreStatus: () => status("connected"),
      sidePanelTracker: {} as never,
      browserControl: { notifyCursorArrived: vi.fn() },
    });

    expect(handler({ type: "UNKNOWN" } as never, {}, vi.fn())).toBe(false);
  });
});
