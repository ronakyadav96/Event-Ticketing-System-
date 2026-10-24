// src/utils/showtime.util.js
// Shared date, timezone, and showtime validation helpers for Booking & Payment controllers.

function parseShowAt(input) {
  if (!input) return null;
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

function getEventTimeZone() {
  return (process.env.EVENT_TIMEZONE || 'Asia/Kolkata').trim() || 'Asia/Kolkata';
}

function yyyyMmDdInTz(d, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);

  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function hhmmInTz(d, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);

  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.hour}:${map.minute}`;
}

function isShowTimeAllowed(eventDoc, showAt) {
  if (!eventDoc || !showAt) return true;

  const start = eventDoc.startDate ? new Date(eventDoc.startDate) : null;
  const end = eventDoc.endDate ? new Date(eventDoc.endDate) : null;
  const times = Array.isArray(eventDoc.showTimes) ? eventDoc.showTimes : [];
  const tz = getEventTimeZone();

  if (start && !Number.isNaN(start.getTime())) {
    const showDateOnly = new Date(`${yyyyMmDdInTz(showAt, tz)}T00:00:00.000Z`);

    if (showDateOnly.getTime() < start.getTime()) return false;

    if (end && !Number.isNaN(end.getTime()) && showDateOnly.getTime() > end.getTime()) {
      return false;
    }
  }

  if (times.length) {
    const hhmm = hhmmInTz(showAt, tz);
    if (!times.includes(hhmm)) return false;
  }

  return true;
}

// Offset (ms) between the given time zone and UTC at instant `d`.
function tzOffsetMs(d, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(d);
  const m = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour, +m.minute, +m.second);
  return asUtc - Math.floor(d.getTime() / 1000) * 1000;
}

// Convert a wall-clock date ("YYYY-MM-DD") + time ("HH:mm") in `timeZone` to a UTC Date.
function zonedDateTimeToUtc(dateStr, hhmm, timeZone = getEventTimeZone()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return null;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(hhmm || ''))) return null;
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0, 0);
  let result = guess - tzOffsetMs(new Date(guess), timeZone);
  // Re-evaluate once in case the offset differs at the corrected instant (DST edges).
  result = guess - tzOffsetMs(new Date(result), timeZone);
  return new Date(result);
}

// Every bookable (future) show slot of an event, in the event time zone.
// Returns [{ date: 'YYYY-MM-DD', time: 'HH:mm', showAt: ISO string }] sorted ascending.
function listShowSlots(eventDoc, { now = new Date(), maxDays = 31 } = {}) {
  if (!eventDoc) return [];
  const tz = getEventTimeZone();

  const startRaw = eventDoc.startDate || eventDoc.date;
  const endRaw = eventDoc.endDate || eventDoc.startDate || eventDoc.date;
  if (!startRaw) return [];
  const start = new Date(startRaw);
  const end = new Date(endRaw);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];

  let times = Array.isArray(eventDoc.showTimes) ? eventDoc.showTimes.filter(Boolean) : [];
  if (!times.length && eventDoc.date) times = [hhmmInTz(new Date(eventDoc.date), tz)];

  const slots = [];
  // startDate/endDate are stored as UTC midnight of the selected calendar dates.
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const last = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  let days = 0;
  while (cursor.getTime() <= last && days < 366) {
    const dateStr = cursor.toISOString().slice(0, 10);
    for (const t of [...times].sort()) {
      const showAt = zonedDateTimeToUtc(dateStr, t, tz);
      if (showAt && showAt.getTime() > now.getTime()) {
        slots.push({ date: dateStr, time: t, showAt: showAt.toISOString() });
      }
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    days += 1;
  }

  const distinctDates = [...new Set(slots.map((s) => s.date))].slice(0, maxDays);
  return slots.filter((s) => distinctDates.includes(s.date));
}

// True when `showAt` is exactly one of the event's future show slots.
function isBookableSlot(eventDoc, showAt, now = new Date()) {
  if (!showAt || Number.isNaN(new Date(showAt).getTime())) return false;
  const iso = new Date(showAt).toISOString();
  return listShowSlots(eventDoc, { now, maxDays: 366 }).some((s) => s.showAt === iso);
}

module.exports = {
  parseShowAt,
  getEventTimeZone,
  yyyyMmDdInTz,
  hhmmInTz,
  isShowTimeAllowed,
  zonedDateTimeToUtc,
  listShowSlots,
  isBookableSlot,
};

