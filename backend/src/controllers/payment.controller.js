const Stripe = require('stripe');
const mongoose = require('mongoose');

const StripeOrder = require('../models/StripeOrder');
const Booking = require('../models/Booking');
const Event = require('../models/Event');
const emailService = require('../services/email.service');
const seatReservations = require('../services/seat-reservation.service');
const { parseShowAt, isBookableSlot } = require('../utils/showtime.util');
const { validateSeatSelection } = require('../utils/seat-map.util');
const { refundQuote } = require('../utils/refund-policy.util');

// Stripe is optional at boot: without a key every payment endpoint answers with a controlled
// PAYMENT_UNAVAILABLE state instead of crashing the whole API or faking a checkout.
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
if (!stripe) {
  console.error('❌ STRIPE_SECRET_KEY missing; payment endpoints will return PAYMENT_UNAVAILABLE');
}

// Stripe requires Checkout Sessions to expire at least 30 minutes after creation, so the
// session gets 31 minutes (measured when it is created). Seat holds last a little longer so a
// payment completed at the last second still finds its seats held.
const CHECKOUT_TTL_MS = 31 * 60 * 1000;
const SEAT_HOLD_TTL_MS = CHECKOUT_TTL_MS + 4 * 60 * 1000;

/* ================= HELPERS ================= */

function generateTicketId() {
  return `TKT-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`.toUpperCase();
}

function requestUserId(req) {
  return String(req.user?.id || req.user?._id || '');
}

function isAdmin(req) {
  return !!req.user?.isAdmin || req.user?.role === 'admin' || req.user?.role === 'superadmin';
}

function frontendBaseUrl() {
  const clientEnv = (process.env.CLIENT_URL || '').split(',')[0]?.trim();
  return (process.env.FRONTEND_URL || clientEnv || 'http://localhost:4200').replace(/\/+$/, '');
}

function paymentUnavailable(res, message) {
  return res.status(503).json({
    success: false,
    status: 'PAYMENT_UNAVAILABLE',
    message: message || 'The payment service is currently unavailable. No charge was made.',
  });
}

// Public projection of an order: what the client / AI service may rely on.
function orderView(order, extra = {}) {
  return {
    success: true,
    orderId: String(order._id),
    sessionId: order.stripeSessionId,
    status: order.status === 'PROCESSING' ? 'PENDING' : order.status,
    eventId: order.eventId,
    eventTitle: order.ticketName,
    showAt: order.showAt ? new Date(order.showAt).toISOString() : null,
    seats: order.seatNumbers || [],
    quantity: order.quantity,
    unitAmount: order.unitAmount,
    amountTotal: order.unitAmount * order.quantity,
    currency: order.currency,
    checkoutUrl: order.status === 'PENDING' ? order.checkoutUrl : null,
    expiresAt: order.expiresAt ? new Date(order.expiresAt).toISOString() : null,
    ticketId: order.ticketId || null,
    bookingId: order.bookingId ? String(order.bookingId) : null,
    failureReason: order.failureReason || null,
    ...extra,
  };
}

async function refundCharge(paymentIntentId, reason) {
  if (!stripe || !paymentIntentId) return null;
  try {
    return await stripe.refunds.create({ payment_intent: paymentIntentId, reason: 'requested_by_customer', metadata: { reason } });
  } catch (err) {
    console.error('❌ Automatic refund failed for', paymentIntentId, err.message);
    return null;
  }
}

/* ================= FINALIZE (verified payment -> booking) ================= */

