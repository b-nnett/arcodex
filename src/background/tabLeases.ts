import { readStorageArea, writeStorageArea } from "../shared/chromeAsync";
import { EXTENSION_INSTANCE_ID_KEY } from "../shared/protocol";

export type TabLeaseOrigin = "agent" | "user";
export type TabLeaseState = "active" | "handoff";

export interface TabLease {
  tabId: number;
  sessionId: string;
  turnId: string;
  origin: TabLeaseOrigin;
  claimedAt: number;
  instanceId: string | null;
  state: TabLeaseState;
  groupId?: number;
  isActiveHandoff?: boolean;
}

type StoredTabLeases = {
  leases?: Record<string, unknown>;
};

export class TabLeases {
  private readonly storageKey = "TAB_LEASES";
  private readonly leases = new Map<number, TabLease>();
  private initializePromise: Promise<void> | null = null;
  private instanceIdPromise: Promise<string | null> | null = null;
  private mutationQueue = Promise.resolve();
  private storageLoaded = false;
  private listenersRegistered = false;
  private readonly activeTabLeaseChangeHandlers = new Set<
    (tabIds: number[]) => void | Promise<void>
  >();

  constructor(
    private readonly storage: chrome.storage.StorageArea = chrome.storage
      .session,
    private readonly instanceStorage: chrome.storage.StorageArea = chrome
      .storage.local,
  ) {
    this.registerEventListeners();
  }

  async ensureInit(): Promise<void> {
    this.initializePromise ??= this.loadFromStorage();
    await this.initializePromise;
  }

  async getOwningSessionId(tabId: number): Promise<string | null> {
    await this.ensureInit();
    await this.waitForPendingMutations();
    const lease = this.leases.get(tabId);
    return lease?.state === "active" ? lease.sessionId : null;
  }

  subscribeActiveTabLeaseChanges(
    handler: (tabIds: number[]) => void | Promise<void>,
  ): () => void {
    this.activeTabLeaseChangeHandlers.add(handler);
    return () => {
      this.activeTabLeaseChangeHandlers.delete(handler);
    };
  }

  mightHaveActiveTabLease(tabId: number): boolean {
    return !this.storageLoaded || this.leases.get(tabId)?.state === "active";
  }

  async claimTab(
    sessionId: string,
    turnId: string,
    tabId: number,
    origin: TabLeaseOrigin,
  ): Promise<void> {
    await this.ensureInit();
    const instanceId = await this.getInstanceId();
    await this.mutate(() => {
      const lease = this.leases.get(tabId);
      if (lease?.state === "active") {
        if (lease.sessionId !== sessionId) {
          throw new Error(
            `Tab ${tabId} is already part of browser session ${lease.sessionId}`,
          );
        }
        if (lease.turnId === turnId && lease.instanceId === instanceId) {
          return false;
        }
        this.leases.set(tabId, { ...lease, turnId, instanceId });
        return true;
      }

      this.leases.set(tabId, {
        tabId,
        sessionId,
        turnId,
        origin,
        claimedAt: Date.now(),
        instanceId,
        state: "active",
      });
      return true;
    });
  }

  async isClaimedBySession(sessionId: string, tabId: number): Promise<boolean> {
    await this.ensureInit();
    await this.waitForPendingMutations();
    const lease = this.leases.get(tabId);
    return lease?.state === "active" && lease.sessionId === sessionId;
  }

  async getSessionActiveLeases(
    sessionId: string,
  ): Promise<Map<number, TabLease>> {
    return this.getSessionLeases(sessionId, "active");
  }

  async getSessionHandoffLeases(
    sessionId: string,
  ): Promise<Map<number, TabLease>> {
    return this.getSessionLeases(sessionId, "handoff");
  }

  async getSessionTabs(sessionId: string): Promise<chrome.tabs.Tab[]> {
    const activeLeases = await this.getSessionActiveLeases(sessionId);
    const entries = await Promise.all(
      [...activeLeases.keys()].map(async (tabId) => {
        try {
          return {
            state: "found" as const,
            tabId,
            tab: await chrome.tabs.get(tabId),
          };
        } catch {
          return { state: "stale" as const, tabId };
        }
      }),
    );

    const tabs: chrome.tabs.Tab[] = [];
    const staleTabIds: number[] = [];
    for (const entry of entries) {
      if (entry.state === "found") {
        tabs.push(entry.tab);
      } else {
        staleTabIds.push(entry.tabId);
      }
    }

    if (staleTabIds.length > 0) {
      await this.releaseTabs(sessionId, staleTabIds);
    }
    return tabs;
  }

