require('dotenv').config();
const connectDB = require('../config/db');
const ShopPartner = require('../models/ShopPartner');
const AssessmentSlot = require('../models/AssessmentSlot');
const slotTime = require('../utils/slotTime');
const {
  PAYMENT_UPFRONT,
  PAYMENT_DEFERRED,
  SLOT_DURATION_MINUTES,
} = require('../config/assessmentConfig');

/**
 * Seed electrical shop partners plus a week of assessment slots, so the worker
 * app has something to book against on a fresh database.
 *
 * Usage:
 *   node src/scripts/seedShopPartners.js                    # seed defaults (Bengaluru)
 *   node src/scripts/seedShopPartners.js --days 14          # 14 days of slots
 *   node src/scripts/seedShopPartners.js --lat 12.93 --lng 77.61
 *                                                           # cluster shops near a point
 *                                                           # (use your test device's location)
 *   node src/scripts/seedShopPartners.js --city Pune
 *   node src/scripts/seedShopPartners.js --reset            # delete existing seeds first
 *
 * Idempotent: partners are matched on ownerPhone and slots on (partner, startsAt),
 * so re-running tops up the calendar rather than duplicating anything.
 */

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

// Times of day each shop opens for assessments (shop-local, 24h).
const SLOT_TIMES = ['10:00', '11:30', '15:00', '16:30'];

// Base shops, offset slightly from the anchor point so the distance sort is visible.
const SHOP_TEMPLATES = [
  { shopName: 'Sri Balaji Electricals', ownerName: 'Ramesh Kumar', ownerPhone: '9800000001', locality: 'Koramangala', dLat: 0.004, dLng: 0.003 },
  { shopName: 'New Light Electrical Works', ownerName: 'Imran Shaikh', ownerPhone: '9800000002', locality: 'Indiranagar', dLat: 0.012, dLng: -0.009 },
  { shopName: 'Ganesh Electrical Store', ownerName: 'Suresh Patil', ownerPhone: '9800000003', locality: 'HSR Layout', dLat: -0.021, dLng: 0.017 },
  { shopName: 'Modern Wiring & Repairs', ownerName: 'Anil Verma', ownerPhone: '9800000004', locality: 'BTM Layout', dLat: 0.035, dLng: 0.028 },
];

(async () => {
  await connectDB();

  const city = arg('city', 'Bengaluru');
  const days = Number(arg('days', 7));
  // Default anchor: central Bengaluru. Override with your device's coordinates so
  // the 500 m check-in geofence can actually be satisfied while testing.
  const anchorLat = Number(arg('lat', 12.9716));
  const anchorLng = Number(arg('lng', 77.5946));

  if (hasFlag('reset')) {
    const phones = SHOP_TEMPLATES.map((s) => s.ownerPhone);
    const doomed = await ShopPartner.find({ ownerPhone: { $in: phones } }).select('_id');
    await AssessmentSlot.deleteMany({ shopPartner: { $in: doomed.map((d) => d._id) } });
    await ShopPartner.deleteMany({ _id: { $in: doomed.map((d) => d._id) } });
    console.log(`🗑  removed ${doomed.length} seeded partner(s) and their slots`);
  }

  let partnersCreated = 0;
  let slotsCreated = 0;

  for (const tpl of SHOP_TEMPLATES) {
    const lat = anchorLat + tpl.dLat;
    const lng = anchorLng + tpl.dLng;

    let partner = await ShopPartner.findOne({ ownerPhone: tpl.ownerPhone });
    if (!partner) {
      partner = await ShopPartner.create({
        shopName: tpl.shopName,
        ownerName: tpl.ownerName,
        ownerPhone: tpl.ownerPhone,
        city,
        locality: tpl.locality,
        fullAddress: `${tpl.shopName}, ${tpl.locality}, ${city}`,
        location: { type: 'Point', coordinates: [lng, lat] },
        googleMapsLink: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`,
        status: 'active',
        feedbackChannel: 'both',
        payment: {
          perAssessment: PAYMENT_UPFRONT + PAYMENT_DEFERRED,
          upfront: PAYMENT_UPFRONT,
          deferred: PAYMENT_DEFERRED,
          method: 'upi',
          upiId: `${tpl.ownerPhone}@upi`,
        },
      });
      partnersCreated += 1;
      console.log(`🏪 created ${partner.shopName} (${tpl.locality}) at ${lat.toFixed(4)},${lng.toFixed(4)}`);
    } else {
      console.log(`↺  ${partner.shopName} already exists — topping up slots`);
    }

    // Build the next `days` days of slots, skipping any already in the past.
    const prepared = [];
    for (let d = 0; d < days; d++) {
      const day = new Date(Date.now() + d * 24 * 60 * 60 * 1000);
      const dateStr = slotTime.localDateKey(day);
      for (const start of SLOT_TIMES) {
        const startsAt = slotTime.toInstant(dateStr, start);
        if (!startsAt || startsAt.getTime() <= Date.now()) continue;
        const endTime = slotTime.addMinutesToHHMM(start, SLOT_DURATION_MINUTES);
        prepared.push({
          shopPartner: partner._id,
          slotDate: slotTime.dateOnly(dateStr),
          slotStartTime: start,
          slotEndTime: endTime,
          startsAt,
          endsAt: slotTime.toInstant(dateStr, endTime),
          maxWorkersPerSlot: 1,
          capacityRemaining: 1,
          isAvailable: true,
        });
      }
    }

    const existing = await AssessmentSlot.find({
      shopPartner: partner._id,
      startsAt: { $in: prepared.map((p) => p.startsAt) },
    }).select('startsAt');
    const taken = new Set(existing.map((e) => e.startsAt.getTime()));
    const toCreate = prepared.filter((p) => !taken.has(p.startsAt.getTime()));

    if (toCreate.length) {
      await AssessmentSlot.insertMany(toCreate);
      slotsCreated += toCreate.length;
    }
    console.log(`   └─ ${toCreate.length} new slot(s), ${taken.size} already present`);
  }

  console.log(
    `\n✅ Done — ${partnersCreated} partner(s) created, ${slotsCreated} slot(s) added in ${city}.` +
      `\n   Anchor point: ${anchorLat},${anchorLng}` +
      `\n   Tip: pass --lat/--lng with your test device's coordinates so check-in passes the 500 m geofence.\n`
  );
  process.exit(0);
})().catch((err) => {
  console.error('❌ seed failed:', err);
  process.exit(1);
});
