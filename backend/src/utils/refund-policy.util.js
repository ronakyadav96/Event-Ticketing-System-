// src/utils/refund-policy.util.js
// User-initiated cancellation / refund policy. Mirrors the published policy
// (ai-service/app/rag/docs/cancellation_policy.md):
//   > 7 days before show      -> 90% of amount paid
//   48 hours .. 7 days        -> 75%
//   24 .. 48 hours            -> 50%
//   < 24 hours                -> not cancellable
// This is the only place the policy is evaluated; the AI service only displays it.

const HOUR = 60 * 60 * 1000;

function refundQuote(booking, { now = new Date() } = {}) {
  const status = String(booking?.paymentStatus || '').toUpperCase();
  const amountPaid = Math.max(0, Number(booking?.amountPaid || 0)); // smallest currency unit
  const currency = booking?.currency || 'inr';
  const showAtRaw = booking?.showAt || booking?.event?.date || null;
  const showAt = showAtRaw ? new Date(showAtRaw) : null;

  const base = { status, amountPaid, currency, showAt: showAt ? showAt.toISOString() : null };

  if (status !== 'PAID') {
    const reason =
      status === 'REFUNDED' || status === 'REFUND_PROCESSING'
        ? 'This booking has already been refunded.'
        : status === 'CANCELLED'
          ? 'This booking has already been cancelled.'
          : 'Only paid bookings can be cancelled.';
    return { ...base, eligible: false, refundPercent: 0, refundAmount: 0, reason };
  }

  if (!showAt || Number.isNaN(showAt.getTime())) {
    return { ...base, eligible: false, refundPercent: 0, refundAmount: 0, reason: 'Show time is unknown for this booking.' };
  }

  const hoursLeft = (showAt.getTime() - now.getTime()) / HOUR;
  if (hoursLeft < 24) {
    return {
      ...base,
      eligible: false,
      refundPercent: 0,
      refundAmount: 0,
      hoursUntilShow: Math.max(0, Math.round(hoursLeft)),
      reason: 'Cancellations are not permitted within 24 hours of the show.',
    };
  }

  const refundPercent = hoursLeft > 7 * 24 ? 90 : hoursLeft >= 48 ? 75 : 50;
  return {
    ...base,
    eligible: true,
    refundPercent,
    refundAmount: Math.floor((amountPaid * refundPercent) / 100),
    hoursUntilShow: Math.round(hoursLeft),
    reason: null,
  };
}

module.exports = { refundQuote };
