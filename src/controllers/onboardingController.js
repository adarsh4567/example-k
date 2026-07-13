const Worker = require('../models/Worker');
const { ok, fail } = require('../utils/response');
const { isValidAadhaar, isValidPincode, isValidPhone, isValidOtp, ageFromDob } = require('../utils/validators');
const { requestAadhaarOtp, verifyAadhaarOtp, requestEsignOtp, verifyEsignOtp } = require('../services/aadhaarService');
const { matchFaces } = require('../services/faceMatchService');
const { OPERATING_CITIES } = require('../services/placesService');

const STEPS = Worker.STEPS;
const nextStep = (step) => {
  const i = STEPS.indexOf(step);
  return i >= 0 && i < STEPS.length - 1 ? STEPS[i + 1] : step;
};
// Advance onboardingStep only forward (never regress if a worker re-submits a screen).
function advance(worker, completedStep) {
  const target = nextStep(completedStep);
  if (STEPS.indexOf(target) > STEPS.indexOf(worker.onboardingStep)) {
    worker.onboardingStep = target;
  }
}

// Reject edits once the application has been submitted / decided.
function ensureEditable(worker, res) {
  if (['submitted', 'under_review', 'manual_review', 'approved', 'rejected'].includes(worker.status)) {
    fail(res, `Application is ${worker.status} and can no longer be edited`, 409);
    return false;
  }
  return true;
}

const VALID_CLEANING_TYPES = [
  'basic_home', 'kitchen', 'bathroom', 'deep_cleaning',
  'sofa_carpet', 'office_commercial', 'post_construction',
];
const VALID_EQUIPMENT = ['mop', 'broom', 'bucket', 'cleaning_cloth', 'scrubbing_brush'];

// ── Screen 2: Personal details ───────────────────────────────
async function updatePersonal(req, res, next) {
  try {
    const worker = req.worker;
    if (!ensureEditable(worker, res)) return;

    const { fullName, dob, gender } = req.body;
    if (!fullName || !fullName.trim()) return fail(res, 'Full name is required', 422);
    if (!dob) return fail(res, 'Date of birth is required', 422);

    const age = ageFromDob(dob);
    if (age === null) return fail(res, 'Invalid date of birth', 422);
    if (age < 18) return fail(res, 'You must be at least 18 years old to register', 422);

    if (!['male', 'female', 'prefer_not_to_say'].includes(gender)) {
      return fail(res, 'Gender must be male, female, or prefer_not_to_say', 422);
    }
    // Profile photo is mandatory — live selfie only (client opens front camera; we just receive the file).
    if (!req.file) return fail(res, 'Profile photo (live selfie) is required', 422);

    worker.fullName = fullName.trim();
    worker.dob = new Date(dob);
    worker.gender = gender;
    worker.profilePhoto = `/uploads/${req.file.filename}`;
    advance(worker, 'personal');
    await worker.save();

    return ok(res, { profilePhoto: worker.profilePhoto, onboardingStep: worker.onboardingStep },
      'Personal details saved');
  } catch (err) {
    next(err);
  }
}

// ── Screen 3: Location ───────────────────────────────────────
async function updateLocation(req, res, next) {
  try {
    const worker = req.worker;
    if (!ensureEditable(worker, res)) return;

    const { city, area, pincode, address, travelRadiusKm } = req.body;
    if (!OPERATING_CITIES.includes(city)) {
      return fail(res, `City must be one of: ${OPERATING_CITIES.join(', ')}`, 422);
    }
    if (!area || !area.trim()) return fail(res, 'Area / locality is required', 422);
    if (!isValidPincode(pincode)) return fail(res, 'Enter a valid 6-digit pincode', 422);
    if (!address || !address.trim()) return fail(res, 'Full residential address is required', 422);
    if (![1, 2, 5, 10].includes(Number(travelRadiusKm))) {
      return fail(res, 'Travel radius must be 1, 2, 5, or 10 km', 422);
    }

    worker.location = {
      city, area: area.trim(), pincode: String(pincode),
      address: address.trim(), travelRadiusKm: Number(travelRadiusKm),
    };
    advance(worker, 'location');
    await worker.save();
    return ok(res, { location: worker.location, onboardingStep: worker.onboardingStep }, 'Location saved');
  } catch (err) {
    next(err);
  }
}

