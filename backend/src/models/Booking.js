const mongoose = require('mongoose');

const bookingSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    event: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Event',
      required: true,
    },

    // ✅ NEW: store booking details used for fixed-quantity ticketing
    name: { type: String, default: '' },
    email: { type: String, default: '' },
    seats: { type: Number, required: true, min: 1, default: 1 },
    registrationTemplate: { type: String, default: 'standard' },
    registrationData: { type: mongoose.Schema.Types.Mixed, default: {} },

    ticketId: {
      type: String,
      required: true,
      unique: true,
    },

    // PENDING | PAID | REFUND_PROCESSING | REFUNDED | CANCELLED
    paymentStatus: { type: String, default: 'PENDING' },
    stripeSessionId: { type: String, default: null },
    stripePaymentIntentId: { type: String, default: null },

    // Specific seat IDs (from utils/seat-map.util.js) when the booking was made with seat selection.
    seatNumbers: { type: [String], default: [] },
    // Amount actually charged, in the smallest currency unit (paise).
    amountPaid: { type: Number, default: 0 },
    currency: { type: String, default: 'inr' },

    // Cancellation / refund (set only by the refund endpoint).
    cancelledAt: { type: Date, default: null },
    refundId: { type: String, default: null },
    refundStatus: { type: String, default: null }, // Stripe refund status: pending | succeeded | failed ...
    refundAmount: { type: Number, default: 0 },    // smallest currency unit
    refundPercent: { type: Number, default: 0 },

    // New: selected show date/time (for multi-day events)
    // Stored as a single datetime for easy display/filtering.
    showAt: { type: Date, default: null },

    bookedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

// Performance indexes for frequent queries
bookingSchema.index({ user: 1, createdAt: -1 });
bookingSchema.index({ event: 1 });

module.exports = mongoose.model('Booking', bookingSchema);