// Called only with a Stripe session that Stripe itself reported. Creates the PAID booking
// exactly once per order, converts seat holds to BOOKED, and verifies amount/currency/order.
async function finalizePaidOrder({ order, session }) {
  if (order.ticketId && order.bookingId) {
    return { status: 'PAID', order };
  }

  // Claim the order so the webhook and the status endpoint cannot both finalize it.
  const claimed = await StripeOrder.findOneAndUpdate(
    { _id: order._id, status: 'PENDING' },
    { $set: { status: 'PROCESSING' } },
    { new: true }
  );
  if (!claimed) {
    const current = await StripeOrder.findById(order._id);
    return { status: current?.status || 'PENDING', order: current || order };
  }
  order = claimed;

  const fail = async (reason, { refund = true } = {}) => {
    if (refund) await refundCharge(session.payment_intent, reason);
    await seatReservations.releaseOrderSeats(order._id);
    order.status = 'FAILED';
    order.failureReason = reason;
    order.paymentStatus = session.payment_status;
    order.stripePaymentIntentId = session.payment_intent || null;
    await order.save();
    return { status: 'FAILED', order };
  };

  // 1. Verify that Stripe's session really belongs to this order and charged the right amount.
  const expectedAmount = Number(order.unitAmount) * Number(order.quantity);
  if (session.payment_status !== 'paid') {
    order.status = 'PENDING';
    await order.save();
    return { status: 'PENDING', order };
  }
  if (session.metadata?.orderId && session.metadata.orderId !== String(order._id)) {
    return fail('Stripe session does not belong to this order.');
  }
  if (Number(session.amount_total) !== expectedAmount || String(session.currency).toLowerCase() !== order.currency) {
    return fail(`Amount mismatch: charged ${session.amount_total} ${session.currency}, expected ${expectedAmount} ${order.currency}.`);
  }

  const seats = Number(order.quantity || 0);
  const seatNumbers = order.seatNumbers || [];

  // 2. Seats: LOCKED -> BOOKED.
  if (seatNumbers.length) {
    const confirmed = await seatReservations.confirmOrderSeats({
      eventId: order.eventId,
      showAt: order.showAt,
      seats: seatNumbers,
      userId: order.userId,
      orderId: order._id,
    });
    if (!confirmed.ok) {
      return fail(`Seat(s) ${confirmed.unavailable.join(', ')} were taken before payment completed. The charge was refunded.`);
    }
  }

  // 3. Capacity counter (also guards quantity-only checkouts).
  const updatedEvent = await Event.findOneAndUpdate(
    { _id: order.eventId, $expr: { $lte: [{ $add: ['$bookedSeats', seats] }, '$totalSeats'] } },
    { $inc: { bookedSeats: seats } },
    { new: true }
  );
  if (!updatedEvent) {
    return fail('Not enough seats available. The charge was refunded.');
  }

  // 4. Booking.
  const ticketId = generateTicketId();
  let booking;
  try {
    booking = await Booking.create({
      user: order.userId,
      event: order.eventId,
      name: order.name || '',
      email: order.email || '',
      seats,
      seatNumbers,
      amountPaid: Number(session.amount_total),
      currency: order.currency,
      registrationTemplate: order.registrationTemplate || 'standard',
      registrationData: order.registrationData || {},
      ticketId,
      paymentStatus: 'PAID',
      stripeSessionId: session.id,
      stripePaymentIntentId: session.payment_intent || null,
      showAt: order.showAt || null,
    });
  } catch (err) {
    await Event.findByIdAndUpdate(order.eventId, { $inc: { bookedSeats: -seats } });
    await fail(`Booking creation failed: ${err.message}`);
    throw err;
  }

  if (seatNumbers.length) await seatReservations.attachBooking(order._id, booking._id);

  order.status = 'PAID';
  order.bookingId = booking._id;
  order.ticketId = ticketId;
  order.paymentStatus = 'paid';
  order.stripePaymentIntentId = session.payment_intent || null;
  await order.save();

  if (order.email) {
    emailService
      .sendTicketEmail({
        to: order.email,
        ticketId,
        eventTitle: updatedEvent.title || order.ticketName,
        date: order.showAt ? new Date(order.showAt).toLocaleString('en-IN') : '',
        venue: updatedEvent.venue || '',
        seats: seatNumbers.length ? seatNumbers.join(', ') : `${seats} Seat(s)`,
        amount: `Rs ${(Number(session.amount_total) / 100).toFixed(2)}`,
      })
      .catch((e) => console.error('Ticket email dispatch failed:', e));
  }

  return { status: 'PAID', order };
}

async function expireOrder(order, newStatus = 'EXPIRED') {
  await seatReservations.releaseOrderSeats(order._id);
  order.status = newStatus;
  await order.save();
  return order;
}

