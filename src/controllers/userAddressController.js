const mongoose = require('mongoose');
const UserAddress = require('../models/UserAddress');
const { ok, fail } = require('../utils/response');

/**
 * The customer's saved addresses, synced so they survive a reinstall.
 *
 * Every handler scopes its query by `user: req.user._id` rather than looking a
 * document up by id and then checking who owns it. Same result on the happy
 * path, but a mismatch reads as "not found" instead of "found, denied" — which
 * is both the honest answer and one that doesn't confirm the id exists.
 */

const MAX_ADDRESSES = 20;

// Same helper as userServiceRequestController — a real coordinate, and not the
// [0,0] that an uninitialised location field produces.
function validCoord(lat, lng) {
  return (
    typeof lat === 'number' && typeof lng === 'number' &&
    !Number.isNaN(lat) && !Number.isNaN(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
  );
}

function addressView(a) {
  return {
    id: a._id,
    label: a.label,
    locality: a.locality,
    city: a.city,
    line: a.line,
    lat: a.lat,
    lng: a.lng,
    isActive: a.isActive,
  };
}

const clean = (v, max) => String(v ?? '').trim().slice(0, max);

// GET /api/user/addresses
async function listAddresses(req, res, next) {
  try {
    const rows = await UserAddress.find({ user: req.user._id }).sort({ createdAt: -1 });
    const active = rows.find((a) => a.isActive);
    return ok(
      res,
      {
        addresses: rows.map(addressView),
        // Surfaced separately so the app doesn't have to scan the list to find
        // the one it should book against.
        activeAddressId: active ? active._id : null,
      },
      'Saved addresses'
    );
  } catch (err) {
    next(err);
  }
}

// POST /api/user/addresses   { label?, locality?, city?, line?, lat, lng }
async function addAddress(req, res, next) {
  try {
    const { label, locality, city, line } = req.body || {};
    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);

    if (!validCoord(lat, lng)) return fail(res, 'A valid lat and lng are required', 422);
    // Something has to identify the address in a list. Coordinates alone give
    // the customer a row they can't tell apart from the next one.
    if (!clean(line, 200) && !clean(locality, 120)) {
      return fail(res, 'Give the address a line or a locality', 422);
    }

    const count = await UserAddress.countDocuments({ user: req.user._id });
    if (count >= MAX_ADDRESSES) {
      return fail(res, `You can save up to ${MAX_ADDRESSES} addresses — remove one first`, 409);
    }

    const address = await UserAddress.create({
      user: req.user._id,
      label: clean(label, 30) || 'Home',
      locality: clean(locality, 120),
      city: clean(city, 80),
      line: clean(line, 200),
      lat,
      lng,
      // The first address saved is the active one by default — otherwise the
      // customer adds an address and still has nothing selected.
      isActive: count === 0,
    });

    return ok(res, { address: addressView(address) }, 'Address saved', 201);
  } catch (err) {
    next(err);
  }
}

// DELETE /api/user/addresses/:id
async function removeAddress(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 'Address not found', 404);

    const deleted = await UserAddress.findOneAndDelete({ _id: req.params.id, user: req.user._id });
    if (!deleted) return fail(res, 'Address not found', 404);

    // Deleting the active address would otherwise leave the customer with a
    // book button and nowhere to send anyone. Promote the most recent survivor.
    let activeAddressId = null;
    if (deleted.isActive) {
      const next_ = await UserAddress.findOne({ user: req.user._id }).sort({ createdAt: -1 });
      if (next_) {
        next_.isActive = true;
        await next_.save();
        activeAddressId = next_._id;
      }
    } else {
      const active = await UserAddress.findOne({ user: req.user._id, isActive: true }).select('_id');
      activeAddressId = active ? active._id : null;
    }

    return ok(res, { removedId: deleted._id, activeAddressId }, 'Address removed');
  } catch (err) {
    next(err);
  }
}

// PUT /api/user/addresses/:id/select
async function selectAddress(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 'Address not found', 404);

    const address = await UserAddress.findOne({ _id: req.params.id, user: req.user._id });
    if (!address) return fail(res, 'Address not found', 404);

    // Clear first, then set: two writes, but the failure mode is "no address
    // selected" rather than "two are", and the app can recover from the first.
    await UserAddress.updateMany(
      { user: req.user._id, isActive: true, _id: { $ne: address._id } },
      { $set: { isActive: false } }
    );
    if (!address.isActive) {
      address.isActive = true;
      await address.save();
    }

    return ok(res, { address: addressView(address), activeAddressId: address._id }, 'Active address set');
  } catch (err) {
    next(err);
  }
}

module.exports = { listAddresses, addAddress, removeAddress, selectAddress, MAX_ADDRESSES };
