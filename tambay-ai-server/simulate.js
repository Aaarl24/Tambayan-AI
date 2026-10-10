// simulate.js — posts believable, slowly drifting counts for every cafe
// flagged "demo" in cafes.json to the real POST /sync endpoint, so the map
// comes alive without a physical Cafe Console. Validation applies here too.
'use strict';
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const SYNC_URL = process.env.SIMULATE_URL || `http://localhost:${PORT}/sync`;
const INTERVAL_MS = 30 * 1000; // same cadence as the real phone app

const cafes = JSON.parse(fs.readFileSync(path.join(__dirname, 'cafes.json'), 'utf8'));
const demoCafes = cafes.filter((c) => c.demo && typeof c.branch === 'string');

if (!demoCafes.length) {
  console.log('No demo cafes in cafes.json — nothing to simulate.');
  process.exit(0);
}

// Per-cafe random-walk state. capacity is a fiction for simulation only.
const state = new Map(
  demoCafes.map((c) => [
    c.branch,
    {
      capacity: 8 + Math.floor(Math.random() * 12), // 8-19 seats
      vacancyBias: Math.random(), // 0 = usually full, 1 = usually empty
    },
  ])
);

function drift(s) {
  const total = s.capacity;
  // occupied is pulled toward (1 - vacancyBias) * capacity, plus noise
  const target = Math.round((1 - s.vacancyBias) * total);
  let occupied = target + Math.round((Math.random() - 0.5) * 6);
  occupied = Math.max(0, Math.min(total, occupied));
  const vacant = total - occupied;
  // laptops loosely track occupied seats
  const laptops = Math.max(0, Math.min(999, Math.round(occupied * (0.2 + Math.random() * 0.5))));
  return { vacant, occupied, laptops };
}

async function post(branch, counts) {
  try {
    const res = await fetch(SYNC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch, ...counts }),
    });
    const d = await res.json();
    if (!d.ok) console.log(`[sim] ${branch}: rejected (${d.error || res.status})`);
  } catch {
    console.log(`[sim] ${branch}: server unreachable — is npm start running?`);
  }
}

async function tick() {
  for (const c of demoCafes) {
    const s = state.get(c.branch);
    // Occasional drama: a rush empties seats, or a seat just opened.
    if (Math.random() < 0.08) s.vacancyBias = Math.min(1, s.vacancyBias + 0.4);
    else if (Math.random() < 0.08) s.vacancyBias = Math.max(0, s.vacancyBias - 0.4);
    else s.vacancyBias += (Math.random() - 0.5) * 0.15;
    s.vacancyBias = Math.max(0.05, Math.min(0.95, s.vacancyBias));
    await post(c.branch, drift(s));
  }
}

console.log(`Simulating ${demoCafes.length} demo cafes -> ${SYNC_URL} every ${INTERVAL_MS / 1000}s`);
console.log('Demo branches:', demoCafes.map((c) => c.branch).join(', '));
tick();
setInterval(tick, INTERVAL_MS);