// Bring a PENDING order in line with Stripe (finalize if paid, release seats if expired).
async function syncOrderWithStripe(order) {
  if (order.status !== 'PENDING' || !order.stripeSessionId || !stripe) return order;
  const session = await stripe.checkout.sessions.retrieve(order.stripeSessionId);
  if (session.payment_status === 'paid') {
    const result = await finalizePaidOrder({ order, session });
    return result.order;
  }
  if (session.status === 'expired') {
    return expireOrder(order, 'EXPIRED');
  }
  return order;
}

/* ================= ORDER STATUS (owner only) ================= */

// GET /api/payments/orders/:sessionId  (also mounted at the legacy verify paths)
exports.getOrderBySession = async (req, res) => {
  try {
    const order = await StripeOrder.findOne({ stripeSessionId: req.params.sessionId });
    if (!order) {
      return res.status(404).json({ success: false, status: 'NOT_FOUND', message: 'Payment order not found.' });
    }
    if (String(order.userId) !== requestUserId(req) && !isAdmin(req)) {
      return res.status(403).json({ success: false, status: 'FORBIDDEN', message: 'This payment does not belong to you.' });
    }

    let synced = order;
    try {
      synced = await syncOrderWithStripe(order);
    } catch (err) {
      console.error('❌ Stripe sync failed:', err.message);
      return res.json(orderView(order, { verification: 'UNAVAILABLE' }));
    }
    return res.json(orderView(synced, { verification: 'VERIFIED' }));
  } catch (err) {
    console.error('❌ Order status error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load payment status.' });
  }
};

/* ================= CANCEL PENDING ORDER (owner only) ================= */

// POST /api/payments/orders/:sessionId/cancel
exports.cancelOrder = async (req, res) => {
  try {
    const order = await StripeOrder.findOne({ stripeSessionId: req.params.sessionId });
    if (!order) return res.status(404).json({ success: false, message: 'Payment order not found.' });
    if (String(order.userId) !== requestUserId(req) && !isAdmin(req)) {
      return res.status(403).json({ success: false, message: 'This payment does not belong to you.' });
    }
    if (order.status !== 'PENDING') {
      return res.json(orderView(order));
    }

    if (stripe) {
      try {
        await stripe.checkout.sessions.expire(order.stripeSessionId);
      } catch (err) {
        // The session may have completed in the meantime; trust Stripe, not the request.
        const synced = await syncOrderWithStripe(order);
        if (synced.status !== 'PENDING') return res.json(orderView(synced));
        console.warn('Stripe session expire failed:', err.message);
      }
    }
    const cancelled = await expireOrder(order, 'CANCELLED');
    return res.json(orderView(cancelled));
  } catch (err) {
    console.error('❌ Cancel order error:', err);
    return res.status(500).json({ success: false, message: 'Failed to cancel payment.' });
  }
};

/* ================= SEAT-SELECTED CHECKOUT (AI assistant) ================= */

