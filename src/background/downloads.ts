import type { DownloadChangeEvent } from "../shared/protocol";

export class DownloadTracker {
  private readonly listeners = new Set<(event: DownloadChangeEvent) => void>();
  private readonly filenamesById = new Map<number, string>();
  private readonly urlsById = new Map<number, string | undefined>();

  addDownloadChangeListener(
    listener: (event: DownloadChangeEvent) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  handleDownloadCreated(item: chrome.downloads.DownloadItem): void {
    if (!isChromeDownloadId(item.id) || typeof item.filename !== "string") {
      return;
    }

    this.filenamesById.set(item.id, item.filename);
    this.urlsById.set(item.id, item.finalUrl);
    this.emit({
      id: String(item.id),
      filename: item.filename,
      url: item.finalUrl,
      status: "started",
    });
  }

  handleDownloadChanged(delta: chrome.downloads.DownloadDelta): void {
    if (!isChromeDownloadId(delta.id)) {
      return;
    }

    const filename = readDownloadFilename(delta, this.filenamesById);
    if (filename == null) {
      return;
    }
    const url = this.urlsById.get(delta.id);
    this.filenamesById.set(delta.id, filename);

    const status = readDownloadStatus(delta);
    if (status != null) {
      this.emit({
        id: String(delta.id),
        filename,
        url,
        status,
      });
    }
  }

  private emit(event: DownloadChangeEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function readDownloadFilename(
  delta: chrome.downloads.DownloadDelta,
  filenamesById: Map<number, string>,
): string | undefined {
  const current = delta.filename?.current;
  return typeof current === "string" ? current : filenamesById.get(delta.id);
}

function readDownloadStatus(
  delta: chrome.downloads.DownloadDelta,
): DownloadChangeEvent["status"] | undefined {
  switch (delta.state?.current) {
    case "complete":
      return "complete";
    case "interrupted":
      return delta.error?.current === "USER_CANCELED" ? "canceled" : "failed";
    case "in_progress":
      return "in_progress";
    case undefined:
      return undefined;
  }
}

function isChromeDownloadId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
