import {
  errorMessage,
  HOST_REQUEST_TIMEOUT_MS,
  type JsonRpcMessage,
  type JsonRpcResponse,
  type NativeHostStatus,
  RECONNECT_ALARM_PERIOD_MINUTES,
  RECONNECT_ALARM_PREFIX,
  RECONNECT_DELAY_MS,
} from "../shared/protocol";

type PendingHostRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: number | null;
};

export type NativeMessageCallback = (message: JsonRpcMessage) => void;
export type NativeStatusCallback = (status: NativeHostStatus) => void;

export class NativeTransport {
  private port: chrome.runtime.Port | null = null;
  private messageCallback: NativeMessageCallback | null = null;
  private nextHostRequestId = 0;
  private readonly pendingHostRequests = new Map<string, PendingHostRequest>();
  private reconnectTimeoutId: number | null = null;
  private reconnectPending = false;
  private reconnectAttempt = 0;
  private status: NativeHostStatus;
  private readonly reconnectAlarmName: string;

  constructor(
    private readonly application: string,
    private readonly onStatusChange?: NativeStatusCallback,
  ) {
    this.reconnectAlarmName = `${RECONNECT_ALARM_PREFIX}:${application}`;
    this.status = {
      state: "disconnected",
      hostName: application,
      lastChecked: Date.now(),
      reconnectAttempt: this.reconnectAttempt,
    };

    chrome.alarms.onAlarm.addListener(this.handleReconnectAlarm);
    if (!this.connect()) {
      this.scheduleReconnect();
    }
  }

  sendMessage(message: JsonRpcMessage): void {
    if (!this.port) {
      this.scheduleReconnect();
      throw new Error("Native transport is disconnected; reconnect is pending");
    }
    this.port.postMessage(message);
  }

