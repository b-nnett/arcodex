// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

type MessageHandler = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
) => boolean;

describe("content script entrypoint", () => {
  let handlers: MessageHandler[];
  let sendMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    document.documentElement.innerHTML = "<head></head><body></body>";
    handlers = [];
    sendMessage = vi.fn(async () => ({
      ok: true,
      state: {
        cursor: null,
        isVisible: false,
        sessionId: null,
        turnId: null,
      },
    }));

    globalThis.chrome = {
      runtime: {
        getURL: vi.fn((path: string) => `chrome-extension://id/${path}`),
        sendMessage,
        onMessage: {
          addListener: vi.fn((handler: MessageHandler) => {
            handlers.push(handler);
          }),
          removeListener: vi.fn(),
        },
      },
    } as unknown as typeof chrome;
  });

  it("creates the overlay root and requests initial cursor state", async () => {
    await import("../src/content/codex");
    await Promise.resolve();

    const root = document.getElementById("codex-agent-overlay-root");
    expect(root).toBeInstanceOf(HTMLDivElement);
    expect(root?.dataset.codexAgentOverlayRoot).toBe("true");
    expect(sendMessage).toHaveBeenCalledWith({
      type: "GET_AGENT_CURSOR_STATE",
    });
    expect(handlers).toHaveLength(1);
  });

  it("responds to content ping messages", async () => {
    await import("../src/content/codex");
    const sendResponse = vi.fn();

    const keepChannelOpen = handlers[0]?.(
      { type: "CONTENT_PING" },
      {},
      sendResponse,
    );

    expect(keepChannelOpen).toBe(true);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });

  it("applies favicon badge messages through the runtime handler", async () => {
    await import("../src/content/codex");
    const sendResponse = vi.fn();
    const faviconDataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP8z8BQDwAFgwJ/lcHfKAAAAABJRU5ErkJggg==";

    handlers[0]?.(
      {
        type: "TAB_FAVICON_BADGE",
        badge: "deliverable",
        faviconDataUrl,
      },
      {},
      sendResponse,
    );

    const link =
      document.head.querySelector<HTMLLinkElement>("link[rel='icon']");
    expect(link?.dataset.codexFaviconBadge).toBe("true");
    expect(decodeURIComponent(link?.getAttribute("href") ?? "")).toContain(
      'fill="#22c55e"',
    );
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });

  it("marks and unmarks page titles while preserving page title updates", async () => {
    document.title = "Example";
    await import("../src/content/codex");
    const sendResponse = vi.fn();

    handlers[0]?.(
      {
        type: "TAB_TITLE_MARKER",
        marker: "[Codex]",
      },
      {},
      sendResponse,
    );

    expect(document.title).toBe("[Codex] Example");
    document.title = "Updated";
    await Promise.resolve();
    expect(document.title).toBe("[Codex] Updated");

    handlers[0]?.(
      {
        type: "TAB_TITLE_MARKER",
        marker: null,
      },
      {},
      sendResponse,
    );

    expect(document.title).toBe("Updated");
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });

  it("sends AGENT_CURSOR_ARRIVED after visible cursor movement", async () => {
    await import("../src/content/codex");
    const sendResponse = vi.fn();

    handlers[0]?.(
      {
        type: "AGENT_CURSOR_STATE",
        state: {
          cursor: {
            visible: true,
            x: 10,
            y: 20,
            animateMovement: false,
            moveSequence: 4,
          },
          isVisible: true,
          sessionId: "session",
          turnId: "turn",
        },
      },
      {},
      sendResponse,
    );

    await vi.runOnlyPendingTimersAsync();

    expect(sendMessage).toHaveBeenCalledWith({
      type: "AGENT_CURSOR_ARRIVED",
      moveSequence: 4,
      sessionId: "session",
      turnId: "turn",
    });
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });
});
