# Kaaryo — Worker App: Job Flow & Live Location Integration Guide

Two changes, one release. Read §1 before anything else — it changes the shape of
the job screen, not just its data.

Base URL: `http://16.112.64.28:4000` (`PORT` in `.env`).
All bodies and responses are `application/json`. Everything here needs a **worker**
JWT (`Authorization: Bearer <token>`), the same one you already hold.

> The **customer** app's half of this feature — the live map, the "arriving soon"
> badge — is in **USER_APP_LIVE_TRACKING_GUIDE.md**. You don't need it to build
> this, but §2 of that document is the other end of the events you'll be sending.
>
> ### This app needs no map at all
> The customer's screen renders the map (OpenStreetMap via Leaflet, in a
> WebView); yours doesn't get one and doesn't need to build one. Your two jobs
> are a background GPS ticker (§4) and a **Navigate** button that opens Google
> Maps / Apple Maps / Waze for turn-by-turn (§4.1) — nothing here asks you to
> embed a map component.

---

## 1. What's wrong today, and what replaces it

Right now, accepting a job puts it straight into `in_progress`, and the only exit
is "Mark as completed". So the moment a worker accepts, your app shows them a
**Complete** button — while they are still in traffic, twenty minutes away. There
is no state for "on my way", so the customer's app can't say one either: it shows
"work in progress" for the entire journey.

The job now has an explicit travel phase:

```
  offer
    │  POST /api/jobs/:id/accept          (or socket job:accept)
    ▼
  ┌─────────────────────────────────────────────────────────┐
  │  EN ROUTE          status: in_progress                  │
  │                    workStage: 'en_route'                │
  │                                                         │
  │  • primary button: "Start job"  (canStart === true)     │
  │  • send a location ping every ~5s while this screen is  │
  │    alive (shouldSendLocation === true)                  │
  │  • the customer watches you move on a map               │
  └─────────────────────────────────────────────────────────┘
    │  POST /api/jobs/:id/start           ← NEW
    ▼
  ┌─────────────────────────────────────────────────────────┐
  │  WORKING           status: in_progress                  │
  │                    workStage: 'working'                 │
  │                                                         │
  │  • primary button: "Mark as completed" (canComplete)    │
  │  • STOP sending location — the server refuses pings now │
  └─────────────────────────────────────────────────────────┘
    │  POST /api/jobs/:id/complete        (unchanged)
    ▼
  PENDING RATING  → POST /api/jobs/:id/rate {rating}  → COMPLETED
```

**`status` did not change.** It is still `in_progress` for both phases. The new
`workStage` field splits it. That was deliberate — `status` already drives your
active-vs-history split in `GET /api/jobs/mine`, and adding values to it would
have broken that and every other switch on it.

### The one breaking behaviour

`POST /api/jobs/:id/complete` now **409s** if the job was never started:

```json
{ "success": false,
  "message": "Start the job before completing it — tap \"Start job\" once you reach the customer" }
```

Backend ships with `TRACKING_REQUIRE_JOB_START=false` during your rollout, which
makes `/complete` auto-start the job so existing builds keep working. Tell the
backend team when your release has drained and they'll drop the override. **Until
they do, don't rely on the lenient behaviour** — build against the strict flow.

### Deploying this — read before the backend goes out

The strict flag is not safe to enable on day one, for two independent reasons:

1. **Jobs already in flight.** A job accepted *before* the deploy has no
   `workStage` stored, so it reads back as `en_route`. Under the strict flag the
   worker doing that job right now cannot complete it — and their installed app
   has no Start button to fix it with. They are stuck.
2. **Old installs.** Same failure for anyone who hasn't updated, for as long as
   they haven't.

So the order is:

```
1. Deploy backend with TRACKING_REQUIRE_JOB_START=false   ← both flows work
2. Release the worker app with the Start button
3. Wait for old builds to drain (and for any pre-deploy job to finish)
4. Remove the override → strict flow enforced
```

