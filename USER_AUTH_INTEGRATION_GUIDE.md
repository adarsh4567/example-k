# Kaaryo — User (Customer) Auth & Profile Integration Guide

Phone + OTP login for the **customer app**, and the name-only profile it creates.
Same mechanism the worker app uses, against its own `User` collection.

**Scope:** phone number, OTP, name. Nothing else is collected — no email, address,
gender, DOB or photo. Those get added when a screen actually needs them.

Base URL: `http://16.112.64.28:4000` (`PORT` in `.env`).
All bodies and responses are `application/json`. CORS is fully open.

---

## 1. The flow in one picture

```
┌─ Login screen ──────────────────────────────┐
│  name (optional here) + 10-digit phone      │
│         ↓                                   │
│  POST /api/user/auth/send-otp               │  { phone }
│         ↓  200 → start a 30s resend timer   │
├─ OTP screen ────────────────────────────────┤
│  6 digits                                   │
│         ↓                                   │
│  POST /api/user/auth/verify-otp             │  { phone, otp, name? }
│         ↓  200 → { token, profileCompleted }│
│  store token                                │
├─ Branch ────────────────────────────────────┤
│  profileCompleted === true   → Home         │
│  profileCompleted === false  → Name screen  │
│         ↓                                   │
│  PUT /api/user/profile                      │  { fullName }
│         ↓                                   │
│  Home                                       │
└─────────────────────────────────────────────┘
```

The account is **created on first successful `verify-otp`** — there is no separate
signup call. Login and signup are the same request; `isNewUser` tells you which
one just happened.

**In development every OTP is `123456`** (`SMS_MODE=mock`, `MOCK_OTP=123456` in
`.env`). No SMS is actually sent — the code is printed in the server log.

---

## 2. Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/user/auth/send-otp` | — | Send the OTP |
| `POST` | `/api/user/auth/resend-otp` | — | Resend (identical behaviour, same cooldown) |
| `POST` | `/api/user/auth/verify-otp` | — | Verify → create/login → returns the token |
| `GET` | `/api/user/profile` | user token | Read the account |
| `PUT` | `/api/user/profile` | user token | Set / change the name |

### Response envelope

Every response is a **flat** JSON object — `success`, `message`, then the payload
fields at the top level. There is no `data` wrapper.

```json
{ "success": true,  "message": "Profile fetched", "profile": { "...": "..." } }
{ "success": false, "message": "Incorrect OTP" }
```

Branch on `success` (or the HTTP status), then read the named field (`token`,
`user`, `profile`).

---

### 2.1 `POST /api/user/auth/send-otp`

**Request**
```json
{ "phone": "9988776655" }
```

| Field | Type | Required | Rule |
|---|---|---|---|
| `phone` | string | ✅ | 10 digits, first digit 6–9 (Indian mobile) |

**`200`**
```json
{ "success": true, "message": "OTP sent successfully", "cooldownSeconds": 30 }
```

Use `cooldownSeconds` to drive the "Resend in 0:29" countdown — don't hardcode 30,
it's env-configurable (`OTP_RESEND_COOLDOWN_SECONDS`).

**Errors**

| Code | `message` | Handling |
|---|---|---|
| `422` | `Enter a valid 10-digit mobile number` | Inline field error; keep the user on the screen |
| `429` | `Please wait 27s before requesting a new OTP` | Cooldown still running — disable the button, show the remaining seconds |
| `403` | `This account has been blocked` | Terminal — show a support message, don't advance |

The OTP is valid for **5 minutes** (`OTP_EXPIRY_MINUTES`).

---

### 2.2 `POST /api/user/auth/resend-otp`

Identical request and responses to `send-otp` — same body, same cooldown, same
errors. It exists so the "Resend code" button reads clearly in your networking
layer. A successful resend **replaces** the previous code; the old one stops working.

---

### 2.3 `POST /api/user/auth/verify-otp`

The important one. Verifies the code, creates the account if the phone is new,
and returns the JWT.

**Request**
```json
{ "phone": "9988776655", "otp": "123456", "name": "Adarsh Kumar" }
```

| Field | Type | Required | Rule |
|---|---|---|---|
| `phone` | string | ✅ | Same number the OTP was sent to |
| `otp` | string | ✅ | 4–6 digits |
| `name` | string | ➖ | Max 60 chars. Send it if you collected the name on the login screen; omit it to ask afterwards |

**`200` — new account (name supplied)**
```json
{
  "success": true,
  "message": "New account created",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "isNewUser": true,
  "profileCompleted": true,
  "user": {
    "id": "6a69e14a17c3113a5666d025",
    "phone": "9988776655",
    "fullName": "Adarsh Kumar",
    "profileCompleted": true,
    "status": "active"
  }
}
```

