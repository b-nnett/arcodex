import type { BuildChannel } from "./buildChannel";

export const EXTENSION_NAME = "Codex (OS Extension)";
export const EXTENSION_DESCRIPTION = "Control Chrome with Codex.";
export const EXTENSION_VERSION = "1.1.14";

export const LEARN_MORE_URL =
  "https://developers.openai.com/codex/app/chrome-extension";
export const CHROME_SETTINGS_URL =
  "codex://settings/computer-use/google-chrome";

export const NATIVE_HOST_STATUS_KEY = "NATIVE_HOST_STATUS";
export const EXTENSION_INSTANCE_ID_KEY = "extensionInstanceId";
export const SIDE_PANEL_OPEN_WINDOW_IDS_KEY = "codexSidePanelOpenWindowIds";
export const PENDING_UPDATE_VERSION_KEY = "codexPendingUpdateVersion";

export const NATIVE_HOSTS: Record<BuildChannel, string> = {
  dev: "com.openai.codexextension.dev",
  internal: "com.openai.codexextension.internal",
  prod: "com.openai.codexextension",
};

export const RECONNECT_ALARM_PREFIX = "native-transport-reconnect";
export const RECONNECT_DELAY_MS = 5000;
export const RECONNECT_ALARM_PERIOD_MINUTES = 0.5;
export const HOST_REQUEST_TIMEOUT_MS = 10000;

export type NativeHostState = "connected" | "disconnected" | "reconnecting";

export interface NativeHostStatus {
  state: NativeHostState;
  hostName: string;
  lastChecked: number;
  reconnectAttempt: number;
  error?: string;
  nextRetryMs?: number;
}

export interface JsonRpcRequest<TParams = unknown> {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: TParams;
}

export interface JsonRpcNotification<TParams = unknown> {
  jsonrpc: "2.0";
  method: string;
  params?: TParams;
}

export type JsonRpcMessage<TParams = unknown> =
  | JsonRpcRequest<TParams>
  | JsonRpcNotification<TParams>
  | JsonRpcResponse;

export interface JsonRpcResponse<TResult = unknown> {
  jsonrpc?: "2.0";
  id: string | number;
  result?: TResult;
  error?: {
    code?: number;
    message: string;
    data?: unknown;
  };
}

export interface GetNativeHostStatusMessage {
  type: "GET_NATIVE_HOST_STATUS";
}

export interface EnsureCodexAppServerMessage {
  type: "ensure_codex_app_server";
  windowId?: number;
}

export interface ContentPingMessage {
  type: "CONTENT_PING";
}

export type FaviconBadge = "active" | "deliverable" | "handoff";

export interface TabFaviconBadgeMessage {
  type: "TAB_FAVICON_BADGE";
  badge: FaviconBadge | null;
  faviconDataUrl: string | null;
}

export interface TabTitleMarkerMessage {
  type: "TAB_TITLE_MARKER";
  marker: string | null;
}

export interface AgentCursor {
  visible: boolean;
  x: number;
  y: number;
  animateMovement?: boolean;
  moveSequence?: number;
}

export interface AgentCursorState {
  cursor: AgentCursor | null;
  isVisible: boolean;
  sessionId: string | null;
  turnId: string | null;
}

export interface GetAgentCursorStateMessage {
  type: "GET_AGENT_CURSOR_STATE";
}

export interface AgentCursorStateMessage {
  type: "AGENT_CURSOR_STATE";
  state: AgentCursorState;
}

export interface AgentCursorArrivedMessage {
  type: "AGENT_CURSOR_ARRIVED";
  sessionId: string;
  turnId: string;
  moveSequence: number;
}

export type RuntimeMessage =
  | GetNativeHostStatusMessage
  | EnsureCodexAppServerMessage
  | ContentPingMessage
  | TabFaviconBadgeMessage
  | TabTitleMarkerMessage
  | GetAgentCursorStateMessage
  | AgentCursorStateMessage
  | AgentCursorArrivedMessage;

export interface NativeHostStatusResponse {
  ok: boolean;
  status: NativeHostStatus;
  error?: string;
}

export interface EnsureCodexAppServerResponse {
  ok: boolean;
  nativeHostStatus: NativeHostStatus;
  sidePanelOpen: boolean;
  error?: string;
  [key: string]: unknown;
}

export const EMPTY_CURSOR_STATE: AgentCursorState = {
  cursor: null,
  isVisible: false,
  sessionId: null,
  turnId: null,
};

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

export type BrowserIdPayload = {
  browser_id?: string;
};

export type BrowserTurnPayload = BrowserIdPayload & {
  session_id: string;
  turn_id: string;
};

export type BrowserTabPayload = BrowserTurnPayload & {
  tabId: number;
};

export interface TabInfo {
  id: number;
  title?: string;
  url?: string;
  active?: boolean;
  lastOpened?: string;
  tabGroup?: string;
}

export interface UserHistoryQuery extends BrowserTurnPayload {
  query?: string;
  limit?: number;
  from?: string;
  to?: string;
}

export interface UserHistoryItem {
  url: string;
  title?: string;
  dateVisited: string;
}

export interface CdpCommandPayload extends BrowserTurnPayload {
  target: chrome.debugger.Debuggee;
  method: string;
  commandParams?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface AttachPayload extends BrowserTurnPayload {
  tabId: number;
}

export interface AttachTargetPayload extends AttachPayload {
  targetId: string;
}

export interface ClaimUserTabPayload extends BrowserTurnPayload {
  tabId: number;
}

export interface NameSessionPayload extends BrowserTurnPayload {
  name: string;
}

export type FinalizeTabStatus = "handoff" | "deliverable";

export interface FinalizeTabEntry {
  tabId: number;
  status: FinalizeTabStatus;
}

export interface FinalizeTabsPayload extends BrowserTurnPayload {
  keep: FinalizeTabEntry[];
}

export interface MoveMousePayload extends BrowserTurnPayload {
  tabId: number;
  x: number;
  y: number;
  waitForArrival?: boolean;
}

export type DownloadChangeStatus =
  | "started"
  | "in_progress"
  | "complete"
  | "canceled"
  | "failed";

export interface DownloadChangeEvent {
  id: string;
  filename: string;
  url?: string;
  status: DownloadChangeStatus;
}

export interface BrowserInfo {
  browser_id: string;
  name: "Chrome";
  version: string;
  type: "extension";
  capabilities: {
    tab: Array<{ id: string; description: string }>;
  };
  metadata: {
    extensionId: string;
    extensionInstanceId: string | null;
  };
}

export const PAGE_ASSETS_CAPABILITY = {
  id: "pageAssets",
  description:
    "List assets already observed in the current page state and bundle selected assets into a temporary local artifact.",
};

export const WEB_MCP_CAPABILITY = {
  id: "webmcp",
  description:
    "List and invoke page-defined WebMCP tools registered through navigator.modelContext in the active tab.",
};
