# Worker App — Real-Time Job Dispatch (React Native / Android Integration Guide)

How to wire the React Native worker app into the live dispatch flow: go online with location → receive job offers over a socket in real time → accept from the notification → work the job → complete. **No polling.**

- **REST base URL:** https://example-k.onrender.com
- **Socket URL:** same origin as REST (Socket.IO shares the HTTPS server)
- **Auth:** the worker JWT from `POST /api/auth/verify-otp`. Sent as `Authorization: Bearer <token>` on REST and as `auth.token` in the socket handshake.

---

## 1. Install dependencies

```bash
npm i socket.io-client @react-native-async-storage/async-storage
npm i react-native-geolocation-service        # or @react-native-community/geolocation
```

Permissions — add to `android/app/src/main/AndroidManifest.xml`:
```xml
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.INTERNET" />
```

> The production server is HTTPS, so no cleartext-traffic config is needed. (If you ever point the app at a plain `http://` dev server, add `android:usesCleartextTraffic="true"` to `<application>`.)

---

## 2. Socket service (singleton)

Create `src/services/socket.js`. One connection for the whole app; screens subscribe to its events.

```js
import { io } from 'socket.io-client';
import AsyncStorage from '@react-native-async-storage/async-storage';

const SERVER_URL = 'https://example-k.onrender.com';
let socket = null;

export async function connectSocket() {
  if (socket && socket.connected) return socket;
  const token = await AsyncStorage.getItem('workerToken');
  if (!token) throw new Error('No worker token — log in first');

  socket = io(SERVER_URL, {
    auth: { token },
    transports: ['websocket'],   // skip long-poll upgrade on mobile
    reconnection: true,          // auto-reconnect on network drop
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });

  socket.on('connect', () => console.log('socket connected', socket.id));
  socket.on('connect_error', (e) => console.log('socket auth/conn error:', e.message));
  socket.on('disconnect', (r) => console.log('socket disconnected:', r));
  return socket;
}

export function getSocket() {
  return socket;
}

export function disconnectSocket() {
  if (socket) { socket.disconnect(); socket = null; }
}
```

Call `connectSocket()` right after login (once you have the token) and `disconnectSocket()` on logout.

---

## 3. Go online + location heartbeat

A worker only receives offers while **approved**, **online**, and with a **current location** set. Send location on going online and refresh it periodically (this is a push *from* the app — not polling for jobs).

```js
import Geolocation from 'react-native-geolocation-service';
import { PermissionsAndroid } from 'react-native';
import { getSocket } from './socket';

async function ensureLocationPermission() {
  const res = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
  );
  return res === PermissionsAndroid.RESULTS.GRANTED;
}

// Go online and start sending location. Uses the socket's presence:update event
// (equivalent REST: PUT /api/jobs/availability).
export async function goOnline() {
  if (!(await ensureLocationPermission())) throw new Error('Location permission denied');
  const socket = getSocket();

  const sendPresence = (isOnline) =>
    Geolocation.getCurrentPosition(
      (pos) =>
        socket.emit(
          'presence:update',
          { isOnline, lat: pos.coords.latitude, lng: pos.coords.longitude },
          (ack) => console.log('presence ack', ack)
        ),
      (err) => console.log('geo error', err),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 }
    );

  sendPresence(true);
  // Heartbeat every 30s so the worker's position stays fresh for matching.
  const timer = setInterval(() => sendPresence(true), 30000);
  return () => {                          // call this to go offline
    clearInterval(timer);
    socket.emit('presence:update', { isOnline: false });
  };
}
```

> `presence:update` and the REST `PUT /api/jobs/availability` are interchangeable. Use the socket version so everything runs over one connection.

---

## 4. Receive offers in real time

Subscribe to the server → worker events. Manage a list of open offers in state/context.

| Event | Payload | Do |
|---|---|---|
| `jobs:open` | `{ jobs: [offer] }` | initial snapshot on connect — seed your list |
| `job:offer` | `offer` | prepend to list, ring/vibrate, start a countdown |
| `job:taken` | `{ id }` | remove that offer (someone else won) |
| `job:expired` | `{ id }` | remove that offer (nobody took it in time) |

`offer` = `{ id, category, subcategory, jobDescription, address, distanceKm, customerName, customerRating, pricing, status, wave, offeredAt }` — **customer phone is hidden until you accept.**

`jobDescription` is what the customer typed — show it verbatim on the offer card. `customerRating` (fixed `4.6` for now — no rating system yet) and `pricing` (`{ currency, totalPrice, platformFeePercent, platformFee, workerEarning }`, dummy rate-card per category) are what the worker uses to decide whether to accept — **lead with `pricing.workerEarning`** ("You'll earn ₹270") since that's the number that drives the accept decision, and show `customerRating` next to the customer's name.

```js
import React, { createContext, useContext, useEffect, useState } from 'react';
import { getSocket } from '../services/socket';

const OffersContext = createContext();
export const useOffers = () => useContext(OffersContext);

export function OffersProvider({ children }) {
  const [offers, setOffers] = useState([]);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const onSnapshot = ({ jobs }) => setOffers(jobs || []);
    const onOffer = (offer) => setOffers((prev) => [offer, ...prev.filter((o) => o.id !== offer.id)]);
    const remove = ({ id }) => setOffers((prev) => prev.filter((o) => o.id !== id));

    socket.on('jobs:open', onSnapshot);
    socket.on('job:offer', onOffer);       // ← live push, no polling
    socket.on('job:taken', remove);
    socket.on('job:expired', remove);

    return () => {
      socket.off('jobs:open', onSnapshot);
      socket.off('job:offer', onOffer);
      socket.off('job:taken', remove);
      socket.off('job:expired', remove);
    };
  }, []);

  return <OffersContext.Provider value={{ offers, setOffers }}>{children}</OffersContext.Provider>;
}
```

