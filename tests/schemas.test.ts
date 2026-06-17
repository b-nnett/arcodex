import { describe, expect, it } from "vitest";
import {
  CdpCommandSchema,
  DownloadChangeEventSchema,
  FinalizeTabsSchema,
  MoveMouseSchema,
} from "../src/shared/schemas";

describe("command schemas", () => {
  it("parses CDP command payloads", () => {
    expect(
      CdpCommandSchema.parse({
        browser_id: "chrome",
        session_id: "session",
        turn_id: "turn",
        target: { tabId: 123 },
        method: "Runtime.evaluate",
        commandParams: { expression: "1 + 1" },
        timeoutMs: 5000,
      }),
    ).toMatchObject({
      target: { tabId: 123 },
      method: "Runtime.evaluate",
    });
  });

  it("accepts current browser-client payloads without browser_id", () => {
    expect(
      CdpCommandSchema.parse({
        session_id: "session",
        turn_id: "turn",
        target: { tabId: 123 },
        method: "Runtime.evaluate",
      }),
    ).toMatchObject({
      session_id: "session",
      turn_id: "turn",
      target: { tabId: 123 },
    });
  });

  it("validates finalize tab status values", () => {
    expect(() =>
      FinalizeTabsSchema.parse({
        browser_id: "chrome",
        session_id: "session",
        turn_id: "turn",
        keep: [{ tabId: 1, status: "archive" }],
      }),
    ).toThrow();
  });

  it("requires finite mouse coordinates", () => {
    expect(() =>
      MoveMouseSchema.parse({
        browser_id: "chrome",
        session_id: "session",
        turn_id: "turn",
        tabId: 1,
        x: Number.NaN,
        y: 1,
      }),
    ).toThrow();
  });

  it("accepts observed download change statuses", () => {
    for (const status of [
      "started",
      "in_progress",
      "complete",
      "canceled",
      "failed",
    ]) {
      expect(
        DownloadChangeEventSchema.parse({
          id: "1",
          filename: "/tmp/file",
          status,
        }).status,
      ).toBe(status);
    }
  });
});
