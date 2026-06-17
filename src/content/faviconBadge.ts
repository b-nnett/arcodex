import type { FaviconBadge } from "../shared/protocol";

const BADGE_MARKER = "codex-favicon-badge";
const BADGED_LINK_SELECTOR = 'link[data-codex-favicon-badge="true"]';
const MANAGED_LINK_SELECTOR = 'link[data-codex-favicon-badge-managed="true"]';
const ICON_LINK_SELECTOR = 'link[rel~="icon"], link[rel="shortcut icon"]';
const CREATED_DATASET_KEY = "codexFaviconBadgeCreated";
const MANAGED_DATASET_KEY = "codexFaviconBadgeManaged";
const ORIGINAL_HREF_DATASET_KEY = "codexOriginalFaviconHref";

let activeBadgedHref: string | null = null;
let managedLink: HTMLLinkElement | null = null;
let faviconObserver: MutationObserver | null = null;
let ensureQueued = false;

export function applyFaviconBadge(
  badge: FaviconBadge,
  faviconDataUrl: string,
): void {
  restoreLegacyBadgedLinks();
  activeBadgedHref = makeBadgedHref(badge, faviconDataUrl);
  ensureManagedLink();
  startFaviconObserver();
}

export function clearFaviconBadge(): void {
  activeBadgedHref = null;
  ensureQueued = false;
  stopFaviconObserver();
  removeManagedLinks();
  restoreLegacyBadgedLinks();
}

function ensureManagedLink(): void {
  if (activeBadgedHref == null) {
    return;
  }

  const head = getDocumentHead();
  const link = getOrCreateManagedLink();
  if (link.rel !== "icon") {
    link.rel = "icon";
  }
  if (link.type !== "image/svg+xml") {
    link.type = "image/svg+xml";
  }
  if (link.dataset.codexFaviconBadge !== "true") {
    link.dataset.codexFaviconBadge = "true";
  }
  if (link.dataset[MANAGED_DATASET_KEY] !== "true") {
    link.dataset[MANAGED_DATASET_KEY] = "true";
  }
  if (link.getAttribute("href") !== activeBadgedHref) {
    link.setAttribute("href", activeBadgedHref);
  }

  if (link.parentElement !== head || head.lastElementChild !== link) {
    head.appendChild(link);
  }
}

function getOrCreateManagedLink(): HTMLLinkElement {
  if (managedLink?.isConnected === true) {
    return managedLink;
  }

  const existing = document.querySelector<HTMLLinkElement>(
    MANAGED_LINK_SELECTOR,
  );
  if (existing) {
    managedLink = existing;
    return existing;
  }

  const link = document.createElement("link");
  managedLink = link;
  return link;
}

function startFaviconObserver(): void {
  if (faviconObserver != null) {
    return;
  }

  faviconObserver = new MutationObserver((mutations) => {
    if (mutations.some(shouldReassertManagedLink)) {
      queueEnsureManagedLink();
    }
  });
  faviconObserver.observe(document.documentElement, {
    attributeFilter: ["href", "rel"],
    attributes: true,
    childList: true,
    subtree: true,
  });
}

function stopFaviconObserver(): void {
  faviconObserver?.disconnect();
  faviconObserver = null;
}

function shouldReassertManagedLink(mutation: MutationRecord): boolean {
  if (activeBadgedHref == null) {
    return false;
  }
  if (mutation.type === "attributes") {
    return isIconLink(mutation.target);
  }
  if (mutation.type !== "childList") {
    return false;
  }
  return [...mutation.addedNodes, ...mutation.removedNodes].some(
    (node) =>
      node === document.head ||
      isIconLink(node) ||
      (node instanceof Element &&
        node.querySelector(ICON_LINK_SELECTOR) != null),
  );
}

function queueEnsureManagedLink(): void {
  if (ensureQueued || activeBadgedHref == null) {
    return;
  }
  ensureQueued = true;
  queueMicrotask(() => {
    ensureQueued = false;
    ensureManagedLink();
  });
}

function isIconLink(value: unknown): value is HTMLLinkElement {
  if (!(value instanceof HTMLLinkElement)) {
    return false;
  }
  return value.matches(ICON_LINK_SELECTOR);
}

function removeManagedLinks(): void {
  for (const link of document.querySelectorAll<HTMLLinkElement>(
    MANAGED_LINK_SELECTOR,
  )) {
    link.remove();
  }
  managedLink = null;
}

function restoreLegacyBadgedLinks(): void {
  for (const link of document.querySelectorAll<HTMLLinkElement>(
    BADGED_LINK_SELECTOR,
  )) {
    if (link.dataset[MANAGED_DATASET_KEY] === "true") {
      continue;
    }
    const createdByCodex = link.dataset[CREATED_DATASET_KEY] === "true";
    const originalHref = link.dataset[ORIGINAL_HREF_DATASET_KEY] ?? null;

    delete link.dataset.codexFaviconBadge;
    delete link.dataset[CREATED_DATASET_KEY];
    delete link.dataset[ORIGINAL_HREF_DATASET_KEY];

    if (createdByCodex) {
      link.remove();
    } else if (originalHref == null) {
      link.removeAttribute("href");
    } else {
      link.setAttribute("href", originalHref);
    }
  }
}

function getDocumentHead(): HTMLHeadElement {
  if (document.head) {
    return document.head;
  }
  const head = document.createElement("head");
  document.documentElement.prepend(head);
  return head;
}

function makeBadgedHref(badge: FaviconBadge, faviconDataUrl: string): string {
  const opacity = badge === "active" ? ' opacity="0.3"' : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" data-codex-favicon-badge="${BADGE_MARKER}" width="32" height="32" viewBox="0 0 32 32"><image href="${escapeXml(faviconDataUrl)}" width="32" height="32"${opacity} />${badgeSvg(badge)}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function badgeSvg(badge: FaviconBadge): string {
  switch (badge) {
    case "active":
      return '<path d="M3.04536 4.45259C2.7582 3.60299 3.60299 2.7582 4.45259 3.04536L14.1828 6.33403C15.1637 6.66558 15.0872 8.08006 14.0715 8.39045L10.2994 9.54319C9.93919 9.65327 9.65327 9.93919 9.54319 10.2994L8.39046 14.0715C8.08007 15.0872 6.66558 15.1637 6.33404 14.1828L3.04536 4.45259Z" fill="black" stroke="white" stroke-width="1.5" stroke-linejoin="round" paint-order="stroke fill" transform="translate(-2 -2) scale(2.1)" />';
    case "deliverable":
      return '<circle cx="24" cy="24" r="7" fill="#22c55e" />';
    case "handoff":
      return '<circle cx="24" cy="24" r="7" fill="#facc15" />';
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
