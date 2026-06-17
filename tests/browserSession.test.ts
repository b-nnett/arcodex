import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TabLease } from "../src/background/tabLeases";

const detachAttachedDebuggersForTabs = vi.fn(async () => {});
const removeTabs = vi.fn(async () => {});
const getExistingTab = vi.fn(async (tabId: number) => ({
  active: tabId === 1,
  id: tabId,
  title: `Tab ${tabId}`,
  url: "https://example.test/",
}));

vi.mock("../src/background/cdp", () => ({
  attachTabDebugger: vi.fn(async () => {}),
  attachTargetDebugger: vi.fn(async () => {}),
  detachAttachedDebuggersForTabs,
  detachTabDebugger: vi.fn(async () => {}),
  detachTargetDebugger: vi.fn(async () => {}),
  executeCdpCommand: vi.fn(async () => ({})),
}));

vi.mock("../src/background/contentScripts", () => ({
  ensureContentScript: vi.fn(async () => true),
}));

vi.mock("../src/background/userTabs", () => ({
  assertTabId: (method: string, tabId: unknown) => {
    if (!Number.isInteger(tabId)) {
      throw new Error(`${method} requires an integer tabId`);
    }
  },
  createBackgroundTab: vi.fn(async () => ({
    active: false,
    id: 1,
    title: "Created",
    url: "about:blank",
  })),
  getExistingTab,
  removeTabs,
  toSessionTabInfo: (tab: chrome.tabs.Tab) => ({
    id: tab.id,
    ...(tab.title == null ? {} : { title: tab.title }),
    ...(tab.url == null ? {} : { url: tab.url }),
    ...(tab.active == null ? {} : { active: tab.active }),
  }),
}));

class FakeTabLeases {
  readonly active = new Map<number, TabLease>();
  readonly handoff = new Map<number, TabLease>();
  readonly handoffCalls: unknown[] = [];
  readonly releaseCalls: number[][] = [];
  readonly resumeCalls: number[][] = [];

  async getSessionTabs(): Promise<chrome.tabs.Tab[]> {
    return [...this.active.values()].map(
      (lease) =>
        ({
          active: lease.tabId === 1,
          id: lease.tabId,
          title: `Tab ${lease.tabId}`,
          url: "https://example.test/",
        }) as chrome.tabs.Tab,
    );
  }

  async getSessionActiveLeases(): Promise<Map<number, TabLease>> {
    return new Map(this.active);
  }

  async getSessionHandoffLeases(): Promise<Map<number, TabLease>> {
    return new Map(this.handoff);
  }

  async releaseTabs(_sessionId: string, tabIds: number[]): Promise<void> {
    this.releaseCalls.push(tabIds);
    for (const tabId of tabIds) {
      this.active.delete(tabId);
      this.handoff.delete(tabId);
    }
  }

  async handoffTabs(
    sessionId: string,
    turnId: string,
    tabIds: number[],
    options: { activeTabId?: number; groupId?: number },
  ): Promise<void> {
    this.handoffCalls.push({ sessionId, tabIds, turnId, options });
    for (const tabId of tabIds) {
      const lease = this.active.get(tabId);
      if (!lease) {
        continue;
      }
      this.active.delete(tabId);
      this.handoff.set(tabId, {
        ...lease,
        state: "handoff",
        turnId,
        ...(options.groupId == null ? {} : { groupId: options.groupId }),
        ...(options.activeTabId === tabId ? { isActiveHandoff: true } : {}),
      });
    }
  }

  async resumeHandoffTabs(
    sessionId: string,
    turnId: string,
    tabIds: number[],
  ): Promise<number[]> {
    this.resumeCalls.push(tabIds);
    const resumed: number[] = [];
    for (const tabId of tabIds) {
      const lease = this.handoff.get(tabId);
      if (!lease) {
        continue;
      }
      this.handoff.delete(tabId);
      this.active.set(tabId, {
        tabId,
        sessionId,
        turnId,
        origin: lease.origin,
        claimedAt: lease.claimedAt,
        instanceId: lease.instanceId,
        state: "active",
      });
      resumed.push(tabId);
    }
    return resumed;
  }

  async updateActiveSessionTurn(
    sessionId: string,
    turnId: string,
  ): Promise<void> {
    for (const [tabId, lease] of this.active) {
      if (lease.sessionId === sessionId) {
        this.active.set(tabId, { ...lease, turnId });
      }
    }
  }

  async isClaimedBySession(sessionId: string, tabId: number): Promise<boolean> {
    return this.active.get(tabId)?.sessionId === sessionId;
  }

  async claimTab(
    sessionId: string,
    turnId: string,
    tabId: number,
    origin: "agent" | "user",
  ): Promise<void> {
    this.active.set(tabId, {
      claimedAt: 1000 + tabId,
      instanceId: "instance",
      origin,
      sessionId,
      state: "active",
      tabId,
      turnId,
    });
  }
}

function lease(
  tabId: number,
  origin: "agent" | "user" = "agent",
  state: "active" | "handoff" = "active",
): TabLease {
  return {
    claimedAt: 1000 + tabId,
    instanceId: "instance",
    origin,
    sessionId: "session",
    state,
    tabId,
    turnId: "turn-1",
  };
}