// POST /api/payments/checkout
// body: { eventId, showAt (ISO), seats: ["A1","A2"] }
// Price, currency, show validity and seat availability are all decided here.
exports.createSeatCheckout = async (req, res) => {
  if (!stripe) return paymentUnavailable(res);

  const userId = requestUserId(req);
  const { eventId, showAt, seats } = req.body || {};

  if (!eventId || !mongoose.Types.ObjectId.isValid(eventId)) {
    return res.status(400).json({ success: false, status: 'INVALID_EVENT', message: 'A valid eventId is required.' });
  }
  const event = await Event.findById(eventId);
  if (!event) return res.status(404).json({ success: false, status: 'INVALID_EVENT', message: 'Event not found.' });

  const showAtDate = parseShowAt(showAt);
  if (!showAtDate || !isBookableSlot(event, showAtDate)) {
    return res.status(400).json({ success: false, status: 'INVALID_SHOWTIME', message: 'The selected show is not available.' });
  }

  const selection = validateSeatSelection(event.totalSeats, seats);
  if (!selection.ok) {
    return res.status(400).json({ success: false, status: 'INVALID_SEATS', message: selection.message });
  }

  const unitAmount = Math.round(Number(event.price) * 100);
  if (!(unitAmount > 0)) {
    return res.status(400).json({ success: false, status: 'FREE_EVENT', message: 'This event does not require payment.' });
  }

  const now = Date.now();
  const order = await StripeOrder.create({
    userId,
    eventId: String(event._id),
    ticketName: event.title,
    name: req.user?.name || '',
    email: req.user?.email || '',
    showAt: showAtDate,
    quantity: selection.seats.length,
    unitAmount,
    currency: 'inr',
    seatNumbers: selection.seats,
    status: 'PENDING',
    expiresAt: new Date(now + CHECKOUT_TTL_MS),
  });

  const lock = await seatReservations.lockSeats({
    eventId: event._id,
    showAt: showAtDate,
    seats: selection.seats,
    userId,
    orderId: order._id,
    expiresAt: new Date(now + SEAT_HOLD_TTL_MS),
  });
  if (!lock.ok) {
    order.status = 'FAILED';
    order.failureReason = 'SEATS_UNAVAILABLE';
    await order.save();
    return res.status(409).json({
      success: false,
      status: 'SEATS_UNAVAILABLE',
      unavailable: lock.unavailable,
      message: `Seat(s) ${lock.unavailable.join(', ')} are no longer available.`,
    });
  }

  try {
    const base = frontendBaseUrl();
    const sessionExpiresAt = Date.now() + CHECKOUT_TTL_MS;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      client_reference_id: userId,
      customer_email: req.user?.email || undefined,
      expires_at: Math.floor(sessionExpiresAt / 1000),
      line_items: [
        {
          price_data: {
            currency: 'inr',
            product_data: {
              name: event.title,
              description: `${event.venue} | ${showAtDate.toISOString()} | Seats: ${selection.seats.join(', ')}`,
            },
            unit_amount: unitAmount,
          },
          quantity: selection.seats.length,
        },
      ],
      success_url: `${base}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/payment-cancel?session_id={CHECKOUT_SESSION_ID}`,
      metadata: {
        orderId: String(order._id),
        eventId: String(event._id),
        userId,
        seats: selection.seats.join(','),
        showAt: showAtDate.toISOString(),
      },
    });

    order.stripeSessionId = session.id;
    order.checkoutUrl = session.url;
    order.expiresAt = new Date(session.expires_at * 1000);
    await order.save();

    return res.status(201).json(orderView(order));
  } catch (err) {
    console.error('❌ Stripe checkout session error:', err.message);
    await seatReservations.releaseOrderSeats(order._id);
    order.status = 'FAILED';
    order.failureReason = 'PAYMENT_UNAVAILABLE';
    await order.save();
    return paymentUnavailable(res);
  }
};

/* ================= QUANTITY CHECKOUT (web booking page) ================= */

// POST /api/payments/create-checkout-session — used by the Angular booking page, which adds
// snacks and promotions to the per-seat amount. The event must exist; no fallback amounts.
exports.createCheckoutSession = async (req, res) => {
  if (!stripe) return paymentUnavailable(res);
  try {
    const {
      eventId,
      currency = 'inr',
      name,
      email,
      registrationTemplate,
      registrationData,
      showAt,
    } = req.body;

    if (!eventId || !mongoose.Types.ObjectId.isValid(eventId)) {
      return res.status(400).json({ success: false, message: 'A valid eventId is required.' });
    }
    const eventDoc = await Event.findById(eventId).select('title date startDate endDate showTimes price');
    if (!eventDoc) return res.status(404).json({ success: false, message: 'Event not found.' });

    const quantity = Math.max(1, Math.min(10, Number(req.body.quantity ?? req.body.seats ?? 1)));
    const unitAmount = Math.round(Number(req.body.unitAmount ?? 0)) || Math.round(Number(eventDoc.price) * 100);
    if (!(unitAmount > 0)) {
      return res.status(400).json({ success: false, message: 'This event does not require payment.' });
    }

    const showAtDate = parseShowAt(showAt) || (eventDoc.date ? new Date(eventDoc.date) : null);
    if (!showAtDate || Number.isNaN(showAtDate.getTime())) {
      return res.status(400).json({ success: false, message: 'Invalid show date/time.' });
    }

    const order = await StripeOrder.create({
      userId: requestUserId(req),
      eventId: String(eventId),
      ticketName: eventDoc.title,
      name: name || req.user?.name || '',
      email: email || req.user?.email || '',
      registrationTemplate: registrationTemplate || 'standard',
      registrationData: registrationData || {},
      showAt: showAtDate,
      quantity,
      unitAmount,
      currency: String(currency).toLowerCase(),
      status: 'PENDING',
    });

    const base = frontendBaseUrl();
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: order.currency,
            product_data: { name: eventDoc.title },
            unit_amount: unitAmount,
          },
          quantity,
        },
      ],
      success_url: `${base}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/payment-cancel?session_id={CHECKOUT_SESSION_ID}`,
      metadata: { orderId: String(order._id), eventId: String(eventId), userId: requestUserId(req) },
    });

    order.stripeSessionId = session.id;
    order.checkoutUrl = session.url;
    order.expiresAt = session.expires_at ? new Date(session.expires_at * 1000) : null;
    await order.save();

    return res.json({
      success: true,
      url: session.url,
      checkout_url: session.url,
      sessionId: session.id,
      session_id: session.id,
      orderId: String(order._id),
    });
  } catch (err) {
    console.error('❌ Stripe checkout session error:', err.message);
    return paymentUnavailable(res);
  }
};

