const mongoose = require('mongoose');

/**
 * Append-only ledger of money credited to (or debited from) a worker.
 *
 * Written when a customer's payment for a job is captured — this row IS the
 * record that "we credited the worker". Nothing mutates a row after insert; a
 * correction is a new opposing row, never an edit.
 *
 * Why a ledger and not a `balance` number on Worker:
 *   • A single mutable balance loses the "why" the moment it changes. Every
 *     rupee here traces back to a serviceRequest and a gateway transactionId,
 *     which is what any payout reconciliation or customer dispute needs.
 *   • It leaves the worker app's existing Earnings tab completely untouched.
 *     That tab derives its numbers from completed ServiceRequests
 *     (earningsService) and keeps doing exactly that — this collection is the
 *     settlement record behind those numbers, not a replacement for them, so no
 *     worker-side endpoint changed shape.
 *
 * The unique index on { serviceRequest, type } is the real double-credit guard:
 * even if two payment confirmations for one job somehow got past the atomic
 * status flip in paymentService, the second insert violates the index and the
 * worker cannot be paid twice.
 */

const TX_TYPES = ['credit', 'debit'];
const TX_SOURCES = ['service_request', 'adjustment'];

const walletTransactionSchema = new mongoose.Schema(
  {
    worker: { type: mongoose.Schema.Types.ObjectId, ref: 'Worker', required: true, index: true },

    type: { type: String, enum: TX_TYPES, required: true },
    amount: { type: Number, required: true }, // always positive; `type` carries the sign
    currency: { type: String, default: 'INR' },

    source: { type: String, enum: TX_SOURCES, default: 'service_request' },
    serviceRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'ServiceRequest', default: null },

    // What the customer paid in total, and what the platform kept, at the moment
    // of this credit. Denormalised so a rate-card change can't rewrite history.
    gross: Number,
    platformFee: Number,

    // Gateway reference for the customer-side payment that funded this credit.
    paymentTransactionId: { type: String, default: null },
    note: String,
  },
  { timestamps: true }
);

// One credit per job, enforced by the database (see the note above).
walletTransactionSchema.index({ serviceRequest: 1, type: 1 }, { unique: true, sparse: true });

// "Latest transactions for this worker" — the ordering a statement screen wants.
walletTransactionSchema.index({ worker: 1, createdAt: -1 });

walletTransactionSchema.statics.TYPES = TX_TYPES;

module.exports = mongoose.model('WalletTransaction', walletTransactionSchema);
