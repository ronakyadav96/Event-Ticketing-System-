// src/models/SeatReservation.js
// One document per (event, show, seat) that is not AVAILABLE.
//   LOCKED  -> held for a pending Stripe checkout; expires automatically (TTL index)
//   BOOKED  -> belongs to a PAID booking; never expires
// The unique index makes seat locking atomic across concurrent buyers.
const mongoose = require('mongoose');

const seatReservationSchema = new mongoose.Schema(
  {
    event: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
    showAt: { type: Date, required: true },
    seat: { type: String, required: true },
    status: { type: String, enum: ['LOCKED', 'BOOKED'], required: true },
    user: { type: String, required: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'StripeOrder', default: null },
    booking: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', default: null },
    // Only LOCKED holds carry an expiry; Mongo's TTL monitor removes them after it passes.
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true }
);

seatReservationSchema.index({ event: 1, showAt: 1, seat: 1 }, { unique: true });
seatReservationSchema.index({ order: 1 });
seatReservationSchema.index({ booking: 1 });
seatReservationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('SeatReservation', seatReservationSchema);
