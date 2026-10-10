/* Tambay-AI student web app — vanilla JS + vendored Leaflet.
 * Polls /api/cafes every 10s; SSE /api/stream upgrades it to instant push.
 * Location is used only in this browser, never sent to the server. */
'use strict';
(() => {
window.LANG = localStorage.getItem('tambay-lang') || 'en';

const CENTER = [14.582, 120.9845]; // Ermita / San Marcelino, Manila
const ZOOM = 16;
const WALK_KMH = 4.5;              // straight-line walking estimate
const POLL_MS = 10000;
const RING_SEGS = 12;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const STATUS_COLOR = {
  available: 'var(--free)', filling: 'var(--filling)', full: 'var(--full)',
  none: 'var(--offline)', offline: 'var(--offline)', notlive: 'var(--offline)',
};
const STATUS_ICON = { available: '\u2713', filling: '\u25D0', full: '\u2715', offline: '\u23F1', notlive: '\u00B7', none: '\u2715' };

const state = {
  cafes: [], userLoc: null, filters: { seats2: false, seats4: false, outlets: false, nearest: false },
  selected: null, snap: 'peek', detailTab: 'info', prevVacant: {}, connDown: false, generatedAt: null,
};
const el = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---------- data ----------
function statusOf(c) {
  const l = c.live;
  if (!l) return 'notlive';
  if (l.stale) return 'offline';
  return l.availability === 'none' ? 'full' : l.availability; // 0 vacant => full
}
function statusLabel(s) {
  return { available: t('statusAvailable'), filling: t('statusFilling'), full: t('statusFull'),
    offline: t('statusOffline'), notlive: t('statusNotLive'), none: t('statusFull') }[s] || s;
}
function distM(c) {
  if (!state.userLoc) return null;
  const [a, b] = [state.userLoc, c];
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function walkMin(c) { const d = distM(c); return d == null ? null : Math.max(1, Math.round((d / 1000 / WALK_KMH) * 60)); }

/* Ranking rule (documented): hard filters first (2+/4+ seats, outlets
 * likely free), then sort — live with free seats before anything else,
 * then most free seats, then nearest (when location is known). */
function passesFilters(c) {
  const l = c.live, f = state.filters;
  if (f.seats2 && !(l && !l.stale && l.vacant >= 2)) return false;
  if (f.seats4 && !(l && !l.stale && l.vacant >= 4)) return false;
  if (f.outlets && !(l && !l.stale && (l.outletDemand === 'low' || l.outletDemand === 'medium'))) return false;
  return true;
}
function ranked() {
  const list = state.cafes.filter(passesFilters);
  const key = (c) => {
    const l = c.live;
    const viable = l && !l.stale && l.vacant > 0 ? 1 : 0;
    const d = distM(c);
    return { viable, vacant: l ? l.vacant : 0, dist: d == null ? Infinity : d };
  };
  return list.sort((a, b) => {
    const ka = key(a), kb = key(b);
    if (state.filters.nearest && state.userLoc) {
      if (kb.viable !== ka.viable) return kb.viable - ka.viable;
      return ka.dist - kb.dist;
    }
    if (kb.viable !== ka.viable) return kb.viable - ka.viable;
    if (kb.vacant !== ka.vacant) return kb.vacant - ka.vacant;
    return ka.dist - kb.dist;
  });
}
function bestPick() { return ranked()[0] || null; }
function whyPick(c) {
  const l = c.live;
  if (!l) return '';
  const outlets = l.outletDemand !== 'high';
  if (state.userLoc && walkMin(c)) {
    return `${t('pickBecauseClosest')}: ${l.vacant} ${t('seatsFree')}, ~${walkMin(c)} ${t('walkEst')}`;
  }
  return outlets ? t('pickBecauseSeatsOutlets') : t('pickBecauseSeats');
}

// ---------- seat-dot SVG ----------
function polar(cx, cy, r, deg) { const a = (deg - 90) * Math.PI / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; }
function arcSeg(cx, cy, r, a0, a1) {
  const [x0, y0] = polar(cx, cy, r, a0), [x1, y1] = polar(cx, cy, r, a1);
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
// Ring of up to 12 segments: filled = taken seat, open = free seat.
function seatDotRing(total, filled, size, color) {
  const segs = Math.min(RING_SEGS, Math.max(total, 1));
  const cx = size / 2, r = size / 2 - 4, gapDeg = 360 / segs * 0.22;
  let paths = '';
  for (let i = 0; i < segs; i++) {
    const a0 = i * (360 / segs) + gapDeg / 2, a1 = (i + 1) * (360 / segs) - gapDeg / 2;
    const on = i < Math.round((filled / Math.max(total, 1)) * segs);
    paths += `<path d="${arcSeg(cx, cy, r, a0, a1)}" fill="none" stroke="${on ? color : 'currentColor'}" stroke-opacity="${on ? 1 : 0.3}" stroke-width="3.5" stroke-linecap="round"/>`;
  }
  return paths;
}
function pinSvg(c) {
  const s = statusOf(c), l = c.live, size = 46;
  const color = STATUS_COLOR[s];
  const total = l ? l.vacant + l.occupied : 0;
  const taken = l ? l.occupied : 0;
  const center = l && !l.stale ? `<text x="23" y="29" text-anchor="middle" font-size="16" font-weight="800" fill="${color}" class="pin-num" font-family="Bricolage Grotesque,Inter,sans-serif">${l.vacant}</text>`
    : `<text x="23" y="29" text-anchor="middle" font-size="17" fill="${color}">${STATUS_ICON[s] || '·'}</text>`;
  return `<div class="seatdot-wrap" style="color:#999">
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="23" cy="23" r="20.5" fill="var(--card)" stroke="${color}" stroke-width="2"/>
      ${seatDotRing(total, taken, size, color)}
      ${center}
    </svg></div>`;
}
function dotBar(c, width) {
  const l = c.live, s = statusOf(c);
  const color = STATUS_COLOR[s];
  const total = l ? l.vacant + l.occupied : 0;
  const segs = Math.min(RING_SEGS, Math.max(total, 1));
  const filled = l ? Math.round((l.occupied / Math.max(total, 1)) * segs) : 0;
  let dots = '';
  for (let i = 0; i < segs; i++) {
    dots += `<circle cx="${5 + i * 10}" cy="5" r="3.4" fill="${i < filled ? color : 'none'}" stroke="${color}" stroke-width="1.5" ${i < filled ? '' : 'opacity="0.5"'}/>`;
  }
  const w = width || segs * 10;
  return `<svg class="dotbar" width="${w}" height="10" viewBox="0 0 ${segs * 10} 10" role="img" aria-label="${l ? `${l.vacant} ${t('free')}, ${l.occupied} ${t('taken')}` : t('statusNotLive')}">${dots}</svg>`;
}

// ---------- map ----------
let map, markers = new Map(), userMarker = null;
function initMap(cfg) {
  map = L.map('map', { zoomControl: false, attributionControl: true }).setView(CENTER, ZOOM);
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.tileLayer(cfg.tileUrl, { maxZoom: 19, attribution: cfg.attribution }).addTo(map);
}
function renderPins() {
  for (const c of state.cafes) {
    const s = statusOf(c);
    const html = pinSvg(c);
    let m = markers.get(c.id);
    const icon = L.divIcon({ className: `seatdot${pulseSet.has(c.id) ? ' pulse' : ''}`, html, iconSize: [46, 46], iconAnchor: [23, 23] });
    if (!m) {
      m = L.marker([c.lat, c.lng], { icon, keyboard: true, title: c.name }).addTo(map);
      m.on('click keypress', (e) => { if (!e.originalEvent || e.originalEvent.key === 'Enter' || e.originalEvent.key === ' ' || e.type === 'click') selectCafe(c.id); });
      markers.set(c.id, m);
    } else m.setIcon(icon);
    const acc = m.getElement()?.querySelector('.seatdot-wrap');
    if (acc) acc.setAttribute('aria-label', `${c.name}: ${statusLabel(s)}${c.live && !c.live.stale ? `, ${c.live.vacant} ${t('seatsFree')}` : ''}`);
    void s;
  }
}
const pulseSet = new Set();

// ---------- bottom sheet ----------
// Snap heights. "peek" hugs the card's measured height so the minimum is
// truly minimum; half and full are viewport fractions.
let peekPx = 170;
const SNAPS = { peek: () => peekPx, half: () => innerHeight * 0.55, full: () => innerHeight * 0.92 };
const snapPx = (k) => (typeof SNAPS[k] === 'function' ? SNAPS[k]() : SNAPS[k]);
function measurePeek() {
  const grab = el('grab').offsetHeight || 26;
  peekPx = Math.min(innerHeight * 0.45, Math.max(120, el('sheetBody').scrollHeight + grab));
  if (state.snap === 'peek') setSnap('peek');
}
function setSnap(k) {
  state.snap = k;
  const px = Math.min(snapPx(k), innerHeight - 60);
  document.documentElement.style.setProperty('--sheet-h', px + 'px');
  el('sheet').style.height = px + 'px';
  renderSheet();
}
function initDrag() {
  const grab = el('grab'); let startY = 0, startH = 0, dragging = false;
  const move = (y) => {
    const h = Math.max(snapPx('peek'), Math.min(innerHeight - 40, startH + (startY - y)));
    el('sheet').style.height = h + 'px';
    document.documentElement.style.setProperty('--sheet-h', h + 'px');
    return h;
  };
  const end = (y) => {
    dragging = false;
    const h = move(y);
    const order = ['peek', 'half', 'full'];
    const best = order.reduce((b, k) => Math.abs(snapPx(k) - h) < Math.abs(snapPx(b) - h) ? k : b, 'peek');
    setSnap(best);
  };
  grab.addEventListener('pointerdown', (e) => { dragging = true; startY = e.clientY; startH = el('sheet').offsetHeight; grab.setPointerCapture(e.pointerId); });
  grab.addEventListener('pointermove', (e) => { if (dragging) move(e.clientY); });
  grab.addEventListener('pointerup', (e) => { if (dragging) end(e.clientY); });
  grab.addEventListener('keydown', (e) => {
    const order = ['peek', 'half', 'full'], i = order.indexOf(state.snap);
    if (e.key === 'ArrowUp') setSnap(order[Math.min(2, i + 1)]);
    if (e.key === 'ArrowDown') setSnap(order[Math.max(0, i - 1)]);
  });
}

// ---------- sheet content ----------
function cafeSubline(c) {
  const l = c.live, s = statusOf(c);
  const bits = [statusLabel(s)];
  if (l && !l.stale) {
    bits.push(`${l.vacant} ${l.vacant === 1 ? t('seatFree') : t('seatsFree')}`);
    if (l.outletDemand === 'low' || l.outletDemand === 'medium') bits.push('⚡ ' + (l.outletDemand === 'low' ? t('outletsLow').split(' ')[0] : t('outletsMedium')));
  }
  const w = walkMin(c); if (w != null) bits.push(`~${w} ${t('walkEst')}`);
  if (l) bits.push(agoText(l.ageSeconds));
  return bits.join(' · ');
}
function agoText(sec) {
  if (sec == null || sec < 5) return t('updatedJustNow');
  if (sec < 60) return `${t('updatedAgo')} ${Math.round(sec)}s ago`;
  return `${t('updatedAgo')} ${Math.floor(sec / 60)}m ago`;
}
function pickCardHtml(c, showWhy) {
  if (!c) return `<div class="pickcard"><div class="why">${t('emptyBody')}</div></div>`;
  const l = c.live, s = statusOf(c);
  return `<div class="pickcard" role="button" tabindex="0" data-open="${esc(c.id)}" aria-label="${esc(c.name)}">
    <div class="pickrow">
      <div class="bigfree num" style="color:${STATUS_COLOR[s]}">${l && !l.stale ? l.vacant : '—'}</div>
      <div class="row-main">
        <div class="row-name">${esc(c.name)}${c.demo ? ` <span class="demo-tag">${t('demoCafe')}</span>` : ''}</div>
        <div class="statusword s-${s}">${STATUS_ICON[s] || ''} ${statusLabel(s)}</div>
        <div class="row-sub">${esc(cafeSubline(c))}</div>
        ${showWhy ? `<div class="why">${esc(whyPick(c))}</div>` : ''}
      </div>
      ${dotBar(c)}
    </div>
  </div>`;
}
function rowHtml(c) {
  const l = c.live, s = statusOf(c);
  return `<button class="row" data-open="${esc(c.id)}">
    <div class="row-free num" style="color:${STATUS_COLOR[s]}">${l && !l.stale ? l.vacant : '—'}</div>
    <div class="row-main">
      <div class="row-name">${esc(c.name)}${c.demo ? ` <span class="demo-tag">${t('demoCafe')}</span>` : ''}</div>
      <div class="row-sub">${esc(cafeSubline(c))}</div>
    </div>
    ${dotBar(c)}
  </button>`;
}

// ---------- floor plan ----------
function floorplanSvg(c) {
  const fp = c.floorplan;
  if (!fp) return `<p class="honest">${t('honestyNote')}</p>`;
  const l = c.live, s = statusOf(c), color = STATUS_COLOR[s];
  // Text halo so labels stay readable over shapes; textLength keeps the
  // "not monitored" note inside narrow zones instead of overflowing.
  const halo = 'paint-order="stroke" stroke="var(--card-2)" stroke-width="3" stroke-linejoin="round"';
  const fit = (w) => `textLength="${Math.max(10, w - 8)}" lengthAdjust="spacingAndGlyphs"`;
  const zoneRects = (fp.zones || []).map((z) => {
    const live = z.monitored && l && !l.stale;
    const sub = z.monitored
      ? (live ? `${l.vacant} ${t('free')} · ${l.occupied} ${t('taken')}` : t('zoneMonitored'))
      : t('zoneNotMonitored');
    const fill = z.monitored ? color : '#888';
    const dash = z.monitored ? '' : 'stroke-dasharray="4 4" opacity="0.6"';
    return `<rect x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" rx="6" fill="${z.monitored ? fill : '#888'}" fill-opacity="${z.monitored ? 0.12 : 0.05}" stroke="${fill}" stroke-width="1.5" ${dash}/>
      <text x="${z.x + 4}" y="${z.y + 10}" font-size="6" font-weight="700" fill="var(--ink)" ${halo} ${fit(z.w)}>${esc(z.label)}</text>
      <text x="${z.x + 4}" y="${z.y + z.h - 4}" font-size="5.5" fill="var(--muted)" ${halo} ${fit(z.w)}>${esc(sub)}</text>`;
  }).join('');
  const KIND_STYLE = {
    table: 'fill="var(--card-2)" stroke="var(--muted)" rx="3"',
    seat: 'fill="var(--muted)" rx="1.5" opacity="0.8"',
    counter: 'fill="var(--filling)" rx="3" opacity="0.85"',
    wall: 'fill="var(--ink)" rx="1" opacity="0.7"',
  };
  const shapes = (fp.shapes || []).map((sh) =>
    `<rect x="${sh.x}" y="${sh.y}" width="${sh.w}" height="${sh.h}" ${KIND_STYLE[sh.kind] || KIND_STYLE.table}/>`
  ).join('');
  const outlets = (fp.outlets || []).map((o) =>
    `<circle cx="${o.x}" cy="${o.y}" r="2.6" fill="var(--laptop)" stroke="#fff" stroke-width="1"/><text x="${o.x - 1.7}" y="${o.y + 2}" font-size="4" fill="#fff">⚡</text>`
  ).join('');
  // Phase B: coarse 4x4 seat grid from the sensor (2 bits/cell: 0 none,
  // 1 free chair, 2 taken). Shaded over monitored zones only.
  let gridCells = '';
  if (l && !l.stale && typeof l.grid === 'string' && /^[0-9a-f]{8}$/i.test(l.grid)) {
    const bits = BigInt('0x' + l.grid);
    const cells = [];
    for (let i = 0; i < 16; i++) cells.push(Number((bits >> BigInt(2 * (15 - i))) & 3n));
    for (const z of fp.zones || []) {
      if (!z.monitored) continue;
      for (let cy = 0; cy < 4; cy++) for (let cx = 0; cx < 4; cx++) {
        const st = cells[cy * 4 + cx];
        if (!st) continue;
        gridCells += `<rect x="${z.x + (cx * z.w) / 4}" y="${z.y + (cy * z.h) / 4}" width="${z.w / 4}" height="${z.h / 4}" fill="${st === 1 ? 'var(--free)' : 'var(--full)'}" fill-opacity="0.16"/>`;
      }
    }
  }
  const e = fp.entrance;
  const entrance = e ? `<circle cx="${e.x}" cy="${e.y}" r="3.4" fill="var(--free)" stroke="#fff" stroke-width="1.4"/><text x="${e.x + 5}" y="${e.y + 2}" font-size="6" font-weight="700" fill="var(--free)">IN</text>` : '';
  return `<div>
    <svg viewBox="${fp.viewBox}" style="width:100%;border-radius:12px;background:var(--card-2)" role="img" aria-label="floor plan">
      ${zoneRects}${gridCells}${shapes}${outlets}${entrance}
    </svg>
    ${fp.label ? `<p class="honest">${esc(fp.label)} · ${t('honestyNote')}</p>` : `<p class="honest">${t('honestyNote')}</p>`}
  </div>`;
}

// ---------- detail ----------
let displayedNum = null, displayedFor = null;
function countUp(target) {
  const node = el('bigFree'); if (!node) return;
  if (reducedMotion || displayedFor !== target.id) { node.textContent = target.v; displayedFor = target.id; displayedNum = target.v; return; }
  const from = displayedNum ?? target.v; displayedNum = target.v;
  const t0 = performance.now(), dur = 450;
  const step = (now) => {
    const k = Math.min(1, (now - t0) / dur), ease = 1 - (1 - k) ** 3;
    node.textContent = Math.round(from + (target.v - from) * ease);
    if (k < 1 && el('bigFree')) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function bolts(d) {
  const n = { low: 1, medium: 2, high: 3 }[d] || 0;
  return `<span class="bolts" aria-label="${t('outletsTitle')}: ${d}">` +
    [1, 2, 3].map((i) => `<span class="${i <= n ? '' : 'bolt-off'}">⚡</span>`).join('') + '</span>';
}
function detailHtml(c) {
  const l = c.live, s = statusOf(c);
  const info = `
    <div class="kv"><b>${t('outletsTitle')}</b><span>${bolts(l ? l.outletDemand : 'low')} <span class="row-sub">${l ? t('outlets' + l.outletDemand[0].toUpperCase() + l.outletDemand.slice(1)) : ''}</span></span></div>
    <p class="honest" style="margin-top:2px">${t('outletsNote')}</p>
    <div class="kv"><b>Area</b><span>${esc(c.areaLabel || '—')} <span class="honest">· ${t('zoneMonitored')}</span></span></div>
    ${l && l.tables !== undefined ? `<div class="kv"><b>Tables</b><span>${l.tables} in view <span class="honest">(experimental)</span></span></div>` : ''}
    <div class="kv"><b>${t('address')}</b><span>${esc(c.address)}</span></div>
    <div class="kv"><b>${t('hours')}</b><span>${esc(c.hours || '—')}</span></div>`;
  const body = state.detailTab === 'floorplan' ? floorplanSvg(c) : info;
  return `
    <div class="pickrow">
      <div><div class="bigfree num" id="bigFree" style="color:${STATUS_COLOR[s]}">${l && !l.stale ? l.vacant : '—'}</div>
      <div class="row-sub">${l && !l.stale ? t('seatsFree') : ''}</div></div>
      <div class="row-main">
        <div class="row-name" style="font-size:1.15rem">${esc(c.name)}${c.demo ? ` <span class="demo-tag">${t('demoCafe')}</span>` : ''}</div>
        <div class="statusword s-${s}">${STATUS_ICON[s] || ''} ${statusLabel(s)}</div>
        <div class="row-sub" id="ageLine">${l ? agoText(l.ageSeconds) : t(s === 'notlive' ? 'notLiveYetHint' : 'offlineHint')}</div>
      </div>
    </div>
    <div style="margin:10px 0">${dotBar(c, 200)}</div>
    <div class="tabs">
      <button class="tab ${state.detailTab === 'info' ? 'on' : ''}" data-tab="info">${t('tabInfo')}</button>
      <button class="tab ${state.detailTab === 'floorplan' ? 'on' : ''}" data-tab="floorplan">${t('tabFloorplan')}</button>
    </div>
    <div id="detailBody">${body}</div>
    <button class="btn-main" data-dir="${esc(c.id)}">${t('takeMeThere')}</button>
    <button class="btn-ghost" data-share="${esc(c.id)}">${t('share')}</button>`;
}

// ---------- render ----------
function renderSheet() {
  const body = el('sheetBody');
  const sel = state.cafes.find((c) => c.id === state.selected);
  if (state.snap === 'full' && sel) {
    body.innerHTML = detailHtml(sel);
    countUp({ id: sel.id, v: sel.live && !sel.live.stale ? sel.live.vacant : 0 });
    return;
  }
  if (state.snap === 'peek') {
    const c = sel || bestPick();
    body.innerHTML = `<div class="sect">${sel ? esc(sel.name) : t('bestPick')}</div>` + pickCardHtml(c, !sel);
    requestAnimationFrame(measurePeek);
    return;
  }
  const list = ranked();
  body.innerHTML = `<div class="sect">${t('allCafes')} · ${list.length}</div>` + list.map(rowHtml).join('');
}
function renderAll() {
  renderPins(); renderSheet();
  el('demoBadge').classList.toggle('show', state.cafes.some((c) => c.demo));
  el('empty').classList.toggle('show', state.cafes.length === 0);
}
function refreshAgeLines() {
  // tick "updated Ns ago" without a full re-render
  const sel = state.cafes.find((c) => c.id === state.selected);
  const node = el('ageLine');
  if (node && sel && sel.live) node.textContent = agoText(sel.live.ageSeconds + (Date.now() - state.generatedAt) / 1000);
}

// ---------- actions ----------
function selectCafe(id, fly) {
  state.selected = id;
  const c = state.cafes.find((x) => x.id === id);
  if (c && fly) map[reducedMotion ? 'setView' : 'flyTo']([c.lat, c.lng], 17, { duration: reducedMotion ? 0 : 1.1 });
  history.replaceState(null, '', `#/cafe/${id}`);
  setSnap('full');
}
function toast(msg) {
  const n = el('toast'); n.textContent = msg; n.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => n.classList.remove('show'), 3500);
}

async function poll() {
  try {
    const r = await fetch('/api/cafes');
    if (!r.ok) throw new Error();
    const d = await r.json();
    // seat-opened detection: browser-side memory only
    for (const c of d.cafes) {
      const prev = state.prevVacant[c.id];
      if (c.live && !c.live.stale && prev === 0 && c.live.vacant > 0) {
        pulseSet.add(c.id); setTimeout(() => { pulseSet.delete(c.id); renderPins(); }, 3000);
        toast(`${t('seatsOpened')} ${c.name}`);
      }
      state.prevVacant[c.id] = c.live && !c.live.stale ? c.live.vacant : prev;
    }
    state.generatedAt = d.generatedAt;
    state.cafes = d.cafes;
    state.connDown = false;
    pollFails = 0;
    el('connBanner').classList.remove('show');
    renderAll();
  } catch (err) {
    console.error('[tambay] poll failed:', err && (err.stack || err.message || err));
    // Banner only after 2 consecutive failures — one dropped request on
    // flaky Wi-Fi shouldn't flash a scary strip at the student.
    if (++pollFails >= 2) {
      state.connDown = true;
      el('connBanner').classList.add('show');
    }
  }
}
let pollFails = 0;

// ---------- init ----------
async function boot() {
  let cfg = { tileUrl: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' };
  try { const r = await fetch('/api/config'); if (r.ok) cfg = { ...cfg, ...(await r.json()) }; } catch { /* offline: use defaults */ }
  initMap(cfg);

  el('findBtn').textContent = t('findSeat');
  el('findBtn').onclick = () => { const c = bestPick(); if (c) selectCafe(c.id, true); else toast(t('emptyBody')); };
  el('locBtn').textContent = '📍 ' + t('useMyLocation');
  el('locBtn').onclick = () => {
    navigator.geolocation?.getCurrentPosition(
      (p) => {
        state.userLoc = { lat: p.coords.latitude, lng: p.coords.longitude };
        if (!userMarker) { userMarker = L.marker([p.coords.latitude, p.coords.longitude], { icon: L.divIcon({ className: '', html: '<div class="loc-marker"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }), interactive: false }).addTo(map); }
        else userMarker.setLatLng([p.coords.latitude, p.coords.longitude]);
        renderAll();
      },
      () => toast('Location unavailable'),
      { timeout: 8000 }
    );
  };
  el('langBtn').textContent = t('langToggle');
  el('langBtn').onclick = () => { window.LANG = window.LANG === 'en' ? 'fil' : 'en'; localStorage.setItem('tambay-lang', window.LANG); location.reload(); };

  const chipDefs = [['seats2', 'filterSeats2'], ['seats4', 'filterSeats4'], ['outlets', 'filterOutlets'], ['nearest', 'filterNearest']];
  el('chips').innerHTML = chipDefs.map(([k, label]) => `<button class="chip" data-f="${k}" aria-pressed="false">${t(label)}</button>`).join('');
  el('chips').onclick = (e) => {
    const b = e.target.closest('[data-f]'); if (!b) return;
    const k = b.dataset.f; state.filters[k] = !state.filters[k];
    b.classList.toggle('on', state.filters[k]); b.setAttribute('aria-pressed', state.filters[k]);
    if (k === 'nearest' && state.filters.nearest && !state.userLoc) el('locBtn').click();
    renderAll();
  };

  el('sheetBody').addEventListener('click', (e) => {
    const cardEl = e.target.closest('[data-open]'); if (cardEl) return selectCafe(cardEl.dataset.open);
    const dir = e.target.closest('[data-dir]');
    if (dir) { const c = state.cafes.find((x) => x.id === dir.dataset.dir); if (c) window.open(`https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lng}&travelmode=walking`, '_blank'); return; }
    const share = e.target.closest('[data-share]');
    if (share) { const u = `${location.origin}/#/cafe/${share.dataset.share}`; navigator.clipboard?.writeText(u).then(() => toast(t('copied'))); return; }
    const tab = e.target.closest('[data-tab]');
    if (tab) { state.detailTab = tab.dataset.tab; renderSheet(); }
  });
  el('sheetBody').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const open = e.target.closest('[data-open]'); if (open) selectCafe(open.dataset.open);
  });
  el('brandName').textContent = t('appName');
  el('tagline').textContent = t('tagline');
  el('emptyTitle').textContent = t('emptyTitle');
  el('emptyBody').textContent = t('emptyBody');
  el('connBanner').textContent = t('connBanner');
  el('demoBadge').textContent = t('demoBadge');

  initDrag(); setSnap('peek');
  await poll();

  // deep link #/cafe/<id>
  const m = location.hash.match(/#\/cafe\/([\w-]+)/);
  if (m && state.cafes.some((c) => c.id === m[1])) selectCafe(m[1]);

  setInterval(poll, POLL_MS);
  // SSE upgrade: instant updates when a sensor reports
  if (window.EventSource) {
    const es = new EventSource('/api/stream');
    es.onmessage = () => poll();
    es.onerror = () => es.close(); // fall back to polling only
  }
  setInterval(refreshAgeLines, 1000);
}
document.addEventListener('DOMContentLoaded', boot);
})();
