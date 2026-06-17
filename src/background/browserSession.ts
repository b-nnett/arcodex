import type {
  AttachPayload,
  AttachTargetPayload,
  CdpCommandPayload,
  ClaimUserTabPayload,
  FinalizeTabEntry,
  FinalizeTabsPayload,
  NameSessionPayload,
  TabInfo,
} from "../shared/protocol";
import {
  attachTabDebugger,
  attachTargetDebugger,
  detachAttachedDebuggersForTabs,
  detachTabDebugger,
  detachTargetDebugger,
  executeCdpCommand,
} from "./cdp";
import { ensureContentScript } from "./contentScripts";
import type { TabFavicons } from "./tabFavicons";
import type { TabGroups } from "./tabGroups";
import type { TabLeases } from "./tabLeases";
import type { TabTitleMarkers } from "./tabTitles";
import {
  assertTabId,
  createBackgroundTab,
  getExistingTab,
  removeTabs,
  toSessionTabInfo,
} from "./userTabs";

export class BrowserSession {
  private activeTabId: number | null = null;
  private lifecycleQueue = Promise.resolve();
  private currentTurnId: string | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly tabLeases: TabLeases,
    private readonly tabGroups: TabGroups,
    private readonly tabFavicons: TabFavicons,
    private readonly tabTitleMarkers: TabTitleMarkers,
  ) {}

  async activateTurn(turnId: string): Promise<void> {
    if (this.currentTurnId !== turnId) {
      await this.runTurnMutation(turnId, async () => {});
    }
  }

  async executeCdp(payload: CdpCommandPayload): Promise<unknown> {
    const tabId = payload.target.tabId;
    if (typeof tabId === "number") {
      await this.requireSessionTab(tabId);
    }
    return executeCdpCommand(payload);
  }

  async attach(turnId: string, payload: AttachPayload): Promise<void> {
    await this.runTurnMutation(turnId, async () => {
      await this.requireSessionTab(payload.tabId);
      await attachTabDebugger(payload.tabId);
    });
  }

  async attachTarget(
    turnId: string,
    payload: AttachTargetPayload,
  ): Promise<void> {
    await this.runTurnMutation(turnId, async () => {
      await this.requireSessionTab(payload.tabId);
      await attachTargetDebugger(payload.tabId, payload.targetId);
    });
  }

  async detach(turnId: string, payload: AttachPayload): Promise<void> {
    await this.runTurnMutation(turnId, async () => {
      await this.requireSessionTab(payload.tabId);
      await detachTabDebugger(payload.tabId);
    });
  }

  async detachTarget(
    turnId: string,
    payload: AttachTargetPayload,
  ): Promise<void> {
    await this.runTurnMutation(turnId, async () => {
      await this.requireSessionTab(payload.tabId);
      await detachTargetDebugger(payload.targetId);
    });
  }

  async getTabs(): Promise<TabInfo[]> {
    return this.listSessionTabs();
  }

  async createTab(turnId: string): Promise<TabInfo> {
    return this.runTurnMutation(turnId, async () => {
      const activeAgentTabIds = await this.activeAgentTabIds();
      const tab = await createBackgroundTab();
      this.activeTabId = tab.id;
      await this.tabGroups.ensureAgentTabGroup(
        this.sessionId,
        tab.id,
        activeAgentTabIds,
      );
      await this.tabLeases.claimTab(this.sessionId, turnId, tab.id, "agent");
      await this.requireSessionTab(tab.id, { trackOverlay: true });
      await this.tabTitleMarkers.mark(tab.id);
      return { ...tab, active: true };
    });
  }

  async claimUserTab(
    turnId: string,
    payload: ClaimUserTabPayload,
  ): Promise<TabInfo> {
    return this.runTurnMutation(turnId, async () => {
      const tab = await getExistingTab(payload.tabId);
      if (tab.url?.startsWith("chrome://")) {
        throw new Error(
          `Chrome internal tab ${payload.tabId} cannot be claimed`,
        );
      }
      const owningSessionId = await this.tabLeases.getOwningSessionId(
        payload.tabId,
      );
      if (owningSessionId != null && owningSessionId !== this.sessionId) {
        throw new Error(
          `Tab ${payload.tabId} is already part of browser session ${owningSessionId}`,
        );
      }

      this.activeTabId = payload.tabId;
      if (owningSessionId == null) {
        await this.tabLeases.claimTab(
          this.sessionId,
          turnId,
          payload.tabId,
          "user",
        );
      }
      await this.requireSessionTab(payload.tabId, { trackOverlay: true });
      await this.tabTitleMarkers.mark(payload.tabId);
      return { ...toSessionTabInfo(tab), active: true };
    });
  }

  async finalizeTabs(payload: FinalizeTabsPayload): Promise<void> {
    await this.runTurnMutation(payload.turn_id, async () => {
      const tabs = await this.listSessionTabs();
      const keep = validateFinalizeTabs(
        payload.keep,
        new Set(tabs.map((tab) => tab.id)),
      );
      const activeLeases = await this.tabLeases.getSessionActiveLeases(
        this.sessionId,
      );

      const handoffTabIds: number[] = [];
      const deliverableTabIds: number[] = [];
      const agentTabIdsToClose: number[] = [];
      const userTabIdsToRelease: number[] = [];

      for (const tab of tabs) {
        const status = keep.get(tab.id);
        if (status === "handoff") {
          handoffTabIds.push(tab.id);
        } else if (status === "deliverable") {
          deliverableTabIds.push(tab.id);
        } else if (activeLeases.get(tab.id)?.origin === "agent") {
          agentTabIdsToClose.push(tab.id);
        } else {
          userTabIdsToRelease.push(tab.id);
        }
      }

      const affectedTabIds = [
        ...handoffTabIds,
        ...deliverableTabIds,
        ...agentTabIdsToClose,
        ...userTabIdsToRelease,
      ];

      await Promise.all([
        Promise.all([
          ...deliverableTabIds.map((tabId) =>
            this.tabFavicons
              .markFinalized(tabId, "deliverable")
              .catch(() => {}),
          ),
          ...handoffTabIds.map((tabId) =>
            this.tabFavicons.markFinalized(tabId, "handoff").catch(() => {}),
          ),
        ]),
        detachAttachedDebuggersForTabs(affectedTabIds),
      ]);

      await this.tabGroups.releaseTabsFromManagedGroups(deliverableTabIds);
      await this.tabTitleMarkers.clearTabs([
        ...deliverableTabIds,
        ...agentTabIdsToClose,
        ...userTabIdsToRelease,
      ]);
      if (agentTabIdsToClose.length > 0) {
        await removeTabs(agentTabIdsToClose);
        await this.tabGroups.refreshManagedGroupsFromChrome();
      }

      await this.tabLeases.releaseTabs(this.sessionId, [
        ...deliverableTabIds,
        ...agentTabIdsToClose,
        ...userTabIdsToRelease,
      ]);

      if (handoffTabIds.length > 0) {
        const agentHandoffTabIds = handoffTabIds.filter(
          (tabId) => activeLeases.get(tabId)?.origin === "agent",
        );
        const groupId =
          await this.tabGroups.getManagedGroupIdContainingTabs(
            agentHandoffTabIds,
          );
        await this.tabLeases.handoffTabs(
          this.sessionId,
          payload.turn_id,
          handoffTabIds,
          {
            ...(this.activeTabId == null
              ? {}
              : { activeTabId: this.activeTabId }),
            ...(groupId == null ? {} : { groupId }),
          },
        );
      }

      this.activeTabId = null;
    });
  }

  async nameSession(payload: NameSessionPayload): Promise<void> {
    await this.runTurnMutation(payload.turn_id, async () => {
      await this.tabGroups.setSessionGroupTitle(
        this.sessionId,
        payload.name,
        await this.activeAgentTabIds(),
      );
    });
  }

  async endTurn(turnId: string): Promise<void> {
    await this.runLifecycle(async () => {
      if (this.currentTurnId !== turnId) {
        return;
      }
      const tabs = await this.listSessionTabs();
      await detachAttachedDebuggersForTabs(tabs.map((tab) => tab.id));
      await this.tabTitleMarkers.clearTabs(tabs.map((tab) => tab.id));
      await this.tabLeases.releaseActiveTurn(this.sessionId, turnId);
      this.activeTabId = null;
      this.currentTurnId = null;
    });
  }

  private async resumeHandoffIfPresent(turnId: string): Promise<void> {
    const handoffLeases = await this.tabLeases.getSessionHandoffLeases(
      this.sessionId,
    );
    if (handoffLeases.size === 0) {
      return;
    }

    const checks = await Promise.all(
      [...handoffLeases.keys()].map(async (tabId) => {
        try {
          await getExistingTab(tabId);
          return { tabId, state: "reclaimed" as const };
        } catch {
          return { tabId, state: "stale" as const };
        }
      }),
    );

    const reclaimedTabIds: number[] = [];
    const staleTabIds: number[] = [];
    for (const check of checks) {
      if (check.state === "reclaimed") {
        reclaimedTabIds.push(check.tabId);
      } else {
        staleTabIds.push(check.tabId);
      }
    }

    if (staleTabIds.length > 0) {
      await this.tabLeases.releaseTabs(this.sessionId, staleTabIds);
    }
    if (reclaimedTabIds.length === 0) {
      return;
    }

    const resumedTabIds = await this.tabLeases.resumeHandoffTabs(
      this.sessionId,
      turnId,
      reclaimedTabIds,
    );
    if (resumedTabIds.length === 0) {
      return;
    }

    const resumed = new Set(resumedTabIds);
    const groupId = [...handoffLeases.values()].find(
      (lease) => resumed.has(lease.tabId) && lease.groupId != null,
    )?.groupId;
    if (groupId != null) {
      await this.tabGroups.reconcileManagedGroupForTabs(
        this.sessionId,
        groupId,
        resumedTabIds,
      );
    }

    const activeHandoffTabId = [...handoffLeases.values()].find(
      (lease) => lease.isActiveHandoff === true && resumed.has(lease.tabId),
    )?.tabId;
    this.activeTabId = activeHandoffTabId ?? resumedTabIds[0] ?? null;
    await this.tabTitleMarkers.markTabs(resumedTabIds);
  }

  private async listSessionTabs(): Promise<TabInfo[]> {
    const tabs = (await this.tabLeases.getSessionTabs(this.sessionId)).filter(
      (tab) => tab.id !== undefined && !tab.url?.startsWith("chrome://"),
    );
    return this.tabInfosWithLogicalActive(tabs);
  }

  private async activeAgentTabIds(): Promise<number[]> {
    return [
      ...(await this.tabLeases.getSessionActiveLeases(this.sessionId)).values(),
    ]
      .filter((lease) => lease.origin === "agent")
      .map((lease) => lease.tabId);
  }

  private tabInfosWithLogicalActive(tabs: chrome.tabs.Tab[]): TabInfo[] {
    const tabInfos = tabs.map(toSessionTabInfo);
    const activeTabId = this.resolveLogicalActiveTabId(tabInfos);
    return activeTabId == null
      ? tabInfos
      : tabInfos.map((tab) =>
          tab.active === (tab.id === activeTabId)
            ? tab
            : { ...tab, active: tab.id === activeTabId },
        );
  }

  private resolveLogicalActiveTabId(tabs: TabInfo[]): number | null {
    if (tabs.length === 0) {
      return null;
    }
    if (
      this.activeTabId != null &&
      tabs.some((tab) => tab.id === this.activeTabId)
    ) {
      return this.activeTabId;
    }
    this.activeTabId =
      tabs.find((tab) => tab.active)?.id ?? tabs[0]?.id ?? null;
    return this.activeTabId;
  }

  private async requireSessionTab(
    tabId: number,
    options: { trackOverlay?: boolean } = {},
  ): Promise<void> {
    if (!(await this.tabLeases.isClaimedBySession(this.sessionId, tabId))) {
      throw new Error(
        `Tab ${tabId} is not part of browser session ${this.sessionId}`,
      );
    }
    if (options.trackOverlay === true) {
      await ensureContentScript(tabId);
      await this.tabFavicons.publishActiveBadge(tabId);
    }
  }

  private async runLifecycle<T>(callback: () => Promise<T>): Promise<T> {
    const next = this.lifecycleQueue.then(callback, callback);
    this.lifecycleQueue = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  private async runTurnMutation<T>(
    turnId: string,
    callback: () => Promise<T>,
  ): Promise<T> {
    return this.runLifecycle(async () => {
      if (this.currentTurnId !== turnId) {
        await this.resumeHandoffIfPresent(turnId);
        await this.tabLeases.updateActiveSessionTurn(this.sessionId, turnId);
        this.currentTurnId = turnId;
      }
      return callback();
    });
  }
}

function validateFinalizeTabs(
  entries: FinalizeTabEntry[],
  knownTabIds: Set<number>,
): Map<number, FinalizeTabEntry["status"]> {
  const keep = new Map<number, FinalizeTabEntry["status"]>();
  for (const entry of entries) {
    if (entry == null) {
      throw new Error("finalizeTabs received invalid tab entry");
    }
    assertTabId("finalizeTabs", entry.tabId);
    if (!knownTabIds.has(entry.tabId)) {
      throw new Error(`finalizeTabs cannot keep unknown tab ${entry.tabId}`);
    }
    if (entry.status !== "handoff" && entry.status !== "deliverable") {
      throw new Error(
        `finalizeTabs received invalid status ${String(entry.status)}`,
      );
    }
    if (keep.has(entry.tabId)) {
      throw new Error(`finalizeTabs received duplicate tab ${entry.tabId}`);
    }
    keep.set(entry.tabId, entry.status);
  }
  return keep;
}
