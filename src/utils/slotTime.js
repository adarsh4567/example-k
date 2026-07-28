/**
 * Slot time helpers. Admins create slots as a calendar date plus wall-clock
 * times in the shop's local timezone (IST by default); everything downstream
 * compares absolute instants. These functions are the only place that conversion
 * happens, so no controller has to reason about offsets.
 *
 * Deliberately dependency-free (no moment/dayjs/date-fns) — a fixed offset is
 * all India needs, and the repo has no date library.
 */

const { TZ_OFFSET_MINUTES } = require('../config/assessmentConfig');

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// 'HH:MM' → { h, m }, or null if malformed.
function parseHHMM(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { h, m: min };
}

const pad = (n) => String(n).padStart(2, '0');

// 'HH:MM' + minutes → 'HH:MM' (wraps within the day; slots never cross midnight
// in practice, but wrapping beats producing '25:00').
function addMinutesToHHMM(value, minutes) {
  const t = parseHHMM(value);
  if (!t) return null;
  const total = (t.h * 60 + t.m + minutes) % (24 * 60);
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

// 'YYYY-MM-DD' → { y, m, d }, or null.
function parseDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

// The calendar day itself, normalised to midnight UTC so date-equality queries work.
function dateOnly(value) {
  const d = parseDate(value);
  if (!d) return null;
  return new Date(Date.UTC(d.y, d.m - 1, d.d, 0, 0, 0, 0));
}

/**
 * Local date + local wall-clock time → the absolute instant.
 * e.g. ('2026-08-02', '10:00') with a +330 offset → 2026-08-02T04:30:00Z
 */
function toInstant(dateValue, hhmm, tzOffsetMinutes = TZ_OFFSET_MINUTES) {
  const d = parseDate(dateValue);
  const t = parseHHMM(hhmm);
  if (!d || !t) return null;
  const utcMs = Date.UTC(d.y, d.m - 1, d.d, t.h, t.m, 0, 0) - tzOffsetMinutes * 60 * 1000;
  return new Date(utcMs);
}

// Shift an instant into shop-local time so the calendar fields read correctly.
function localParts(instant, tzOffsetMinutes = TZ_OFFSET_MINUTES) {
  const shifted = new Date(new Date(instant).getTime() + tzOffsetMinutes * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
    hours: shifted.getUTCHours(),
    minutes: shifted.getUTCMinutes(),
  };
}

// '10:00 AM'
function formatTime(instant, tzOffsetMinutes = TZ_OFFSET_MINUTES) {
  const p = localParts(instant, tzOffsetMinutes);
  const ampm = p.hours >= 12 ? 'PM' : 'AM';
  const h12 = p.hours % 12 === 0 ? 12 : p.hours % 12;
  return `${h12}:${pad(p.minutes)} ${ampm}`;
}

// 'Wednesday, 12 Mar'
function formatDate(instant, tzOffsetMinutes = TZ_OFFSET_MINUTES) {
  const p = localParts(instant, tzOffsetMinutes);
  return `${DAY_NAMES[p.weekday]}, ${p.day} ${MONTH_NAMES[p.month]}`;
}

// 'Wednesday, 12 Mar at 10:00 AM' — the shape used in SMS copy.
function formatDateTime(instant, tzOffsetMinutes = TZ_OFFSET_MINUTES) {
  return `${formatDate(instant, tzOffsetMinutes)} at ${formatTime(instant, tzOffsetMinutes)}`;
}

// 'YYYY-MM-DD' for the shop-local calendar day of an instant — the grouping key
// the slot list uses ("Today", "Tomorrow", …).
function localDateKey(instant, tzOffsetMinutes = TZ_OFFSET_MINUTES) {
  const p = localParts(instant, tzOffsetMinutes);
  return `${p.year}-${pad(p.month + 1)}-${pad(p.day)}`;
}

// Human label for a date key relative to today, in shop-local terms.
function relativeDayLabel(instant, tzOffsetMinutes = TZ_OFFSET_MINUTES) {
  const key = localDateKey(instant, tzOffsetMinutes);
  const todayKey = localDateKey(new Date(), tzOffsetMinutes);
  const tomorrowKey = localDateKey(new Date(Date.now() + 24 * 60 * 60 * 1000), tzOffsetMinutes);
  if (key === todayKey) return 'Today';
  if (key === tomorrowKey) return 'Tomorrow';
  return formatDate(instant, tzOffsetMinutes);
}

module.exports = {
  parseHHMM,
  addMinutesToHHMM,
  parseDate,
  dateOnly,
  toInstant,
  localParts,
  formatTime,
  formatDate,
  formatDateTime,
  localDateKey,
  relativeDayLabel,
};
