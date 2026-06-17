// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  applyFaviconBadge,
  clearFaviconBadge,
} from "../src/content/faviconBadge";

const faviconDataUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP8z8BQDwAFgwJ/lcHfKAAAAABJRU5ErkJggg==";

describe("favicon badge reconstruction", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
  });

  it("adds a managed badge favicon without rewriting the page favicon", () => {
    const link = document.createElement("link");
    link.rel = "icon";
    link.href = "https://example.test/favicon.ico";
    document.head.appendChild(link);

    applyFaviconBadge("deliverable", faviconDataUrl);

    const managed = document.head.querySelector<HTMLLinkElement>(
      'link[data-codex-favicon-badge="true"]',
    );
    expect(managed).not.toBeNull();
    expect(managed).not.toBe(link);
    expect(document.head.lastElementChild).toBe(managed);
    expect(link.dataset.codexFaviconBadge).toBeUndefined();
    expect(link.href).toBe("https://example.test/favicon.ico");
    expect(decodeURIComponent(managed?.getAttribute("href") ?? "")).toContain(
      'data-codex-favicon-badge="codex-favicon-badge"',
    );
    expect(decodeURIComponent(managed?.getAttribute("href") ?? "")).toContain(
      'fill="#22c55e"',
    );

    clearFaviconBadge();

    expect(link.href).toBe("https://example.test/favicon.ico");
    expect(
      document.head.querySelector('link[data-codex-favicon-badge="true"]'),
    ).toBeNull();
  });

  it("creates and removes a favicon when the page has none", () => {
    applyFaviconBadge("handoff", faviconDataUrl);

    const link =
      document.head.querySelector<HTMLLinkElement>("link[rel='icon']");
    expect(link).not.toBeNull();
    expect(link?.dataset.codexFaviconBadge).toBe("true");
    expect(decodeURIComponent(link?.getAttribute("href") ?? "")).toContain(
      'fill="#facc15"',
    );

    clearFaviconBadge();

    expect(document.head.querySelector("link[rel='icon']")).toBeNull();
  });

  it("updates the managed favicon in place when the badge changes", () => {
    applyFaviconBadge("handoff", faviconDataUrl);
    const managed = document.head.querySelector<HTMLLinkElement>(
      'link[data-codex-favicon-badge="true"]',
    );

    applyFaviconBadge("deliverable", faviconDataUrl);

    const updated = document.head.querySelector<HTMLLinkElement>(
      'link[data-codex-favicon-badge="true"]',
    );
    expect(updated).toBe(managed);
    expect(decodeURIComponent(updated?.getAttribute("href") ?? "")).toContain(
      'fill="#22c55e"',
    );
  });

  it("keeps the managed favicon after page favicon rewrites", async () => {
    applyFaviconBadge("handoff", faviconDataUrl);
    const managed = document.head.querySelector<HTMLLinkElement>(
      'link[data-codex-favicon-badge="true"]',
    );
    const pageIcon = document.createElement("link");
    pageIcon.rel = "icon";
    pageIcon.href = "https://example.test/new-favicon.ico";

    document.head.appendChild(pageIcon);
    await Promise.resolve();
    await Promise.resolve();

    expect(document.head.lastElementChild).toBe(managed);
    expect(pageIcon.href).toBe("https://example.test/new-favicon.ico");
  });
});
