const mongoose = require('mongoose');
const UserWalletTransaction = require('../models/UserWalletTransaction');

/**
 * The customer's reward wallet, read side.
 *
 * This lived in userTrialService while trial cashback was its only funding
 * source, with a note to move it out "if a second reward reason appears". Two
 * have: referral rewards now write to the same ledger, and the Account hero card
 * reads the balance alongside the Wallet screen. Neither should have to import
 * the trial engine to ask what a customer's credits are.
 *
 * The balance is always the sum of the ledger, never a cached number on User — a
 * single mutable field loses the "why" the moment it changes. See the model.
 */

const RECENT_LIMIT = 50;

/**
 * @returns {Promise<number>} credits in INR — the one number both the Wallet
 *   screen and the Account hero card show.
 */
async function getCreditsBalance(userId) {
  const rows = await UserWalletTransaction.aggregate([
    { $match: { user: new mongoose.Types.ObjectId(String(userId)) } },
    { $group: { _id: '$type', total: { $sum: '$amount' } } },
  ]);
  const by = rows.reduce((acc, r) => ({ ...acc, [r._id]: r.total }), {});
  return (by.credit || 0) - (by.debit || 0);
}

// The statement, newest first. Capped rather than paginated because the ledger
// only grows on a reward — a customer will not have hundreds of these before
// redemption ships and gives the screen a reason to page.
async function listTransactions(userId, limit = RECENT_LIMIT) {
  const rows = await UserWalletTransaction.find({ user: userId }).sort({ createdAt: -1 }).limit(limit);
  return rows.map((t) => ({
    id: t._id,
    type: t.type,
    amount: t.amount,
    currency: t.currency,
    source: t.source,
    note: t.note,
    createdAt: t.createdAt,
  }));
}

module.exports = { getCreditsBalance, listTransactions, RECENT_LIMIT };
