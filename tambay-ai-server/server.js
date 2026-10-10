// tambay-ai-server: receives anonymized seat counts from Cafe Console
// sensor nodes (POST /sync) and serves the student web app + APIs.
// Zero dependencies — plain node:http. `npm start` is all it needs.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const REGISTRY_FILE = path.join(__dirname, 'cafes.json');

const STALE_AFTER_MS = 90 * 1000; // silent >90s => shown "Offline"
const DROP_AFTER_MS = 10 * 60 * 1000; // readings older than 10min are dropped
const MAX_SYNC_BYTES = 1024; // spec: 1 KB limit; real payloads are <100 bytes
const BRANCH_MAX_LEN = 24; // matches buildPayload() in ../src/cloud.ts
// The only fields a sensor may ever send. Strict: anything else => 400.
const SYNC_KEYS = new Set(['branch', 'vacant', 'occupied', 'laptops']);

// ---------------------------------------------------------------------------
// Telemetry rules — keep in sync with ../src/telemetry.ts (same thresholds).
// ---------------------------------------------------------------------------
const FILLING_AT_OCCUPANCY_PCT = 75;
const OUTLET_MEDIUM_AT = 0.25; // laptops / seats
const OUTLET_HIGH_AT = 0.6;

function deriveTelemetry(vacant, occupied, laptops) {
  const totalSeats = vacant + occupied;
  const occupancyPct = totalSeats > 0 ? Math.round((occupied / totalSeats) * 100) : 0;
  const laptopRatio = totalSeats > 0 ? laptops / totalSeats : 0;
  let availability = 'available';
  if (totalSeats === 0) availability = 'none';
  else if (vacant === 0) availability = 'full';
  else if (occupancyPct >= FILLING_AT_OCCUPANCY_PCT) availability = 'filling';
  const outletDemand =
    laptopRatio >= OUTLET_HIGH_AT ? 'high' : laptopRatio >= OUTLET_MEDIUM_AT ? 'medium' : 'low';
  return { totalSeats, occupancyPct, availability, outletDemand };
}

// ---------------------------------------------------------------------------
// Cafe registry (cafes.json). `branch` is the join key with POST /sync.
// ---------------------------------------------------------------------------
function loadCafes() {
  try {
    const cafes = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
    if (!Array.isArray(cafes)) throw new Error('not an array');
    return cafes;
  } catch (e) {
    console.error(`[cafes] could not load ${REGISTRY_FILE}: ${e.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Strict validation for POST /sync — PRIVACY: only 4 fields may leave a phone.
// Returns an error string, or null when the payload is valid.
// ---------------------------------------------------------------------------
function validateSync(p) {
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return 'expected a JSON object';
  for (const k of Object.keys(p)) if (!SYNC_KEYS.has(k)) return `unexpected field "${k}"`;
  const branch = p.branch;
  if (typeof branch !== 'string' || !branch.trim()) return 'branch must be a non-empty string';
  if (/[^\x20-\x7E]/.test(branch)) return 'branch must be ASCII';
  if (branch.length > BRANCH_MAX_LEN) return `branch longer than ${BRANCH_MAX_LEN} chars`;
  for (const k of ['vacant', 'occupied', 'laptops']) {
    if (typeof p[k] !== 'number' || !Number.isFinite(p[k]) || p[k] < 0 || p[k] > 999) {
      return `${k} must be a number 0-999`;
    }
  }
  return null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};

function createServer() {
  const cafes = loadCafes();
  /** branch -> { branch, vacant, occupied, laptops, at } — latest only, in memory */
  const readings = new Map();
  const sseClients = new Set();

  // Drop readings older than 10min (a dead sensor must not linger forever).
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [b, r] of readings) if (now - r.at > DROP_AFTER_MS) readings.delete(b);
  }, 30 * 1000);
  sweeper.unref();

  const broadcast = (entry) => {
    const line = `data: ${JSON.stringify(entry)}\n\n`;
    for (const res of sseClients) res.write(line);
  };

  const liveFor = (branch, now) => {
    const r = readings.get(branch);
    if (!r) return null;
    const ageMs = now - r.at;
    if (ageMs > DROP_AFTER_MS) return null;
    const t = deriveTelemetry(r.vacant, r.occupied, r.laptops);
    return {
      vacant: r.vacant,
      occupied: r.occupied,
      laptops: r.laptops,
      occupancyPct: t.occupancyPct,
      availability: t.availability,
      outletDemand: t.outletDemand,
      ageSeconds: Math.round(ageMs / 1000),
      stale: ageMs > STALE_AFTER_MS,
    };
  };

  return http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // --- ingest: sensor nodes POST {branch, vacant, occupied, laptops} ---
    if (req.method === 'POST' && url.pathname === '/sync') {
      let body = '';
      let tooBig = false;
      req.on('data', (c) => {
        body += c;
        if (body.length > MAX_SYNC_BYTES) {
          tooBig = true;
          req.destroy();
        }
      });
      req.on('end', () => {
        if (tooBig) return json(res, 413, { ok: false, error: 'payload too large' });
        let p;
        try {
          p = JSON.parse(body);
        } catch {
          return json(res, 400, { ok: false, error: 'invalid JSON' });
        }
        const err = validateSync(p);
        if (err) return json(res, 400, { ok: false, error: err });
        const entry = {
          branch: p.branch,
          vacant: Math.trunc(p.vacant),
          occupied: Math.trunc(p.occupied),
          laptops: Math.trunc(p.laptops),
          at: Date.now(),
        };
        readings.set(entry.branch, entry);
        broadcast(entry);
        console.log(`[sync] ${entry.branch}: ${entry.vacant}v/${entry.occupied}o/${entry.laptops}l`);
        return json(res, 200, { ok: true });
      });
      req.on('error', () => {});
      return;
    }

    // --- legacy/status APIs (backward compatible) ---
    if (req.method === 'GET' && (url.pathname === '/api/availability' || url.pathname === '/api/status')) {
      const now = Date.now();
      return json(res, 200, {
        branches: [...readings.values()].filter((r) => now - r.at <= DROP_AFTER_MS),
        staleAfterMs: STALE_AFTER_MS,
        serverTime: now,
      });
    }

    // --- student API: registry joined with latest readings ---
    if (req.method === 'GET' && url.pathname === '/api/cafes') {
      const now = Date.now();
      return json(res, 200, {
        generatedAt: now,
        cafes: cafes.map((c) => {
          const { branch, ...rest } = c;
          void branch;
          return { ...rest, live: liveFor(c.branch, now) };
        }),
      });
    }

    // --- live push channel for viewers (SSE); polling is the fallback ---
    if (req.method === 'GET' && (url.pathname === '/api/stream' || url.pathname === '/api/events')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('retry: 3000\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    // --- static student web app files ---
    if (req.method === 'GET') {
      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname);
      const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
      if (!filePath.startsWith(PUBLIC_DIR)) {
        res.writeHead(403);
        return res.end();
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          return res.end('not found');
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
        res.end(data);
      });
      return;
    }

    res.writeHead(405);
    res.end();
  });
}

module.exports = { createServer, deriveTelemetry, validateSync, STALE_AFTER_MS, DROP_AFTER_MS, MAX_SYNC_BYTES };

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Tambay-AI server listening on http://0.0.0.0:${PORT}`);
    console.log(`  student app: http://localhost:${PORT}`);
    console.log(`  cafes API:   http://localhost:${PORT}/api/cafes`);
    console.log(`  ingest:      POST http://<this-pc-ip>:${PORT}/sync`);
    console.log(`  simulator:   npm run simulate`);
  });
}
