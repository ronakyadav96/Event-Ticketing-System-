const express = require('express');
const router = express.Router();

const {
  createCheckoutSession,
  createSeatCheckout,
  stripeWebhook,
  getOrderBySession,
  cancelOrder,
  getRefundQuote,
  getRefundStatus,
  refundBooking,
} = require('../controllers/payment.controller');

const { protect } = require('../middlewares/auth.middleware');

// Stripe calls this; authenticity is checked with the webhook signature.
router.post('/webhook', stripeWebhook);

// Seat-selected checkout (AI assistant): server decides price, show and seat availability.
router.post('/checkout', protect, createSeatCheckout);

// Quantity checkout used by the web booking page.
router.post('/create-checkout-session', protect, createCheckoutSession);

// Authoritative order / payment status (owner only). The legacy verify paths share the handler.
router.get('/orders/:sessionId', protect, getOrderBySession);
router.post('/orders/:sessionId/cancel', protect, cancelOrder);
router.get('/stripe/session/:sessionId', protect, getOrderBySession);
router.get('/verify-session/:sessionId', protect, getOrderBySession);

// Cancellation & refunds of completed bookings (policy enforced server-side).
router.get('/refund-quote', protect, getRefundQuote);
router.get('/refund-status', protect, getRefundStatus);
router.post('/refund', protect, refundBooking);

module.exports = router;
