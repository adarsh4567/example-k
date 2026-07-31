const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const Worker = require('../models/Worker');
const User = require('../models/User');
const ServiceRequest = require('../models/ServiceRequest');
const TrialJob = require('../models/TrialJob');
const dispatch = require('../services/dispatchService');
const { offerView, assignedView } = require('../utils/jobPayload');
const { customerView } = require('../utils/requestPayload');
const { trialUserView } = require('../utils/trialPayload');
const emitter = require('./emitter');

/**
 * Real-time channel for BOTH apps, on one Socket.IO server.
 *
 * Handshake (identical for both): pass the JWT as `auth.token` (socket.io-client:
 *   io(url, { auth: { token } })).
 *
 * The `type` claim on the token decides which audience a socket belongs to and
 * therefore which room it joins and which events it can send. A worker token gets
 * the worker channel, a user token gets the customer channel, and neither can
 * reach the other's events — the two share JWT_SECRET, so this claim is the whole
 * boundary (same rule as middleware/auth vs middleware/userAuth on the REST side).
 *
 * ── Worker channel (unchanged) ──────────────────────────────────
 * Server → worker:
 *   jobs:open   { jobs:[offer] }   snapshot of open offers on connect (no polling)
 *   job:offer   offer               a new job was dispatched to this worker
 *   job:taken   { id }              another worker took a job you were offered
 *   job:expired { id }              a job you were offered expired with no taker
 *
 * Worker → server (with ack callback):
 *   job:accept  { requestId }  ->  { ok, job } | { ok:false, message }
 *   job:decline { requestId }  ->  { ok } | { ok:false, message }
 *   presence:update { isOnline?, lat?, lng? } -> { ok, availability }
 *
 * ── Customer channel ────────────────────────────────────────────
 * Server → customer (every payload carries the SAME `request` shape the REST
 * endpoints return, so one parser handles both transports):
 *   requests:active   { requests:[request] }  snapshot of live requests on connect
 *   request:searching { request, newlyOffered }  a wave went out / radius grew
 *   request:accepted  { request }   a professional took the job (worker card inside)
 *   request:expired   { request, reason }  nobody accepted; `canRetry` says if
 *                                          the retry button should be live
 *   request:work_done { request }   worker marked the work done → payment is due
 *   request:completed { request }   worker submitted their rating → job closed
 *   request:paid      { request }   payment captured and the worker credited
 *   request:cancelled { request }
 *
 * Discounted trial bookings push a parallel `trial:*` set, each carrying a
 * `trial` object (see utils/trialPayload.trialUserView):
 *   trials:active            { trials:[trial] }  snapshot on connect
 *   trial:searching          { trial, candidateNumber, candidateCount }
 *   trial:accepted           { trial }   a trainee took it (worker card inside)
 *   trial:started            { trial }
 *   trial:feedback_requested { trial }   work done → pay + rate to onboard them
 *   trial:paid               { trial, rewardCredited }
 *   trial:no_workers         { trial, reason }  queue spent; `canRetry` is true
 *   trial:cancelled          { trial }
 *
 * Customer → server: none. Everything the customer does (raise, cancel, retry,
 * pay) is a REST call — those are state-changing, need request bodies and proper
 * status codes, and must work when the socket is down. The socket is a read-only
 * push channel for them.
 */

