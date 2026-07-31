const mongoose = require('mongoose');

/**
 * Append-only ledger of reward money credited to a CUSTOMER.
 *
 * Today it has one writer: the cashback a customer earns for booking a
 * discounted trial job (40% of what they paid, by default). The row is written
 * when their trial payment is captured.
 *
 * Deliberately a separate collection from WalletTransaction (the worker ledger)
 * rather than one polymorphic table, for the same reason `User` and `Worker` are
 * separate collections: the two have unrelated lifecycles and one phone number
 * may legitimately be both. An `ownerType` discriminator would put customer
 * cashback and worker payouts one forgotten filter away from each other in every
 * balance query — and those are real money in opposite directions.
 *
 * Balance is always the sum of this ledger, never a cached number on User. A
 * single mutable balance loses the "why" the moment it changes; here every rupee
 * traces back to the trial that earned it.
 *
 * The unique index on { source, sourceId, type } makes double-crediting
 * impossible at the database level even if a payment were somehow confirmed
 * twice — the second insert violates the index.
 */

const TX_TYPES = ['credit', 'debit'];
const TX_SOURCES = ['trial_reward', 'adjustment', 'redemption'];

const userWalletTransactionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    type: { type: String, enum: TX_TYPES, required: true },
    amount: { type: Number, required: true }, // always positive; `type` carries the sign
    currency: { type: String, default: 'INR' },

    source: { type: String, enum: TX_SOURCES, default: 'trial_reward' },
    // The document that caused this credit — a TrialJob id for 'trial_reward'.
    // Untyped ref because sources will differ as more reward reasons are added.
    sourceId: { type: mongoose.Schema.Types.ObjectId, default: null },

    // What the customer paid, and the % of it this reward represents, at the
    // moment of crediting. Denormalised so a config change can't rewrite history.
    basedOnAmount: Number,
    percent: Number,

    paymentTransactionId: { type: String, default: null },
    note: String,
  },
  { timestamps: true }
);

// One credit per source document (see the note above).
userWalletTransactionSchema.index({ source: 1, sourceId: 1, type: 1 }, { unique: true, sparse: true });

// "Latest reward activity for this customer" — what a wallet screen wants.
userWalletTransactionSchema.index({ user: 1, createdAt: -1 });

userWalletTransactionSchema.statics.TYPES = TX_TYPES;
userWalletTransactionSchema.statics.SOURCES = TX_SOURCES;

module.exports = mongoose.model('UserWalletTransaction', userWalletTransactionSchema);