  async updateActiveSessionTurn(
    sessionId: string,
    turnId: string,
  ): Promise<void> {
    await this.ensureInit();
    const instanceId = await this.getInstanceId();
    await this.mutate(() => {
      let changed = false;
      for (const [tabId, lease] of this.leases.entries()) {
        if (
          lease.sessionId === sessionId &&
          lease.state === "active" &&
          (lease.turnId !== turnId || lease.instanceId !== instanceId)
        ) {
          this.leases.set(tabId, { ...lease, turnId, instanceId });
          changed = true;
        }
      }
      return changed;
    });
  }

  async handoffTabs(
    sessionId: string,
    turnId: string,
    tabIds: number[],
    options: { groupId?: number; activeTabId?: number },
  ): Promise<void> {
    await this.ensureInit();
    const instanceId = await this.getInstanceId();
    const selected = new Set(tabIds);
    if (selected.size === 0) {
      return;
    }

    await this.mutate(() => {
      let changed = false;
      for (const tabId of selected) {
        const lease = this.leases.get(tabId);
        if (lease?.state === "active" && lease.sessionId === sessionId) {
          this.leases.set(tabId, {
            ...lease,
            turnId,
            instanceId,
            state: "handoff",
            ...(options.groupId == null ? {} : { groupId: options.groupId }),
            ...(options.activeTabId === tabId ? { isActiveHandoff: true } : {}),
          });
          changed = true;
        }
      }
      return changed;
    });
  }

  async resumeHandoffTabs(
    sessionId: string,
    turnId: string,
    tabIds: number[],
  ): Promise<number[]> {
    await this.ensureInit();
    const instanceId = await this.getInstanceId();
    const selected = new Set(tabIds);
    const resumed: number[] = [];
    if (selected.size === 0) {
      return resumed;
    }

    await this.mutate(() => {
      let changed = false;
      for (const tabId of selected) {
        const lease = this.leases.get(tabId);
        if (lease?.state === "handoff" && lease.sessionId === sessionId) {
          this.leases.set(tabId, {
            tabId,
            sessionId,
            turnId,
            origin: lease.origin,
            claimedAt: lease.claimedAt,
            instanceId,
            state: "active",
          });
          resumed.push(tabId);
          changed = true;
        }
      }
      return changed;
    });
    return resumed;
  }

  async releaseTabs(sessionId: string, tabIds: number[]): Promise<void> {
    await this.ensureInit();
    const selected = new Set(tabIds);
    if (selected.size === 0) {
      return;
    }

    await this.mutate(() => {
      let changed = false;
      for (const tabId of selected) {
        if (this.leases.get(tabId)?.sessionId === sessionId) {
          this.leases.delete(tabId);
          changed = true;
        }
      }
      return changed;
    });
  }

  async releaseActiveTurn(sessionId: string, turnId: string): Promise<void> {
    await this.ensureInit();
    await this.mutate(() => {
      let changed = false;
      for (const [tabId, lease] of this.leases.entries()) {
        if (
          lease.sessionId === sessionId &&
          lease.turnId === turnId &&
          lease.state === "active"
        ) {
          this.leases.delete(tabId);
          changed = true;
        }
      }
      return changed;
    });
  }

  private async getSessionLeases(
    sessionId: string,
    state: TabLeaseState,
  ): Promise<Map<number, TabLease>> {
    await this.ensureInit();
    await this.waitForPendingMutations();
    return new Map(
      [...this.leases.entries()].filter(
        ([, lease]) => lease.sessionId === sessionId && lease.state === state,
      ),
    );
  }

  private registerEventListeners(): void {
    if (this.listenersRegistered) {
      return;
    }
    this.listenersRegistered = true;
    chrome.tabs.onRemoved?.addListener((tabId) => {
      this.removeTab(tabId).catch(() => {});
    });
    chrome.tabs.onReplaced?.addListener((addedTabId, removedTabId) => {
      this.replaceTab(addedTabId, removedTabId).catch(() => {});
    });
  }

  private async removeTab(tabId: number): Promise<void> {
    await this.ensureInit();
    await this.mutate(() => this.leases.delete(tabId));
  }

  private async replaceTab(
    addedTabId: number,
    removedTabId: number,
  ): Promise<void> {
    await this.ensureInit();
    await this.mutate(() => {
      const lease = this.leases.get(removedTabId);
      if (!lease) {
        return false;
      }
      this.leases.delete(removedTabId);
      this.leases.set(addedTabId, { ...lease, tabId: addedTabId });
      return true;
    });
  }

