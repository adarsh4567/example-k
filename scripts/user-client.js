/**
 * Customer real-time test client — stands in for the (not-yet-built) customer app
 * so you can drive the whole flow end to end and watch it live.
 *
 * It does the REST calls (login, book, cancel, retry, pay) AND holds the socket
 * open, so every server push is printed as it happens: the search waves, the
 * moment a worker accepts, the work-done cue, the payment.
 *
 * Usage:
 *   node scripts/user-client.js                       # interactive, phone prompted
 *   PHONE=9876543210 node scripts/user-client.js      # log in and wait
 *   PHONE=9876543210 AUTO=1 node scripts/user-client.js  # log in, book, then auto-pay
 *
 * Env: SERVER (default http://localhost:4000), PHONE, OTP (default 123456),
 *      NAME, CATEGORY (cleaning), SUBCATEGORY, LAT, LNG, AUTO=1
 *
 * Commands at the prompt:
 *   book [category] [subcategory]   raise a request (starts the 1-minute timer)
 *   status                          re-read the active request
 *   retry                           search again after it expired
 *   cancel                          cancel the active request
 *   pay [method]                    initiate + confirm payment (default upi)
 *   list                            my requests (active + history)
 *   q                               quit
 *
 * Pair it with scripts/worker-client.js in another terminal to play the worker
 * side and watch both halves of the same job.
 */

const readline = require('readline');
const { io } = require('socket.io-client');

const SERVER = process.env.SERVER || 'http://localhost:4000';
const OTP = process.env.OTP || '123456';
const AUTO = process.env.AUTO === '1';

// Bengaluru city centre — override with LAT/LNG to test other supply areas.
const LAT = Number(process.env.LAT || 12.9716);
const LNG = Number(process.env.LNG || 77.5946);
const CATEGORY = process.env.CATEGORY || 'cleaning';
const SUBCATEGORY = process.env.SUBCATEGORY || '';

let token = null;
let activeId = null;
let socket = null;
let countdown = null;

const log = (label, obj) =>
  console.log(`\n[${label}]${obj === undefined ? '' : ' ' + JSON.stringify(obj, null, 2)}`);

