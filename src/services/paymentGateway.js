const crypto = require('crypto');

/**
 * The payment provider seam — the ONLY place that talks to a gateway.
 *
 * Extracted from paymentService so the two things a customer can pay for (a
 * normal service request and a discounted trial job) share one gateway, one mock
 * implementation and one place to wire a real provider. What differs between the
 * two flows is what a capture *triggers* — crediting a worker's ledger vs.
 * crediting a customer's reward — and that stays with each flow's own service.
 *
 * MOCK (default): no network. `createOrder` mints an id and `capture` succeeds
 *       unconditionally, so both flows are testable end to end from a REST
 *       client. PAYMENT_FORCE_FAIL=1 makes every capture decline instead, which
 *       is how the retry paths get exercised.
 * REAL: set PAYMENT_MODE=real and fill in the two marked blocks. No caller
 *       changes — the state machines, idempotency and ledger writes above this
 *       layer are provider-agnostic.
 *
 * Same MODE-switch shape as smsService and payoutService.
 */

const MODE = process.env.PAYMENT_MODE || 'mock';
const FORCE_FAIL = process.env.PAYMENT_FORCE_FAIL === '1';
const PROVIDER = MODE === 'real' ? process.env.PAYMENT_PROVIDER || 'gateway' : 'mock';

// Methods a customer app may send. Shared by both flows so the payment screen is
// identical whichever it is paying for.
const METHODS = ['upi', 'card', 'netbanking', 'wallet', 'cash'];

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}`;
}

/**
 * Open an order with the provider.
 * @returns {Promise<{orderId:string, provider:string}>}
 */
async function createOrder({ amount, currency, method, reference, label = 'request' }) {
  if (MODE === 'real') {
    // ── REAL INTEGRATION #1 ────────────────────────────────────
    // e.g. const order = await razorpay.orders.create({ amount: amount * 100, currency, receipt: reference })
    //      return { orderId: order.id, provider: 'razorpay' };
    throw new Error('PAYMENT_MODE=real but no provider implemented in paymentGateway.js');
  }
  const orderId = newId('order');
  console.log(`💳 [MOCK PAY] order ${orderId} · ₹${amount} ${currency} · ${method} · ${label} ${reference}`);
  return { orderId, provider: PROVIDER };
}

/**
 * Capture an opened order.
 * @returns {Promise<{captured:true, transactionId:string, provider:string} | {captured:false, reason:string}>}
 */
async function capture({ orderId, gatewayReference, amount }) {
  if (MODE === 'real') {
    // ── REAL INTEGRATION #2 ────────────────────────────────────
    // Verify the gateway signature the client handed back, then read the
    // authoritative amount/status off the provider rather than trusting the
    // client's numbers.
    throw new Error('PAYMENT_MODE=real but no provider implemented in paymentGateway.js');
  }
  if (FORCE_FAIL) {
    return { captured: false, reason: 'Payment declined by bank (PAYMENT_FORCE_FAIL=1)' };
  }
  const transactionId = gatewayReference || newId('pay');
  console.log(`💳 [MOCK PAY] captured ₹${amount} · order ${orderId} · txn ${transactionId}`);
  return { captured: true, transactionId, provider: PROVIDER };
}

module.exports = { createOrder, capture, METHODS, MODE, PROVIDER };
