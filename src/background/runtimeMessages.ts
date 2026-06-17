import {
  type AgentCursorArrivedMessage,
  EMPTY_CURSOR_STATE,
  type GetNativeHostStatusMessage,
  type NativeHostStatus,
  type RuntimeMessage,
} from "../shared/protocol";
import type { BrowserControlService } from "./browserControl";
import type { NativeTransport } from "./nativeTransport";
import { ensureCodexAppServer, type SidePanelTracker } from "./sidePanel";

export type RuntimeMessageDependencies = {
  nativeTransport: NativeTransport;
  refreshAndStoreStatus: () => NativeHostStatus;
  sidePanelTracker: SidePanelTracker;
  browserControl: Pick<BrowserControlService, "notifyCursorArrived">;
};

export function createRuntimeMessageHandler({
  nativeTransport,
  refreshAndStoreStatus,
  sidePanelTracker,
  browserControl,
}: RuntimeMessageDependencies) {
  return function handleRuntimeMessage(
    message: RuntimeMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ): true | false {
    if (message?.type === "GET_NATIVE_HOST_STATUS") {
      handleGetNativeHostStatus(message, refreshAndStoreStatus, sendResponse);
      return true;
    }

    if (message?.type === "ensure_codex_app_server") {
      void ensureCodexAppServer({
        nativeTransport,
        refreshStatus: refreshAndStoreStatus,
        sidePanelTracker,
        windowId: message.windowId,
      }).then(sendResponse);
      return true;
    }

    if (message?.type === "GET_AGENT_CURSOR_STATE") {
      sendResponse({ ok: true, state: EMPTY_CURSOR_STATE });
      return true;
    }

    if (message?.type === "AGENT_CURSOR_ARRIVED") {
      handleAgentCursorArrived(message, sender, browserControl);
      sendResponse({ ok: true });
      return true;
    }

    return false;
  };
}

function handleGetNativeHostStatus(
  _message: GetNativeHostStatusMessage,
  refreshAndStoreStatus: () => NativeHostStatus,
  sendResponse: (response?: unknown) => void,
): void {
  const status = refreshAndStoreStatus();
  sendResponse({
    ok: status.state === "connected",
    status,
    error: status.error,
  });
}

function handleAgentCursorArrived(
  message: AgentCursorArrivedMessage,
  _sender: chrome.runtime.MessageSender,
  browserControl: Pick<BrowserControlService, "notifyCursorArrived">,
): void {
  browserControl.notifyCursorArrived(message);
}
