# Kaaryo — User (Customer) App: Live Tracking Integration Guide

The tracking screen becomes a real map. The assigned professional's position
streams in while they travel, the header flips to **Arriving soon** and then
**Arrived** on its own, and **Work started** is now a real event rather than
something implied by acceptance.

Base URL: `http://16.112.64.28:4000` (`PORT` in `.env`).
Everything here needs a **user** JWT — see **USER_AUTH_INTEGRATION_GUIDE.md**.
The booking flow itself is unchanged; this extends
**USER_SERVICE_BOOKING_INTEGRATION_GUIDE.md** (and the trial equivalent).

> The professional's side is in **WORKER_APP_JOB_FLOW_AND_TRACKING_GUIDE.md**.
> The one thing worth knowing from it: accepting a job no longer means work has
> begun — the worker now taps **Start job** on arrival, which is what produces
> `request:started` below.
>
> ### Renderer: OpenStreetMap via Leaflet-in-WebView, not Mapbox
> §5 below replaced an earlier native-Mapbox-SDK plan with **Leaflet running
> inside `react-native-webview`**, tiled from an OpenStreetMap provider. Nothing
> above §5 changed because of that swap — `stage`, the `worker` block, the
> socket events are all renderer-agnostic; only how you draw the dot moved.
> Two consequences worth knowing up front: it needs **no native module**, so it
> runs in Expo Go with no dev-client build, and it renders on **web** too (a
> WebView degrades to an iframe), so there's no `Platform.OS === 'web'` map
> gap to paper over with `MapBackdrop` — one component covers all three targets.

---

## 1. The flow, with the new states

```
  searching  ──▶  ACCEPTED
                     │   stage: 'en_route'      "Professional on the way"
                     │   ← request:location every ~5s: move the marker
                     ▼
                  stage: 'arriving_soon'        "Arriving in ~4 min"
                     │   ← request:arriving_soon
                     ▼
                  stage: 'arrived'              "Arrived"
                     │   ← request:arrived   (haptic here)
                     ▼   worker taps "Start job" in their app
                  stage: 'working'              "Work in progress"
                     │   ← request:started
                     ▼
                  stage: 'work_done'            payment.payable === true
                     │   ← request:work_done
                     ▼
                  stage: 'completed'
```

`status` is unchanged and still authoritative for payment, cancel and retry.
`en_route`, `arriving_soon`, `arrived` and `working` are **all** `status:
'in_progress'` underneath. Nothing you already built on `status` breaks.

---

## 2. Render from `stage`, not from `status`

Every customer payload — `GET /api/user/service-requests/:id`, `/active`, `/`,
and every `request:*` socket event — now carries a top-level:

```jsonc
"stage": "arriving_soon",   // searching | en_route | arriving_soon | arrived
                            // | working | work_done | completed | cancelled | expired
"workStage": "en_route"     // 'en_route' | 'working' | null — the raw sub-field
```

`stage` is composed server-side from `status` + `workStage` + the geofence, in
that precedence. Use it for the header, the badge and the timeline. It exists so
those three things can't disagree, and so the list card and the detail screen
can't disagree either — `stage` is on the **summary** view too (with
`etaMinutes`), at no extra query cost.

Suggested copy:

| `stage` | Header | Badge |
|---|---|---|
| `searching` | Finding a professional | Searching |
| `en_route` | Professional on the way | On the way |
| `arriving_soon` | Arriving in ~`etaMinutes` min | Arriving soon |
| `arrived` | Your professional has arrived | Arrived |
| `working` | Work in progress | In progress |
| `work_done` | Work complete — payment due | Payment due |
| `completed` | Completed | Completed |

Show the map for `en_route` / `arriving_soon` / `arrived`. Keep the existing
radar animation for `searching` — there's no real position to plot yet. From
`working` onward, drop the map: the professional is at the door and the screen
should be about the work and the payment.

---

## 3. The `worker` block is now live