async function api(method, path, body) {
  const res = await fetch(`${SERVER}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ...json };
}

// ── The countdown, rendered from the server's absolute deadline ──
// Deliberately NOT a local 60-second timer: the server owns when the search dies
// (searchExpiresAt), so a client that was asleep or has a skewed clock still shows
// the truth. This is exactly what the real app should do.
function startCountdown(searchExpiresAt) {
  stopCountdown();
  if (!searchExpiresAt) return;
  countdown = setInterval(() => {
    const left = Math.max(0, Math.ceil((new Date(searchExpiresAt) - Date.now()) / 1000));
    process.stdout.write(`\r  ⏳ searching… ${left}s left   `);
    if (left <= 0) stopCountdown();
  }, 1000);
}
function stopCountdown() {
  if (countdown) clearInterval(countdown);
  countdown = null;
  process.stdout.write('\r                             \r');
}

function showRequest(r) {
  if (!r) return;
  activeId = r.id;
  const bits = [
    `status=${r.status}`,
    `attempt=${r.attempt}/${r.maxAttempts}`,
    `radius=${r.radiusKm}km`,
    `notified=${r.workersNotified}`,
    `payment=${r.payment.status}${r.payment.payable ? ' (PAYABLE)' : ''}`,
  ];
  console.log(`  → ${r.id}  ${bits.join('  ')}`);
  if (r.worker) console.log(`  → assigned: ${r.worker.name} · ${r.worker.phone} · ${r.worker.distanceKm}km · rating ${r.worker.rating ?? 'new'}`);
  if (r.status === 'searching') startCountdown(r.searchExpiresAt);
  else stopCountdown();
  if (r.status === 'expired') {
    console.log(r.canRetry ? '  → nobody accepted. type "retry"' : '  → out of retries. book a new request.');
  }
  if (r.payment.payable) console.log(`  → work done. type "pay" to pay ₹${r.payment.amount}`);
}

async function login(phone, name) {
  let res = await api('POST', '/api/user/auth/send-otp', { phone });
  if (!res.success) return console.error('✗ send-otp:', res.message);
  console.log(`✓ OTP sent (dev OTP is ${OTP})`);

  res = await api('POST', '/api/user/auth/verify-otp', { phone, otp: OTP, name });
  if (!res.success) return console.error('✗ verify-otp:', res.message);
  token = res.token;
  console.log(`✓ logged in as ${res.user.fullName || '(no name)'} · ${res.isNewUser ? 'new account' : 'returning'}`);

  if (!res.profileCompleted) {
    const fallback = name || 'Test Customer';
    const p = await api('PUT', '/api/user/profile', { fullName: fallback });
    console.log(p.success ? `✓ profile name set to ${fallback}` : `✗ profile: ${p.message}`);
  }

  connectSocket();
  const active = await api('GET', '/api/user/service-requests/active');
  if (active.request) {
    console.log('↩︎ resuming an active request:');
    showRequest(active.request);
  }
  if (AUTO) await book(CATEGORY, SUBCATEGORY);
}

function connectSocket() {
  socket = io(SERVER, { auth: { token } });
  socket.on('connect', () => console.log(`🔌 socket connected (${socket.id}) — live updates on`));
  socket.on('connect_error', (err) => console.error('❌ socket connect error:', err.message));

  socket.on('requests:active', (d) => {
    log('requests:active (snapshot)');
    (d.requests || []).forEach(showRequest);
  });

  // Every push carries the identical `request` shape the REST endpoints return,
  // so there is one render path regardless of transport.
  const events = {
    'request:searching': 'searching (wave sent)',
    'request:accepted': '✅ A PROFESSIONAL ACCEPTED',
    'request:expired': '⌛ EXPIRED — nobody accepted',
    'request:work_done': '🧹 WORK DONE — payment due',
    'request:completed': '🏁 COMPLETED (worker rated the job)',
    'request:paid': '💰 PAID — worker credited',
    'request:cancelled': '🚫 CANCELLED',
  };
  Object.entries(events).forEach(([event, label]) => {
    socket.on(event, async (d) => {
      stopCountdown();
      log(event, { label, ...(d.reason ? { reason: d.reason } : {}), ...(d.newlyOffered !== undefined ? { newlyOffered: d.newlyOffered } : {}) });
      showRequest(d.request);
      if (AUTO && d.request && d.request.payment && d.request.payment.payable) await pay('upi');
    });
  });
}

async function book(category, subcategory) {
  const res = await api('POST', '/api/user/service-requests', {
    category: category || CATEGORY,
    subcategory: subcategory || SUBCATEGORY || undefined,
    jobDescription: 'Test booking from user-client — 2BHK, kitchen needs a deep clean.',
    lat: LAT,
    lng: LNG,
    address: 'Test address, Bengaluru',
  });
  if (!res.success) {
    console.error(`✗ book (${res.status}):`, res.message);
    // 409 hands back the request already in flight — show that instead of nothing.
    if (res.request) showRequest(res.request);
    return;
  }
  console.log(`✓ booked · ${res.workersNotified} worker(s) notified · ${res.searchWindowSeconds}s to accept`);
  showRequest(res.request);
}

async function pay(method) {
  if (!activeId) return console.log('  nothing to pay — book a job first');
  const init = await api('POST', `/api/user/service-requests/${activeId}/payment/initiate`, {
    method: method || 'upi',
  });
  if (!init.success) return console.error(`✗ initiate (${init.status}):`, init.message);
  if (!init.payment) {
    console.log('  already paid');
    return showRequest(init.request);
  }
  console.log(`✓ order ${init.payment.orderId} · ₹${init.payment.amount} · ${init.payment.method} (${init.payment.mode} gateway)`);

  // In mock mode there's no gateway SDK step — a real app would hand orderId to
  // the provider's checkout here and confirm with what it returns.
  const done = await api('POST', `/api/user/service-requests/${activeId}/payment/confirm`, {
    orderId: init.payment.orderId,
  });
  if (!done.success) {
    console.error(`✗ confirm (${done.status}):`, done.message, '— you can initiate again');
    return showRequest(done.request);
  }
  console.log(`✓ ${done.message}${done.workerCredited ? ' (ledger credit written)' : ''}`);
  showRequest(done.request);
}

async function status() {
  const res = activeId
    ? await api('GET', `/api/user/service-requests/${activeId}`)
    : await api('GET', '/api/user/service-requests/active');
  if (!res.success) return console.error('✗', res.message);
  if (!res.request) return console.log('  no active request');
  showRequest(res.request);
}

async function retry() {
  if (!activeId) return console.log('  nothing to retry');
  const res = await api('POST', `/api/user/service-requests/${activeId}/retry`);
  if (!res.success) return console.error(`✗ retry (${res.status}):`, res.message);
  console.log(`✓ ${res.message}`);
  showRequest(res.request);
}

async function cancel() {
  if (!activeId) return console.log('  nothing to cancel');
  const res = await api('POST', `/api/user/service-requests/${activeId}/cancel`);
  console.log(res.success ? '✓ cancelled' : `✗ ${res.message}`);
  if (res.request) showRequest(res.request);
}

async function list() {
  const res = await api('GET', '/api/user/service-requests');
  if (!res.success) return console.error('✗', res.message);
  console.log(`\n  active (${res.active.length}):`);
  res.active.forEach(showRequest);
  console.log(`  history (${res.history.length}):`);
  res.history.forEach((r) =>
    console.log(`  · ${r.id} ${r.status} ₹${r.totalPrice} payment=${r.payment.status}${r.canRetry ? ' (can retry)' : ''}`)
  );
}

// ── CLI ──────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

(async () => {
  console.log(`Kaaryo customer test client → ${SERVER}`);
  const phone = process.env.PHONE || (await ask('10-digit phone: ')).trim();
  const name = process.env.NAME || 'Test Customer';
  await login(phone, name);

  console.log('\ncommands: book [category] [sub] | status | retry | cancel | pay [method] | list | q\n');
  rl.on('line', async (line) => {
    const [cmd, a, b] = line.trim().split(/\s+/);
    try {
      if (cmd === 'book') await book(a, b);
      else if (cmd === 'status') await status();
      else if (cmd === 'retry') await retry();
      else if (cmd === 'cancel') await cancel();
      else if (cmd === 'pay') await pay(a);
      else if (cmd === 'list') await list();
      else if (cmd === 'q') process.exit(0);
      else if (line.trim()) console.log('commands: book | status | retry | cancel | pay | list | q');
    } catch (err) {
      console.error('✗', err.message);
    }
  });
})();