Wrap the authenticated part of your app in `<OffersProvider>` (after the socket is connected). Any screen can now read `useOffers().offers` and render offer cards.

---

## 5. Accept / decline (with ack)

Accept over the socket; the ack callback tells you if you won. **First worker to accept wins** — if you lost the race you get a clear message.

```js
import { getSocket } from '../services/socket';

export function acceptJob(requestId) {
  return new Promise((resolve) => {
    getSocket().emit('job:accept', { requestId }, (res) => resolve(res));
    // res = { ok:true, job:{ id, status:'in_progress', customer:{name,phone}, address, location, acceptedAt } }
    //     | { ok:false, message:'This job is no longer available (already taken or expired)' }
  });
}

export function declineJob(requestId) {
  return new Promise((resolve) => {
    getSocket().emit('job:decline', { requestId }, (res) => resolve(res));
  });
}
```

Usage in an offer card — show the price/description/rating so the worker can decide, then accept:
```jsx
function OfferCard({ offer, onAccepted }) {
  const onAccept = async () => {
    const res = await acceptJob(offer.id);
    if (res.ok) {
      onAccepted(res.job); // customer name + phone now available; pricing carries through unchanged
    } else {
      Alert.alert('Missed it', res.message); // job:taken already removed the card
    }
  };

  return (
    <View style={styles.card}>
      <Text style={styles.category}>{offer.category} · {offer.subcategory}</Text>
      <Text style={styles.description}>{offer.jobDescription}</Text>
      <Text style={styles.distance}>{offer.distanceKm} km away</Text>
      <Text style={styles.customer}>{offer.customerName} ★ {offer.customerRating}</Text>
      <Text style={styles.earning}>You'll earn ₹{offer.pricing.workerEarning}</Text>
      <Text style={styles.breakdown}>
        (Job total ₹{offer.pricing.totalPrice} · platform fee {offer.pricing.platformFeePercent}%)
      </Text>
      <Button title="Accept" onPress={onAccept} />
    </View>
  );
}
```

---

## 6. Active job + completion (REST)

Once accepted, the job is yours until you complete it (you won't receive new offers while assigned).

```js
const API = 'https://example-k.onrender.com';
const authHeader = async () => ({ Authorization: `Bearer ${await AsyncStorage.getItem('workerToken')}` });

// GET /api/jobs/mine → { active:[...], history:[...] }
export async function fetchMyJobs() {
  const r = await fetch(`${API}/api/jobs/mine`, { headers: await authHeader() });
  return r.json();
}

// POST /api/jobs/:id/complete → frees you + increments jobsCompleted
export async function completeJob(id) {
  const r = await fetch(`${API}/api/jobs/${id}/complete`, { method: 'POST', headers: await authHeader() });
  return r.json();
}
```

Call `fetchMyJobs()` on app resume to restore an in-progress job (e.g. after the app was killed). Completing a job bumps `jobsCompleted`, which is what the Profile screen's "N Jobs Done" reads.

---

## 7. App lifecycle & reconnection

- **Socket auto-reconnects** (configured above). On reconnect the server re-sends `jobs:open`, so your offer list self-heals — no manual refetch needed.
- **On app resume** (`AppState` `active`): call `connectSocket()` if not connected, and `fetchMyJobs()` to restore any active job.
- **On logout:** `disconnectSocket()` and clear the token.
- **Token expiry:** a `connect_error` with "Invalid or expired token" means the JWT expired → route the worker back to the OTP login (Screen 1).

```js
import { AppState } from 'react-native';
AppState.addEventListener('change', (state) => {
  if (state === 'active') connectSocket();
});
```

---

## 8. Background / killed app (production note)

A socket only reaches a **foreground** app. For offers to arrive when the app is backgrounded or killed, add **FCM push** (the backend already has a mock `notificationService` hook that fires alongside every socket emit — swap it for FCM):

1. Add `@react-native-firebase/app` + `@react-native-firebase/messaging`, register the device token with the backend (a small `PUT /api/jobs/availability` extension or a new endpoint — ask and I'll add it).
2. On the FCM data message, show a local notification; tapping it opens the app, which connects the socket and calls `GET /api/jobs/available` once to fetch the still-open offer, then accepts as usual.

The socket handles the foreground real-time path today; FCM is the background complement.

---

## 9. Endpoints & events used by the worker app

**Socket (server → app):** `jobs:open`, `job:offer`, `job:taken`, `job:expired`
**Socket (app → server, with ack):** `job:accept {requestId}`, `job:decline {requestId}`, `presence:update {isOnline,lat,lng}`

**REST (worker JWT):**
| Method | Path | Use |
|---|---|---|
| PUT | `/api/jobs/availability` | go online/offline + location (REST alt to `presence:update`) |
| GET | `/api/jobs/available` | fallback snapshot of open offers (don't poll) |
| GET | `/api/jobs/mine` | restore active + past jobs on resume |
| POST | `/api/jobs/:id/accept` | REST alt to `job:accept` |
| POST | `/api/jobs/:id/complete` | mark job done |

**Precondition for receiving offers:** the worker account is **approved** (admin panel) and the app has gone **online with a location**. If offers never arrive, that's the first thing to check.