Present once a professional is assigned, on every full `request` payload:

```jsonc
"worker": {
  "id": "...", "name": "Ravi", "phone": "9000000000",
  "rating": 4.7, "jobsCompleted": 12,

  "distanceKm": 2.4,                 // measured when the offer went out — FIXED, historical
  "location": { "type": "Point", "coordinates": [77.5946, 12.98] },  // [lng, lat]
  "locationUpdatedAt": "2026-08-01T11:22:56.343Z",
  "locationStale": false,            // true if that fix is over 60s old
  "heading": 184.2,                  // degrees 0-360 — rotate the marker
  "speedKmh": 24,
  "distanceMeters": 934,             // live, straight-line
  "liveDistanceKm": 0.93,            // same, in the unit your UI uses
  "etaMinutes": 4,
  "etaSource": "estimate",
  "arrivalStatus": "arriving_soon",
  "arrivalStatusChangedAt": "..."
}
```

Three things to note:

**`location` changed meaning, not shape.** It used to be the worker's generic
availability heartbeat — a position from whenever they last pinged for any
reason, possibly an hour old. It is now this job's own live stream. Same key,
same GeoJSON `[lng, lat]`, so existing code keeps working and just gets better
data. It falls back to the heartbeat until the first real ping lands, so your
marker always has somewhere to start.

**`distanceKm` and `liveDistanceKm` are different numbers on purpose.** The first
is frozen at offer time — that's what the assigned-professional card has always
shown. The second moves. Don't swap one for the other; show `distanceKm` on the
card and `liveDistanceKm` in the map header.

**Never re-derive arrival from the coordinates.** `arrivalStatus` is the server's
verdict, with hysteresis and an accuracy gate behind it. Computing your own
distance and deciding "close enough" means one bad GPS fix shows **Arrived** on
that one phone while the server, the worker's app and the timeline all say
otherwise.

`etaSource: "estimate"` means straight-line distance ÷ assumed speed — real
enough to show, not a promise. Word it as "~4 min". If it ever reads
`"directions"`, a routing provider answered and you can drop the tilde.

**The live fields disappear once the job stops being live.** `location`,
`heading`, `speedKmh`, `distanceMeters`, `liveDistanceKm`, `etaMinutes`,
`etaSource`, `arrivalStatus`, `arrivalStatusChangedAt` and `locationStale` are
only present while `status === 'in_progress'` (i.e. `stage` is one of
`en_route` / `arriving_soon` / `arrived` / `working`). On a `pending_rating` or
`completed` request, `worker` still carries `id`/`name`/`phone`/`rating`/
`jobsCompleted`/`distanceKm` — the customer may still need to call about a
finished job — but not a single coordinate. Don't code against "if `worker.location`
is missing, treat it as not-yet-pinged" for a finished job; on a finished job it
means exactly what it says: not shown, not tracked anymore. Gate your own map
rendering on `stage`, same as §2 already tells you to, and this is never
something your code needs to branch on directly.

---

## 4. Socket events

Your existing handler pattern is unchanged: **every event below except one**
carries the same full `request` object your REST calls return, so they all go
through your existing update path.

| Event | Payload | Do |
|---|---|---|
| `request:location` | `{ requestId, stage, worker }` | **The exception.** Fires on every ping. Merge `worker` into the worker block you hold and move the marker. Don't re-render the screen. |
| `request:arriving_soon` | `{ request }` | Normal update. Badge → Arriving soon. |
| `request:arrived` | `{ request }` | Normal update. Badge → Arrived. Fire a haptic here. |
| `request:en_route` | `{ request }` | Arrival **reversed** — they were at the door and drove off. Rare; announced so a stale "Arrived" can't sit on screen. Don't haptic. |
| `request:started` | `{ request }` | Normal update. Hide the map, show work-in-progress. |

The three arrival events are named after the state being *entered*, not the
direction of travel, so you can route them by name without checking what the
previous state was. Only fire a haptic on `request:arrived`.

