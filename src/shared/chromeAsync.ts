export function readStorageArea<T extends Record<string, unknown>>(
  area: chrome.storage.StorageArea,
  keys?: string | string[] | Record<string, unknown> | null,
): Promise<T> {
  return area.get(keys as never) as Promise<T>;
}

export async function writeStorageArea(
  area: chrome.storage.StorageArea,
  items: Record<string, unknown>,
): Promise<void> {
  await area.set(items);
}

export function randomId(): string {
  return crypto.randomUUID();
}
