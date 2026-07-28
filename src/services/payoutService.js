/**
 * Shop-owner payouts for the assessment filter (₹300 upfront + ₹200 deferred).
 *
 * MOCK: logs the payout and returns a synthetic reference number, so the whole
 *       flow is testable end to end without a gateway.
 * REAL: set PAYOUT_MODE=real and implement sendPayout() with your provider
 *       (RazorpayX, Cashfree Payouts, etc.). Everything else stays the same.
 *
 * Same mock/real MODE shape as smsService, so wiring a provider later is a
 * one-function change and no caller needs to know.
 */

const MODE = process.env.PAYOUT_MODE || 'mock';

let mockCounter = 0;

/**
 * Pay a shop partner.
 * @param {Document} partner a ShopPartner document
 * @param {object} opts { amount, purpose, assessmentId }
 * @returns {Promise<{paid:boolean, reference:string, provider:string}>}
 */
async function sendPayout(partner, { amount, purpose, assessmentId }) {
  if (MODE === 'real') {
    // ── REAL INTEGRATION GOES HERE ─────────────────────────────
    // e.g. await razorpayX.payouts.create({ amount: amount * 100, ... })
    throw new Error('PAYOUT_MODE=real but no provider implemented in payoutService.js');
  }

  mockCounter += 1;
  const reference = `MOCKPAY-${Date.now()}-${mockCounter}`;
  console.log(
    `💸 [MOCK PAYOUT] ₹${amount} to ${partner.shopName} (${partner.ownerPhone}) ` +
      `— ${purpose} · assessment ${assessmentId} · ref ${reference}`
  );
  return { paid: true, reference, provider: 'mock' };
}

module.exports = { sendPayout, MODE };
