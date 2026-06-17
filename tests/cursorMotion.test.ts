// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CursorMotionController,
  type CursorVisualState,
} from "../src/content/cursorMotion";

describe("CursorMotionController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("snaps non-animated moves and acknowledges the move sequence immediately", () => {
    const rendered: CursorVisualState[] = [];
    const arrived: number[] = [];
    const controller = new CursorMotionController(
      (state) => rendered.push(state),
      (moveSequence) => arrived.push(moveSequence),
    );

    controller.setState({
      cursor: {
        visible: true,
        x: 100,
        y: 120,
        animateMovement: false,
        moveSequence: 1,
      },
      isVisible: true,
      turnKey: "session:turn",
      viewportSize: { height: 800, width: 1200 },
    });

    expect(arrived).toEqual([1]);
    expect(rendered.at(-1)?.transform).toContain("translate3d(88px, 108px, 0)");

    controller.destroy();
  });

  it("animates later visible moves before acknowledging arrival", async () => {
    const rendered: CursorVisualState[] = [];
    const arrived: number[] = [];
    const controller = new CursorMotionController(
      (state) => rendered.push(state),
      (moveSequence) => arrived.push(moveSequence),
    );

    controller.setState({
      cursor: { visible: true, x: 100, y: 120, animateMovement: false },
      isVisible: true,
      turnKey: "session:turn",
      viewportSize: { height: 800, width: 1200 },
    });
    await vi.advanceTimersByTimeAsync(1200);

    controller.setState({
      cursor: { visible: true, x: 900, y: 620, moveSequence: 2 },
      isVisible: true,
      turnKey: "session:turn",
      viewportSize: { height: 800, width: 1200 },
    });

    expect(arrived).toEqual([]);

    for (let i = 0; i < 180 && arrived.length === 0; i += 1) {
      await vi.advanceTimersByTimeAsync(16);
    }

    expect(arrived).toEqual([2]);
    expect(rendered.at(-1)?.transform).toContain(
      "translate3d(888px, 608px, 0)",
    );

    controller.destroy();
  });
});
