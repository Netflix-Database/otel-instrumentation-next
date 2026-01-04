import { randomUUID } from 'node:crypto';
import { REQUEST_ID_HEADER } from './constants';

export function getOrCreateRequestId(headers: Headers): string {
  const incoming = headers.get(REQUEST_ID_HEADER);
  if (incoming && incoming.trim()) return incoming.trim();
  return randomUUID();
}

/**
 * Upsert a key-value pair into a baggage string. 
 */
export function upsertBaggage(baggage: string | null, key: string, value: string) {
  const encKey = encodeURIComponent(key);
  const encVal = encodeURIComponent(value);

  const parts = (baggage ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const map = new Map<string, string>();
  for (const p of parts) {
    const [k, ...rest] = p.split("=");
    if (!k || rest.length === 0) continue;
    map.set(k.trim(), rest.join("=").split(";")[0].trim());
  }

  map.set(encKey, encVal);

  return Array.from(map.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}
