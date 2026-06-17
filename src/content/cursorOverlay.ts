import type { AgentCursorState } from "../shared/protocol";
import { CursorMotionController, type ViewportSize } from "./cursorMotion";

type OverlayOptions = {
  assetUrl: string;
  onArrived?: (moveSequence: number) => void;
};

export class AgentCursorOverlay {
  private readonly layer: HTMLDivElement;
  private readonly cursor: HTMLDivElement;
  private readonly motion: CursorMotionController;

  constructor(mount: HTMLElement, options: OverlayOptions) {
    this.layer = document.createElement("div");
    this.layer.className = "codex-agent-overlay";
    this.layer.setAttribute("aria-hidden", "true");
    Object.assign(this.layer.style, {
      inset: "0",
      overflow: "hidden",
      pointerEvents: "none",
      position: "absolute",
      zIndex: "20",
    });

    this.cursor = document.createElement("div");
    this.cursor.dataset.testid = "browser-agent-cursor";
    Object.assign(this.cursor.style, {
      height: "24px",
      left: "0",
      opacity: "0",
      position: "absolute",
      top: "0",
      transformOrigin: "12px 12px",
      width: "24px",
      willChange: "transform",
    });

    const imageWrap = document.createElement("div");
    imageWrap.style.transform = "translate3d(12px, -2.5px, 0)";

    const image = document.createElement("img");
    image.alt = "";
    image.dataset.browserAgentCursorAsset = "";
    image.dataset.testid = "browser-agent-cursor-asset";
    image.draggable = false;
    image.height = 24;
    image.src = options.assetUrl;
    image.width = 23;
    Object.assign(image.style, {
      display: "block",
      filter:
        "drop-shadow(0 0 6px rgba(51, 156, 255, 0.9)) drop-shadow(0 0 15px rgba(51, 156, 255, 0.48))",
      transform: "rotate(44deg) scale(1)",
      transformOrigin: "0 0",
    });

    imageWrap.appendChild(image);
    this.cursor.appendChild(imageWrap);
    this.layer.appendChild(this.cursor);
    mount.replaceChildren(this.layer);

    this.motion = new CursorMotionController((visualState) => {
      this.cursor.style.transform = visualState.transform;
      this.cursor.style.opacity = `${visualState.opacity}`;
      this.cursor.style.filter = visualState.filter;
    }, options.onArrived);
  }

  setState(state: AgentCursorState): void {
    this.motion.setState({
      cursor: state.cursor,
      isVisible: state.isVisible && state.sessionId != null,
      turnKey:
        state.sessionId == null
          ? null
          : `${state.sessionId}:${state.turnId ?? ""}`,
      viewportSize: currentViewportSize(),
    });
  }

  destroy(): void {
    this.motion.destroy();
    this.layer.remove();
  }
}

function currentViewportSize(): ViewportSize {
  return {
    height: window.visualViewport?.height ?? window.innerHeight,
    width: window.visualViewport?.width ?? window.innerWidth,
  };
}
