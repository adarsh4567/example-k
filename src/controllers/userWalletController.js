const { ok } = require('../utils/response');
const wallet = require('../services/userWalletService');

/**
 * The customer's reward wallet screen. Moved out of userTrialController once
 * referrals became a second thing that funds it — see services/userWalletService.
 */

// GET /api/user/wallet
async function getWallet(req, res, next) {
  try {
    const [balance, transactions] = await Promise.all([
      wallet.getCreditsBalance(req.user._id),
      wallet.listTransactions(req.user._id),
    ]);

    return ok(
      res,
      {
        balance,
        currency: 'INR',
        // Redemption isn't built — see the integration guide. Surfaced explicitly
        // so the app doesn't render a "use balance" control that can't work.
        redeemable: false,
        transactions,
      },
      'Reward wallet'
    );
  } catch (err) {
    next(err);
  }
}

module.exports = { getWallet };
