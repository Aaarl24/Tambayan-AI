# tambay-ai-server

Zero-dependency Node server for Tambay-AI. It receives anonymized seat
counts from Cafe Console sensor phones and serves the student web app.

## Run (Windows / PowerShell)

```powershell
npm install    # no packages to download, but it creates package-lock.json
npm start      # server on http://localhost:3000
npm run simulate   # in a SECOND terminal: fake live data for demo cafes
npm test       # validation + <100 byte payload guard
```

Then open <http://localhost:3000> — the map shows demo cafes updating live.

## Endpoints

| Method | Path                | Purpose                                             |
|--------|---------------------|-----------------------------------------------------|
| POST   | `/sync`             | Sensor ingest — **only** `{branch, vacant, occupied, laptops}` (max 1 KB) |
| GET    | `/api/cafes`        | Cafe registry joined with live readings (`live` = null when silent) |
| GET    | `/api/availability` | Raw latest readings per branch (legacy, used by old viewers) |
| GET    | `/api/status`       | Alias of `/api/availability`                        |
| GET    | `/api/stream`       | SSE — pushes instantly on every `/sync`             |
| GET    | `/api/config`       | Map tile URL + attribution for the web app          |
| GET    | `/`                 | Student web app (`public/`)                         |

## Map tiles

The student map uses OpenStreetMap tiles. The tile URL is configurable —
set `TILE_URL` before `npm start` to swap providers (e.g. a self-hosted
tile server on venue Wi-Fi):

```powershell
$env:TILE_URL="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"; npm start
```

**Note:** the public OSM tile servers have a
[usage policy](https://operations.osmfoundation.org/policies/tiles/) —
fine for a demo, but heavy production traffic needs your own tile host.
Leaflet and fonts are vendored in `public/vendor` and `public/fonts`
(committed — no CDN needed at runtime, works on flaky Wi-Fi).

## Wiring the Cafe Console (phone app) to it

In `tambay-ai/.env` (gitignored — never commit):

```powershell
EXPO_PUBLIC_SYNC_URL=http://<this-pc-ip>:3000/sync
EXPO_PUBLIC_BRANCH_NAME=Taft Ave
```

`<this-pc-ip>` is your LAN IP (`ipconfig` → "IPv4 Address", e.g.
`192.168.100.69`). An Android emulator can instead use
`http://10.0.2.2:3000/sync`. The branch name must exactly match a
`branch` value in `cafes.json` — `Taft Ave` is the seeded real cafe.

## cafes.json registry

One entry per cafe. `branch` is the join key to `POST /sync`.

```json
{
  "id": "demo-adamson-1",
  "branch": "Demo Kape AdU",
  "name": "Kape AdU",
  "district": "San Marcelino",
  "address": "...",
  "lat": 14.5857, "lng": 120.9853,
  "areaLabel": "Main hall",
  "hours": "7:00-22:00",
  "demo": true,
  "floorplan": { "...": "optional, see below" }
}
```

### Floor plan schema (optional, per cafe)

Top-down schematic so students can see *where* inside a cafe the camera
sees. Shapes are simple rects in the `viewBox` coordinate space.

- `viewBox` — SVG viewBox string, e.g. `"0 0 120 80"`.
- `entrance` — `{x, y}` marker.
- `zones[]` — `{id, label, monitored, x, y, w, h}`. Only `monitored`
  zones may show live counts; others are labeled "not monitored".
- `shapes[]` — `{kind: "table"|"seat"|"counter"|"wall", zone, x, y, w, h}`.
- `outlets[]` — `{x, y}` markers shown only if listed (the AI does
  *not* detect outlets).
- `label` — e.g. `"demo layout"`, displayed on the plan for honesty.

## Privacy / rules that must hold

- Only `branch`, `vacant`, `occupied`, `laptops` are accepted. Anything
  else → `400`. Bodies over 1 KB → `413`.
- Payloads from the phone are under 100 bytes (test enforces).
- No images, no accounts, no history, no database. In-memory latest
  reading per cafe only.
- Readings go **stale** at 90 s and are dropped after 10 min.
- Demo cafes are marked `demo: true` and labeled in the UI — never
  presented as real venues.

## Known limitations

- **`/sync` is unauthenticated** — anyone who can reach the server can
  post counts. Acceptable for the MVP demo; add a shared-secret header
  before exposing publicly.
- State is in-memory; restarting clears counts until the next 30 s sync.
- The camera only sees one area of a cafe; counts describe that area.
