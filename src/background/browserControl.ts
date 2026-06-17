import type { BuildChannel } from "../shared/buildChannel";
import { readStorageArea } from "../shared/chromeAsync";
import {
  type BrowserInfo,
  type CdpCommandPayload,
  type DownloadChangeEvent,
  EMPTY_CURSOR_STATE,
  EXTENSION_INSTANCE_ID_KEY,
  errorMessage,
  type MoveMousePayload,
  PAGE_ASSETS_CAPABILITY,
  WEB_MCP_CAPABILITY,
} from "../shared/protocol";
import {
  BrowserTurnSchema,
  CdpCommandSchema,
  FinalizeTabsSchema,
  MoveMouseSchema,
  NameSessionSchema,
  TabIdSchema,
  TargetIdSchema,
  UserHistoryQuerySchema,
} from "../shared/schemas";
import { BrowserSession } from "./browserSession";
import { publishCursorState } from "./contentScripts";
import { DownloadTracker } from "./downloads";
import { TabFavicons } from "./tabFavicons";
import { TabGroups } from "./tabGroups";
import { TabLeases } from "./tabLeases";
import { TabTitleMarkers } from "./tabTitles";
import { assertTabId, getUserHistory, getUserTabs } from "./userTabs";

const CURSOR_ARRIVAL_TIMEOUT_MS = 2000;

export class BrowserControlService {
  private readonly sessions = new Map<string, BrowserSession>();
  private extensionInstanceId: string | null = null;
  private readonly cursorArrivalWaiters = new Map<string, () => void>();
  private nextCursorMoveSequence = 1;

  constructor(
    private readonly buildChannel: BuildChannel,
    private readonly tabLeases = new TabLeases(),
    private readonly tabGroups = new TabGroups(),
    private readonly downloadTracker = new DownloadTracker(),
    private readonly tabFavicons = new TabFavicons(tabLeases),
    private readonly tabTitleMarkers = new TabTitleMarkers(),
  ) {}

  ping(): string {
    return "pong";
  }

  async executeCdp(params: unknown): Promise<unknown> {
    const payload = CdpCommandSchema.parse(params) as CdpCommandPayload;
    return (await this.activateSession(payload)).executeCdp(payload);
  }

  async attach(params: unknown): Promise<void> {
    const payload = TabIdSchema.parse(params);
    await this.resolveSession(payload).attach(payload.turn_id, payload);
  }

  async attachTarget(params: unknown): Promise<void> {
    const payload = TargetIdSchema.parse(params);
    await this.resolveSession(payload).attachTarget(payload.turn_id, payload);
  }

  async detach(params: unknown): Promise<void> {
    const payload = TabIdSchema.parse(params);
    await this.resolveSession(payload).detach(payload.turn_id, payload);
  }

  async detachTarget(params: unknown): Promise<void> {
    const payload = TargetIdSchema.parse(params);
    await this.resolveSession(payload).detachTarget(payload.turn_id, payload);
  }

  async getTabs(params: unknown): Promise<unknown> {
    const payload = BrowserTurnSchema.parse(params);
    return (await this.activateSession(payload)).getTabs();
  }

  async getUserTabs(params: unknown): Promise<unknown> {
    const payload = BrowserTurnSchema.parse(params);
    await this.activateSession(payload);
    return getUserTabs();
  }

  async getUserHistory(params: unknown): Promise<unknown> {
    const payload = UserHistoryQuerySchema.parse(params);
    await this.activateSession(payload);
    return getUserHistory(payload);
  }

  async claimUserTab(params: unknown): Promise<unknown> {
    const payload = TabIdSchema.parse(params);
    return this.resolveSession(payload).claimUserTab(payload.turn_id, payload);
  }

  async createTab(params: unknown): Promise<unknown> {
    const payload = BrowserTurnSchema.parse(params);
    return this.resolveSession(payload).createTab(payload.turn_id);
  }

  async finalizeTabs(params: unknown): Promise<void> {
    const payload = FinalizeTabsSchema.parse(params);
    await this.resolveSession(payload).finalizeTabs(payload);
  }

  async nameSession(params: unknown): Promise<void> {
    const payload = NameSessionSchema.parse(params);
    await this.resolveSession(payload).nameSession(payload);
  }

  async executeUnhandledCommand(params: unknown): Promise<never> {
    await this.activateSession(BrowserTurnSchema.parse(params));
    const type =
      params && typeof params === "object" && "type" in params
        ? String((params as { type: unknown }).type)
        : "unknown";
    throw new Error(`Chrome does not support command "${type}".`);
  }

