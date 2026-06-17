import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeTransport } from "../src/background/nativeTransport";
import type { JsonRpcMessage, NativeHostStatus } from "../src/shared/protocol";

type Listener<T> = (value: T) => void;

class EventMock<T> {
  listeners: Listener<T>[] = [];

  addListener(listener: Listener<T>): void {
    this.listeners.push(listener);
  }

  removeListener(listener: Listener<T>): void {
    this.listeners = this.listeners.filter(
      (candidate) => candidate !== listener,
    );
  }

  emit(value: T): void {
    for (const listener of this.listeners) {
      listener(value);
    }
  }
}

class PortMock {
  readonly onMessage = new EventMock<JsonRpcMessage>();
  readonly onDisconnect = new EventMock<void>();
  readonly postMessage = vi.fn();
}

describe("NativeTransport", () => {
  let alarmEvent: EventMock<chrome.alarms.Alarm>;
  let createdAlarms: Array<{
    name: string;
    info: chrome.alarms.AlarmCreateInfo;
  }>;
  let clearedAlarms: string[];
  let connectNative: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("self", globalThis);
    alarmEvent = new EventMock<chrome.alarms.Alarm>();
    createdAlarms = [];
    clearedAlarms = [];
    connectNative = vi.fn();

    globalThis.chrome = {
      alarms: {
        onAlarm: alarmEvent,
        get: vi.fn(async () => undefined),
        create: vi.fn(
          async (name: string, info: chrome.alarms.AlarmCreateInfo) => {
            createdAlarms.push({ name, info });
          },
        ),
        clear: vi.fn(async (name: string) => {
          clearedAlarms.push(name);
          return true;
        }),
      },
      runtime: {
        connectNative,
        lastError: undefined,
      },
    } as unknown as typeof chrome;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("connects to the native host and reports connected status", () => {
    const port = new PortMock();
    connectNative.mockReturnValue(port);
    const statuses: NativeHostStatus[] = [];

    const transport = new NativeTransport(
      "com.openai.codexextension",
      (status) => {
        statuses.push(status);
      },
    );

    expect(connectNative).toHaveBeenCalledWith("com.openai.codexextension");
    expect(transport.getStatus()).toMatchObject({
      state: "connected",
      hostName: "com.openai.codexextension",
      reconnectAttempt: 0,
    });
    expect(statuses.at(-1)?.state).toBe("connected");
    expect(clearedAlarms).toContain(
      "native-transport-reconnect:com.openai.codexextension",
    );
  });

  it("sends host requests with observed native-host ids and resolves responses", async () => {
    const port = new PortMock();
    connectNative.mockReturnValue(port);
    const transport = new NativeTransport("com.openai.codexextension");

    const request = transport.requestHost("ensureCodexAppServer");

    expect(port.postMessage).toHaveBeenCalledWith({
      jsonrpc: "2.0",
      id: "native-host:1",
      method: "ensureCodexAppServer",
    });

    port.onMessage.emit({
      jsonrpc: "2.0",
      id: "native-host:1",
      result: { port: 1234 },
    });

    await expect(request).resolves.toEqual({ port: 1234 });
  });

  it("rejects unanswered host requests after a bounded timeout", async () => {
    const port = new PortMock();
    connectNative.mockReturnValue(port);
    const transport = new NativeTransport("com.openai.codexextension");

    const request = transport.requestHost("ensureCodexAppServer", undefined, {
      timeoutMs: 250,
    });
    const rejection = expect(request).rejects.toThrow(
      'Native host request "ensureCodexAppServer" timed out after 250ms',
    );

    await vi.advanceTimersByTimeAsync(250);
    await rejection;

    port.onMessage.emit({
      jsonrpc: "2.0",
      id: "native-host:1",
      result: { late: true },
    });
    await Promise.resolve();
  });

  it("enters reconnecting state when native connection fails and creates reconnect alarm", async () => {
    connectNative.mockImplementation(() => {
      throw new Error("Specified native messaging host not found.");
    });
    const statuses: NativeHostStatus[] = [];

    const transport = new NativeTransport(
      "com.openai.codexextension",
      (status) => {
        statuses.push(status);
      },
    );
    await Promise.resolve();

    expect(transport.getStatus()).toMatchObject({
      state: "reconnecting",
      hostName: "com.openai.codexextension",
      reconnectAttempt: 1,
      nextRetryMs: 5000,
    });
    expect(transport.getStatus().error).toBe(
      "Specified native messaging host not found.",
    );
    expect(createdAlarms).toEqual([
      {
        name: "native-transport-reconnect:com.openai.codexextension",
        info: { periodInMinutes: 0.5 },
      },
    ]);
    expect(statuses.map((status) => status.state)).toContain("reconnecting");
  });

  it("rejects pending host requests and schedules reconnect on disconnect", async () => {
    const port = new PortMock();
    connectNative.mockReturnValue(port);
    const transport = new NativeTransport("com.openai.codexextension");

    const request = transport.requestHost("ping");
    const rejection = expect(request).rejects.toThrow(
      "Native transport disconnected",
    );
    Object.defineProperty(chrome.runtime, "lastError", {
      configurable: true,
      value: { message: "Native host exited." },
    });
    port.onDisconnect.emit(undefined);
    await Promise.resolve();

    await rejection;
    expect(transport.getStatus()).toMatchObject({
      state: "reconnecting",
      reconnectAttempt: 1,
      nextRetryMs: 5000,
    });
    expect(transport.getStatus().error).toBe("Native host exited.");
  });
});
