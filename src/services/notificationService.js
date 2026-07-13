/**
 * Push + SMS notifications sent to the worker (Screen 9 promises: approved /
 * rejected / info-missing notifications).
 *
 * MOCK: logs to console. Reuses smsService for the SMS half.
 * REAL: plug FCM / APNs for push and keep smsService for SMS.
 */

const { sendTransactionalSms } = require('./smsService');

async function notifyWorker(worker, { title, message }) {
  console.log(`🔔 [MOCK PUSH] to ${worker.phone} — ${title}: ${message}`);
  await sendTransactionalSms(worker.phone, `${title}: ${message}`);
  return { pushed: true, smsSent: true };
}

module.exports = { notifyWorker };