`request:location` is deliberately lean: it fires every few seconds, and
re-serialising the whole request that often (each one costs a database read) is
waste when all that changed is a pair of coordinates. Its `worker` object has
exactly the tracking keys listed in §3 plus `id` — spread it over what you have:

```js
socket.on('request:location', ({ requestId, worker }) => {
  if (requestId !== currentRequest.id) return;
  setRequest((r) => ({ ...r, worker: { ...r.worker, ...worker } }));
});
```

Everything already documented (`request:searching`, `:accepted`, `:expired`,
`:work_done`, `:completed`, `:paid`, `:cancelled`) is unchanged.

### Polling fallback

The socket stays an optimisation, not a requirement — `GET /api/user/service-requests/:id`
returns every field above, so a phone with no socket still gets a moving map, just
a chunkier one. Two tweaks worth making:

- While `stage` is `en_route` / `arriving_soon`, shorten the in-progress poll from
  8 s to **4–5 s**. Once `arrived` or `working`, relax it again — nobody's moving.
- On reconnect, don't reconcile. Let the next poll tick win, exactly as the
  existing foreground/background handling does.

---

## 5. Building the map

### 5.1 Renderer: Leaflet in a WebView

```bash
pnpm --filter @workspace/mobile exec expo install react-native-webview
```

That's the entire dependency. No native config, no prebuild, no dev client —
`react-native-webview` is on Expo's supported-in-Expo-Go list, so the team's
existing QR-code-into-Expo-Go workflow keeps working unchanged.

Two new files:

```
components/map/leafletHtml.ts     — the WebView document (a template string)
components/map/LiveTrackingMap.tsx — the RN component wrapping it
```

`MapBackdrop` **stays** — it's still what you show for `stage === 'searching'`
(no real position to plot yet) and it's the fallback if the WebView reports a
tile-load failure.

### 5.2 Tiles: pick a provider, never the OSMF demo server

`tile.openstreetmap.org` is the OpenStreetMap Foundation's own demo server —
its [Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/)
explicitly forbids production/commercial traffic and it blocks offending clients
without warning. Point at a real provider instead: MapTiler, Geoapify, Stadia
Maps or Thunderforest all have a usable free tier and a raster tile URL template.
Ask the backend team which one they've provisioned before wiring this up — it's
one line either way:

```
EXPO_PUBLIC_OSM_TILE_URL=https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key=XXXX
EXPO_PUBLIC_OSM_TILE_URL_DARK=https://api.maptiler.com/maps/streets-v2-dark/{z}/{x}/{y}.png?key=XXXX
EXPO_PUBLIC_OSM_ATTRIBUTION=&copy; OpenStreetMap contributors
```

(`EXPO_PUBLIC_*` is inlined at bundle time — changing `.env` needs a bundler
restart, not just a reload, same as `EXPO_PUBLIC_API_URL` today.)