  requestHost(
    method: string,
    params?: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<unknown> {
    const port = this.port;
    if (!port) {
      this.scheduleReconnect();
      return Promise.reject(
        new Error("Native transport is disconnected; reconnect is pending"),
      );
    }

    const id = this.createHostRequestId();
    const message = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    } satisfies JsonRpcMessage;

    return new Promise((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? HOST_REQUEST_TIMEOUT_MS;
      const timeoutId =
        timeoutMs > 0
          ? self.setTimeout(() => {
              this.pendingHostRequests.delete(id);
              reject(
                new Error(
                  `Native host request "${method}" timed out after ${timeoutMs}ms`,
                ),
              );
            }, timeoutMs)
          : null;

      this.pendingHostRequests.set(id, { resolve, reject, timeoutId });
      try {
        port.postMessage(message);
      } catch (error) {
        this.clearPendingHostRequest(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  setMessageCallback(callback: NativeMessageCallback): void {
    this.messageCallback = callback;
  }

  getStatus(): NativeHostStatus {
    return { ...this.status };
  }

  refreshStatus(): NativeHostStatus {
    this.updateStatus(this.port ? "connected" : this.status.state, {
      error: this.status.error,
      nextRetryMs: this.status.nextRetryMs,
    });
    return this.getStatus();
  }

  connect(
    options: { failureState?: "disconnected" | "reconnecting" } = {},
  ): boolean {
    if (this.port) {
      return true;
    }

    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connectNative(this.application);
    } catch (error) {
      const failureState = options.failureState ?? "disconnected";
      this.updateStatus(failureState, {
        error: errorMessage(error),
        ...(failureState === "reconnecting"
          ? { nextRetryMs: RECONNECT_DELAY_MS }
          : {}),
      });
      return false;
    }

    this.port = port;
    this.reconnectPending = false;
    this.reconnectAttempt = 0;
    this.clearReconnectTimeout();
    this.clearReconnectAlarm();
    this.updateStatus("connected");

    port.onMessage.addListener((message: JsonRpcMessage) => {
      if (this.port !== port) {
        return;
      }
      this.reconnectAttempt = 0;
      this.updateStatus("connected");
      if (!this.handleHostResponse(message)) {
        this.messageCallback?.(message);
      }
    });

    port.onDisconnect.addListener(() => {
      if (this.port !== port) {
        return;
      }
      this.port = null;
      this.rejectPendingHostRequests(
        new Error("Native transport disconnected"),
      );
      this.updateStatus("disconnected", {
        error: chrome.runtime.lastError?.message,
      });
      this.scheduleReconnect();
    });

    return true;
  }

  private readonly handleReconnectAlarm = (
    alarm: chrome.alarms.Alarm,
  ): void => {
    if (alarm.name !== this.reconnectAlarmName) {
      return;
    }
    if (this.port) {
      this.clearReconnectAlarm();
      return;
    }
    this.runReconnectAttempt();
  };

  private createHostRequestId(): string {
    this.nextHostRequestId += 1;
    return `native-host:${this.nextHostRequestId}`;
  }

  private handleHostResponse(message: JsonRpcMessage): boolean {
    if (!message || typeof message !== "object" || !("id" in message)) {
      return false;
    }

    const response = message as JsonRpcResponse;
    const pending = this.pendingHostRequests.get(String(response.id));
    if (!pending) {
      return false;
    }

    this.clearPendingHostRequest(String(response.id));
    if (response.error) {
      pending.reject(new Error(response.error.message));
    } else if ("result" in response) {
      pending.resolve(response.result);
    } else {
      pending.reject(new Error("Native host returned an invalid response"));
    }
    return true;
  }

  private clearPendingHostRequest(id: string): void {
    const pending = this.pendingHostRequests.get(id);
    if (!pending) {
      return;
    }
    if (pending.timeoutId !== null) {
      clearTimeout(pending.timeoutId);
    }
    this.pendingHostRequests.delete(id);
  }

  private rejectPendingHostRequests(error: Error): void {
    for (const pending of this.pendingHostRequests.values()) {
      if (pending.timeoutId !== null) {
        clearTimeout(pending.timeoutId);
      }
      pending.reject(error);
    }
    this.pendingHostRequests.clear();
  }

  private scheduleReconnect(): void {
    if (this.port) {
      return;
    }

    if (!this.reconnectPending) {
      this.reconnectPending = true;
      this.reconnectAttempt += 1;
    }

    this.scheduleReconnectRetry();
    this.updateStatus("reconnecting", {
      error: this.status.error,
      nextRetryMs: RECONNECT_DELAY_MS,
    });
  }

  private scheduleReconnectRetry(): void {
    this.scheduleReconnectTimeout();
    this.scheduleReconnectAlarm();
  }

  private scheduleReconnectTimeout(): void {
    if (this.port || this.reconnectTimeoutId !== null) {
      return;
    }

    this.reconnectTimeoutId = self.setTimeout(() => {
      this.reconnectTimeoutId = null;
      this.runReconnectAttempt();
    }, RECONNECT_DELAY_MS);
  }

  private clearReconnectTimeout(): void {
    if (this.reconnectTimeoutId === null) {
      return;
    }
    clearTimeout(this.reconnectTimeoutId);
    this.reconnectTimeoutId = null;
  }

  private runReconnectAttempt(): void {
    if (this.port) {
      return;
    }

    this.clearReconnectTimeout();
    this.reconnectPending = true;
    this.reconnectAttempt += 1;
    if (!this.connect({ failureState: "reconnecting" })) {
      this.scheduleReconnectRetry();
    }
  }

  private async ensureReconnectAlarm(): Promise<void> {
    if (this.port) {
      return;
    }
    const alarm = await chrome.alarms.get(this.reconnectAlarmName);
    if (!this.port && !alarm) {
      await chrome.alarms.create(this.reconnectAlarmName, {
        periodInMinutes: RECONNECT_ALARM_PERIOD_MINUTES,
      });
    }
  }

  private clearReconnectAlarm(): void {
    chrome.alarms.clear(this.reconnectAlarmName).catch(() => {});
  }

  private scheduleReconnectAlarm(): void {
    this.ensureReconnectAlarm().catch((error) => {
      if (this.port) {
        return;
      }
      this.reconnectPending = false;
      this.updateStatus("disconnected", { error: errorMessage(error) });
    });
  }

  private updateStatus(
    state: NativeHostStatus["state"],
    fields: Pick<NativeHostStatus, "error" | "nextRetryMs"> = {},
  ): void {
    this.status = {
      state,
      hostName: this.application,
      lastChecked: Date.now(),
      reconnectAttempt: this.reconnectAttempt,
      ...(fields.error ? { error: fields.error } : {}),
      ...(fields.nextRetryMs ? { nextRetryMs: fields.nextRetryMs } : {}),
    };
    this.onStatusChange?.(this.getStatus());
  }
}
