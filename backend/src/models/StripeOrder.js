// models/StripeOrder.js ✅ UPDATED FILE
const mongoose = require('mongoose');

const StripeOrderSchema = new mongoose.Schema(
  {
    userId: { type: String, default: null }, // will be set from JWT on server
    eventId: { type: String, required: true },
    ticketName: { type: String, required: true },

    // ✅ store buyer info (optional)
    name: { type: String, default: '' },
    email: { type: String, default: '' },
    registrationTemplate: { type: String, default: 'standard' },
    registrationData: { type: mongoose.Schema.Types.Mixed, default: {} },

    // New: selected show datetime (stored so webhook finalization uses same show)
    showAt: { type: Date, default: null },

    // quantity = seats
    quantity: { type: Number, required: true },
    unitAmount: { type: Number, required: true }, // smallest unit: paise
    currency: { type: String, default: 'inr' },

    status: {
      type: String,
      // PROCESSING is a short-lived claim that prevents the webhook and the polling endpoint
      // from finalizing the same order twice.
      enum: ['PENDING', 'PROCESSING', 'PAID', 'EXPIRED', 'CANCELLED', 'FAILED'],
      default: 'PENDING',
    },

    paymentStatus: { type: String, default: null },

    stripeSessionId: { type: String, default: null },
    stripePaymentIntentId: { type: String, default: null },

    // Seat-selected checkout (AI assistant flow). Empty for quantity-only checkouts.
    seatNumbers: { type: [String], default: [] },
    checkoutUrl: { type: String, default: null },
    expiresAt: { type: Date, default: null },
    failureReason: { type: String, default: null },

    // ✅ link created booking (idempotency + easy lookup)
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', default: null },
    ticketId: { type: String, default: null },
  },
  { timestamps: true }
);

StripeOrderSchema.index({ stripeSessionId: 1 });

module.exports = mongoose.model('StripeOrder', StripeOrderSchema);
