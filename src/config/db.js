const mongoose = require('mongoose');

const intFromEnv = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

// Keep the pool bounded for Render's small memory footprint. These defaults
// still allow useful I/O concurrency and can be raised with the instance size.
const connectionOptions = {
  maxPoolSize: intFromEnv('MONGODB_MAX_POOL_SIZE', 20),
  minPoolSize: 0,
  maxIdleTimeMS: intFromEnv('MONGODB_MAX_IDLE_TIME_MS', 30_000),
  serverSelectionTimeoutMS: intFromEnv('MONGODB_SERVER_SELECTION_TIMEOUT_MS', 10_000),
  socketTimeoutMS: intFromEnv('MONGODB_SOCKET_TIMEOUT_MS', 45_000),
  heartbeatFrequencyMS: intFromEnv('MONGODB_HEARTBEAT_FREQUENCY_MS', 10_000),
  retryReads: true,
  retryWrites: true,
};

async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set in .env');

  mongoose.set('strictQuery', true);
  // Production indexes are installed explicitly by `npm run db:indexes` so a
  // deploy never turns into an unbounded background index build.
  mongoose.set('autoIndex', process.env.NODE_ENV !== 'production');
  await mongoose.connect(uri, connectionOptions);
  console.log('✅ MongoDB connected');
  return mongoose.connection;
}

module.exports = connectDB;
module.exports.disconnectDB = async function disconnectDB() {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
};
module.exports.readiness = () => mongoose.connection.readyState === 1;
module.exports.connectionOptions = connectionOptions;
