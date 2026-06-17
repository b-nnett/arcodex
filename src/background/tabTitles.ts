import { ensureContentScript } from "./contentScripts";

const STORAGE_KEY = "TAB_TITLE_MARKERS";
const CODEX_TITLE_MARKER = "[Codex]";

export class TabTitleMarkers {
  private readonly markedTabIds = new Set<number>();
  private initializePromise: Promise<void> | null = null;

  constructor(private readonly storage = chrome.storage.session) {
    this.registerEventListeners();
    this.ensureInit().catch(() => {});
  }

  async ensureInit(): Promise<void> {
    this.initializePromise ??= this.loadFromStorage();
    await this.initializePromise;
  }

  async mark(tabId: number): Promise<void> {
    await this.ensureInit();
    this.markedTabIds.add(tabId);
    await this.saveToStorage();
    await this.publishMarker(tabId, CODEX_TITLE_MARKER);
  }

  async markTabs(tabIds: number[]): Promise<void> {
    await Promise.all(tabIds.map((tabId) => this.mark(tabId)));
  }

  async clear(tabId: number): Promise<void> {
    await this.ensureInit();
    this.markedTabIds.delete(tabId);
    await this.saveToStorage();
    await this.publishMarker(tabId, null);
  }

  async clearTabs(tabIds: number[]): Promise<void> {
    await Promise.all(tabIds.map((tabId) => this.clear(tabId)));
  }

  private registerEventListeners(): void {
    chrome.tabs.onUpdated?.addListener((tabId, changeInfo) => {
      if (
        this.markedTabIds.has(tabId) &&
        (changeInfo.status === "complete" || changeInfo.title != null)
      ) {
        this.publishMarker(tabId, CODEX_TITLE_MARKER).catch(() => {});
      }
    });
    chrome.tabs.onRemoved?.addListener((tabId) => {
      if (this.markedTabIds.delete(tabId)) {
        this.saveToStorage().catch(() => {});
      }
    });
    chrome.tabs.onReplaced?.addListener((addedTabId, removedTabId) => {
      if (this.markedTabIds.delete(removedTabId)) {
        this.markedTabIds.add(addedTabId);
        this.saveToStorage().catch(() => {});
        this.publishMarker(addedTabId, CODEX_TITLE_MARKER).catch(() => {});
      }
    });
  }

  private async publishMarker(
    tabId: number,
    marker: string | null,
  ): Promise<void> {
    if (!(await ensureContentScript(tabId))) {
      return;
    }
    await chrome.tabs
      .sendMessage(tabId, {
        type: "TAB_TITLE_MARKER",
        marker,
      })
      .catch(() => {});
  }

  private async loadFromStorage(): Promise<void> {
    const stored = (await this.storage.get(STORAGE_KEY))[STORAGE_KEY];
    if (
      !stored ||
      typeof stored !== "object" ||
      !("tabIds" in stored) ||
      !Array.isArray(stored.tabIds)
    ) {
      return;
    }

    for (const tabId of stored.tabIds) {
      if (Number.isInteger(tabId)) {
        this.markedTabIds.add(tabId);
      }
    }
  }

  private async saveToStorage(): Promise<void> {
    await this.storage.set({
      [STORAGE_KEY]: {
        tabIds: [...this.markedTabIds],
      },
    });
  }
}
