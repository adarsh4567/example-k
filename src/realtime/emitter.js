/**
 * Thin, dependency-free holder for the Socket.IO instance so that any module
 * (e.g. the dispatch engine) can push events to a specific worker's room
 * without importing the socket wiring — this keeps the require graph acyclic.
 *
 * Each connected worker joins the room `worker:<workerId>`.
 */

let io = null;

function setIo(instance) {
  io = instance;
}

function room(workerId) {
  return `worker:${String(workerId)}`;
}

// Push an event to one worker (all their connected devices/tabs).
function emitToWorker(workerId, event, payload) {
  if (!io) return false;
  io.to(room(workerId)).emit(event, payload);
  return true;
}

// Is this worker currently connected via at least one socket?
async function isWorkerConnected(workerId) {
  if (!io) return false;
  const sockets = await io.in(room(workerId)).fetchSockets();
  return sockets.length > 0;
}

module.exports = { setIo, emitToWorker, isWorkerConnected, room };