/* ================= WEBHOOK ================= */

exports.stripeWebhook = async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).send('Stripe webhook not configured');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    const session = event.data.object;
    const orderId = session?.metadata?.orderId;
    const order = orderId && mongoose.Types.ObjectId.isValid(orderId) ? await StripeOrder.findById(orderId) : null;

    if (order) {
      if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
        if (session.payment_status === 'paid') await finalizePaidOrder({ order, session });
      } else if (event.type === 'checkout.session.expired' && order.status === 'PENDING') {
        await expireOrder(order, 'EXPIRED');
      } else if (event.type === 'checkout.session.async_payment_failed' && order.status === 'PENDING') {
        await expireOrder(order, 'FAILED');
      }
    }
  } catch (err) {
    console.error('❌ Webhook processing error:', err);
    return res.status(500).json({ received: false });
  }

  return res.json({ received: true });
};

/* ================= REFUNDS ================= */

async function findOwnedBooking(req, { bookingId, ticketId }) {
  const query = bookingId && mongoose.Types.ObjectId.isValid(bookingId) ? { _id: bookingId } : ticketId ? { ticketId } : null;
  if (!query) return { error: [400, 'bookingId or ticketId required'] };
  const booking = await Booking.findOne(query).populate('event', 'title venue date price');
  if (!booking) return { error: [404, 'Booking not found'] };
  if (String(booking.user?._id || booking.user) !== requestUserId(req) && !isAdmin(req)) {
    // Do not reveal whether another user's booking exists.
    return { error: [404, 'Booking not found'] };
  }
  return { booking };
}

function bookingRefundView(booking) {
  return {
    bookingId: String(booking._id),
    ticketId: booking.ticketId,
    eventTitle: booking.event?.title || null,
    showAt: booking.showAt ? new Date(booking.showAt).toISOString() : null,
    seats: booking.seats,
    seatNumbers: booking.seatNumbers || [],
    paymentStatus: booking.paymentStatus,
    amountPaid: booking.amountPaid,
    currency: booking.currency,
    refundId: booking.refundId,
    refundStatus: booking.refundStatus,
    refundAmount: booking.refundAmount,
    refundPercent: booking.refundPercent,
    cancelledAt: booking.cancelledAt,
  };
}

// GET /api/payments/refund-quote?ticketId=... | bookingId=...
exports.getRefundQuote = async (req, res) => {
  try {
    const { booking, error } = await findOwnedBooking(req, req.query);
    if (error) return res.status(error[0]).json({ success: false, message: error[1] });
    return res.json({ success: true, booking: bookingRefundView(booking), quote: refundQuote(booking) });
  } catch (err) {
    console.error('❌ Refund quote error:', err);
    return res.status(500).json({ success: false, message: 'Failed to compute refund quote.' });
  }
};