describe("BrowserSession lifecycle", () => {
  let leases: FakeTabLeases;
  let tabGroups: {
    ensureAgentTabGroup: ReturnType<typeof vi.fn>;
    getManagedGroupIdContainingTabs: ReturnType<typeof vi.fn>;
    reconcileManagedGroupForTabs: ReturnType<typeof vi.fn>;
    refreshManagedGroupsFromChrome: ReturnType<typeof vi.fn>;
    releaseTabsFromManagedGroups: ReturnType<typeof vi.fn>;
    setSessionGroupTitle: ReturnType<typeof vi.fn>;
  };
  let tabFavicons: {
    markFinalized: ReturnType<typeof vi.fn>;
    publishActiveBadge: ReturnType<typeof vi.fn>;
  };
  let tabTitleMarkers: {
    clearTabs: ReturnType<typeof vi.fn>;
    mark: ReturnType<typeof vi.fn>;
    markTabs: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.resetModules();
    detachAttachedDebuggersForTabs.mockClear();
    getExistingTab.mockClear();
    removeTabs.mockClear();
    leases = new FakeTabLeases();
    tabGroups = {
      ensureAgentTabGroup: vi.fn(async () => {}),
      getManagedGroupIdContainingTabs: vi.fn(async () => 99),
      reconcileManagedGroupForTabs: vi.fn(async () => {}),
      refreshManagedGroupsFromChrome: vi.fn(async () => {}),
      releaseTabsFromManagedGroups: vi.fn(async () => {}),
      setSessionGroupTitle: vi.fn(async () => {}),
    };
    tabFavicons = {
      markFinalized: vi.fn(async () => {}),
      publishActiveBadge: vi.fn(async () => {}),
    };
    tabTitleMarkers = {
      clearTabs: vi.fn(async () => {}),
      mark: vi.fn(async () => {}),
      markTabs: vi.fn(async () => {}),
    };
  });

  it("finalizes tabs by handing off kept tabs, marking deliverables, and closing unkept agent tabs", async () => {
    const { BrowserSession } = await import("../src/background/browserSession");
    leases.active.set(1, lease(1, "agent"));
    leases.active.set(2, lease(2, "agent"));
    leases.active.set(3, lease(3, "user"));
    const session = new BrowserSession(
      "session",
      leases as never,
      tabGroups as never,
      tabFavicons as never,
      tabTitleMarkers as never,
    );

    await session.finalizeTabs({
      browser_id: "chrome",
      keep: [
        { tabId: 1, status: "handoff" },
        { tabId: 3, status: "deliverable" },
      ],
      session_id: "session",
      turn_id: "turn-2",
    });

    expect(tabFavicons.markFinalized).toHaveBeenCalledWith(1, "handoff");
    expect(tabFavicons.markFinalized).toHaveBeenCalledWith(3, "deliverable");
    expect(detachAttachedDebuggersForTabs).toHaveBeenCalledWith([1, 3, 2]);
    expect(tabGroups.releaseTabsFromManagedGroups).toHaveBeenCalledWith([3]);
    expect(tabTitleMarkers.clearTabs).toHaveBeenCalledWith([3, 2]);
    expect(removeTabs).toHaveBeenCalledWith([2]);
    expect(tabGroups.refreshManagedGroupsFromChrome).toHaveBeenCalled();
    expect(leases.releaseCalls).toEqual([[3, 2]]);
    expect(leases.handoff.get(1)).toEqual(
      expect.objectContaining({
        groupId: 99,
        state: "handoff",
        tabId: 1,
        turnId: "turn-2",
      }),
    );
  });

  it("resumes existing handoff tabs at the start of a later turn", async () => {
    const { BrowserSession } = await import("../src/background/browserSession");
    leases.handoff.set(1, {
      ...lease(1, "agent", "handoff"),
      groupId: 99,
      isActiveHandoff: true,
    });
    const session = new BrowserSession(
      "session",
      leases as never,
      tabGroups as never,
      tabFavicons as never,
      tabTitleMarkers as never,
    );

    await session.activateTurn("turn-3");
    const tabs = await session.getTabs();

    expect(leases.resumeCalls).toEqual([[1]]);
    expect(tabGroups.reconcileManagedGroupForTabs).toHaveBeenCalledWith(
      "session",
      99,
      [1],
    );
    expect(tabTitleMarkers.markTabs).toHaveBeenCalledWith([1]);
    expect(tabs).toEqual([
      expect.objectContaining({ active: true, id: 1, title: "Tab 1" }),
    ]);
  });

  it("marks created tabs with the Codex title marker", async () => {
    const { BrowserSession } = await import("../src/background/browserSession");
    const session = new BrowserSession(
      "session",
      leases as never,
      tabGroups as never,
      tabFavicons as never,
      tabTitleMarkers as never,
    );

    await session.createTab("turn-1");

    expect(tabTitleMarkers.mark).toHaveBeenCalledWith(1);
  });
});