With the flag off, `/complete` from `en_route` still back-fills `workStartedAt`,
so the customer's timeline never shows work that finished without ever starting.

---

## 2. Drive the buttons off the server's flags, not off `status`

`GET /api/jobs/mine` and every `POST /api/jobs/:id/*` response now carry these on
the job object. Switch your primary button on them directly:

| Field | Type | Meaning |
|---|---|---|
| `workStage` | `'en_route' \| 'working'` | Travel phase. Only meaningful while `status === 'in_progress'`. |
| `shouldSendLocation` | bool | Run your GPS ticker while true. When false, the ping endpoint will refuse you anyway. |
| `canStart` | bool | Show **Start job**. |
| `canComplete` | bool | Show **Mark as completed**. |
| `canRate` | bool | Show the rating card. |
| `workStartedAt` | ISO date \| null | When Start was tapped. |
| `arrivalStatus` | `'en_route' \| 'arriving_soon' \| 'arrived'` | The server's read on how close you are — the *same* verdict the customer sees. |
| `distanceMeters` | number \| null | Straight-line distance to the job, last ping. |
| `etaMinutes` | number \| null | Rough estimate (see §5). |

Please don't re-derive these from `status` + `workStage` yourself. The rules live
on the server because the server enforces them anyway, and a second copy in the
app drifts the first time either side changes. This is the same reason the
customer app is handed `canRetry` and `payment.payable` rather than a status
matrix.

```js
// The whole job screen, essentially:
if (job.canStart)    return <PrimaryButton label="Start job"        onPress={start} />;
if (job.canComplete) return <PrimaryButton label="Mark as completed" onPress={complete} />;
if (job.canRate)     return <RatingCard onSubmit={rate} />;
```

---

## 3. New endpoints

### 3.1 `POST /api/jobs/:id/start`

Worker reached the address; work begins. Idempotent — a double tap or a retry
after a dropped response returns success with the original timestamp.

```
POST /api/jobs/:id/start
→ 200 { success, message, job }          job.workStage === 'working'
→ 403 not your job
→ 409 the job isn't in_progress
```

**It is not gated on GPS.** You can call it whether or not `arrivalStatus` says
`arrived`. Indoor fixes, dead batteries, denied permissions and dense-building
drift are all routine, and a worker standing in a customer's kitchen unable to
start work because the server thinks they're 300 m away would be a far worse bug
than an early tap. Use `arrivalStatus` to *nudge* ("You don't look like you're
there yet — start anyway?") if you like, but never to disable the button.

### 3.2 `POST /api/jobs/:id/location`

```jsonc
// body — lat/lng required, the rest optional but useful
{ "lat": 12.9716, "lng": 77.5946,
  "heading": 184.2,   // degrees 0-360; rotates the customer's marker
  "speedKmh": 24,
  "accuracy": 12 }    // metres; see the note below — send it if you have it
```

```jsonc
// 200
{ "success": true, "throttled": false,
  "arrivalStatus": "arriving_soon", "arrivalStatusChanged": true,
  "tracking": { "location": {...}, "etaMinutes": 4, "distanceMeters": 934, ... } }
```

| Code | When |
|---|---|
| 200 `throttled:true` | You pinged faster than the server's 3 s floor. **Not an error** — the position simply wasn't written. Keep pinging on your normal cadence; don't back off, don't retry. |
| 403 | Not your job. |
| 409 | Job isn't `in_progress`, or it's already started. Stop your ticker. |
| 422 | `lat`/`lng` missing or not a valid coordinate. |

**Send `accuracy`.** A fix worse than 150 m still moves the dot on the customer's
map but is not allowed to change `arrivalStatus` — a ±400 m fix cannot honestly
claim to be inside a 100 m geofence, and a wrong "Arrived" sends a customer to
their door for nobody. Omit it and the server has to trust every fix.

### 3.3 Socket alternative: `job:location`

Same service, same validation, same effect — cheaper, because you already hold
the connection:

```js
socket.emit('job:location',
  { requestId, lat, lng, heading, speedKmh, accuracy },
  (res) => { /* { ok, throttled, arrivalStatus, changed } */ });
```

**Use the socket for pings and REST for everything else.** Pings are frequent,
individually worthless (the next one is 5 seconds away) and fine to lose; the
socket suits that exactly. Accept/start/complete/rate are state changes that need
real status codes and must work when the socket is down — keep those on REST.

If the socket is disconnected, fall back to `POST /:id/location`. Sending both is
harmless: the 3 s throttle collapses the duplicate.

---

## 4. Sending location: what to actually build

### 4.1 You are not building a map

This app has no map screen today, and this feature doesn't give it one. The
**customer's** app renders the map (Leaflet/OpenStreetMap, in
**USER_APP_LIVE_TRACKING_GUIDE.md**) — that's the whole reason the ping endpoint
exists, to feed *their* screen. All the worker side needs is:

