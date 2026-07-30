const crypto = require('crypto');
const ServiceRequest = require('../models/ServiceRequest');
const WalletTransaction = require('../models/WalletTransaction');
const { CURRENCY } = require('./pricingService');

/**
 * Customer payment for a finished job, and the worker credit it funds.
 *
 * MOCK (default): no gateway. `initiate` mints an order id and `confirm`
 *       captures it unconditionally — so the whole flow is testable end to end
 *       from a REST client. Set PAYMENT_FORCE_FAIL=1 to make every capture
 *       decline instead, which is how you exercise the retry path.
 * REAL: set PAYMENT_MODE=real and fill in the two marked blocks (create order /
 *       verify signature). Nothing else in the codebase needs to change — the
 *       state machine, idempotency and ledger writes are provider-agnostic.
 *
 * Same MODE-switch shape as smsService and payoutService, so wiring a provider
 * later is a local change no caller has to know about.
 *
 * ── The state machine ───────────────────────────────────────────
 *   not_due ──(worker marks work done)──▶ due
 *   due|failed ──(POST payment/initiate)──▶ processing   [order created]
 *   processing ──(POST payment/confirm, captured)──▶ paid  [+ worker credited]
 *   processing ──(POST payment/confirm, declined)──▶ failed → back to initiate
 *
 * Two properties matter more than the happy path:
 *
 *   Idempotency. Confirming twice must not pay the worker twice. The capture is
 *   an atomic conditional update that only matches a request still awaiting
 *   payment, so exactly one concurrent confirm wins and the losers are told the
 *   job is already paid. The unique index on WalletTransaction is the second,
 *   database-level line of defence.
 *
 *   Never lose a captured payment. The worker credit is written AFTER the money
 *   is marked captured, so a crash in between leaves a paid request with no
 *   ledger row — recoverable — rather than a credited worker with no payment.
 *   creditWorker() is idempotent for exactly that reason and can be re-run.
 */

const MODE = process.env.PAYMENT_MODE || 'mock';
const FORCE_FAIL = process.env.PAYMENT_FORCE_FAIL === '1';
const PROVIDER = MODE === 'real' ? process.env.PAYMENT_PROVIDER || 'gateway' : 'mock';

// Methods the customer app may send. `cash` is settled in the same two calls as
// the online methods (initiate → confirm) rather than getting its own shortcut,
// so the app has one payment code path and one set of states to render.
const METHODS = ServiceRequest.PAYMENT_METHODS;

// Payment is collectable from the moment the work is physically done. It
// deliberately does NOT wait for `completed` (the worker's rating tap): making
// the customer's ability to pay depend on the worker remembering to rate would
// strand the money for a reason the customer can neither see nor fix.
const PAYABLE_JOB_STATUS = ['pending_rating', 'completed'];

