import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("user tab helpers", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates background tabs through the normal Chrome callback path", async () => {
    const query = vi.fn(
      (
        _queryInfo: chrome.tabs.QueryInfo,
        callback: (tabs: chrome.tabs.Tab[]) => void,
      ) => {
        callback([tab({ id: 1, url: "https://example.test/", windowId: 7 })]);
      },
    );
    const create = vi.fn(
      (
        _createProperties: chrome.tabs.CreateProperties,
        callback: (tab: chrome.tabs.Tab) => void,
      ) => {
        callback(
          tab({
            active: false,
            id: 2,
            title: "about:blank",
            url: "about:blank",
            windowId: 7,
          }),
        );
      },
    );
    installChromeTabMocks({ create, query });

    const { createBackgroundTab } = await import("../src/background/userTabs");

    await expect(createBackgroundTab()).resolves.toEqual({
      active: false,
      id: 2,
      title: "about:blank",
      url: "about:blank",
    });
    expect(create).toHaveBeenCalledWith(
      {
        active: false,
        url: "about:blank",
        windowId: 7,
      },
      expect.any(Function),
    );
  });

  it("recovers Arc-created background tabs when chrome.tabs.create does not resolve", async () => {
    const queryResults = [
      [tab({ id: 1, url: "https://example.test/", windowId: 7 })],
      [
        tab({ id: 1, url: "https://example.test/", windowId: 7 }),
        tab({
          active: false,
          id: 42,
          title: "about:blank",
          url: "about:blank",
          windowId: 7,
        }),
      ],
    ];
    const query = vi.fn(
      (
        _queryInfo: chrome.tabs.QueryInfo,
        callback: (tabs: chrome.tabs.Tab[]) => void,
      ) => {
        callback(queryResults.shift() ?? []);
      },
    );
    const create = vi.fn();
    installChromeTabMocks({ create, query });

    const { createBackgroundTab } = await import("../src/background/userTabs");
    const tabPromise = createBackgroundTab();

    await vi.waitFor(() => expect(create).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(1500);

    await expect(tabPromise).resolves.toEqual({
      active: false,
      id: 42,
      title: "about:blank",
      url: "about:blank",
    });
  });
});

function installChromeTabMocks({
  create,
  query,
}: {
  create: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
}): void {
  globalThis.chrome = {
    tabs: {
      create,
      query,
    },
    windows: {
      getAll: vi.fn(async () => [{ focused: true, id: 7 }]),
    },
  } as unknown as typeof chrome;
}

function tab(overrides: Partial<chrome.tabs.Tab>): chrome.tabs.Tab {
  return {
    active: false,
    autoDiscardable: true,
    discarded: false,
    frozen: false,
    groupId: -1,
    highlighted: false,
    id: 1,
    incognito: false,
    index: 0,
    pinned: false,
    selected: false,
    windowId: 7,
    ...overrides,
  } as chrome.tabs.Tab;
}
