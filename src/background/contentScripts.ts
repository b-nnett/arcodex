import type { AgentCursorState } from "../shared/protocol";

const CONTENT_SCRIPT_MESSAGE_TIMEOUT_MS = 1000;

export async function ensureContentScript(tabId: number): Promise<boolean> {
  if (await pingContentScript(tabId)) {
    return true;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content-scripts/codex.js"],
    });
  } catch {
    return false;
  }

  return pingContentScript(tabId);
}

export async function publishCursorState(
  tabId: number,
  state: AgentCursorState,
): Promise<boolean> {
  if (!(await ensureContentScript(tabId))) {
    return false;
  }
  try {
    const response = await withTimeout(
      chrome.tabs.sendMessage(tabId, {
        type: "AGENT_CURSOR_STATE",
        state,
      }),
      CONTENT_SCRIPT_MESSAGE_TIMEOUT_MS,
    );
    return response?.ok === true;
  } catch {
    return false;
  }
}

async function pingContentScript(tabId: number): Promise<boolean> {
  try {
    const response = await withTimeout(
      chrome.tabs.sendMessage(tabId, {
        type: "CONTENT_PING",
      }),
      CONTENT_SCRIPT_MESSAGE_TIMEOUT_MS,
    );
    return response?.ok === true;
  } catch {
    return false;
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = self.setTimeout(() => {
      reject(
        new Error(`Content script message timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
