const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const Worker = require('../models/Worker');
const ServiceRequest = require('../models/ServiceRequest');
const dispatch = require('../services/dispatchService');
const { offerView, assignedView } = require('../utils/jobPayload');
const emitter = require('./emitter');

/**
 * Real-time channel for workers.
 *
 * Handshake: pass the worker JWT as `auth.token` (socket.io-client:
 *   io(url, { auth: { token } })).
 *
 * Server → worker events:
 *   jobs:open   { jobs:[offer] }   snapshot of open offers on connect (no polling)
 *   job:offer   offer               a new job was dispatched to this worker
 *   job:taken   { id }              another worker took a job you were offered
 *   job:expired { id }              a job you were offered expired with no taker
 *
 * Worker → server events (with ack callback):
 *   job:accept  { requestId }  ->  { ok, job } | { ok:false, message }
 *   job:decline { requestId }  ->  { ok } | { ok:false, message }
 *   presence:update { isOnline?, lat?, lng? } -> { ok, availability }
 */
function init(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  });
  emitter.setIo(io);

  // Authenticate every socket via the worker JWT before it connects.
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth && socket.handshake.auth.token;
      if (!token) return next(new Error('Auth token missing'));
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const worker = await Worker.findById(decoded.id);
      if (!worker) return next(new Error('Worker not found'));
      socket.workerId = String(worker._id);
      next();
    } catch (err) {
      next(new Error('Invalid or expired token'));
    }
  });

  io.on('connection', async (socket) => {
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

  console.log('🔌 Socket.IO real-time channel ready (worker offers pushed live)');
  return io;
}

module.exports = { init };