**Show the attribution.** OSM data is ODbL-licensed — `© OpenStreetMap
contributors` (plus the tile provider's own line) is a legal requirement, not a
design nicety. Leave Leaflet's attribution control visible; don't hide it under
your own chrome.

### 5.3 The WebView document

A single self-contained HTML string, built once and never rebuilt per ping:

```ts
// components/map/leafletHtml.ts
export function leafletHtml(opts: {
  tileUrl: string; attribution: string;
  destination: [number, number]; // [lat, lng] — see the coordinate-order note below
  dark: boolean;
}): string {
  const config = JSON.stringify(opts); // never string-concatenate this in — see below
  return `<!doctype html><html><head>
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
    <style>html,body,#map{height:100%;margin:0;padding:0}</style>
  </head><body><div id="map"></div><script>
    const CONFIG = ${config};
    const map = L.map('map').setView(CONFIG.destination, 15);
    L.tileLayer(CONFIG.tileUrl, { attribution: CONFIG.attribution }).addTo(map);
    const dest = L.marker(CONFIG.destination).addTo(map);
    let worker = null;
    window.setWorker = function (lat, lng, heading) { /* §5.4 */ };
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ready' }));
  </script></body></html>`;
}
```

**Every value that reaches this document goes through `JSON.stringify`,
never template-concatenated in raw.** The address string and any future
free-text field flow from server data into an HTML document here — treat it as
you would any other unescaped-HTML injection point.

### 5.4 Smooth marker movement (the one non-obvious part)

Pings land every 4–5 seconds. Snapping the marker between them reads as broken.
Animate **inside the WebView**, so it costs zero RN↔WebView bridge traffic per
frame:

```js
// inside the <script> block above
let marker = null, raf = null;
window.setWorker = function (lat, lng, heading) {
  const next = L.latLng(lat, lng);
  if (!marker) { marker = L.marker(next).addTo(map); fitBoth(); return; }
  if (raf) cancelAnimationFrame(raf);
  const from = marker.getLatLng(), start = performance.now(), DURATION = 1200;
  (function step(now) {
    const t = Math.min(1, (now - start) / DURATION);
    const eased = t * (2 - t); // easeOutQuad
    marker.setLatLng([from.lat + (next.lat - from.lat) * eased,
                       from.lng + (next.lng - from.lng) * eased]);
    if (t < 1) raf = requestAnimationFrame(step);
  })(start);
};
```

`DURATION` is deliberately a bit longer than your ping interval, so the marker
is still gliding when the next ping lands rather than sitting still waiting.

**Camera behaviour:**
- First position → `map.fitBounds([dest, worker], { padding: [48,48], maxZoom: 16 })`.
- Subsequent positions → only re-fit if the worker has left the current
  viewport. Re-fitting on every ping makes the map twitch and fights a user who
  has zoomed in.
- The moment the user pans/zooms by hand → stop auto-following and show a small
  "Recenter" chip instead. Auto-camera overriding a deliberate pan is the single
  most common complaint about tracking maps — don't build that in.

### 5.5 `LiveTrackingMap.tsx`

```tsx
interface LiveTrackingMapProps {
  height: number;
  destination: [number, number]; // GeoJSON [lng, lat] — same shape as request.location
  worker?: { coordinates: [number, number]; heading?: number | null; locationStale?: boolean };
  caption?: string;
}
```

- Same `height` prop as `MapBackdrop` — it drops into the identical layout slot.
- **Build the HTML once**, `useMemo`'d on `[tileUrl, destination, dark]` only —
  never on `worker`. If the HTML string's identity changes on every ping, the
  WebView reloads the whole map and you get a white flash every few seconds.
  This is the single easiest way to get this component wrong.
- Push updates via `injectJavaScript`, not by re-rendering the WebView:

```tsx
useEffect(() => {
  if (!ready || !worker) return;
  const [lng, lat] = worker.coordinates; // GeoJSON is [lng, lat] — Leaflet wants [lat, lng]
  webViewRef.current?.injectJavaScript(
    `window.setWorker(${JSON.stringify(lat)}, ${JSON.stringify(lng)}, ${JSON.stringify(worker.heading ?? null)}); true;`
  );
}, [ready, worker]);
```

**Watch the coordinate order.** `request.worker.location.coordinates` (and
`request.location.coordinates`) is GeoJSON `[lng, lat]` — the same shape
documented in §3. Leaflet wants `[lat, lng]`. Swap once, right here at the
component boundary, and never again anywhere else. A transposed pair here is
the single most common bug in this exact feature — it silently drops the pin
in the wrong hemisphere instead of erroring.

- Grey the marker when `worker.locationStale` — a confident dot where the
  worker was two minutes ago is worse than an obviously uncertain one.
- Fallbacks: no `destination` → `<MapBackdrop />`. `stage === 'searching'` →
  the existing radar `<MapBackdrop />`. A `tile-error` message posted from the
  WebView → `<MapBackdrop />` plus a quiet "Map unavailable" caption.
- WebView props worth setting: `originWhitelist={['*']}`,
  `scrollEnabled={false}` (it likely sits inside a `ScrollView` — otherwise the
  two fight over the pan gesture), and a `renderLoading` skeleton.
- Dark mode: point at `EXPO_PUBLIC_OSM_TILE_URL_DARK` if your provider has one,
  or apply a CSS filter to `.leaflet-tile` (`invert(1) hue-rotate(180deg)
  brightness(0.9)`) as a one-line stopgap. The real dark tile style looks
  noticeably better; the filter is free.
- A route line (road-following, not straight) is a later phase that needs a
  routing engine on the backend — ship the straight line between the two
  markers first, swap in a polyline once that lands with no change to this
  component's props.

**No new location permission is needed.** `expo-location` is already a
dependency for capturing the customer's own address at booking time; rendering
someone else's position needs nothing further.

### 5.6 Web

A WebView degrades to roughly an iframe on `react-native-web`, so this same
component renders there too — no `Platform.OS === 'web'` branch needed, and no
separate web map implementation to build or maintain.

---

## 6. Trial bookings: identical, different event names

Discounted trial bookings (`/api/user/trials/*`) get the same treatment, and the
field names are deliberately identical so **one map component serves both flows**.

| | Normal booking | Trial booking |
|---|---|---|
| Payload | `request` | `trial` |
| Marker delta | `request:location` | `trial:location` (`{ trialId, stage, worker }`) |
| Badge changes | `request:arriving_soon` / `:arrived` / `:en_route` | `trial:arriving_soon` / `:arrived` / `:en_route` |
| Work begins | `request:started` | `trial:started` *(already existed)* |
| Composed state | `stage` | `stage` — same vocabulary |
| Worker block | `worker.{location,etaMinutes,arrivalStatus,…}` | identical, plus `isTrainee: true` |

One mapping difference to know: a trial's `stage` reports `work_done` while its
`status` is `completed`. That's not a bug — a trial's status stays `completed`
forever while the customer still owes payment *and* the feedback form that
onboards the trainee. `feedbackPending` and `payment.payable` say which is
outstanding.

---

## 7. Nothing else changed

Untouched: booking, cancel, retry, both payment endpoints, the search countdown,
`canRetry` / `canCancel` / `payment.payable`, and every existing socket event's
shape. Everything in this document is a new, optional key on payloads you already
parse — an app that ignores all of it behaves exactly as it does today.

Worth knowing: cancelling is still permitted while `stage === 'working'`
(`canCancel` follows `status`, which is still `in_progress`). If that should
change now that "work has started" is a real event, say so — it's a one-line
server change, but it's a product call, not a technical one.

---

## 8. Checklist

- [ ] Header/badge/timeline switch on `stage`, not `status`
- [ ] List cards use `summary.stage` so they match the detail screen
- [ ] `request:location` merges into the worker block without a full re-render
- [ ] Marker rotates by `heading`, greys out on `locationStale`
- [ ] Haptic on `request:arrived` only (not `request:en_route`)
- [ ] Map hidden from `stage === 'working'` onward
- [ ] `distanceKm` (card) vs `liveDistanceKm` (map header) not swapped
- [ ] ETA worded as an estimate while `etaSource === 'estimate'`
- [ ] In-progress poll shortened to 4–5 s while en route
- [ ] `react-native-webview` installed; tile provider key confirmed with backend
- [ ] `leafletHtml()` memoised on `[tileUrl, destination, dark]` — never on `worker`
- [ ] Marker updates go through `injectJavaScript`, never a WebView re-render
- [ ] `[lng, lat]` → `[lat, lng]` swap happens exactly once, at the component boundary
- [ ] OSM attribution visible on the map
- [ ] Tile-load failure falls back to `MapBackdrop`
- [ ] Trial screens wired to the `trial:*` twins