const isPayableStatus = (status) => PAYABLE_JOB_STATUS.includes(status);

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}`;
}

/**
 * Mark payment due. Called when the worker marks the on-site work done, and
 * idempotent so re-entering that transition can't reset a payment in flight or
 * already captured.
 * Mutates `request` — the caller saves.
 */
function markDue(request) {
  if (request.payment && request.payment.status !== 'not_due') return request.payment;
  request.payment = request.payment || {};
  request.payment.status = 'due';
  request.payment.amount = (request.pricing && request.pricing.totalPrice) || 0;
  request.payment.currency = (request.pricing && request.pricing.currency) || CURRENCY;
  request.payment.dueAt = new Date();
  return request.payment;
}

// ── Provider seam ────────────────────────────────────────────────

async function createProviderOrder({ amount, currency, method, requestId }) {
  if (MODE === 'real') {
    // ── REAL INTEGRATION #1 ────────────────────────────────────
    // e.g. const order = await razorpay.orders.create({ amount: amount * 100, currency, receipt: requestId })
    //      return { orderId: order.id, provider: 'razorpay' };
    throw new Error('PAYMENT_MODE=real but no provider implemented in paymentService.js');
  }
  const orderId = newId('order');
  console.log(`💳 [MOCK PAY] order ${orderId} · ₹${amount} ${currency} · ${method} · request ${requestId}`);
  return { orderId, provider: PROVIDER };
}

async function captureProviderPayment({ orderId, gatewayReference, amount }) {
  if (MODE === 'real') {
    // ── REAL INTEGRATION #2 ────────────────────────────────────
    // Verify the gateway signature the client handed back, then read the
    // authoritative amount/status off the provider rather than trusting the
    // client's numbers.
    throw new Error('PAYMENT_MODE=real but no provider implemented in paymentService.js');
  }
  if (FORCE_FAIL) {
    return { captured: false, reason: 'Payment declined by bank (PAYMENT_FORCE_FAIL=1)' };
  }
  const transactionId = gatewayReference || newId('pay');
  console.log(`💳 [MOCK PAY] captured ₹${amount} · order ${orderId} · txn ${transactionId}`);
  return { captured: true, transactionId, provider: PROVIDER };
}

// ── Step 1: open a payment ───────────────────────────────────────

/**
 * @returns {{ok:true, request, payment}} | {{ok:false, code, reason}}
 */
async function initiatePayment(request, { method }) {
  if (!isPayableStatus(request.status)) {
    return {
      ok: false,
      code: 409,
      reason: request.status === 'in_progress'
        ? 'The work is still in progress — you can pay once the professional marks it done'
        : `Nothing to pay on a ${request.status} request`,
    };
  }
  if (!method || !METHODS.includes(method)) {
    return { ok: false, code: 422, reason: `method must be one of: ${METHODS.join(', ')}` };
  }

  const payment = request.payment || {};
  if (payment.status === 'paid') {
    // Idempotent: the app may re-open this screen after a lost response.
    return { ok: true, request, payment: request.payment, alreadyPaid: true };
  }
  if (payment.status === 'not_due') {
    // Self-heal: the row reached a payable status without markDue running (a
    // request finished before this feature shipped, or a crash mid-transition).
    markDue(request);
  }

  const amount = (request.pricing && request.pricing.totalPrice) || payment.amount || 0;
  if (!amount) return { ok: false, code: 409, reason: 'This request has no priced amount to pay' };

  const currency = (request.pricing && request.pricing.currency) || CURRENCY;
  const order = await createProviderOrder({
    amount,
    currency,
    method,
    requestId: String(request._id),
  });

  request.payment.status = 'processing';
  request.payment.method = method;
  request.payment.amount = amount;
  request.payment.currency = currency;
  request.payment.orderId = order.orderId;
  request.payment.provider = order.provider;
  request.payment.initiatedAt = new Date();
  request.payment.attempts = (request.payment.attempts || 0) + 1;
  // A fresh attempt clears the previous decline so the app isn't showing a stale
  // "card declined" next to a live order.
  request.payment.failureReason = null;
  request.payment.failedAt = undefined;
  await request.save();

  return { ok: true, request, payment: request.payment };
}

// ── Step 2: capture, then credit the worker ──────────────────────

/**
 * @returns {{ok:true, request, payment, credited}} | {{ok:false, code, reason, request?}}
 */
async function confirmPayment(request, { orderId, gatewayReference } = {}) {
  const payment = request.payment || {};

  if (payment.status === 'paid') {
    // Idempotent success. Re-run the credit in case a crash landed between the
    // capture and the ledger write — creditWorker() no-ops if it already exists.
    await creditWorker(request).catch((err) =>
      console.error('Worker credit retry failed for request', String(request._id), err.message)
    );
    return { ok: true, request, payment: request.payment, alreadyPaid: true, credited: false };
  }
  if (payment.status !== 'processing') {
    return {
      ok: false,
      code: 409,
      reason: payment.status === 'due' || payment.status === 'failed'
        ? 'Start a payment first (POST /payment/initiate)'
        : 'This request has no payment to confirm yet',
    };
  }
  // The order id is the anti-replay tie: a confirm may only capture the attempt
  // it was issued for, never whichever attempt happens to be open now.
  if (orderId && String(orderId) !== String(payment.orderId)) {
    return { ok: false, code: 409, reason: 'orderId does not match the payment in progress' };
  }

  const result = await captureProviderPayment({
    orderId: payment.orderId,
    gatewayReference,
    amount: payment.amount,
  });

  if (!result.captured) {
    request.payment.status = 'failed';
    request.payment.failedAt = new Date();
    request.payment.failureReason = result.reason || 'Payment failed';
    await request.save();
    return { ok: false, code: 402, reason: request.payment.failureReason, request };
  }

  // Atomic capture: only one concurrent confirm can flip `processing` → `paid`,
  // which is what makes double-charging and double-crediting impossible even if
  // the app fires confirm twice.
  const now = new Date();
  const claimed = await ServiceRequest.findOneAndUpdate(
    { _id: request._id, 'payment.status': 'processing' },
    {
      $set: {
        'payment.status': 'paid',
        'payment.paidAt': now,
        'payment.transactionId': result.transactionId,
        'payment.provider': result.provider,
        'payment.failureReason': null,
      },
    },
    { new: true }
  );

  if (!claimed) {
    // Another confirm won the race; report its outcome rather than inventing one.
    const fresh = await ServiceRequest.findById(request._id);
    return { ok: true, request: fresh, payment: fresh.payment, alreadyPaid: true, credited: false };
  }

  const credit = await creditWorker(claimed);
  return { ok: true, request: credit.request || claimed, payment: (credit.request || claimed).payment, credited: credit.created };
}

/**
 * Write the worker's share of a captured payment into the ledger.
 *
 * Idempotent by design — safe to call again after a crash, and called on the
 * already-paid path of confirmPayment for exactly that reason. Returns
 * { created:false } when the credit was already there.
 */
async function creditWorker(request) {
  if (!request.acceptedBy) return { created: false, request, reason: 'no assigned worker' };
  if (!request.payment || request.payment.status !== 'paid') {
    return { created: false, request, reason: 'payment not captured' };
  }

  const existing = await WalletTransaction.findOne({ serviceRequest: request._id, type: 'credit' });
  if (existing) return { created: false, request, transaction: existing };

  const pricing = request.pricing || {};
  const gross = request.payment.amount || pricing.totalPrice || 0;
  // Fall back to deriving the split if an old row has no workerEarning stored.
  const platformFee = pricing.platformFee ?? Math.round(gross * ((pricing.platformFeePercent || 0) / 100));
  const amount = pricing.workerEarning ?? gross - platformFee;

  let transaction;
  try {
    transaction = await WalletTransaction.create({
      worker: request.acceptedBy,
      type: 'credit',
      amount,
      currency: request.payment.currency || pricing.currency || CURRENCY,
      source: 'service_request',
      serviceRequest: request._id,
      gross,
      platformFee,
      paymentTransactionId: request.payment.transactionId || null,
      note: `Job payout · ${request.category}${request.subcategory ? ' / ' + request.subcategory : ''}`,
    });
  } catch (err) {
    // 11000 = the unique { serviceRequest, type } index fired, i.e. a concurrent
    // credit beat us to it. That's the guard working, not an error.
    if (err.code !== 11000) throw err;
    const winner = await WalletTransaction.findOne({ serviceRequest: request._id, type: 'credit' });
    return { created: false, request, transaction: winner };
  }

  const updated = await ServiceRequest.findByIdAndUpdate(
    request._id,
    { $set: { 'payment.workerCreditedAt': transaction.createdAt, 'payment.workerCreditAmount': amount } },
    { new: true }
  );

  console.log(
    `🏦 Worker credited ₹${amount} (of ₹${gross}, platform fee ₹${platformFee}) ` +
      `· worker ${request.acceptedBy} · request ${request._id} · txn ${request.payment.transactionId}`
  );

  return { created: true, request: updated || request, transaction };
}

// Ledger balance for a worker — the sum of the ledger, never a cached number.
async function getWorkerLedgerBalance(workerId) {
  const rows = await WalletTransaction.aggregate([
    { $match: { worker: workerId } },
    { $group: { _id: '$type', total: { $sum: '$amount' } } },
  ]);
  const by = rows.reduce((acc, r) => ({ ...acc, [r._id]: r.total }), {});
  return (by.credit || 0) - (by.debit || 0);
}

module.exports = {
  markDue,
  initiatePayment,
  confirmPayment,
  creditWorker,
  getWorkerLedgerBalance,
  isPayableStatus,
  METHODS,
  MODE,
  PAYABLE_JOB_STATUS,
};
