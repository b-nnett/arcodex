export class TabGroups {
  private readonly sessionGroupTitles = new Map<string, string>();

  async ensureAgentTabGroup(
    sessionId: string,
    newTabId: number,
    existingAgentTabIds: number[],
  ): Promise<void> {
    // Arc exposes Chrome tab group APIs but can hang synchronously when grouping
    // a newly created tab. Group presentation is optional; tab control is not.
    if (!AGENT_TAB_GROUPS_ENABLED) {
      return;
    }

    if (!chrome.tabs.group || !chrome.tabGroups) {
      return;
    }

    const existingGroupId =
      await this.findManagedGroupContainingTabs(existingAgentTabIds);
    if (existingGroupId != null) {
      const groupId = await runBestEffortTabGroupOperation(() =>
        chrome.tabs.group({ groupId: existingGroupId, tabIds: [newTabId] }),
      );
      if (typeof groupId === "number") {
        await this.reconcileGroupPresentation(sessionId, groupId);
      }
      return;
    }

    const groupId = await runBestEffortTabGroupOperation(() =>
      chrome.tabs.group({ tabIds: [newTabId] }),
    );
    if (typeof groupId === "number") {
      await this.reconcileGroupPresentation(sessionId, groupId);
    }
  }

  async setSessionGroupTitle(
    sessionId: string,
    title: string,
    activeAgentTabIds: number[],
  ): Promise<void> {
    this.sessionGroupTitles.set(sessionId, title);
    const groupId =
      await this.findManagedGroupContainingTabs(activeAgentTabIds);
    if (groupId != null) {
      await this.reconcileGroupPresentation(sessionId, groupId);
    }
  }

  async releaseTabsFromManagedGroups(tabIds: number[]): Promise<void> {
    if (tabIds.length === 0 || !chrome.tabs.ungroup) {
      return;
    }
    await Promise.allSettled(
      tabIds.map((tabId) =>
        runBestEffortTabGroupOperation(() => chrome.tabs.ungroup(tabId)),
      ),
    );
  }

  async getManagedGroupIdContainingTabs(
    tabIds: number[],
  ): Promise<number | null> {
    return this.findManagedGroupContainingTabs(tabIds);
  }

  async reconcileManagedGroupForTabs(
    sessionId: string,
    groupId: number,
    tabIds: number[],
  ): Promise<void> {
    for (const tabId of tabIds) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.groupId !== groupId) {
          await runBestEffortTabGroupOperation(() =>
            chrome.tabs.group({ groupId, tabIds: [tabId] }),
          );
        }
      } catch {}
    }
    await this.reconcileGroupPresentation(sessionId, groupId);
  }

  async refreshManagedGroupsFromChrome(): Promise<void> {
    // Chrome remains the source of truth for current tab group membership.
  }

  private async findManagedGroupContainingTabs(
    tabIds: number[],
  ): Promise<number | null> {
    for (const tabId of tabIds) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (typeof tab.groupId === "number" && tab.groupId !== -1) {
          return tab.groupId;
        }
      } catch {}
    }
    return null;
  }

  private async reconcileGroupPresentation(
    sessionId: string,
    groupId: number,
  ): Promise<void> {
    if (!chrome.tabGroups?.update) {
      return;
    }
    const title = this.sessionGroupTitles.get(sessionId);
    await runBestEffortTabGroupOperation(() =>
      chrome.tabGroups.update(groupId, {
        ...(title == null ? {} : { title }),
        color: "blue",
        collapsed: false,
      }),
    );
  }
}

const AGENT_TAB_GROUPS_ENABLED = false;
const TAB_GROUP_OPERATION_TIMEOUT_MS = 1500;

async function runBestEffortTabGroupOperation<T>(
  operation: () => Promise<T>,
): Promise<T | undefined> {
  const operationPromise = operation().catch(() => undefined);
  const timeoutPromise = new Promise<undefined>((resolve) => {
    setTimeout(() => resolve(undefined), TAB_GROUP_OPERATION_TIMEOUT_MS);
  });
  return Promise.race([operationPromise, timeoutPromise]);
}