**`200` — new account (no name yet)**
```json
{
  "success": true,
  "message": "New account created",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "isNewUser": true,
  "profileCompleted": false,
  "user": {
    "id": "6a69e15517c3113a5666d030",
    "phone": "9911223344",
    "fullName": null,
    "profileCompleted": false,
    "status": "active"
  }
}
```

**`200` — returning user**: same shape, `message: "Welcome back"`,
`isNewUser: false`.

**Response fields**

| Field | Type | Meaning |
|---|---|---|
| `token` | string | JWT, valid **30 days** (`JWT_EXPIRES_IN`). Store it securely; send it as `Authorization: Bearer <token>` |
| `isNewUser` | boolean | `true` if this call just created the account. Use it for a welcome screen / analytics — **not** for routing |
| `profileCompleted` | boolean | `false` means `fullName` is still null. **This is the routing flag**: `false` → name screen, `true` → home |
| `user.id` | string | Mongo ObjectId |
| `user.phone` | string | 10 digits, unformatted |
| `user.fullName` | string \| null | Null until supplied |
| `user.status` | string | `active` or `blocked` |

`profileCompleted` is duplicated at the top level and inside `user` — read
whichever is convenient.

**Errors**

| Code | `message` | Handling |
|---|---|---|
| `422` | `Enter a valid 10-digit mobile number` | Bad phone |
| `422` | `Enter a valid OTP` | Not 4–6 digits — validate client-side first |
| `422` | `Full name must be under 60 characters` | Name too long. **The OTP is NOT consumed** — the user can retype the name and submit the same code again |
| `400` | `OTP expired or not requested. Please request a new one` | Nothing pending for this number (expired after 5 min, or already used). Send them back to request a fresh code |
| `400` | `Incorrect OTP` | Wrong digits. Let them retry with the same code — it stays valid until it expires |
| `403` | `This account has been blocked` | Terminal |

**A correct OTP is consumed immediately** and cannot be replayed. If your app
double-fires the request (double tap, retry-on-timeout), the second call returns
`400 OTP expired or not requested` even though the first succeeded. Guard the
submit button and treat a `400` that follows a successful response as a no-op.

**Returning users keep the name they already have.** Passing a different `name`
on a later login does not overwrite it — use `PUT /api/user/profile` to rename.

---

### 2.4 `GET /api/user/profile`

**Request** — no body.
```
Authorization: Bearer <token>
```

**`200`**
```json
{
  "success": true,
  "message": "Profile fetched",
  "profile": {
    "id": "6a69e15517c3113a5666d030",
    "phone": "9911223344",
    "phoneFormatted": "+91 99112 23344",
    "phoneVerified": true,
    "fullName": "Priya Sharma",
    "displayInitial": "P",
    "profileCompleted": true,
    "status": "active",
    "createdAt": "2026-07-29T11:17:41.112Z",
    "lastLoginAt": "2026-07-29T11:17:41.142Z"
  }
}
```

| Field | Notes |
|---|---|
| `phoneFormatted` | Pre-formatted `+91 99112 23344` — render this, don't format client-side |
| `displayInitial` | First letter of the name, uppercased; `"?"` when the name is null. Use it for the avatar circle |
| `profileCompleted` | `!!fullName` |
| `lastLoginAt` | Set on every successful `verify-otp` |

Call this on app launch to validate the stored token and refresh the account. A
`401` means the token is dead → clear it and show the login screen.

