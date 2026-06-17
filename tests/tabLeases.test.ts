import { beforeEach, describe, expect, it, vi } from "vitest";
import { TabLeases } from "../src/background/tabLeases";

class MemoryStorageArea {
  readonly values = new Map<string, unknown>();

  async get(
    keys?: string | string[] | Record<string, unknown> | null,
  ): Promise<Record<string, unknown>> {
    if (typeof keys === "string") {
      return { [keys]: this.values.get(keys) };
    }
    if (Array.isArray(keys)) {
      return Object.fromEntries(keys.map((key) => [key, this.values.get(key)]));
    }
    if (keys && typeof keys === "object") {
      return Object.fromEntries(
        Object.entries(keys).map(([key, fallback]) => [
          key,
          this.values.has(key) ? this.values.get(key) : fallback,
        ]),
      );
    }
    return Object.fromEntries(this.values.entries());
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) {
      this.values.set(key, value);
    }
  }
}

function eventMock() {
  return {
    addListener: vi.fn(),
    removeListener: vi.fn(),
  };
}

describe("TabLeases", () => {
  let sessionStorage: MemoryStorageArea;
  let localStorage: MemoryStorageArea;

  beforeEach(() => {
    sessionStorage = new MemoryStorageArea();
    localStorage = new MemoryStorageArea();
    localStorage.values.set("extensionInstanceId", "instance-1");

    globalThis.chrome = {
      tabs: {
        get: vi.fn(async (tabId: number) => ({
          id: tabId,
          title: `Tab ${tabId}`,
          url: "https://example.test/",
        })),
        onRemoved: eventMock(),
        onReplaced: eventMock(),
      },
    } as unknown as typeof chrome;
  });

  it("claims tabs, persists active leases, and prevents cross-session ownership", async () => {
    const leases = new TabLeases(
      sessionStorage as unknown as chrome.storage.StorageArea,
      localStorage as unknown as chrome.storage.StorageArea,
    );

    await leases.claimTab("session-a", "turn-1", 42, "agent");

    expect(await leases.isClaimedBySession("session-a", 42)).toBe(true);
    expect(await leases.getOwningSessionId(42)).toBe("session-a");
    expect(sessionStorage.values.get("TAB_LEASES")).toEqual({
      leases: {
        "42": expect.objectContaining({
          tabId: 42,
          sessionId: "session-a",
          turnId: "turn-1",
          origin: "agent",
          instanceId: "instance-1",
          state: "active",
        }),
      },
    });

    await expect(
      leases.claimTab("session-b", "turn-1", 42, "user"),
    ).rejects.toThrow("Tab 42 is already part of browser session session-a");
  });

  it("hands off, resumes, and releases tabs with active lease notifications", async () => {
    const leases = new TabLeases(
      sessionStorage as unknown as chrome.storage.StorageArea,
      localStorage as unknown as chrome.storage.StorageArea,
    );
    const changed: number[][] = [];
    leases.subscribeActiveTabLeaseChanges((tabIds) => {
      changed.push(tabIds);
    });

    await leases.claimTab("session-a", "turn-1", 42, "agent");
    await leases.handoffTabs("session-a", "turn-2", [42], {
      activeTabId: 42,
      groupId: 7,
    });
    expect(await leases.getOwningSessionId(42)).toBeNull();
    expect([
      ...(await leases.getSessionHandoffLeases("session-a")).values(),
    ]).toEqual([
      expect.objectContaining({
        tabId: 42,
        state: "handoff",
        groupId: 7,
        isActiveHandoff: true,
      }),
    ]);

    expect(await leases.resumeHandoffTabs("session-a", "turn-3", [42])).toEqual(
      [42],
    );
    expect(await leases.getOwningSessionId(42)).toBe("session-a");

    await leases.releaseActiveTurn("session-a", "turn-3");
    expect(await leases.isClaimedBySession("session-a", 42)).toBe(false);
    expect(changed.flat()).toContain(42);
  });

  it("loads valid leases from storage and drops stale tabs from getSessionTabs", async () => {
    sessionStorage.values.set("TAB_LEASES", {
      leases: {
        "1": {
          tabId: 1,
          sessionId: "session-a",
          turnId: "turn-1",
          origin: "user",
          claimedAt: Date.now(),
          instanceId: "instance-1",
          state: "active",
        },
        "2": {
          tabId: 2,
          sessionId: "session-a",
          turnId: "turn-1",
          origin: "user",
          claimedAt: Date.now(),
          instanceId: "instance-1",
          state: "active",
        },
        bad: { tabId: 3 },
      },
    });
    vi.mocked(chrome.tabs.get).mockImplementation(async (tabId: number) => {
      if (tabId === 2) {
        throw new Error("No tab");
      }
      return { id: tabId, title: `Tab ${tabId}` };
    });

    const leases = new TabLeases(
      sessionStorage as unknown as chrome.storage.StorageArea,
      localStorage as unknown as chrome.storage.StorageArea,
    );

    expect(await leases.getSessionTabs("session-a")).toEqual([
      expect.objectContaining({ id: 1, title: "Tab 1" }),
    ]);
    expect(await leases.isClaimedBySession("session-a", 2)).toBe(false);
  });
});
