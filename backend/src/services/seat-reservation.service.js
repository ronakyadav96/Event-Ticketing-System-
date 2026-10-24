// src/services/seat-reservation.service.js
// Persistent seat state machine: AVAILABLE -> LOCKED -> BOOKED (and LOCKED -> AVAILABLE on
// expiry / cancellation / payment failure). Backed by the SeatReservation collection whose
// unique (event, showAt, seat) index guarantees no two buyers can hold the same seat.

const mongoose = require('mongoose');
const SeatReservation = require('../models/SeatReservation');

const DUPLICATE_KEY = 11000;

function toObjectId(id) {
  return id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id));
}

// Remove LOCKED holds that have expired but not yet been reaped by the TTL monitor
// (the monitor only runs about once a minute).
async function purgeExpired(eventId, showAt) {
  await SeatReservation.deleteMany({
    event: toObjectId(eventId),
    showAt,
    status: 'LOCKED',
    expiresAt: { $lte: new Date() },
  });
}

async function getSeatStates(eventId, showAt) {
  await purgeExpired(eventId, showAt);
  const docs = await SeatReservation.find({ event: toObjectId(eventId), showAt })
    .select('seat status')
    .lean();
  const booked = [];
  const locked = [];
  for (const d of docs) (d.status === 'BOOKED' ? booked : locked).push(d.seat);
  return { booked, locked };
}

// Atomically lock all `seats` for `orderId`, or none of them.
// Returns { ok: true } or { ok: false, unavailable: [...] }.
async function lockSeats({ eventId, showAt, seats, userId, orderId, expiresAt }) {
  await purgeExpired(eventId, showAt);
  const docs = seats.map((seat) => ({
    event: toObjectId(eventId),
    showAt,
    seat,
    status: 'LOCKED',
    user: String(userId),
    order: toObjectId(orderId),
    expiresAt,
  }));

  try {
    await SeatReservation.insertMany(docs, { ordered: false });
    return { ok: true };
  } catch (err) {
    // Roll back whatever part of this order did get inserted, then report the conflicts.
    await SeatReservation.deleteMany({ order: toObjectId(orderId), status: 'LOCKED' });
    const writeErrors = err?.writeErrors || err?.result?.writeErrors || [];
    const isConflict = err?.code === DUPLICATE_KEY || writeErrors.some((e) => (e.code ?? e.err?.code) === DUPLICATE_KEY);
    if (!isConflict) throw err;
    const taken = await SeatReservation.find({ event: toObjectId(eventId), showAt, seat: { $in: seats } })
      .select('seat')
      .lean();
    return { ok: false, unavailable: taken.map((t) => t.seat) };
  }
}

async function releaseOrderLocks(orderId) {
  const res = await SeatReservation.deleteMany({ order: toObjectId(orderId), status: 'LOCKED' });
  return res.deletedCount || 0;
}

// Convert an order's LOCKED holds into BOOKED seats. Seats whose hold already expired are
// re-acquired if still free. Returns { ok: true } or { ok: false, unavailable: [...] }.
async function confirmOrderSeats({ eventId, showAt, seats, userId, orderId, bookingId }) {
  const order = toObjectId(orderId);
  await SeatReservation.updateMany(
    { order, status: 'LOCKED' },
    { $set: { status: 'BOOKED', booking: bookingId ? toObjectId(bookingId) : null, expiresAt: null } }
  );

  const held = await SeatReservation.find({ order, status: 'BOOKED' }).select('seat').lean();
  const heldSet = new Set(held.map((h) => h.seat));
  const missing = seats.filter((s) => !heldSet.has(s));
  if (!missing.length) return { ok: true };

  await purgeExpired(eventId, showAt);
  try {
    await SeatReservation.insertMany(
      missing.map((seat) => ({
        event: toObjectId(eventId),
        showAt,
        seat,
        status: 'BOOKED',
        user: String(userId),
        order,
        booking: bookingId ? toObjectId(bookingId) : null,
        expiresAt: null,
      })),
      { ordered: false }
    );
    return { ok: true };
  } catch (err) {
    const taken = await SeatReservation.find({
      event: toObjectId(eventId),
      showAt,
      seat: { $in: missing },
      order: { $ne: order },
    })
      .select('seat')
      .lean();
    if (!taken.length) throw err;
    return { ok: false, unavailable: taken.map((t) => t.seat) };
  }
}

async function attachBooking(orderId, bookingId) {
  await SeatReservation.updateMany({ order: toObjectId(orderId) }, { $set: { booking: toObjectId(bookingId) } });
}

async function releaseOrderSeats(orderId) {
  await SeatReservation.deleteMany({ order: toObjectId(orderId) });
}

async function releaseBookingSeats(bookingId) {
  await SeatReservation.deleteMany({ booking: toObjectId(bookingId) });
}

module.exports = {
  getSeatStates,
  lockSeats,
  releaseOrderLocks,
  confirmOrderSeats,
  attachBooking,
  releaseOrderSeats,
  releaseBookingSeats,
};