  private async loadFromStorage(): Promise<void> {
    const before = this.readActiveTabIds();
    const items = await readStorageArea<Record<string, StoredTabLeases>>(
      this.storage,
      this.storageKey,
    );
    const stored = items[this.storageKey];
    this.leases.clear();
    for (const [tabId, lease] of parseStoredLeases(stored)) {
      this.leases.set(tabId, lease);
    }
    this.storageLoaded = true;
    this.publishActiveTabLeaseChanges(before);
  }

  private async getInstanceId(): Promise<string | null> {
    this.instanceIdPromise ??= this.loadInstanceId();
    return this.instanceIdPromise;
  }

  private async loadInstanceId(): Promise<string | null> {
    const items = await readStorageArea<Record<string, unknown>>(
      this.instanceStorage,
      EXTENSION_INSTANCE_ID_KEY,
    );
    const value = items[EXTENSION_INSTANCE_ID_KEY];
    return typeof value === "string" ? value : null;
  }

  private async mutate(
    callback: () => boolean | Promise<boolean>,
  ): Promise<void> {
    const operation = async () => {
      const before = this.readActiveTabIds();
      if (await callback()) {
        await this.saveToStorage();
        this.publishActiveTabLeaseChanges(before);
      }
    };
    const next = this.mutationQueue.then(operation, operation);
    this.mutationQueue = next.then(
      () => {},
      () => {},
    );
    await next;
  }

  private async waitForPendingMutations(): Promise<void> {
    await this.mutationQueue;
  }

  private async saveToStorage(): Promise<void> {
    await writeStorageArea(this.storage, {
      [this.storageKey]: {
        leases: Object.fromEntries(this.leases.entries()),
      },
    });
  }

  private readActiveTabIds(): Set<number> {
    return new Set(
      [...this.leases.entries()]
        .filter(([, lease]) => lease.state === "active")
        .map(([tabId]) => tabId),
    );
  }

  private publishActiveTabLeaseChanges(previous: Set<number>): void {
    const changed = symmetricDifference(previous, this.readActiveTabIds());
    if (changed.length === 0) {
      return;
    }
    for (const handler of this.activeTabLeaseChangeHandlers) {
      Promise.resolve(handler(changed)).catch(() => {});
    }
  }
}

function parseStoredLeases(
  stored: StoredTabLeases | undefined,
): Map<number, TabLease> {
  if (
    !stored ||
    typeof stored !== "object" ||
    !stored.leases ||
    typeof stored.leases !== "object" ||
    Array.isArray(stored.leases)
  ) {
    return new Map();
  }

  const leases = new Map<number, TabLease>();
  for (const [key, value] of Object.entries(stored.leases)) {
    const tabId = Number(key);
    const lease = parseLease(value);
    if (Number.isInteger(tabId) && lease && lease.tabId === tabId) {
      leases.set(tabId, lease);
    }
  }
  return leases;
}

function parseLease(value: unknown): TabLease | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const lease = value as Partial<TabLease>;
  if (
    typeof lease.tabId !== "number" ||
    !Number.isInteger(lease.tabId) ||
    typeof lease.sessionId !== "string" ||
    typeof lease.turnId !== "string" ||
    (lease.origin !== "agent" && lease.origin !== "user") ||
    typeof lease.claimedAt !== "number" ||
    !Number.isFinite(lease.claimedAt) ||
    (lease.instanceId !== null && typeof lease.instanceId !== "string") ||
    (lease.state !== "active" && lease.state !== "handoff")
  ) {
    return null;
  }

  return {
    tabId: lease.tabId,
    sessionId: lease.sessionId,
    turnId: lease.turnId,
    origin: lease.origin,
    claimedAt: lease.claimedAt,
    instanceId: lease.instanceId,
    state: lease.state,
    ...(typeof lease.groupId === "number" && Number.isInteger(lease.groupId)
      ? { groupId: lease.groupId }
      : {}),
    ...(typeof lease.isActiveHandoff === "boolean"
      ? { isActiveHandoff: lease.isActiveHandoff }
      : {}),
  };
}

function symmetricDifference(
  previous: Set<number>,
  next: Set<number>,
): number[] {
  const changed = new Set<number>();
  for (const tabId of previous) {
    if (!next.has(tabId)) {
      changed.add(tabId);
    }
  }
  for (const tabId of next) {
    if (!previous.has(tabId)) {
      changed.add(tabId);
    }
  }
  return [...changed];
}
