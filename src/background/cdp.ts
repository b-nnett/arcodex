import type { CdpCommandPayload } from "../shared/protocol";

const DEFAULT_CDP_TIMEOUT_MS = 30_000;

const attachedTabs = new Set<number>();
const attachedTargets = new Set<string>();
const targetTabIds = new Map<string, number>();
const tabLocks = new Map<number, Promise<void>>();
const targetLocks = new Map<string, Promise<void>>();

export class CdpCommandTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for CDP command ${method}.`);
    this.name = "CdpCommandTimeoutError";
  }
}

export async function attachTabDebugger(tabId: number): Promise<void> {
  await withLock(tabLocks, tabId, async () => {
    if (attachedTabs.has(tabId)) {
      return;
    }
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
    } catch (error) {
      if (!isAnotherDebuggerError(error)) {
        throw error;
      }
    }
    attachedTabs.add(tabId);
  });
}

export async function attachTargetDebugger(
  tabId: number,
  targetId: string,
): Promise<void> {
  await withLock(targetLocks, targetId, async () => {
    if (attachedTargets.has(targetId)) {
      return;
    }
    try {
      await chrome.debugger.attach({ targetId }, "1.3");
    } catch (error) {
      if (!isAnotherDebuggerError(error)) {
        throw error;
      }
    }
    attachedTargets.add(targetId);
    targetTabIds.set(targetId, tabId);
  });
}

export async function detachTabDebugger(tabId: number): Promise<void> {
  await withLock(tabLocks, tabId, async () => {
    try {
      await chrome.debugger.detach({ tabId });
    } catch (error) {
      if (!isDebuggerNotAttachedError(error)) {
        throw error;
      }
    } finally {
      attachedTabs.delete(tabId);
    }
  });
}

export async function detachTargetDebugger(targetId: string): Promise<void> {
  await withLock(targetLocks, targetId, async () => {
    try {
      await chrome.debugger.detach({ targetId });
    } catch (error) {
      if (!isDebuggerNotAttachedError(error)) {
        throw error;
      }
    } finally {
      attachedTargets.delete(targetId);
      targetTabIds.delete(targetId);
    }
  });
}

export async function detachAttachedDebuggersForTabs(
  tabIds: Iterable<number>,
): Promise<void> {
  const ids = new Set(tabIds);
  await Promise.allSettled([
    ...[...ids]
      .filter((tabId) => attachedTabs.has(tabId))
      .map((tabId) => detachTabDebugger(tabId)),
    ...[...targetTabIds.entries()]
      .filter(([, tabId]) => ids.has(tabId))
      .map(([targetId]) => detachTargetDebugger(targetId)),
  ]);
}

export async function forceDetachTabDebugger(tabId: number): Promise<void> {
  await withLock(tabLocks, tabId, async () => {
    attachedTabs.delete(tabId);
    try {
      await chrome.debugger.detach({ tabId });
    } catch {}
  });
}

export async function executeCdpCommand(
  payload: CdpCommandPayload,
): Promise<unknown> {
  const tabId = payload.target.tabId;
  if (typeof tabId === "number" && !attachedTabs.has(tabId)) {
    throw new Error("Debugger unattached");
  }

  try {
    return await withTimeout(
      sendDebuggerCommand(payload),
      payload.timeoutMs,
      payload.method,
    );
  } catch (error) {
    if (error instanceof CdpCommandTimeoutError && typeof tabId === "number") {
      await forceDetachTabDebugger(tabId);
    }
    throw error;
  }
}

async function sendDebuggerCommand(
  payload: CdpCommandPayload,
): Promise<unknown> {
  if (payload.method === "Target.getTargets") {
    const targetInfos = await chrome.debugger.getTargets();
    return { targetInfos };
  }

  const target =
    typeof payload.target.targetId === "string"
      ? { targetId: payload.target.targetId }
      : payload.target;

  return chrome.debugger.sendCommand(
    target,
    payload.method,
    payload.commandParams,
  );
}

async function withTimeout(
  promise: Promise<unknown>,
  timeoutMs: number | undefined,
  method: string,
): Promise<unknown> {
  const effectiveTimeout =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_CDP_TIMEOUT_MS;

  let timeoutId: number | undefined;
  const timeout = new Promise((_, reject) => {
    timeoutId = self.setTimeout(() => {
      reject(new CdpCommandTimeoutError(method, effectiveTimeout));
    }, effectiveTimeout);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

async function withLock<TKey>(
  locks: Map<TKey, Promise<void>>,
  key: TKey,
  callback: () => Promise<void>,
): Promise<void> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release = () => {};
  const current = previous
    .catch(() => {})
    .then(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
  locks.set(key, current);

  try {
    await previous.catch(() => {});
    await callback();
  } finally {
    release();
    if (locks.get(key) === current) {
      locks.delete(key);
    }
  }
}

function isAnotherDebuggerError(error: unknown): boolean {
  return errorMessage(error).includes("Another debugger");
}

function isDebuggerNotAttachedError(error: unknown): boolean {
  return errorMessage(error).toLowerCase().includes("not attached");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
