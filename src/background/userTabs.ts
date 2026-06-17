import type {
  TabInfo,
  UserHistoryItem,
  UserHistoryQuery,
} from "../shared/protocol";

const MAX_USER_TABS = 100;
const TAB_CREATE_RECOVERY_TIMEOUT_MS = 1500;
const TAB_CREATE_RECOVERY_POLL_MS = 100;
const TAB_CREATE_RECOVERY_DEADLINE_MS = 2000;
const TAB_CREATE_TIMED_OUT = Symbol("tab-create-timed-out");
const TAB_QUERY_TIMED_OUT = Symbol("tab-query-timed-out");

export async function getUserTabs(): Promise<TabInfo[]> {
  const tabs = (await chrome.tabs.query({}))
    .filter(tabHasId)
    .sort(compareTabsByLastAccess)
    .slice(0, MAX_USER_TABS);
  const groupTitles = await readTabGroupTitles(tabs);
  return tabs.map((tab) => toUserTabInfo(tab, groupTitles));
}

export async function getUserHistory(
  payload: UserHistoryQuery,
): Promise<UserHistoryItem[]> {
  const query = normalizeHistoryQuery(payload.query);
  const maxResults = normalizeHistoryLimit(payload.limit);
  const startTime = normalizeHistoryDate(payload.from, "from") ?? 0;
  const endTime = normalizeHistoryDate(payload.to, "to");

  const items = await chrome.history.search({
    text: query,
    maxResults,
    startTime,
    ...(endTime == null ? {} : { endTime }),
  });

  return items.flatMap((item): UserHistoryItem[] => {
    if (
      typeof item.url !== "string" ||
      typeof item.lastVisitTime !== "number" ||
      !Number.isFinite(item.lastVisitTime)
    ) {
      return [];
    }
    return [
      {
        url: item.url,
        ...(item.title == null ? {} : { title: item.title }),
        dateVisited: new Date(item.lastVisitTime).toISOString(),
      },
    ];
  });
}

export async function getExistingTab(tabId: number): Promise<chrome.tabs.Tab> {
  const tab = await chrome.tabs.get(tabId);
  if (tab.id !== undefined) {
    return tab;
  }
  throw new Error(`Chrome tab ${tabId} has no id`);
}

export async function createBackgroundTab(): Promise<TabInfo> {
  const windowId = await findTargetWindowId();
  const tab =
    windowId == null
      ? await createWindowWithBlankTab()
      : await createTabInWindow(windowId);
  return toSessionTabInfo(tab);
}

export function toSessionTabInfo(tab: chrome.tabs.Tab): TabInfo {
  if (tab.id === undefined) {
    throw new Error("Chrome tab has no id");
  }
  return {
    id: tab.id,
    title: tab.title,
    active: tab.active,
    url: tab.url,
  };
}

export function assertTabId(
  commandName: string,
  tabId: unknown,
): asserts tabId is number {
  if (!Number.isInteger(tabId)) {
    throw new Error(`${commandName} requires an integer tabId`);
  }
}

export async function removeTabs(tabIds: number[]): Promise<void> {
  const first = tabIds[0];
  if (first == null) {
    return;
  }
  if (tabIds.length === 1) {
    await chrome.tabs.remove(first);
  } else {
    await chrome.tabs.remove([first, ...tabIds.slice(1)]);
  }
}

async function findTargetWindowId(): Promise<number | null> {
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  const focused = windows.find(
    (window) => window.focused && window.id !== undefined,
  );
  if (focused?.id !== undefined) {
    return focused.id;
  }
  return windows.find((window) => window.id !== undefined)?.id ?? null;
}

async function createWindowWithBlankTab(): Promise<chrome.tabs.Tab> {
  const window = await chrome.windows.create({
    focused: false,
    type: "normal",
    url: "about:blank",
  });
  const tab = window?.tabs?.find(tabHasId);
  if (tab) {
    return tab;
  }
  if (window?.id === undefined) {
    throw new Error("Created Chrome window has no id");
  }
  return createTabInWindow(window.id);
}

async function createTabInWindow(windowId: number): Promise<chrome.tabs.Tab> {
  const existingTabIds = await queryWindowTabIds(windowId);
  const tab = await callChromeApiWithTimeout<
    chrome.tabs.Tab,
    typeof TAB_CREATE_TIMED_OUT
  >(
    "chrome.tabs.create",
    TAB_CREATE_RECOVERY_TIMEOUT_MS,
    (resolve) =>
      chrome.tabs.create(
        {
          active: false,
          url: "about:blank",
          windowId,
        },
        resolve,
      ),
    TAB_CREATE_TIMED_OUT,
  );
  if (tab === TAB_CREATE_TIMED_OUT) {
    const recoveredTab = await recoverCreatedBlankTab(windowId, existingTabIds);
    if (recoveredTab) {
      return recoveredTab;
    }
    throw new Error("Created tab did not become observable");
  }
  if (tabHasId(tab)) {
    return tab;
  }
  throw new Error("Created tab has no id");
}

async function queryWindowTabIds(windowId: number): Promise<Set<number>> {
  return new Set(
    (await queryWindowTabs(windowId)).filter(tabHasId).map((tab) => tab.id),
  );
}

