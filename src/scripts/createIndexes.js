require('dotenv').config();

const connectDB = require('../config/db');

// Load every model before walking mongoose.models; createIndexes() is additive
// and will not drop an existing production index.
[
  '../models/Admin',
  '../models/AssessmentSlot',
  '../models/Otp',
  '../models/ServiceRequest',
  '../models/ShopPartner',
  '../models/SpecializationSubmission',
  '../models/TrialJob',
  '../models/User',
  '../models/UserAddress',
  '../models/UserWalletTransaction',
  '../models/WalletTransaction',
  '../models/Worker',
  '../models/WorkerAssessment',
  '../models/WorkerOnboardingVideo',
  '../models/WorkerStatusTransition',
].forEach(require);

async function assertUniqueData(mongoose) {
  const checks = [
    ['OTP phone/purpose', mongoose.model('Otp'), [
      { $group: { _id: { phone: '$phone', purpose: '$purpose' }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 1 },
    ]],
    ['active user address', mongoose.model('UserAddress'), [
      { $match: { isActive: true } },
      { $group: { _id: '$user', count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 1 },
    ]],
    ['live partner slot instant', mongoose.model('AssessmentSlot'), [
      { $match: { cancelledAt: null } },
      { $group: { _id: { shopPartner: '$shopPartner', startsAt: '$startsAt' }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 1 },
    ]],
  ];

  for (const [label, model, pipeline] of checks) {
    const duplicate = await model.aggregate(pipeline);
    if (duplicate.length) {
      throw new Error(`Cannot create unique index: duplicate ${label} records exist`);
    }
  }
}

async function main() {
  const mongoose = require('mongoose');
  await connectDB();
  await assertUniqueData(mongoose);
  for (const model of Object.values(mongoose.models)) {
    await model.createIndexes();
    console.log(`✅ indexes ready: ${model.collection.collectionName}`);
  }
  await connectDB.disconnectDB();
}

main().catch(async (err) => {
  console.error('❌ index creation failed:', err.message);
  await connectDB.disconnectDB().catch(() => {});
  process.exit(1);
});
