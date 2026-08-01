/**
 * Worker real-time test client — stands in for the worker app so you can watch
 * live job offers arrive over Socket.IO, accept them, drive to the customer and
 * work the job through to completion, no polling and no build.
 *
 * Usage:
 *   node scripts/worker-client.js <WORKER_JWT> [serverUrl]
 *   # env alternatives: TOKEN=<jwt> SERVER=http://localhost:4000 AUTO_ACCEPT=1
 *
 * Once connected, it prints every offer. Commands at the prompt:
 *   a <requestId>   accept a job
 *   d <requestId>   decline a job
 *   drive [km]      simulate travelling to the accepted job from `km` away
 *                   (default 3), pinging location as you close in. Watch the
 *                   customer client flip to "arriving soon" then "arrived".
 *   here            jump to the doorstep in one ping
 *   s               start the job (arrived on site → work begins)
 *   c               mark the work complete → payment falls due
 *   r <1-5>         submit your rating → job closed
 *   q               quit
 * Set AUTO_ACCEPT=1 to auto-accept the first offer received.
 *
 * The accept → drive → start → complete order is the real flow and the server
 * enforces it: /complete before /start answers 409. That is the point of the
 * `s` command — before it existed, accepting a job put "Mark complete" in front
 * of a worker who was still in traffic.
 */

const readline = require('readline');
const { io } = require('socket.io-client');

const token = process.argv[2] || process.env.TOKEN;
const server = process.argv[3] || process.env.SERVER || 'http://localhost:4000';
const autoAccept = process.env.AUTO_ACCEPT === '1';

if (!token) {
  console.error('Provide a worker JWT: node scripts/worker-client.js <WORKER_JWT> [serverUrl]');
  process.exit(1);
}

const socket = io(server, { auth: { token } });
let autoAccepted = false;

function log(label, obj) {
  console.log(`\n[${label}]`, JSON.stringify(obj, null, 2));
}

socket.on('connect', () => console.log(`✅ connected to ${server} (socket ${socket.id}) — waiting for offers...`));
socket.on('connect_error', (err) => console.error('❌ connect error:', err.message));
socket.on('disconnect', (reason) => console.log('⚠️  disconnected:', reason));

socket.on('jobs:open', (data) => log('jobs:open (snapshot)', data));

socket.on('job:offer', (offer) => {
  log('job:offer  ← NEW JOB', offer);
  if (autoAccept && !autoAccepted) {
    autoAccepted = true;
    accept(offer.id);
  } else {
    console.log(`   → type "a ${offer.id}" to accept`);
  }
});

socket.on('job:taken', (d) => log('job:taken (someone else got it)', d));
socket.on('job:expired', (d) => log('job:expired', d));

// The job we're currently on, remembered from the accept ack so the commands
// below don't have to repeat the id (and so `drive` knows where it's driving to).
let current = null; // { id, lat, lng }

function remember(job) {
  const coords = job && job.location && job.location.coordinates;
  current = {
    id: job.id,
    lng: Array.isArray(coords) ? coords[0] : null,
    lat: Array.isArray(coords) ? coords[1] : null,
  };
}

function accept(id) {
  socket.emit('job:accept', { requestId: id }, (res) => {
    if (!res || !res.ok) return console.log('   ✗ accept failed:', res && res.message);
    remember(res.job);
    log('ACCEPTED ✓ (customer contact revealed)', res.job);
    console.log('   → you are EN ROUTE. Type "drive" to travel there, then "s" to start.');
  });
}
function decline(id) {
  socket.emit('job:decline', { requestId: id }, (res) => {
    console.log(res && res.ok ? '   declined' : `   decline failed: ${res && res.message}`);
  });
}

// REST for the state-changing steps, exactly as the worker app should do them:
// they need proper status codes and must work when the socket is down.
async function post(path, body) {
  const res = await fetch(`${server}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// One location ping. Sent over the socket — same service, same validation as
// POST /api/jobs/:id/location, but cheaper on an already-open connection, which
// is what a real app pinging every 5s wants.
function ping(lat, lng, heading) {
  return new Promise((resolve) => {
    socket.emit('job:location', { requestId: current.id, lat, lng, heading, accuracy: 12 }, resolve);
  });
}

/**
 * Simulate the drive in. Starts `km` north of the job and walks in over ~12
 * steps, spaced far enough apart to clear the server's ping throttle. Prints the
 * server's arrival verdict each step so you can watch the geofence trip.
 */
async function drive(km) {
  if (!current || current.lat == null) return console.log('   accept a job first');
  const steps = 12;
  const startLat = current.lat + km / 111.32; // ~111.32 km per degree of latitude
  console.log(`\n🚗 driving in from ${km} km out (${steps} pings)...`);
  for (let i = 1; i <= steps; i += 1) {
    const lat = startLat + ((current.lat - startLat) * i) / steps;
    // eslint-disable-next-line no-await-in-loop
    const res = await ping(lat, current.lng, 180); // heading south, toward the job
    const tag = res && res.ok ? (res.throttled ? 'throttled' : res.arrivalStatus) : `✗ ${res && res.message}`;
    console.log(`   ${String(i).padStart(2)}/${steps}  ${tag}${res && res.changed ? '   ← BADGE CHANGED' : ''}`);
    if (!res || !res.ok) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 3200)); // clear MIN_PING_INTERVAL_MS
  }
  console.log('   arrived. Type "s" to start the job.\n');
}

async function jump() {
  if (!current || current.lat == null) return console.log('   accept a job first');
  const res = await ping(current.lat, current.lng, 0);
  console.log('   ', JSON.stringify(res));
}

async function call(label, path, body) {
  if (!current) return console.log('   accept a job first');
  const { status, body: out } = await post(path, body);
  console.log(`   ${label} → ${status} ${out.message || ''}`);
  if (out.job) console.log('   job:', JSON.stringify({
    status: out.job.status, workStage: out.job.workStage,
    canStart: out.job.canStart, canComplete: out.job.canComplete, canRate: out.job.canRate,
  }));
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '' });
rl.on('line', (line) => {
  const [cmd, arg] = line.trim().split(/\s+/);
  if (cmd === 'a' && arg) accept(arg);
  else if (cmd === 'd' && arg) decline(arg);
  else if (cmd === 'drive') drive(Number(arg) || 3);
  else if (cmd === 'here') jump();
  else if (cmd === 's') call('start', `/api/jobs/${current && current.id}/start`);
  else if (cmd === 'c') call('complete', `/api/jobs/${current && current.id}/complete`);
  else if (cmd === 'r' && arg) call('rate', `/api/jobs/${current && current.id}/rate`, { rating: Number(arg) });
  else if (cmd === 'q') process.exit(0);
  else if (line.trim()) console.log('commands: a <id> | d <id> | drive [km] | here | s | c | r <1-5> | q');
});
