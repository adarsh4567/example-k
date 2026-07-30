/**
 * Thin, dependency-free holder for the Socket.IO instance so that any module
 * (e.g. the dispatch engine) can push events to a specific worker's or
 * customer's room without importing the socket wiring — this keeps the require
 * graph acyclic.
 *
 * Rooms are namespaced by audience so the two can never collide, even though a
 * single phone number may legitimately own both a Worker and a User account:
 *   worker:<workerId>   the worker app's device(s)
 *   user:<userId>       the customer app's device(s)
 */

let io = null;

function setIo(instance) {
  io = instance;
}

function room(workerId) {
  return `worker:${String(workerId)}`;
}

function userRoom(userId) {
  return `user:${String(userId)}`;
}

// Push an event to one worker (all their connected devices/tabs).
function emitToWorker(workerId, event, payload) {
  if (!io) return false;
  io.to(room(workerId)).emit(event, payload);
  return true;
}

// Push an event to one customer (all their connected devices/tabs).
// No-ops on a null id: requests raised through the legacy unauthenticated
// endpoint have no `user`, and dispatch shouldn't have to special-case that.
function emitToUser(userId, event, payload) {
  if (!io || !userId) return false;
  io.to(userRoom(userId)).emit(event, payload);
  return true;
}

// Is this worker currently connected via at least one socket?
async function isWorkerConnected(workerId) {
  if (!io) return false;
  const sockets = await io.in(room(workerId)).fetchSockets();
  return sockets.length > 0;
}

module.exports = { setIo, emitToWorker, emitToUser, isWorkerConnected, room, userRoom };
