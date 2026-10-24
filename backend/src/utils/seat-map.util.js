// src/utils/seat-map.util.js
// Deterministic seat layout derived from an event's totalSeats.
// Every event gets the same layout on every call, so seat IDs ("A1", "B12", ...)
// are stable identifiers that can be locked and booked.

const MAX_SEATS_PER_BOOKING = 10;

function seatsPerRowFor(totalSeats) {
  if (totalSeats <= 60) return 10;
  if (totalSeats <= 200) return 15;
  return 20;
}

function rowLabel(index) {
  // 0 -> A ... 25 -> Z, 26 -> AA, 27 -> AB ...
  let label = '';
  let n = index;
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

function buildSeatLayout(totalSeats) {
  const total = Math.max(0, Number(totalSeats) || 0);
  const perRow = seatsPerRowFor(total);
  const rows = [];
  let remaining = total;
  let r = 0;
  while (remaining > 0) {
    const count = Math.min(perRow, remaining);
    const label = rowLabel(r);
    rows.push({
      row: label,
      seats: Array.from({ length: count }, (_, i) => `${label}${i + 1}`),
    });
    remaining -= count;
    r += 1;
  }
  return rows;
}

function allSeatIds(totalSeats) {
  return buildSeatLayout(totalSeats).flatMap((r) => r.seats);
}

function normalizeSeatId(raw) {
  return String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
}

// Validates a requested seat list against the layout.
// Returns { ok: true, seats } or { ok: false, message }.
function validateSeatSelection(totalSeats, requested) {
  if (!Array.isArray(requested) || requested.length === 0) {
    return { ok: false, message: 'At least one seat must be selected.' };
  }
  const seats = [...new Set(requested.map(normalizeSeatId).filter(Boolean))];
  if (seats.length !== requested.length) {
    return { ok: false, message: 'Duplicate seat IDs in selection.' };
  }
  if (seats.length > MAX_SEATS_PER_BOOKING) {
    return { ok: false, message: `A maximum of ${MAX_SEATS_PER_BOOKING} seats can be booked per order.` };
  }
  const valid = new Set(allSeatIds(totalSeats));
  const invalid = seats.filter((s) => !valid.has(s));
  if (invalid.length) {
    return { ok: false, message: `Seat(s) ${invalid.join(', ')} do not exist for this event.` };
  }
  return { ok: true, seats };
}

module.exports = {
  MAX_SEATS_PER_BOOKING,
  buildSeatLayout,
  allSeatIds,
  normalizeSeatId,
  validateSeatSelection,
};