// GET /api/payments/refund-status?ticketId=... | bookingId=...
// Refreshes the refund status from Stripe so the caller never relies on stale data.
exports.getRefundStatus = async (req, res) => {
  try {
    const { booking, error } = await findOwnedBooking(req, req.query);
    if (error) return res.status(error[0]).json({ success: false, message: error[1] });

    if (booking.refundId && stripe && booking.refundStatus !== 'succeeded') {
      try {
        const refund = await stripe.refunds.retrieve(booking.refundId);
        if (refund.status !== booking.refundStatus) {
          booking.refundStatus = refund.status;
          await booking.save();
        }
      } catch (err) {
        console.warn('Stripe refund retrieve failed:', err.message);
      }
    }
    return res.json({ success: true, booking: bookingRefundView(booking) });
  } catch (err) {
    console.error('❌ Refund status error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load refund status.' });
  }
};

// POST /api/payments/refund  { bookingId | ticketId }
// Cancels a PAID booking according to the refund policy and refunds the policy amount via Stripe.
exports.refundBooking = async (req, res) => {
  try {
    const { booking, error } = await findOwnedBooking(req, req.body || {});
    if (error) return res.status(error[0]).json({ success: false, message: error[1] });

    const quote = refundQuote(booking);
    if (!quote.eligible) {
      return res.status(400).json({ success: false, status: 'NOT_ELIGIBLE', message: quote.reason, quote });
    }
    if (quote.refundAmount > 0 && !stripe) return paymentUnavailable(res, 'The refund service is currently unavailable.');
    if (quote.refundAmount > 0 && !booking.stripePaymentIntentId) {
      return res.status(409).json({
        success: false,
        status: 'MANUAL_REVIEW',
        message: 'This booking has no recorded card payment; please contact support for a refund.',
        quote,
      });
    }

    // Claim the booking so a double request cannot refund twice.
    const claimed = await Booking.findOneAndUpdate(
      { _id: booking._id, paymentStatus: 'PAID' },
      { $set: { paymentStatus: 'REFUND_PROCESSING' } },
      { new: true }
    );
    if (!claimed) {
      return res.status(409).json({ success: false, status: 'ALREADY_PROCESSED', message: 'This booking is already being cancelled or refunded.' });
    }

    let refund = null;
    if (quote.refundAmount > 0) {
      try {
        refund = await stripe.refunds.create({
          payment_intent: booking.stripePaymentIntentId,
          amount: quote.refundAmount,
          reason: 'requested_by_customer',
          metadata: { bookingId: String(booking._id), ticketId: booking.ticketId },
        });
      } catch (err) {
        await Booking.updateOne({ _id: booking._id }, { $set: { paymentStatus: 'PAID' } });
        console.error('❌ Stripe refund error:', err.message);
        return res.status(502).json({ success: false, status: 'REFUND_FAILED', message: 'The refund could not be processed. Your booking is unchanged.' });
      }
      if (refund.status === 'failed' || refund.status === 'canceled') {
        await Booking.updateOne({ _id: booking._id }, { $set: { paymentStatus: 'PAID' } });
        return res.status(502).json({ success: false, status: 'REFUND_FAILED', message: 'The refund was declined by the payment provider. Your booking is unchanged.' });
      }
    }

    await seatReservations.releaseBookingSeats(booking._id);
    const seatsToRelease = Math.max(Number(booking.seats || 0), 0);
    if (seatsToRelease > 0) {
      await Event.findByIdAndUpdate(booking.event?._id || booking.event, { $inc: { bookedSeats: -seatsToRelease } });
    }

    claimed.paymentStatus = refund ? 'REFUNDED' : 'CANCELLED';
    claimed.cancelledAt = new Date();
    claimed.refundId = refund ? refund.id : null;
    claimed.refundStatus = refund ? refund.status : null;
    claimed.refundAmount = refund ? refund.amount : 0;
    claimed.refundPercent = quote.refundPercent;
    await claimed.save();
    await claimed.populate('event', 'title venue date price');

    return res.json({ success: true, status: claimed.paymentStatus, booking: bookingRefundView(claimed), quote });
  } catch (err) {
    console.error('❌ Refund error:', err);
    return res.status(500).json({ success: false, message: 'Refund failed.' });
  }
};
