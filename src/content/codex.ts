import {
  type AgentCursorState,
  EMPTY_CURSOR_STATE,
  type RuntimeMessage,
} from "../shared/protocol";
import { AgentCursorOverlay } from "./cursorOverlay";
import { applyFaviconBadge, clearFaviconBadge } from "./faviconBadge";

const ROOT_ID = "codex-agent-overlay-root";
const ROOT_DATASET_KEY = "codexAgentOverlayRoot";

let overlay: AgentCursorOverlay | null = null;
let state: AgentCursorState = EMPTY_CURSOR_STATE;
let activeTitleMarker: string | null = null;
let titleObserver: MutationObserver | null = null;
let applyingTitleMarker = false;

function ensureOverlayRoot(): HTMLElement | null {
  const documentElement = document.documentElement;
  if (!documentElement) {
    return null;
  }

  const existing = document.getElementById(ROOT_ID);
  if (existing instanceof HTMLDivElement) {
    if (existing.dataset[ROOT_DATASET_KEY] === "true") {
      return existing;
    }
    return null;
  }

  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.dataset[ROOT_DATASET_KEY] = "true";
  documentElement.appendChild(root);

  const shadowRoot = root.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent =
    ".codex-agent-overlay{all:initial;z-index:2147483646;pointer-events:none;position:fixed;inset:0}@media print{.codex-agent-overlay{display:none}}";
  shadowRoot.appendChild(style);

  const mount = document.createElement("div");
  shadowRoot.appendChild(mount);
  overlay = new AgentCursorOverlay(mount, {
    assetUrl: chrome.runtime.getURL("images/cursor-chat.png"),
    onArrived: (moveSequence) => {
      if (state.sessionId == null || state.turnId == null) {
        return;
      }
      chrome.runtime
        .sendMessage({
          type: "AGENT_CURSOR_ARRIVED",
          moveSequence,
          sessionId: state.sessionId,
          turnId: state.turnId,
        })
        .catch(() => {});
    },
  });

  return root;
}

function setCursorState(nextState: AgentCursorState): void {
  state = normalizeCursorState(nextState);
  ensureOverlayRoot();
  overlay?.setState(state);
}

function normalizeCursorState(value: unknown): AgentCursorState {
  if (!value || typeof value !== "object") {
    return EMPTY_CURSOR_STATE;
  }

  const candidate = value as Partial<AgentCursorState>;
  const sessionId =
    typeof candidate.sessionId === "string" ? candidate.sessionId : null;
  const turnId = typeof candidate.turnId === "string" ? candidate.turnId : null;
  const cursor =
    candidate.cursor &&
    typeof candidate.cursor.visible === "boolean" &&
    typeof candidate.cursor.x === "number" &&
    Number.isFinite(candidate.cursor.x) &&
    typeof candidate.cursor.y === "number" &&
    Number.isFinite(candidate.cursor.y)
      ? candidate.cursor
      : null;

  return {
    cursor,
    isVisible: candidate.isVisible === true && sessionId != null,
    sessionId,
    turnId,
  };
}

function setTitleMarker(marker: string | null): void {
  activeTitleMarker =
    typeof marker === "string" && marker.trim() ? marker.trim() : null;
  applyTitleMarker();
  updateTitleObserver();
}

function applyTitleMarker(): void {
  const title = document.querySelector("title");
  if (!title) {
    if (activeTitleMarker != null && document.head) {
      const nextTitle = document.createElement("title");
      document.head.appendChild(nextTitle);
    } else {
      return;
    }
  }

  const nextTitle = readMarkedTitle(document.title, activeTitleMarker);
  if (document.title === nextTitle) {
    return;
  }
  applyingTitleMarker = true;
  document.title = nextTitle;
  applyingTitleMarker = false;
}

function updateTitleObserver(): void {
  titleObserver?.disconnect();
  titleObserver = null;

  if (activeTitleMarker == null) {
    return;
  }

  titleObserver = new MutationObserver(() => {
    if (!applyingTitleMarker) {
      applyTitleMarker();
    }
  });
  titleObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}

function readMarkedTitle(title: string, marker: string | null): string {
  const unmarked = removeKnownTitleMarker(title);
  if (marker == null) {
    return unmarked;
  }
  return unmarked ? `${marker} ${unmarked}` : marker;
}

function removeKnownTitleMarker(title: string): string {
  if (title === "[Codex]") {
    return "";
  }
  return title.startsWith("[Codex] ") ? title.slice("[Codex] ".length) : title;
}

function handleMessage(
  message: RuntimeMessage,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): true | false {
  if (message?.type === "CONTENT_PING") {
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "TAB_FAVICON_BADGE") {
    if (message.badge == null || message.faviconDataUrl == null) {
      clearFaviconBadge();
    } else {
      applyFaviconBadge(message.badge, message.faviconDataUrl);
    }
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "TAB_TITLE_MARKER") {
    setTitleMarker(message.marker);
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "AGENT_CURSOR_STATE") {
    setCursorState(message.state);
    sendResponse({ ok: true });
    return true;
  }

  return false;
}

ensureOverlayRoot();
chrome.runtime.onMessage.addListener(handleMessage);
chrome.runtime
  .sendMessage({ type: "GET_AGENT_CURSOR_STATE" })
  .then((response) => {
    if (response?.ok) {
      setCursorState(response.state);
    }
  })
  .catch(() => {});
