/**
 * Worker real-time test client — stands in for the (not-yet-built) worker app so
 * you can watch live job offers arrive over Socket.IO and accept them, no polling.
 *
 * Usage:
 *   node scripts/worker-client.js <WORKER_JWT> [serverUrl]
 *   # env alternatives: TOKEN=<jwt> SERVER=http://localhost:4000 AUTO_ACCEPT=1
 *
 * Once connected, it prints every offer. To accept/decline, type at the prompt:
 *   a <requestId>   accept a job
 *   d <requestId>   decline a job
 *   q               quit
 * Set AUTO_ACCEPT=1 to auto-accept the first offer received.
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

function accept(id) {
  socket.emit('job:accept', { requestId: id }, (res) => {
    if (res && res.ok) log('ACCEPTED ✓ (customer contact revealed)', res.job);
    else console.log('   ✗ accept failed:', res && res.message);
  });
}
function decline(id) {
  socket.emit('job:decline', { requestId: id }, (res) => {
    console.log(res && res.ok ? '   declined' : `   decline failed: ${res && res.message}`);
  });
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '' });
rl.on('line', (line) => {
  const [cmd, id] = line.trim().split(/\s+/);
  if (cmd === 'a' && id) accept(id);
  else if (cmd === 'd' && id) decline(id);
  else if (cmd === 'q') process.exit(0);
  else if (line.trim()) console.log('commands: a <id> | d <id> | q');
});