// ── Screen 4: Aadhaar — request OTP ──────────────────────────
async function aadhaarRequestOtp(req, res, next) {
  try {
    const worker = req.worker;
    if (!ensureEditable(worker, res)) return;

    const { aadhaarNumber } = req.body;
    if (!isValidAadhaar(aadhaarNumber)) return fail(res, 'Enter a valid 12-digit Aadhaar number', 422);

    const result = await requestAadhaarOtp(aadhaarNumber);
    if (!result.success) return fail(res, result.message || 'Could not send Aadhaar OTP', 400);

    return ok(res, { refId: result.refId }, result.message);
  } catch (err) {
    next(err);
  }
}

// ── Screen 4: Aadhaar — verify OTP ───────────────────────────
async function aadhaarVerify(req, res, next) {
  try {
    const worker = req.worker;
    if (!ensureEditable(worker, res)) return;

    const { aadhaarNumber, otp, refId } = req.body;
    if (!isValidAadhaar(aadhaarNumber)) return fail(res, 'Enter a valid 12-digit Aadhaar number', 422);
    if (!isValidOtp(otp)) return fail(res, 'Enter a valid Aadhaar OTP', 422);

    const result = await verifyAadhaarOtp(aadhaarNumber, otp, refId);
    if (!result.success) return fail(res, result.message || 'Aadhaar verification failed', 400);

    worker.aadhaar = {
      last4: aadhaarNumber.slice(-4),
      verified: true,
      nameFromAadhaar: result.demographics.name,
      dobFromAadhaar: result.demographics.dob,
      photoRef: result.photoRef,
      mobileMismatch: !!result.mobileMismatch,
      verifiedAt: new Date(),
    };
    advance(worker, 'aadhaar');
    await worker.save();

    return ok(
      res,
      {
        // Returned for the user to CONFIRM (Screen 4 note: auto-fill name & DOB from Aadhaar).
        confirmDetails: { name: result.demographics.name, dob: result.demographics.dob },
        mobileMismatch: worker.aadhaar.mobileMismatch,
        onboardingStep: worker.onboardingStep,
      },
      worker.aadhaar.mobileMismatch
        ? 'Aadhaar verified. Note: your Aadhaar-linked mobile differs from your registered number.'
        : 'Aadhaar verified successfully'
    );
  } catch (err) {
    next(err);
  }
}

// ── Screen 5: Face match ─────────────────────────────────────
async function faceMatch(req, res, next) {
  try {
    const worker = req.worker;
    if (!ensureEditable(worker, res)) return;

    if (!worker.aadhaar || !worker.aadhaar.verified) {
      return fail(res, 'Complete Aadhaar verification before face match', 400);
    }
    if (!req.file) return fail(res, 'Live selfie is required', 422);

    if (!worker.faceMatch) worker.faceMatch = {};
    worker.faceMatch.selfiePath = `/uploads/${req.file.filename}`;
    worker.faceMatch.attempts = (worker.faceMatch.attempts || 0) + 1;

    const { matched } = await matchFaces(worker.faceMatch.selfiePath, worker.aadhaar.photoRef);

    if (matched) {
      worker.faceMatch.status = 'success';
      advance(worker, 'face_match');
      await worker.save();
      return ok(res, { onboardingStep: worker.onboardingStep }, 'Face verified successfully');
    }

    // Failed. Allow exactly one retry; on the second failure flag for manual review.
    if (worker.faceMatch.attempts >= 2) {
      worker.faceMatch.status = 'manual_review';
      worker.status = 'manual_review';
      worker.reviewLog.push({ action: 'flagged', by: 'system', message: 'Face match failed twice' });
      await worker.save();
      return ok(res, { manualReview: true },
        'We could not verify your photo. Your application has been sent for manual review.', 200);
    }

    worker.faceMatch.status = 'failed';
    await worker.save();
    return fail(res, 'Face did not match. Please retry — remove glasses, ensure good lighting, look straight at the camera.',
      400, { retryAllowed: true, attempts: worker.faceMatch.attempts });
  } catch (err) {
    next(err);
  }
}

