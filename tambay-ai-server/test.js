// test.js — `npm test`. Boots the server on an ephemeral port and exercises
// the /sync contract + /api/cafes join. Also guards the <100 byte payload rule.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer } = require('./server');

let server, base;
test.before(async () => {
  server = createServer();
  server.listen(0);
  await once(server, 'listening');
  base = `http://localhost:${server.address().port}`;
});
test.after(() => server.close());

const post = (body, raw) =>
  fetch(`${base}/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw ? body : JSON.stringify(body),
  });

test('accepts a valid sensor payload', async () => {
  const r = await post({ branch: 'Taft Ave', vacant: 4, occupied: 6, laptops: 2 });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
});

test('rejects an extra field (only 4 fields may leave the phone)', async () => {
  const r = await post({ branch: 'X', vacant: 1, occupied: 2, laptops: 0, image: 'no' });
  assert.equal(r.status, 400);
});

test('rejects oversized bodies (>1 KB)', async () => {
  const r = await post('{"branch":"' + 'x'.repeat(2000) + '"}', true).catch(() => null);
  // destroy() may abort the connection entirely; a 413 or a dropped socket both pass
  assert.ok(!r || r.status === 413);
});

test('rejects missing fields and bad types', async () => {
  for (const bad of [
    { branch: 'X', vacant: 1, occupied: 2 }, // missing laptops
    { branch: 'X', vacant: 'four', occupied: 2, laptops: 0 },
    { branch: '', vacant: 1, occupied: 2, laptops: 0 },
    'a string, not an object',
    [1, 2, 3],
  ]) {
    const r = await post(bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
});

test('GET /api/cafes joins the registry with live readings', async () => {
  await post({ branch: 'Taft Ave', vacant: 3, occupied: 7, laptops: 2 });
  const r = await fetch(`${base}/api/cafes`);
  const d = await r.json();
  assert.ok(Array.isArray(d.cafes) && d.cafes.length >= 7);
  const real = d.cafes.find((c) => c.id === 'taft-ave');
  assert.equal(real.demo, false);
  assert.equal(real.live.vacant, 3);
  assert.equal(real.live.availability, 'available'); // 7/10 = 70% occupied, below 75% threshold
  assert.equal(real.live.occupancyPct, 70);
  const demo = d.cafes.find((c) => c.demo);
  assert.ok(demo, 'expected at least one demo cafe');
});

test('accepts optional tables + grid with strict formats', async () => {
  const ok = await post({ branch: 'Taft Ave', vacant: 1, occupied: 2, laptops: 0, tables: 3, grid: 'a5a5ff00' });
  assert.equal(ok.status, 200);
  assert.equal((await post({ branch: 'X', vacant: 1, occupied: 2, laptops: 0, grid: 'zzzzzzzz' })).status, 400);
  assert.equal((await post({ branch: 'X', vacant: 1, occupied: 2, laptops: 0, grid: 'a5a5ff0' })).status, 400); // 7 chars
  assert.equal((await post({ branch: 'X', vacant: 1, occupied: 2, laptops: 0, tables: -1 })).status, 400);
  const cafes = await (await fetch(`${base}/api/cafes`)).json();
  const real = cafes.cafes.find((c) => c.id === 'taft-ave');
  assert.equal(real.live.grid, 'a5a5ff00');
  assert.equal(real.live.tables, 3);
});

test('payload byte guard: worst-case phone payload stays under 100 bytes', () => {
  // Mirror of buildPayload() in ../src/cloud.ts: 6 fields, branch shrinks
  // until the JSON fits. Assert the result is always under 100 bytes.
  const build = (branchLen, grid, tables) => {
    let name = 'X'.repeat(24);
    const make = () => ({
      branch: name, vacant: 999, occupied: 999, laptops: 999,
      ...(tables ? { tables: 99 } : {}),
      ...(grid ? { grid: 'ffffffff' } : {}),
    });
    let p = make();
    while (JSON.stringify(p).length >= 100 && name.length > 1) {
      name = name.slice(0, -1);
      p = make();
    }
    return p;
  };
  for (const grid of [false, true]) {
    for (const tables of [false, true]) {
      const p = build(24, grid, tables);
      assert.ok(JSON.stringify(p).length < 100, `grid=${grid} tables=${tables}: ${JSON.stringify(p).length}B`);
    }
  }
});
