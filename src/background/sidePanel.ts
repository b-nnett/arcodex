import { readStorageArea, writeStorageArea } from "../shared/chromeAsync";
import {
  type EnsureCodexAppServerResponse,
  errorMessage,
  type NativeHostStatus,
  SIDE_PANEL_OPEN_WINDOW_IDS_KEY,
} from "../shared/protocol";
import type { NativeTransport } from "./nativeTransport";

function toWindowIdSet(value: unknown): Set<number> {
  return Array.isArray(value)
    ? new Set(
        value.filter(
          (candidate): candidate is number =>
            typeof candidate === "number" && Number.isSafeInteger(candidate),
        ),
      )
    : new Set();
}

export class SidePanelTracker {
  private openWindowIds = new Set<number>();
  private listenersRegistered = false;

  registerListeners(): void {
    if (this.listenersRegistered || !chrome.sidePanel) {
      return;
    }

    chrome.sidePanel.onOpened?.addListener((info) => {
      this.setOpen(info.windowId, true).catch(() => {});
    });
    chrome.sidePanel.onClosed?.addListener((info) => {
      this.setOpen(info.windowId, false).catch(() => {});
    });
    this.listenersRegistered = true;
  }

  async restore(): Promise<void> {
    const items = await readStorageArea<Record<string, unknown>>(
      chrome.storage.session,
      SIDE_PANEL_OPEN_WINDOW_IDS_KEY,
    );
    this.openWindowIds = toWindowIdSet(items[SIDE_PANEL_OPEN_WINDOW_IDS_KEY]);
  }

  isOpen(windowId?: number): boolean {
    return typeof windowId === "number"
      ? this.openWindowIds.has(windowId)
      : this.openWindowIds.size > 0;
  }

  async setOpen(windowId: number, open: boolean): Promise<void> {
    if (open) {
      this.openWindowIds.add(windowId);
    } else {
      this.openWindowIds.delete(windowId);
    }
    await writeStorageArea(chrome.storage.session, {
      [SIDE_PANEL_OPEN_WINDOW_IDS_KEY]: [...this.openWindowIds],
    });
  }
}

export async function ensureCodexAppServer({
  nativeTransport,
  refreshStatus,
  sidePanelTracker,
  windowId,
}: {
  nativeTransport: NativeTransport;
  refreshStatus: () => NativeHostStatus;
  sidePanelTracker: SidePanelTracker;
  windowId?: number;
}): Promise<EnsureCodexAppServerResponse> {
  await sidePanelTracker.restore();
  if (!sidePanelTracker.isOpen(windowId)) {
    const nativeHostStatus = refreshStatus();
    return {
      ok: false,
      error: "Codex side panel is not open.",
      nativeHostStatus,
      sidePanelOpen: false,
    };
  }

  try {
    const hostResponse = await nativeTransport.requestHost(
      "ensureCodexAppServer",
    );
    const nativeHostStatus = refreshStatus();
    return {
      ok: true,
      nativeHostStatus,
      sidePanelOpen: true,
      ...(hostResponse && typeof hostResponse === "object"
        ? (hostResponse as Record<string, unknown>)
        : {}),
    };
  } catch (error) {
    const nativeHostStatus = refreshStatus();
    return {
      ok: false,
      error: errorMessage(error),
      nativeHostStatus,
      sidePanelOpen: true,
    };
  }
}