// ── Screen 6: Work details & skills ──────────────────────────
async function updateWorkDetails(req, res, next) {
  try {
    const worker = req.worker;
    if (!ensureEditable(worker, res)) return;

    const {
      cleaningTypes, experience, workedBefore, prevPlatform,
      ownsEquipment, equipmentList, workingHours, workingDays,
    } = req.body;

    if (!Array.isArray(cleaningTypes) || cleaningTypes.length === 0) {
      return fail(res, 'Select at least one type of cleaning you can do', 422);
    }
    const badType = cleaningTypes.find((t) => !VALID_CLEANING_TYPES.includes(t));
    if (badType) return fail(res, `Invalid cleaning type: ${badType}`, 422);

    if (!['lt_1', '1_3', '3_5', 'gt_5'].includes(experience)) {
      return fail(res, 'Select a valid experience range', 422);
    }
    if (!['morning', 'afternoon', 'evening', 'flexible'].includes(workingHours)) {
      return fail(res, 'Select valid preferred working hours', 422);
    }
    if (!['weekdays', 'weekends', 'all_days'].includes(workingDays)) {
      return fail(res, 'Select valid preferred working days', 422);
    }

    const work = {
      cleaningTypes,
      experience,
      workedBefore: !!workedBefore,
      workingHours,
      workingDays,
      ownsEquipment: !!ownsEquipment,
    };

    if (work.workedBefore) {
      if (!prevPlatform || !prevPlatform.name) {
        return fail(res, 'Provide the platform/agency name and duration', 422);
      }
      work.prevPlatform = { name: prevPlatform.name, duration: prevPlatform.duration || '' };
    }
    if (work.ownsEquipment) {
      const eq = Array.isArray(equipmentList) ? equipmentList : [];
      const badEq = eq.find((e) => !VALID_EQUIPMENT.includes(e));
      if (badEq) return fail(res, `Invalid equipment item: ${badEq}`, 422);
      work.equipmentList = eq;
    }

    worker.work = work;
    advance(worker, 'work_details');
    await worker.save();
    return ok(res, { work: worker.work, onboardingStep: worker.onboardingStep }, 'Work details saved');
  } catch (err) {
    next(err);
  }
}

// ── Screen 7: References ─────────────────────────────────────
async function updateReferences(req, res, next) {
  try {
    const worker = req.worker;
    if (!ensureEditable(worker, res)) return;

    const { references, referenceConsent } = req.body;
    if (!referenceConsent) return fail(res, 'You must allow Kaaryo to contact your references', 422);
    if (!Array.isArray(references) || references.length < 1) {
      return fail(res, 'At least one reference is required', 422);
    }
    if (references.length > 2) return fail(res, 'You can add at most two references', 422);

    const validRelations = ['past_employer', 'neighbor', 'known_family', 'other'];
    const phones = [];
    for (const [idx, ref] of references.entries()) {
      if (!ref.name || !ref.name.trim()) return fail(res, `Reference ${idx + 1}: name is required`, 422);
      if (!validRelations.includes(ref.relationship)) {
        return fail(res, `Reference ${idx + 1}: invalid relationship`, 422);
      }
      if (!isValidPhone(ref.phone)) return fail(res, `Reference ${idx + 1}: enter a valid phone number`, 422);
      if (ref.phone === worker.phone) {
        return fail(res, `Reference ${idx + 1}: cannot be your own registered number`, 422);
      }
      if (phones.includes(ref.phone)) {
        return fail(res, 'The two references cannot have the same phone number', 422);
      }
      phones.push(ref.phone);
    }

    worker.references = references.map((r) => ({
      name: r.name.trim(), relationship: r.relationship, phone: r.phone,
    }));
    worker.referenceConsent = true;
    advance(worker, 'references');
    await worker.save();
    return ok(res, { references: worker.references, onboardingStep: worker.onboardingStep },
      'References saved');
  } catch (err) {
    next(err);
  }
}

// ── Screen 8: Aadhaar e-sign — request OTP (demo mock, alternative to signature pad) ──
async function esignRequestOtp(req, res, next) {
  try {
    const worker = req.worker;
    if (!ensureEditable(worker, res)) return;
    if (!worker.aadhaar || !worker.aadhaar.verified) {
      return fail(res, 'Complete Aadhaar verification (Screen 4) before e-signing', 400);
    }

    const result = await requestEsignOtp();
    return ok(res, {}, result.message);
  } catch (err) {
    next(err);
  }
}

// ── Screen 8: Aadhaar e-sign — verify OTP ─────────────────────
async function esignVerifyOtp(req, res, next) {
  try {
    const worker = req.worker;
    if (!ensureEditable(worker, res)) return;

    const { otp } = req.body;
    if (!isValidOtp(otp)) return fail(res, 'Enter a valid OTP', 422);

    const result = await verifyEsignOtp(otp);
    if (!result.success) return fail(res, result.message, 400);

    worker.consent = worker.consent || {};
    worker.consent.esignVerified = true;
    worker.consent.signaturePath = result.esignRef;
    await worker.save();
    return ok(res, {}, 'Aadhaar e-sign verified. You can now submit your consent.');
  } catch (err) {
    next(err);
  }
}

