import {
  cachedActiveKeyIds,
  cachedConfig,
  cachedCursor,
  cachedKeysById,
  dirtyKeyIds,
  keyCooldownUntil,
  setCachedActiveKeyIds,
  setCachedCursor,
  setDirtyConfig,
} from "./state.ts";

export function rebuildActiveKeyIds(): void {
  const keys = Array.from(cachedKeysById.values());
  keys.sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );
  setCachedActiveKeyIds(
    keys.filter((k) => k.status === "active").map((k) => k.id),
  );
  if (cachedActiveKeyIds.length === 0) {
    setCachedCursor(0);
    return;
  }
  setCachedCursor(cachedCursor % cachedActiveKeyIds.length);
}

export function getNextApiKeyFast(
  now: number,
): { key: string; id: string } | null {
  if (cachedActiveKeyIds.length === 0) return null;

  for (let offset = 0; offset < cachedActiveKeyIds.length; offset++) {
    const idx = (cachedCursor + offset) % cachedActiveKeyIds.length;
    const id = cachedActiveKeyIds[idx];
    const cooldownUntil = keyCooldownUntil.get(id) ?? 0;
    if (cooldownUntil > now) continue;

    const keyEntry = cachedKeysById.get(id);
    if (!keyEntry || keyEntry.status !== "active") continue;

    setCachedCursor((idx + 1) % cachedActiveKeyIds.length);

    keyEntry.useCount += 1;
    keyEntry.lastUsed = now;
    dirtyKeyIds.add(id);

    if (cachedConfig) {
      cachedConfig.totalRequests += 1;
      setDirtyConfig(true);
    }

    return { key: keyEntry.key, id };
  }

  return null;
}

export function markKeyCooldownFrom429(id: string, response: Response): void {
  const retryAfter = response.headers.get("retry-after")?.trim();
  const retryAfterMs = retryAfter && /^\d+$/.test(retryAfter)
    ? Number.parseInt(retryAfter, 10) * 1000
    : 2000;
  keyCooldownUntil.set(id, Date.now() + Math.max(0, retryAfterMs));
}

export function markKeyInvalid(id: string): void {
  const keyEntry = cachedKeysById.get(id);
  if (!keyEntry) return;
  if (keyEntry.status === "invalid") return;
  keyEntry.status = "invalid";
  dirtyKeyIds.add(id);
  keyCooldownUntil.delete(id);
  rebuildActiveKeyIds();
}
