import { describe, expect, it } from "vitest";
import { DownloadTracker } from "../src/background/downloads";

describe("DownloadTracker", () => {
  it("emits started and complete download changes", () => {
    const tracker = new DownloadTracker();
    const events: unknown[] = [];
    tracker.addDownloadChangeListener((event) => events.push(event));

    tracker.handleDownloadCreated({
      id: 7,
      filename: "/tmp/report.pdf",
      finalUrl: "https://example.test/report.pdf",
    } as chrome.downloads.DownloadItem);
    tracker.handleDownloadChanged({
      id: 7,
      state: { current: "complete" },
    } as chrome.downloads.DownloadDelta);

    expect(events).toEqual([
      {
        id: "7",
        filename: "/tmp/report.pdf",
        url: "https://example.test/report.pdf",
        status: "started",
      },
      {
        id: "7",
        filename: "/tmp/report.pdf",
        url: "https://example.test/report.pdf",
        status: "complete",
      },
    ]);
  });

  it("maps interrupted downloads to canceled or failed", () => {
    const tracker = new DownloadTracker();
    const events: Array<{ status: string }> = [];
    tracker.addDownloadChangeListener((event) => events.push(event));

    tracker.handleDownloadCreated({
      id: 8,
      filename: "/tmp/canceled",
      finalUrl: "https://example.test/canceled",
    } as chrome.downloads.DownloadItem);
    tracker.handleDownloadChanged({
      id: 8,
      state: { current: "interrupted" },
      error: { current: "USER_CANCELED" },
    } as chrome.downloads.DownloadDelta);
    tracker.handleDownloadCreated({
      id: 9,
      filename: "/tmp/failed",
      finalUrl: "https://example.test/failed",
    } as chrome.downloads.DownloadItem);
    tracker.handleDownloadChanged({
      id: 9,
      state: { current: "interrupted" },
      error: { current: "NETWORK_FAILED" },
    } as chrome.downloads.DownloadDelta);

    expect(events.map((event) => event.status)).toEqual([
      "started",
      "canceled",
      "started",
      "failed",
    ]);
  });
});
