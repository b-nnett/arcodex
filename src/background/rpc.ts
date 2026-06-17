import {
  errorMessage,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "../shared/protocol";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

type RequestHandler = (params: unknown) => unknown | Promise<unknown>;
type EventHandler = (params: unknown) => void | Promise<void>;

export interface RpcTransport {
  sendMessage(message: JsonRpcMessage): void;
  setMessageCallback(callback: (message: JsonRpcMessage) => void): void;
}

export class JsonRpcPeer {
  private nextId = 1;
  private readonly pendingRequests = new Map<string | number, PendingRequest>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly eventHandlers = new Map<string, EventHandler[]>();

  constructor(private readonly transport: RpcTransport) {
    this.transport.setMessageCallback((message) => {
      void this.handleIncomingMessage(message);
    });
  }

  registerRequestHandler(name: string, handler: RequestHandler): void {
    this.requestHandlers.set(name, handler);
  }

  registerRequestHandlerObject(handlerObject: object): void {
    const names = new Set([
      ...Object.getOwnPropertyNames(handlerObject),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(handlerObject)),
    ]);

    for (const name of names) {
      if (name === "constructor") {
        continue;
      }
      const value = (handlerObject as Record<string, unknown>)[name];
      if (typeof value === "function") {
        this.registerRequestHandler(name, value.bind(handlerObject));
      }
    }
  }

  addEventListener(name: string, handler: EventHandler): void {
    const handlers = this.eventHandlers.get(name) ?? [];
    handlers.push(handler);
    this.eventHandlers.set(name, handlers);
  }

  removeEventListener(name: string, handler: EventHandler): void {
    const handlers = this.eventHandlers.get(name) ?? [];
    this.eventHandlers.set(
      name,
      handlers.filter((candidate) => candidate !== handler),
    );
  }

  sendNotification(method: string, params?: unknown): void {
    this.transport.sendMessage({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    } satisfies JsonRpcNotification);
  }

  sendRequest(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      try {
        this.transport.sendMessage({
          jsonrpc: "2.0",
          method,
          params,
          id,
        } satisfies JsonRpcRequest);
      } catch (error) {
        this.pendingRequests.delete(id);
        reject(error);
      }
    });
  }

  async handleIncomingMessage(message: JsonRpcMessage): Promise<void> {
    if (!message || typeof message !== "object") {
      return;
    }

    if ("method" in message) {
      await this.handleIncomingRequest(message as JsonRpcRequest);
      return;
    }

    if (!("id" in message)) {
      return;
    }

    const response = message as JsonRpcResponse;
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      return;
    }
    this.pendingRequests.delete(response.id);

    if (response.error) {
      pending.reject(response.error.message || "Something went wrong");
    } else {
      pending.resolve(response.result);
    }
  }

  rejectPendingRequests(error: unknown): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private async handleIncomingRequest(message: JsonRpcRequest): Promise<void> {
    if (message.id === undefined) {
      for (const handler of this.eventHandlers.get(message.method ?? "") ??
        []) {
        Promise.resolve(handler(message.params)).catch(() => {});
      }
      return;
    }

    const handler = this.requestHandlers.get(message.method ?? "");
    if (!handler) {
      this.transport.sendMessage({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -1,
          message: `No handler registered for method: ${message.method}`,
        },
      });
      return;
    }

    try {
      const result = await handler(message.params);
      this.transport.sendMessage({
        jsonrpc: "2.0",
        id: message.id,
        result,
      });
    } catch (error) {
      this.transport.sendMessage({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: 1,
          message: errorMessage(error),
        },
      });
    }
  }
}

export class BrowserRpcPeer extends JsonRpcPeer {
  constructor(
    transport: RpcTransport,
    handler: { moveMouse(params: unknown): unknown | Promise<unknown> },
  ) {
    super(transport);
    this.registerRequestHandlerObject(handler);
    this.addEventListener("moveMouse", (params) => {
      Promise.resolve(handler.moveMouse(params)).catch(() => {});
    });
  }

  ping(): Promise<unknown> {
    return this.sendRequest("ping");
  }

  sendCdpEvent(event: unknown): void {
    this.sendNotification("onCDPEvent", event);
  }

  sendDownloadChange(event: unknown): void {
    this.sendNotification("onDownloadChange", event);
  }
}