  async moveMouse(params: unknown): Promise<void> {
    const payload = MoveMouseSchema.parse(params) as MoveMousePayload;
    assertTabId("moveMouse", payload.tabId);

    const session = await this.activateSession(payload);
    await session.getTabs();

    const moveSequence = this.nextCursorMoveSequence;
    this.nextCursorMoveSequence += 1;

    const waiter =
      payload.waitForArrival === false
        ? null
        : this.createCursorArrivalWaiter({
            moveSequence,
            sessionId: payload.session_id,
            turnId: payload.turn_id,
          });

    const published = await publishCursorState(payload.tabId, {
      ...EMPTY_CURSOR_STATE,
      cursor: {
        moveSequence,
        visible: true,
        x: payload.x,
        y: payload.y,
        ...(payload.waitForArrival === false ? { animateMovement: false } : {}),
      },
      isVisible: true,
      sessionId: payload.session_id,
      turnId: payload.turn_id,
    });

    if (waiter != null) {
      if (!published) {
        waiter.cancel();
        return;
      }
      await waiter.promise;
    }
  }

  notifyCursorArrived({
    moveSequence,
    sessionId,
    turnId,
  }: {
    moveSequence: number;
    sessionId: string;
    turnId: string;
  }): void {
    if (Number.isInteger(moveSequence)) {
      this.cursorArrivalWaiters.get(
        cursorArrivalKey(sessionId, turnId, moveSequence),
      )?.();
    }
  }

  async turnEnded(params: unknown): Promise<void> {
    const payload = BrowserTurnSchema.parse(params);
    const session = this.sessions.get(payload.session_id);
    if (session) {
      await session.endTurn(payload.turn_id);
      return;
    }
    await this.tabLeases.releaseActiveTurn(payload.session_id, payload.turn_id);
  }

  async getInfo(_params?: unknown): Promise<BrowserInfo> {
    this.extensionInstanceId ??= await this.loadExtensionInstanceId();
    const browserId = this.extensionInstanceId ?? chrome.runtime.id;
    return {
      browser_id: browserId,
      name: "Chrome",
      version: chrome.runtime.getManifest().version,
      type: "extension",
      capabilities: {
        tab: [
          PAGE_ASSETS_CAPABILITY,
          ...(this.isWebMcpEnabled() ? [WEB_MCP_CAPABILITY] : []),
        ],
      },
      metadata: {
        extensionId: chrome.runtime.id,
        extensionInstanceId: this.extensionInstanceId,
      },
    };
  }

  addDownloadChangeListener(
    listener: (event: DownloadChangeEvent) => void,
  ): () => void {
    return this.downloadTracker.addDownloadChangeListener(listener);
  }

  handleDownloadCreated(item: chrome.downloads.DownloadItem): void {
    this.downloadTracker.handleDownloadCreated(item);
  }

  handleDownloadChanged(delta: chrome.downloads.DownloadDelta): void {
    this.downloadTracker.handleDownloadChanged(delta);
  }

  private resolveSession(params: { session_id?: unknown }): BrowserSession {
    const sessionId = this.requireSessionId(params);
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = new BrowserSession(
        sessionId,
        this.tabLeases,
        this.tabGroups,
        this.tabFavicons,
        this.tabTitleMarkers,
      );
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private async activateSession(params: {
    session_id?: unknown;
    turn_id?: unknown;
  }): Promise<BrowserSession> {
    const session = this.resolveSession(params);
    await session.activateTurn(this.requireTurnId(params));
    return session;
  }

  private requireSessionId(params: { session_id?: unknown }): string {
    if (typeof params.session_id !== "string") {
      throw new Error("Missing required browser session_id");
    }
    return params.session_id;
  }

  private requireTurnId(params: { turn_id?: unknown }): string {
    if (typeof params.turn_id !== "string") {
      throw new Error("Missing required browser turn_id");
    }
    return params.turn_id;
  }

  private createCursorArrivalWaiter({
    moveSequence,
    sessionId,
    turnId,
  }: {
    moveSequence: number;
    sessionId: string;
    turnId: string;
  }): { cancel: () => void; promise: Promise<void> } {
    const key = cursorArrivalKey(sessionId, turnId, moveSequence);
    let timeoutId: number | null = null;
    let resolvePromise: (() => void) | null = null;

    const done = () => {
      if (timeoutId != null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      this.cursorArrivalWaiters.delete(key);
      resolvePromise?.();
    };

    return {
      cancel: done,
      promise: new Promise((resolve) => {
        resolvePromise = resolve;
        timeoutId = self.setTimeout(done, CURSOR_ARRIVAL_TIMEOUT_MS);
        this.cursorArrivalWaiters.set(key, done);
      }),
    };
  }

  private async loadExtensionInstanceId(): Promise<string | null> {
    const item = await readStorageArea<Record<string, unknown>>(
      chrome.storage.local,
      EXTENSION_INSTANCE_ID_KEY,
    );
    return typeof item[EXTENSION_INSTANCE_ID_KEY] === "string"
      ? item[EXTENSION_INSTANCE_ID_KEY]
      : null;
  }

  private isWebMcpEnabled(): boolean {
    return this.buildChannel !== "prod";
  }
}

function cursorArrivalKey(
  sessionId: string,
  turnId: string,
  moveSequence: number,
): string {
  return `${sessionId}:${turnId}:${moveSequence}`;
}

export function normalizeThrown(error: unknown): Error {
  return error instanceof Error ? error : new Error(errorMessage(error));
}