**Errors:** see [§3](#3-authentication-errors).

---

### 2.5 `PUT /api/user/profile`

Sets or changes the name. This is the "profile setup" screen and the "edit name"
screen — same call.

**Request**
```json
{ "fullName": "Priya Sharma" }
```

| Field | Type | Required | Rule |
|---|---|---|---|
| `fullName` | string | ✅ | Non-empty after trimming, max 60 chars |

**`200`** — returns the full profile object, same shape as `GET`:
```json
{
  "success": true,
  "message": "Profile updated",
  "profile": {
    "id": "6a69e15517c3113a5666d030",
    "phone": "9911223344",
    "phoneFormatted": "+91 99112 23344",
    "phoneVerified": true,
    "fullName": "Priya Sharma",
    "displayInitial": "P",
    "profileCompleted": true,
    "status": "active",
    "createdAt": "2026-07-29T11:17:41.112Z",
    "lastLoginAt": "2026-07-29T11:17:41.142Z"
  }
}
```

Use the returned `profile` to update local state — no follow-up `GET` needed.

**Errors**

| Code | `message` |
|---|---|
| `422` | `fullName is required` (key absent from the body) |
| `422` | `Full name cannot be empty` (empty or whitespace-only) |
| `422` | `Full name must be under 60 characters` |

The name **cannot be cleared** once set — it's what the worker sees on every
booking. There is no delete-account endpoint.

---

## 3. Authentication errors

Every protected route (`/api/user/profile`, and any future user route) returns:

| Code | `message` | Cause | App should |
|---|---|---|---|
| `401` | `Authentication token missing` | No `Authorization` header, or not `Bearer ` prefixed | Log out |
| `401` | `Invalid or expired token` | Malformed, tampered, or past its 30-day life | Clear the token, go to login |
| `401` | `This endpoint requires a user token` | A **worker** token was sent to a user route | Bug — never mix the two token stores |
| `401` | `User not found` | Valid token, but the account no longer exists | Log out |
| `403` | `This account has been blocked` | `status: 'blocked'` | Show a support message; don't retry |

Put this in one interceptor: **any `401` → wipe the stored token and route to
login.** Do not attempt a refresh — there is no refresh endpoint. The 30-day
token is the whole session.

---

## 4. Token handling

- **Header:** `Authorization: Bearer <token>` on every protected request. Exactly
  that prefix — the server slices the first 7 characters.
- **Lifetime:** 30 days from issue (`JWT_EXPIRES_IN`), no refresh. When it expires
  the user re-does phone + OTP.
- **Storage:** Expo `SecureStore` / React Native Keychain, or `localStorage` on web.
- **Logout** is purely local: delete the token. There is no server-side logout or
  token blacklist.
- **Never send a user token to a worker endpoint** (`/api/auth/*`, `/api/jobs/*`,
  `/api/profile/*`). Both token families are signed with the same secret and are
  told apart by a `type` claim, so the server rejects the crossover explicitly —
  but keep them in separate storage keys so it can't happen by accident.
- The **Socket.IO channel accepts both** token types and routes each to its own
  audience: a user token gets the customer's read-only `request:*` stream, a worker
  token gets the job-offer stream. Neither can reach the other's events.

---

## 5. Two auth systems — do not cross the wires

This backend serves two apps. The endpoints look similar and are **not**
interchangeable.

| | Customer app | Worker app |
|---|---|---|
| Login | `/api/user/auth/*` | `/api/auth/*` |
| Creates | a `User` record | a `Worker` record |
| Token claim | `type: 'user'` | *(none)* |
| Profile | `/api/user/profile` | `/api/profile` |
| Bookings | `/api/user/service-requests` | `/api/jobs/*` |
| Sockets | optional — read-only `request:*` updates | required — job offers |

**Calling `/api/auth/send-otp` + `verify-otp` from the customer app creates a
Worker record** for that phone number and drops it into the worker onboarding
pipeline. That's the single most damaging mistake available here. Use
`/api/user/auth/*`.

The same phone number can hold both a customer and a worker account — their OTP
codes are tracked separately (`purpose` on the OTP record), so a person logging
into both apps won't have one flow invalidate the other's code.

---

## 6. Client sketch

```js
const BASE = 'http://16.112.64.28:4000';
const TOKEN_KEY = 'kaaryo.user.token'; // separate key from any worker token

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({ success: false, message: 'Network error' }));

  // One place to handle a dead session.
  if (res.status === 401) {
    await clearToken();
    throw Object.assign(new Error(data.message), { status: 401, logout: true });
  }
  if (!data.success) throw Object.assign(new Error(data.message), { status: res.status });

  return data;
}

// ── Login screen ──
export const sendOtp   = (phone) => api('/api/user/auth/send-otp',   { method: 'POST', body: { phone } });
export const resendOtp = (phone) => api('/api/user/auth/resend-otp', { method: 'POST', body: { phone } });

// ── OTP screen ── returns where to go next
export async function verifyOtp(phone, otp, name) {
  const { token, isNewUser, profileCompleted, user } = await api('/api/user/auth/verify-otp', {
    method: 'POST',
    body: { phone, otp, ...(name ? { name } : {}) },
  });
  await saveToken(token);
  return { user, isNewUser, next: profileCompleted ? 'home' : 'name' };
}

// ── Profile ──
export const getProfile = (token) => api('/api/user/profile', { token });
export const setName = (token, fullName) =>
  api('/api/user/profile', { method: 'PUT', token, body: { fullName } });

// ── App launch ──
export async function bootstrap() {
  const token = await loadToken();
  if (!token) return { screen: 'login' };
  try {
    const { profile } = await getProfile(token);          // also validates the token
    return { screen: profile.profileCompleted ? 'home' : 'name', profile };
  } catch (err) {
    return { screen: 'login' };                           // 401 already cleared it
  }
}
```

---

## 7. Screens to build

1. **Login** — name field (optional) + 10-digit phone. Validate `/^[6-9]\d{9}$/`
   client-side before calling. → `send-otp`.
2. **OTP** — 6-box input, auto-submit on the 6th digit. "Resend in 0:29" driven by
   `cooldownSeconds`; enable the resend button at zero. Show `Incorrect OTP`
   inline and let them retry the same code. In dev, prefill `123456`.
3. **Name** — shown only when `profileCompleted === false`. Single field, 60-char
   cap. → `PUT /api/user/profile` → home.
4. **Account** — render `phoneFormatted`, `fullName`, `displayInitial` from
   `GET /api/user/profile`. Edit-name reuses the same `PUT`. Logout = delete the
   stored token (no API call).

---

## 8. Not built — don't design around it

- **Refresh tokens / silent renewal.** 30-day token, then re-login.
- **Server-side logout, session list, device management.**
- **Any profile field beyond the name** — no email, address, gender, DOB, photo.
- **Delete account / clear name.**
- **Social or password login.** OTP only.
> **Bookings ARE now linked to the account** — this section previously said they
> weren't. Use `POST /api/user/service-requests`, which reads the customer's name
> and phone from the token and attaches the request to the `User` record. See
> **USER_SERVICE_BOOKING_INTEGRATION_GUIDE.md** for the whole booking → dispatch →
> payment flow. The old `POST /api/service-requests` (with `customerName` /
> `customerPhone` in the body) still exists for test scripts but leaves the request
> ownerless — the app must not use it.

---

## 9. Ready-to-paste brief for Replit

> Add phone + OTP authentication to the Kaaryo **customer** app. Backend base URL:
> `http://16.112.64.28:4000`. All requests and responses are JSON. Every response
> is flat — `{ success, message, ...payload }` — with no `data` wrapper; errors are
> `{ success: false, message }`.
>
> **Only the name and phone number are collected. Nothing else** — no email,
> address, gender, date of birth or photo. Do not add those fields.
>
> **Endpoints:**
> - `POST /api/user/auth/send-otp` — body `{ phone }` (10 digits, starts 6–9) →
>   `200 { success, message, cooldownSeconds }`. Errors: `422` invalid phone,
>   `429` cooldown active (message contains the seconds left), `403` blocked.
> - `POST /api/user/auth/resend-otp` — identical to send-otp.
> - `POST /api/user/auth/verify-otp` — body `{ phone, otp, name? }` (`name` max 60
>   chars, optional) → `200 { success, message, token, isNewUser,
>   profileCompleted, user: { id, phone, fullName, profileCompleted, status } }`.
>   Errors: `400 "Incorrect OTP"`, `400 "OTP expired or not requested..."`,
>   `422` invalid phone/otp/name-too-long, `403` blocked.
>   The account is created here on first success — there is no signup endpoint.
> - `GET /api/user/profile` — header `Authorization: Bearer <token>` → `200
>   { success, message, profile: { id, phone, phoneFormatted, phoneVerified,
>   fullName, displayInitial, profileCompleted, status, createdAt, lastLoginAt } }`.
> - `PUT /api/user/profile` — header `Authorization: Bearer <token>`, body
>   `{ fullName }` → `200 { success, message, profile }` (same profile shape).
>   Errors: `422 "fullName is required"`, `422 "Full name cannot be empty"`,
>   `422 "Full name must be under 60 characters"`.
>
> **Flow:** login screen (optional name + phone) → `send-otp` → OTP screen (6
> digits, auto-submit, "Resend in Ns" from `cooldownSeconds`) → `verify-otp` →
> store the `token` securely. Then route on **`profileCompleted`**: `false` → a
> single-field name screen that calls `PUT /api/user/profile`; `true` → home. Use
> `isNewUser` only for a welcome message, never for routing.
>
> **Token:** send as `Authorization: Bearer <token>` on every protected call.
> Valid 30 days, **no refresh endpoint**. Add one interceptor: any `401` → delete
> the stored token and go to the login screen. Logout is local-only (delete the
> token); there is no logout API. On app launch, call `GET /api/user/profile` to
> validate the stored token and decide the landing screen.
>
> **In development every OTP is `123456`** — no SMS is sent. Prefill it in dev builds.
>
> **Critical:** do NOT call `/api/auth/send-otp` or `/api/auth/verify-otp` — those
> are the *worker* app's endpoints and calling them creates a worker account for
> the phone number. The customer app uses `/api/user/auth/*` only. Store the
> customer token under its own key and never send it to `/api/jobs/*`,
> `/api/profile/*` or the Socket.IO channel.
>
> **Do not build:** refresh tokens, server-side logout, device management,
> password or social login, delete-account, or any profile field beyond the name.
> No endpoints exist for them.
>
> **Note on bookings:** `POST /api/service-requests` does not yet read the auth
> token — it still takes `customerName` and `customerPhone` in the body. Populate
> those from the logged-in profile (`profile.fullName`, `profile.phone`).