1. A **background GPS ticker** posting pings while `shouldSendLocation` is true
   (§4.2–§4.4).
2. A **"Navigate" button** that hands off to whichever navigation app is already
   installed on the phone — Google Maps, Apple Maps, or Waze. Don't embed a map
   or build turn-by-turn directions yourselves; that's a wheel every worker
   already has, and it does traffic-aware routing better than anything you'd
   build in a sprint.

```ts
import { Linking, Platform } from 'react-native';

// destination: the job's [lat, lng] — from job.location.coordinates,
// remembering that's GeoJSON [lng, lat], so swap before calling this.
function openNavigation(destLat: number, destLng: number) {
  const label = encodeURIComponent('Job location');
  const url = Platform.select({
    ios: `maps://app?daddr=${destLat},${destLng}&dirflg=d`,
    android: `google.navigation:q=${destLat},${destLng}&mode=d`,
    default: `https://www.google.com/maps/dir/?api=1&destination=${destLat},${destLng}`,
  })!;
  Linking.openURL(url).catch(() =>
    // Fall back to the universal web URL if the native scheme isn't handled
    // (e.g. Google Maps not installed on iOS).
    Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${destLat},${destLng}`)
  );
}
```

Put this button on the "en route" job screen, next to (not instead of) your GPS
ticker — tapping it opens the OS's map app in front of yours; your ticker keeps
running in the background and keeps pinging while the worker follows turn-by-turn
directions there. That's exactly the "workers *will* switch to Maps for
navigation" case §4.3 exists to survive.

### 4.2 Cadence and lifecycle

**Cadence.** Every 5 seconds, or every 25 metres of movement, whichever is less
frequent. The server floor is 3 s; going faster just gets pings dropped and burns
battery for nothing. `expo-location`'s `distanceInterval`/`timeInterval` on the
background task config (§4.3) implement this for you — set both, not just one.

**Lifecycle.** Start the ticker the moment a job's `shouldSendLocation` becomes
true (right after accept). Stop it on: Start tapped, the job leaving
`in_progress`, a 409 from the ping endpoint, or the worker going offline. A
background task that outlives its job is both a battery complaint and a privacy
incident — it is a worker's real-time position still streaming to a customer who
has nothing left to track.

### 4.3 Background location — Android

Foreground-only tracking means the dot freezes the instant the worker's screen
locks or they switch to Maps — exactly when the customer is watching hardest.
Android kills background location without a foreground service, so:

- Manifest permissions: `ACCESS_FINE_LOCATION`, `ACCESS_BACKGROUND_LOCATION`,
  `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`.
- `expo-location` + `expo-task-manager`, with a defined background task and
  `startLocationUpdatesAsync` configured with `foregroundService: { notificationTitle: 'On the way to a job', notificationBody: 'Sharing your location with the customer' }`
  — this is what keeps the persistent notification up and the OS from killing
  the task.

```ts
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

const LOCATION_TASK = 'job-location-ping';

TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
  if (error || !data) return;
  const { locations } = data as { locations: Location.LocationObject[] };
  const last = locations.at(-1);
  if (!last) return;
  await postLocationPing(currentJobId, {
    lat: last.coords.latitude,
    lng: last.coords.longitude,
    heading: last.coords.heading ?? undefined,
    speedKmh: last.coords.speed != null ? last.coords.speed * 3.6 : undefined,
    accuracy: last.coords.accuracy ?? undefined,
  });
});

async function startTracking(jobId: string) {
  currentJobId = jobId;
  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: Location.Accuracy.High,
    timeInterval: 5000,
    distanceInterval: 25,
    foregroundService: {
      notificationTitle: 'On the way to a job',
      notificationBody: 'Sharing your location with the customer',
    },
  });
}

async function stopTracking() {
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  }
}
```

**OEM battery optimisers.** Xiaomi/Oppo/Vivo/Realme — heavily represented among
Indian Android users — kill background services far more aggressively than
stock Android, foreground service or not. Budget real support time for "the dot
froze" tickets that turn out to be MIUI/ColorOS battery settings, and consider a
one-time onboarding screen pointing workers at their phone's "no battery
restrictions for this app" setting.

### 4.4 Background location — iOS

- `app.json`: `"UIBackgroundModes": ["location"]`.
- `NSLocationWhenInUseUsageDescription` **and**
  `NSLocationAlwaysAndWhenInUseUsageDescription` — iOS shows the latter's text
  when asking to upgrade from "while using" to "always".
- Request `Always` authorization (not just "while using") when the worker
  accepts a job — `Location.requestBackgroundPermissionsAsync()`.
- Set `showsBackgroundLocationIndicator: true` (the blue status-bar pill) — this
  is Apple's own "an app is tracking you in the background" signal to the
  *worker*, and hiding it risks App Review rejection, not just bad practice.

### 4.5 Ask at the right moment, and expect "no"

Request location permission **at accept time**, not at app launch or onboarding.
"Share your location so the customer can see you coming" lands when there's a
live job on screen and reads as surveillance when there isn't one.

**Store review.** Both Apple and Google require a plain-language justification
for background location, in the store listing *and* in-product. Say, in both
places, exactly what this does: location is shared only with the customer of an
active job, and only until the job starts (§3.2 — pings are refused once
`workStage` flips to `working`). That's a true, narrow claim and it's the one
that gets approved.

**Degrade gracefully.** Permission denied or GPS off is not a blocker — the
worker can still start and complete the job with no map on the customer's side
at all; the customer just gets a static card instead of a moving dot. Show a
dismissible banner, never gate accept/start/complete on location being granted.

### 4.6 Offline

Don't queue and replay pings. A position from four minutes ago plotted as
current is worse than no position at all — the customer payload already carries
`locationStale` for exactly this gap, and a replayed backlog would make a
worker who was stationary for network reasons look like they teleported. Drop
failed pings on the floor and let the next successful one carry the current
position.

---

## 5. What `arrivalStatus` and `etaMinutes` mean

The server geofences every accepted ping against the job address:

| Status | Trigger (all env-tunable) |
|---|---|
| `en_route` | further than 1.5 km and ETA over 5 min |
| `arriving_soon` | within 1.5 km, **or** ETA ≤ 5 min |
| `arrived` | within 100 m |

Once `arrived`, it takes moving **250 m** away to drop back — a phone sitting on a
doorstep drifts tens of metres between fixes, and without that gap the customer's
badge would flap while nobody moved.

`etaMinutes` is currently straight-line distance ÷ an assumed 18 km/h, inflated
30% for roads bending — `etaSource` says `'estimate'`. Word it loosely ("~8 min"),
never as a promise. A real routing provider may replace it later; `etaSource` will
say `'directions'` and nothing else about the field changes.

---

## 6. Trial jobs: the same, with one fewer moving part

Trial jobs (`/api/worker/trial/*`) already had an explicit start step, so the
lifecycle needs no change — `accepted` **is** the travelling state and
`in_progress` **is** on-site. Only tracking is new.

| | Normal job | Trial job |
|---|---|---|
| Travelling | `status:'in_progress'` + `workStage:'en_route'` | `status:'accepted'` |
| Start | `POST /api/jobs/:id/start` | `POST /api/worker/trial/:id/start` *(existing)* |
| Working | `status:'in_progress'` + `workStage:'working'` | `status:'in_progress'` |
| Send location | `POST /api/jobs/:id/location` | `POST /api/worker/trial/:id/location` ← NEW |
| Complete | `POST /api/jobs/:id/complete` | `POST /api/worker/trial/:id/complete` |

`trialWorkerView` now carries the **same** `shouldSendLocation` / `canStart` /
`canComplete` / `arrivalStatus` / `distanceMeters` / `etaMinutes` fields as a
normal job, so the same job screen and the same GPS ticker serve both. There is no
`workStage` on a trial — you don't need one, the status enum already says it.

There is no socket ping event for trials; use REST. Trials are low-volume enough
that the saving wasn't worth a second code path.

---

## 7. Test it without the customer app

```bash
node scripts/worker-client.js <WORKER_JWT> http://localhost:4000
```

```
a <requestId>   accept
drive 3         simulate driving in from 3 km out, pinging as you close
                → prints the server's verdict per ping, flags the badge change
here            jump to the doorstep in one ping
s               start the job
c               mark complete
r 5             rate → closed
```

Run `node scripts/user-client.js` in a second terminal to watch the customer end
receive `request:location`, `request:arriving_soon`, `request:arrived` and
`request:started` as you drive.

`npm run test:tracking` covers the geofence itself (thresholds, hysteresis,
throttling, accuracy gating) as pure functions — worth reading if a threshold ever
looks wrong.

---

## 8. Nothing else changed

Untouched, byte for byte: `GET /api/jobs/available`, `PUT /api/jobs/availability`,
`POST /api/jobs/:id/accept|decline|rate`, `GET /api/earnings/*`, the offer payload
(`offerView`), and the `jobs:open` / `job:offer` / `job:taken` / `job:expired` /
`job:accept` / `job:decline` / `presence:update` socket contract. All additions to
the assigned-job payload are new optional keys.

`presence:update` (your availability heartbeat) is **separate** from job location
pings and still needed — it's what dispatch geo-matches against to decide who gets
offered a job at all. Keep sending it on its existing cadence whether or not you
have a job. Job pings are scoped to one job and stop when it starts; the heartbeat
runs whenever you're online.

---

## 9. Checklist

- [ ] Job screen switches on `canStart` / `canComplete` / `canRate`, not `status`
- [ ] **Start job** button added, wired to `POST /api/jobs/:id/start`
- [ ] **Navigate** button added — deep-links to the OS map app, no in-app map built
- [ ] "Mark as completed" no longer appears while `workStage === 'en_route'`
- [ ] GPS ticker: starts on `shouldSendLocation`, stops on start/409/offline
- [ ] Android: foreground service + persistent notification configured
- [ ] iOS: `UIBackgroundModes: ["location"]`, `Always` authorization requested, blue indicator left visible
- [ ] Location permission requested at accept time, with a reason
- [ ] `accuracy` included in every ping
- [ ] 200 + `throttled:true` treated as success, not retried
- [ ] 409 from the ping endpoint stops the ticker
- [ ] Denied permission degrades to a banner, never blocks start/complete
- [ ] No ping backlog replayed after reconnecting — latest position only
- [ ] Store listing + in-product copy explain the background-location use case
- [ ] Trial job screen: `POST /api/worker/trial/:id/location` on the same ticker
- [ ] Verified end to end against `scripts/user-client.js`
