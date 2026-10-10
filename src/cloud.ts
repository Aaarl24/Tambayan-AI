// src/cloud.ts
import type { Counts } from './detection';
import { MAX_PAYLOAD_BYTES, SYNC_URL } from './config';

export interface TelemetryPayload {
  branch: string;
  vacant: number;
  occupied: number;
  laptops: number;
  /** Experimental: dining-table count. */
  tables: number;
  /** Optional 8-hex-char seat grid (4x4, 2 bits/cell). Not an image. */
  grid?: string;
}

export interface SyncResult {
  ok: boolean;
  bytes: number;
  at: number; // epoch ms
}

const clampCount = (n: number): number => Math.max(0, Math.min(999, Math.trunc(n)));

/**
 * Builds the payload and guarantees it stays under MAX_PAYLOAD_BYTES.
 * Worst case with grid+tables is 109 bytes at a 24-char branch, so the
 * shrink loop can push branch names down to ~11 chars — still readable.
 */
export function buildPayload(branch: string, counts: Counts, grid?: string): TelemetryPayload {
  // ASCII-only so string length === byte length.
  let name = branch.replace(/[^\x20-\x7E]/g, '').slice(0, 24) || 'cafe';
  const make = (): TelemetryPayload => ({
    branch: name,
    vacant: clampCount(counts.vacant),
    occupied: clampCount(counts.occupied),
    laptops: clampCount(counts.laptops),
    tables: clampCount(counts.tables),
    ...(grid ? { grid } : {}),
  });
  let payload = make();
  while (JSON.stringify(payload).length >= MAX_PAYLOAD_BYTES && name.length > 1) {
    name = name.slice(0, -1);
    payload = make();
  }
  return payload;
}

/**
 * PRIVACY: this uploads well under 100 bytes of anonymized JSON text (three
 * integers and a branch name) and ZERO images or video frames. All vision
 * inference stays on-device in TFLite, so we remain fully compliant with the
 * local-AI privacy requirement. If the network is down the call fails quietly;
 * the on-device AI keeps working because it never depends on the cloud.
 */
export async function syncTelemetryToCloud(
  branch: string,
  counts: Counts,
  grid?: string
): Promise<SyncResult> {
  const payload = buildPayload(branch, counts, grid);
  const body = JSON.stringify(payload);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(SYNC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
    return { ok: res.ok, bytes: body.length, at: Date.now() };
  } catch {
    return { ok: false, bytes: body.length, at: Date.now() };
  } finally {
    clearTimeout(timeout);
  }
}