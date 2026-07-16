const { ok, fail } = require('../utils/response');
const { computeEarningsSummary } = require('../services/earningsService');

// GET /api/earnings/summary?period=week|month
async function getSummary(req, res, next) {
  try {
    const { period } = req.query;
    if (period && !['week', 'month'].includes(period)) {
      return fail(res, 'period must be "week" or "month"', 422);
    }
    const summary = await computeEarningsSummary(req.worker._id, period === 'month' ? 'month' : 'week');
    return ok(res, summary, 'Earnings summary');
  } catch (err) {
    next(err);
  }
}

module.exports = { getSummary };
