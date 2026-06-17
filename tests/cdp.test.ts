import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CdpCommandPayload } from "../src/shared/protocol";

function installChromeDebuggerMock() {
  const debuggerApi = {
    attach: vi.fn(async () => {}),
    detach: vi.fn(async () => {}),
    getTargets: vi.fn(async () => [
      { id: "target-1", tabId: 10, type: "page" },
    ]),
    sendCommand: vi.fn(async () => ({ value: 4 })),
  };

  globalThis.chrome = {
    debugger: debuggerApi,
  } as unknown as typeof chrome;
  (globalThis as unknown as { self: unknown }).self = globalThis;
  return debuggerApi;
}

function payload(
  overrides: Partial<CdpCommandPayload> = {},
): CdpCommandPayload {
  return {
    browser_id: "chrome",
    session_id: "session",
    turn_id: "turn",
    target: { tabId: 10 },
    method: "Runtime.evaluate",
    commandParams: { expression: "2 + 2" },
    ...overrides,
  };
}

describe("CDP debugger bridge", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useRealTimers();
    installChromeDebuggerMock();
  });

  it("requires tab debuggers to be attached before sending tab commands", async () => {
    const { executeCdpCommand } = await import("../src/background/cdp");

    await expect(executeCdpCommand(payload())).rejects.toThrow(
      "Debugger unattached",
    );
  });

  it("attaches, sends CDP command payloads, and passes results through", async () => {
    const debuggerApi = installChromeDebuggerMock();
    const { attachTabDebugger, detachTabDebugger, executeCdpCommand } =
      await import("../src/background/cdp");

    await attachTabDebugger(10);
    await expect(executeCdpCommand(payload())).resolves.toEqual({ value: 4 });

    expect(debuggerApi.attach).toHaveBeenCalledWith({ tabId: 10 }, "1.3");
    expect(debuggerApi.sendCommand).toHaveBeenCalledWith(
      { tabId: 10 },
      "Runtime.evaluate",
      { expression: "2 + 2" },
    );

    await detachTabDebugger(10);
  });

  it("uses chrome.debugger.getTargets for Target.getTargets", async () => {
    const debuggerApi = installChromeDebuggerMock();
    const { executeCdpCommand } = await import("../src/background/cdp");

    await expect(
      executeCdpCommand(
        payload({
          method: "Target.getTargets",
          target: {},
        }),
      ),
    ).resolves.toEqual({
      targetInfos: [{ id: "target-1", tabId: 10, type: "page" }],
    });
    expect(debuggerApi.sendCommand).not.toHaveBeenCalled();
  });

  it("force-detaches tabs after CDP command timeouts", async () => {
    vi.useFakeTimers();
    const debuggerApi = installChromeDebuggerMock();
    debuggerApi.sendCommand.mockReturnValue(new Promise(() => {}));
    const { attachTabDebugger, executeCdpCommand } = await import(
      "../src/background/cdp"
    );

    await attachTabDebugger(10);
    const result = executeCdpCommand(payload({ timeoutMs: 10 }));
    const rejected = expect(result).rejects.toThrow(
      "Timed out after 10ms waiting for CDP command Runtime.evaluate.",
    );
    await vi.advanceTimersByTimeAsync(11);

    await rejected;
    expect(debuggerApi.detach).toHaveBeenCalledWith({ tabId: 10 });
  });

  it("treats already-detached debugger targets as detached", async () => {
    const debuggerApi = installChromeDebuggerMock();
    debuggerApi.detach.mockRejectedValue(new Error("Debugger is not attached"));
    const { attachTabDebugger, detachTabDebugger } = await import(
      "../src/background/cdp"
    );

    await attachTabDebugger(10);
    await expect(detachTabDebugger(10)).resolves.toBeUndefined();
  });
});