async function recoverCreatedBlankTab(
  windowId: number,
  existingTabIds: Set<number>,
): Promise<chrome.tabs.Tab | null> {
  const deadline = Date.now() + TAB_CREATE_RECOVERY_DEADLINE_MS;
  do {
    const candidates = (await queryWindowTabs(windowId))
      .filter(tabHasId)
      .filter((tab) => !existingTabIds.has(tab.id))
      .filter(isBlankTab)
      .sort((left, right) => right.id - left.id);
    if (candidates[0]) {
      return candidates[0];
    }
    await delay(TAB_CREATE_RECOVERY_POLL_MS);
  } while (Date.now() < deadline);
  return null;
}

async function queryWindowTabs(windowId: number): Promise<chrome.tabs.Tab[]> {
  const tabs = await callChromeApiWithTimeout<
    chrome.tabs.Tab[],
    typeof TAB_QUERY_TIMED_OUT
  >(
    "chrome.tabs.query",
    TAB_CREATE_RECOVERY_TIMEOUT_MS,
    (resolve) => chrome.tabs.query({}, resolve),
    TAB_QUERY_TIMED_OUT,
  );
  if (tabs === TAB_QUERY_TIMED_OUT) {
    throw new Error("chrome.tabs.query timed out while recovering created tab");
  }
  return tabs.filter((tab) => tab.windowId === windowId);
}

function isBlankTab(tab: chrome.tabs.Tab): boolean {
  const pendingUrl = (tab as chrome.tabs.Tab & { pendingUrl?: string })
    .pendingUrl;
  return tab.url === "about:blank" || pendingUrl === "about:blank";
}

function callChromeApiWithTimeout<T, TTimeout>(
  apiName: string,
  timeoutMs: number,
  invoke: (resolve: (value: T) => void) => void,
  timeoutValue: TTimeout,
): Promise<T | TTimeout> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        callback();
      }
    };
    const timeout = setTimeout(() => {
      finish(() => resolve(timeoutValue));
    }, timeoutMs);
    try {
      invoke((value) => {
        const lastError = chrome.runtime?.lastError;
        finish(() => {
          if (lastError?.message) {
            reject(new Error(lastError.message));
          } else {
            resolve(value);
          }
        });
      });
    } catch (error) {
      finish(() =>
        reject(error instanceof Error ? error : new Error(`${apiName} failed`)),
      );
    }
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeHistoryQuery(query: unknown): string {
  if (query == null) {
    return "";
  }
  if (typeof query !== "string") {
    throw new Error("getUserHistory requires query to be a string");
  }
  return query;
}

function normalizeHistoryLimit(limit: unknown): number {
  if (limit == null) {
    return 100;
  }
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
    throw new Error("getUserHistory requires limit to be a positive integer");
  }
  return limit;
}

function normalizeHistoryDate(
  value: unknown,
  name: "from" | "to",
): number | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`getUserHistory requires ${name} to be a valid date`);
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`getUserHistory requires ${name} to be a valid date`);
  }
  return parsed;
}

async function readTabGroupTitles(
  tabs: chrome.tabs.Tab[],
): Promise<Map<number, string>> {
  const groupIds = new Set<number>();
  for (const tab of tabs) {
    if (typeof tab.groupId === "number" && tab.groupId !== -1) {
      groupIds.add(tab.groupId);
    }
  }

  const entries = await Promise.all(
    [...groupIds].map(async (groupId) => {
      try {
        const title = (await chrome.tabGroups.get(groupId)).title?.trim();
        return title ? ([groupId, title] as const) : null;
      } catch {
        return null;
      }
    }),
  );

  return new Map(
    entries.filter(
      (entry): entry is readonly [number, string] => entry != null,
    ),
  );
}

function compareTabsByLastAccess(
  left: chrome.tabs.Tab,
  right: chrome.tabs.Tab,
): number {
  const lastAccessed = readLastAccessed(right) - readLastAccessed(left);
  if (lastAccessed !== 0) {
    return lastAccessed;
  }
  const windowDiff = (left.windowId ?? 0) - (right.windowId ?? 0);
  if (windowDiff !== 0) {
    return windowDiff;
  }
  return (left.index ?? 0) - (right.index ?? 0);
}

function readLastAccessed(tab: chrome.tabs.Tab): number {
  return typeof tab.lastAccessed === "number" &&
    Number.isFinite(tab.lastAccessed)
    ? tab.lastAccessed
    : 0;
}

function toUserTabInfo(
  tab: chrome.tabs.Tab,
  groupTitles: Map<number, string>,
): TabInfo {
  const lastOpened = readLastAccessed(tab);
  const groupTitle =
    typeof tab.groupId === "number" ? groupTitles.get(tab.groupId) : undefined;
  return {
    id: tab.id as number,
    ...(tab.title == null ? {} : { title: tab.title }),
    ...(tab.url == null ? {} : { url: tab.url }),
    ...(lastOpened <= 0
      ? {}
      : { lastOpened: new Date(lastOpened).toISOString() }),
    ...(groupTitle == null ? {} : { tabGroup: groupTitle }),
  };
}

function tabHasId(
  tab: chrome.tabs.Tab,
): tab is chrome.tabs.Tab & { id: number } {
  return tab.id !== undefined;
}