function init(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  });
  emitter.setIo(io);

  // Authenticate every socket before it connects, and tag it with its audience.
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth && socket.handshake.auth.token;
      if (!token) return next(new Error('Auth token missing'));
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      if (decoded.type === 'user') {
        const user = await User.findById(decoded.id);
        if (!user) return next(new Error('User not found'));
        if (user.status === 'blocked') return next(new Error('This account has been blocked'));
        socket.userId = String(user._id);
        return next();
      }

      // No `type` claim means a worker token issued before the customer app
      // existed — those are still valid, so absent is treated as 'worker'.
      if (decoded.type && decoded.type !== 'worker') return next(new Error('Unsupported token type'));
      const worker = await Worker.findById(decoded.id);
      if (!worker) return next(new Error('Worker not found'));
      socket.workerId = String(worker._id);
      next();
    } catch (err) {
      next(new Error('Invalid or expired token'));
    }
  });

  io.on('connection', async (socket) => {
    // Customer sockets take the read-only path and never register the worker
    // handlers below — so a user token cannot accept a job even by emitting
    // `job:accept` directly, because no listener is bound for it.
    if (socket.userId) return initCustomerSocket(socket);

    socket.join(emitter.room(socket.workerId));
    console.log(`🔌 worker socket CONNECTED: ${socket.workerId} · rooms: ${JSON.stringify([...socket.rooms])}`);
    socket.on('disconnect', (reason) => {
      console.log(`🔌 worker socket DISCONNECTED: ${socket.workerId} (${reason})`);
    });

    // Send the current open offers immediately so the UI is populated without polling.
    try {
      const open = await ServiceRequest.find({
        status: 'searching',
        offers: { $elemMatch: { worker: socket.workerId, status: 'offered' } },
      }).sort({ createdAt: -1 });
      socket.emit('jobs:open', { jobs: open.map((r) => offerView(r, socket.workerId)) });
    } catch (err) {
      /* non-fatal */
    }

    // Accept a job over the socket. First-to-accept still wins (atomic in dispatch).
    socket.on('job:accept', async (data, ack) => {
      const cb = typeof ack === 'function' ? ack : () => {};
      try {
        const worker = await Worker.findById(socket.workerId);
        if (!worker) return cb({ ok: false, message: 'Worker not found' });
        const result = await dispatch.acceptRequest(data && data.requestId, worker);
        if (!result.ok) return cb({ ok: false, message: result.reason });
        cb({ ok: true, job: assignedView(result.request) });
      } catch (err) {
        cb({ ok: false, message: err.message });
      }
    });

    socket.on('job:decline', async (data, ack) => {
      const cb = typeof ack === 'function' ? ack : () => {};
      try {
        const worker = await Worker.findById(socket.workerId);
        if (!worker) return cb({ ok: false, message: 'Worker not found' });
        const result = await dispatch.declineRequest(data && data.requestId, worker);
        if (!result.ok) return cb({ ok: false, message: result.reason });
        cb({ ok: true });
      } catch (err) {
        cb({ ok: false, message: err.message });
      }
    });

    // Optional: manage availability + live location over the socket too.
    socket.on('presence:update', async (data, ack) => {
      const cb = typeof ack === 'function' ? ack : () => {};
      try {
        const worker = await Worker.findById(socket.workerId);
        if (!worker) return cb({ ok: false, message: 'Worker not found' });
        worker.availability = worker.availability || {};
        if (typeof (data && data.isOnline) !== 'undefined') worker.availability.isOnline = !!data.isOnline;
        if (data && data.lat !== undefined && data.lng !== undefined) {
          const lat = Number(data.lat);
          const lng = Number(data.lng);
          if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
            worker.currentLocation = { type: 'Point', coordinates: [lng, lat] };
          }
        }
        worker.availability.lastSeenAt = new Date();
        await worker.save();
        cb({ ok: true, availability: { isOnline: worker.availability.isOnline, location: worker.currentLocation || null } });
      } catch (err) {
        cb({ ok: false, message: err.message });
      }
    });
  });

  console.log('🔌 Socket.IO real-time channel ready (worker offers + customer request updates pushed live)');
  return io;
}

/**
 * The customer half of the connection. Read-only: it joins the customer's room to
 * receive `request:*` pushes and sends one snapshot so a freshly-opened app is
 * correct immediately, without a polling round trip.
 */
async function initCustomerSocket(socket) {
  socket.join(emitter.userRoom(socket.userId));
  console.log(`🔌 customer socket CONNECTED: ${socket.userId}`);
  socket.on('disconnect', (reason) => {
    console.log(`🔌 customer socket DISCONNECTED: ${socket.userId} (${reason})`);
  });

  // Snapshot on connect — this is what makes the flow survive an app restart
  // mid-search. A request whose timer is still running comes back with its
  // remaining seconds, so the countdown resumes at the right number instead of
  // starting over at 60. Same predicate as GET /active, by construction.
  try {
    const live = await ServiceRequest.find(ServiceRequest.liveForUserQuery(socket.userId))
      .sort({ createdAt: -1 })
      .limit(10);
    socket.emit('requests:active', {
      requests: await Promise.all(live.map((r) => customerView(r))),
    });
  } catch (err) {
    /* non-fatal — the customer app's polling GET covers this */
  }

  // Trial bookings ride the same channel but their own event, so an app that
  // hasn't built the trial screens simply never listens for it. A completed trial
  // still owing feedback is included: that form is what onboards the worker, and
  // it's the easiest thing to lose track of across an app restart.
  try {
    const liveTrials = await TrialJob.find(TrialJob.needsCustomerQuery(socket.userId))
      .sort({ createdAt: -1 })
      .limit(5);
    if (liveTrials.length) {
      socket.emit('trials:active', {
        trials: await Promise.all(liveTrials.map((j) => trialUserView(j))),
      });
    }
  } catch (err) {
    /* non-fatal — GET /api/user/trials/active covers this */
  }
}

module.exports = { init };
