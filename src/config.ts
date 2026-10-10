// src/config.ts
// Central place for settings you may want to change per cafe / environment.

/** Shown on the student-facing viewer. ASCII only, max 24 chars. */
export const BRANCH_NAME: string = process.env.EXPO_PUBLIC_BRANCH_NAME ?? 'Taft Ave';

/**
 * Where the 30-second telemetry is POSTed.
 * Default is the placeholder from the brief; set EXPO_PUBLIC_SYNC_URL in a
 * `.env` file to point at your own server (see the server/ folder).
 */
export const SYNC_URL: string = process.env.EXPO_PUBLIC_SYNC_URL ?? 'https://api.tambay.ai/sync';

export const SYNC_INTERVAL_MS = 30_000;

/** Project requirement: the sync payload must stay under 100 bytes. */
export const MAX_PAYLOAD_BYTES = 100;

/**
 * Base URL of the tambay-ai-server, used by the Cafe Console picker to
 * list branches (GET /api/cafes). Derived from SYNC_URL by dropping the
 * `/sync` suffix; override with EXPO_PUBLIC_API_URL if they differ.
 */
export const API_URL: string =
  process.env.EXPO_PUBLIC_API_URL ?? SYNC_URL.replace(/\/sync\/?$/, '');