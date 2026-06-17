import type { FaviconBadge } from "../shared/protocol";
import { ensureContentScript } from "./contentScripts";
import type { TabLeases } from "./tabLeases";

const STORAGE_KEY = "TAB_FAVICON_BADGES";
const FETCH_TIMEOUT_MS = 2000;

export class TabFavicons {
  private readonly unseenFinalizedBadges = new Map<
    number,
    "deliverable" | "handoff"
  >();
  private readonly faviconDataUrls = new Map<
    number,
    { pageUrl: string; dataUrl: string }
  >();
  private initializePromise: Promise<void> | null = null;

  constructor(
    private readonly tabLeases: TabLeases,
    private readonly storage = chrome.storage.session,
  ) {
    this.registerEventListeners();
    this.ensureInit().catch(() => {});
  }

  async ensureInit(): Promise<void> {
    this.initializePromise ??= this.loadFromStorage();
    await this.initializePromise;
  }

  async markFinalized(
    tabId: number,
    badge: "deliverable" | "handoff",
  ): Promise<void> {
    await this.ensureInit();
    const visible = await this.tabIsVisible(tabId);
    if (visible) {
      this.unseenFinalizedBadges.delete(tabId);
    } else {
      this.unseenFinalizedBadges.set(tabId, badge);
    }
    await this.saveToStorage();
    await this.publishBadge(tabId, visible ? null : badge);
  }

  async publishActiveBadge(tabId: number): Promise<void> {
    await this.publishBadge(tabId, "active");
  }

  async clearBadge(tabId: number): Promise<void> {
    this.unseenFinalizedBadges.delete(tabId);
    await this.saveToStorage();
    await this.publishBadge(tabId, null);
  }

  private registerEventListeners(): void {
    chrome.tabs.onActivated?.addListener((info) => {
      this.clearBadge(info.tabId).catch(() => {});
    });
    chrome.tabs.onUpdated?.addListener((tabId, changeInfo) => {
      if (changeInfo.url != null || changeInfo.favIconUrl != null) {
        this.faviconDataUrls.delete(tabId);
      }
      if (changeInfo.status === "complete" || changeInfo.favIconUrl != null) {
        this.republishBadge(tabId).catch(() => {});
      }
    });
    chrome.tabs.onRemoved?.addListener((tabId) => {
      this.faviconDataUrls.delete(tabId);
      this.unseenFinalizedBadges.delete(tabId);
      this.saveToStorage().catch(() => {});
    });
    chrome.tabs.onReplaced?.addListener((addedTabId, removedTabId) => {
      this.faviconDataUrls.delete(removedTabId);
      const badge = this.unseenFinalizedBadges.get(removedTabId);
      this.unseenFinalizedBadges.delete(removedTabId);
      if (badge) {
        this.unseenFinalizedBadges.set(addedTabId, badge);
      }
      this.saveToStorage().catch(() => {});
    });
  }

  private async republishBadge(tabId: number): Promise<void> {
    const owningSession = await this.tabLeases.getOwningSessionId(tabId);
    const badge =
      owningSession != null
        ? "active"
        : (this.unseenFinalizedBadges.get(tabId) ?? null);
    await this.publishBadge(tabId, badge);
  }

  private async publishBadge(
    tabId: number,
    badge: FaviconBadge | null,
  ): Promise<void> {
    if (!(await ensureContentScript(tabId))) {
      return;
    }
    const faviconDataUrl =
      badge == null ? null : await this.readFaviconDataUrl(tabId);
    await chrome.tabs
      .sendMessage(tabId, {
        type: "TAB_FAVICON_BADGE",
        badge: faviconDataUrl == null ? null : badge,
        faviconDataUrl,
      })
      .catch(() => {});
  }

  private async readFaviconDataUrl(tabId: number): Promise<string | null> {
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return null;
    }
    if (typeof tab.url !== "string" || tab.url.length === 0) {
      return null;
    }
    const cached = this.faviconDataUrls.get(tabId);
    if (cached?.pageUrl === tab.url) {
      return cached.dataUrl;
    }
    if (
      typeof tab.favIconUrl !== "string" ||
      tab.favIconUrl.length === 0 ||
      tab.favIconUrl.startsWith("data:image/svg+xml,")
    ) {
      return null;
    }

    const dataUrl = await fetchFaviconDataUrl(tab.url);
    if (dataUrl != null) {
      this.faviconDataUrls.set(tabId, { pageUrl: tab.url, dataUrl });
    }
    return dataUrl;
  }

  private async tabIsVisible(tabId: number): Promise<boolean> {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.active !== true || typeof tab.windowId !== "number") {
        return false;
      }
      return (await chrome.windows.get(tab.windowId)).focused === true;
    } catch {
      return false;
    }
  }

  private async loadFromStorage(): Promise<void> {
    const stored = (await this.storage.get(STORAGE_KEY))[STORAGE_KEY];
    if (
      !stored ||
      typeof stored !== "object" ||
      !("badges" in stored) ||
      !stored.badges ||
      typeof stored.badges !== "object" ||
      Array.isArray(stored.badges)
    ) {
      return;
    }

    for (const [key, value] of Object.entries(stored.badges)) {
      const tabId = Number(key);
      if (
        Number.isInteger(tabId) &&
        (value === "deliverable" || value === "handoff")
      ) {
        this.unseenFinalizedBadges.set(tabId, value);
      }
    }
  }

  private async saveToStorage(): Promise<void> {
    await this.storage.set({
      [STORAGE_KEY]: {
        badges: Object.fromEntries(this.unseenFinalizedBadges.entries()),
      },
    });
  }
}

async function fetchFaviconDataUrl(pageUrl: string): Promise<string | null> {
  const faviconUrl = new URL(chrome.runtime.getURL("/_favicon/"));
  faviconUrl.searchParams.set("pageUrl", pageUrl);
  faviconUrl.searchParams.set("size", "32");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(faviconUrl.toString(), {
      credentials: "omit",
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const contentType = response.headers.get("content-type") ?? "image/bmp";
    if (!contentType.startsWith("image/")) {
      return null;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0) {
      return null;
    }
    return `data:${contentType};base64,${bytesToBase64(bytes)}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