// ── Screen 8: Background check consent ───────────────────────
async function submitConsent(req, res, next) {
  try {
    const worker = req.worker;
    if (!ensureEditable(worker, res)) return;

    // Booleans may arrive as strings from multipart forms.
    const bg = req.body.backgroundCheck === true || req.body.backgroundCheck === 'true';
    const info = req.body.infoAccurate === true || req.body.infoAccurate === 'true';

    if (!bg) return fail(res, 'You must consent to the background verification check', 422);
    if (!info) return fail(res, 'You must confirm that your information is accurate and true', 422);

    // Legally binding signature: either an uploaded signature-pad image OR a
    // server-verified Aadhaar e-sign (via /consent/esign/request-otp + /verify above).
    const alreadyEsigned = !!(worker.consent && worker.consent.esignVerified);
    if (!req.file && !alreadyEsigned) {
      return fail(res, 'A digital signature (upload) or Aadhaar e-sign (via /consent/esign/verify) is required', 422);
    }

    worker.consent = {
      backgroundCheck: true,
      infoAccurate: true,
      signaturePath: req.file ? `/uploads/${req.file.filename}` : worker.consent.signaturePath,
      signedAt: new Date(),
      esignVerified: alreadyEsigned,
    };
    advance(worker, 'consent');
    await worker.save();
    return ok(res, { signedAt: worker.consent.signedAt, onboardingStep: worker.onboardingStep },
      'Consent recorded');
  } catch (err) {
    next(err);
  }
}

// Build a simple referral code from the worker id (deterministic, no RNG).
function buildReferralCode(worker) {
  return `KAARYO-${String(worker._id).slice(-6).toUpperCase()}`;
}

// ── Screen 9: Submit application ─────────────────────────────
async function submitApplication(req, res, next) {
  try {
    const worker = req.worker;
    if (worker.status !== 'in_progress') {
      return fail(res, `Application already ${worker.status}`, 409);
    }

    // Ensure every prior screen is complete before submission.
    const missing = [];
    if (!worker.fullName || !worker.profilePhoto) missing.push('personal details');
    if (!worker.location || !worker.location.city) missing.push('location');
    if (!worker.aadhaar || !worker.aadhaar.verified) missing.push('Aadhaar verification');
    if (!worker.faceMatch || worker.faceMatch.status !== 'success') missing.push('face verification');
    if (!worker.work || !worker.work.cleaningTypes || worker.work.cleaningTypes.length === 0) missing.push('work details');
    if (!worker.references || worker.references.length === 0) missing.push('references');
    if (!worker.consent || !worker.consent.backgroundCheck || !worker.consent.infoAccurate) missing.push('consent');
    if (missing.length) return fail(res, `Please complete: ${missing.join(', ')}`, 400, { missing });

    worker.status = 'submitted';
    worker.onboardingStep = 'submitted';
    worker.submittedAt = new Date();
    worker.referralCode = buildReferralCode(worker);
    worker.reviewLog.push({ action: 'submitted', by: 'worker', message: 'Application submitted' });
    await worker.save();

    return ok(
      res,
      {
        name: worker.fullName,
        referralCode: worker.referralCode,
        nextSteps: [
          { step: 1, title: 'Application review', eta: '24 to 48 hours' },
          { step: 2, title: 'References contacted', eta: '' },
          { step: 3, title: 'Background verification', eta: '2 to 3 working days' },
          { step: 4, title: 'Approval / rejection notification (app + SMS)', eta: '' },
        ],
      },
      `Congratulations ${worker.fullName}! Your application has been submitted.`
    );
  } catch (err) {
    next(err);
  }
}

// ── Progress / status tracker ────────────────────────────────
async function getStatus(req, res, next) {
  try {
    const worker = req.worker;
    return ok(res, {
      status: worker.status,
      onboardingStep: worker.onboardingStep,
      progress: {
        personal: !!worker.fullName,
        location: !!(worker.location && worker.location.city),
        aadhaar: !!(worker.aadhaar && worker.aadhaar.verified),
        faceMatch: worker.faceMatch ? worker.faceMatch.status : 'pending',
        workDetails: !!(worker.work && worker.work.cleaningTypes && worker.work.cleaningTypes.length),
        references: !!(worker.references && worker.references.length),
        consent: !!(worker.consent && worker.consent.backgroundCheck),
        submitted: worker.status !== 'in_progress',
      },
      referralCode: worker.referralCode || null,
      submittedAt: worker.submittedAt || null,
    }, 'Status fetched');
  } catch (err) {
    next(err);
  }
}

module.exports = {
  updatePersonal, updateLocation, aadhaarRequestOtp, aadhaarVerify, faceMatch,
  updateWorkDetails, updateReferences, esignRequestOtp, esignVerifyOtp, submitConsent,
  submitApplication, getStatus,
};
