const express = require('express');
const router = express.Router();

const Booking = require('../models/Booking');
const Event = require('../models/Event');
const { protect } = require('../middlewares/auth.middleware');
const { parseShowAt, isShowTimeAllowed } = require('../utils/showtime.util');

// ✅ helper: generate unique ticket id
function parsePagination(req, defaultLimit = 10) {
  const pageRaw = parseInt(req.query.page, 10);
  const limitRaw = parseInt(req.query.limit, 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : defaultLimit;
  const skip = (page - 1) * limit;
  const paged = 'page' in req.query || 'limit' in req.query;
  return { page, limit, skip, paged };
}

function generateTicketId() {
  return `TKT-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`.toUpperCase();
}

// ==========================
// CREATE BOOKING (NON-STRIPE / MANUAL)
// POST /api/bookings
// NOTE: If you are using Stripe webhook booking creation,
// DO NOT call this route from frontend (will double book seats).
// ==========================
router.post('/', protect, async (req, res) => {
  try {
    const { eventId, name, email, seats, registrationTemplate, registrationData, showAt } = req.body;

    if (!eventId) return res.status(400).json({ message: 'eventId is required' });
    if (!name) return res.status(400).json({ message: 'name is required' });
    if (!email) return res.status(400).json({ message: 'email is required' });

    const seatCount = Number(seats);
    if (!seatCount || seatCount < 1) {
      return res.status(400).json({ message: 'seats must be >= 1' });
    }

    const showAtDate = parseShowAt(showAt);

    const eventDoc = await Event.findById(eventId).select('date startDate endDate showTimes price');
    if (!eventDoc) return res.status(404).json({ message: 'Event not found' });

    // ✅ Guard: Block direct non-Stripe booking for paid events
    if (Number(eventDoc.price || 0) > 0 && req.user?.role !== 'superadmin') {
      return res.status(400).json({
        message: 'This is a paid event. Direct booking without payment is not permitted. Please complete payment via Stripe Checkout.'
      });
    }

    const effectiveShowAt = showAtDate || (eventDoc.date ? new Date(eventDoc.date) : null);
    if (!effectiveShowAt || Number.isNaN(effectiveShowAt.getTime())) {
      return res.status(400).json({ message: 'Invalid show date/time' });
    }

    if (effectiveShowAt.getTime() < Date.now()) {
      return res.status(400).json({ message: 'Cannot book past events' });
    }

    if (!isShowTimeAllowed(eventDoc, effectiveShowAt)) {
      return res.status(400).json({ message: 'Selected show date/time not available' });
    }

    // ✅ ATOMIC: increment bookedSeats only if seats are available
    const updatedEvent = await Event.findOneAndUpdate(
      {
        _id: eventId,
        $expr: { $lte: [{ $add: ['$bookedSeats', seatCount] }, '$totalSeats'] },
      },
      { $inc: { bookedSeats: seatCount } },
      { new: true }
    );

    if (!updatedEvent) {
      return res.status(400).json({ message: 'Not enough seats available' });
    }

    const ticketId = generateTicketId();

    const booking = await Booking.create({
      user: req.user.id,
      event: eventId,
      name,
      email,
      seats: seatCount,
      registrationTemplate: registrationTemplate || 'standard',
      registrationData: registrationData || {},
      ticketId,
      paymentStatus: 'PAID', // manual booking assumes paid; adjust if needed
      showAt: effectiveShowAt,
    });

    return res.status(201).json({
      message: 'Booking created',
      ticketId: booking.ticketId,
      booking,
      event: updatedEvent,
      availableSeats: Math.max((updatedEvent.totalSeats ?? 0) - (updatedEvent.bookedSeats ?? 0), 0),
    });
  } catch (err) {
    console.error('Booking create error:', err);
    return res.status(500).json({ message: 'Booking failed', error: err.message });
  }
});

// ==========================
// GET BOOKING BY TICKET ID
// GET /api/bookings/ticket/:ticketId
// ==========================
router.get('/ticket/:ticketId', protect, async (req, res) => {
  try {
    const { ticketId } = req.params;
    if (!ticketId) return res.status(400).json({ message: 'ticketId missing' });

    const booking = await Booking.findOne({ ticketId })
      .populate('event', 'title date venue price totalSeats bookedSeats')
      .populate('user', 'name email');

    if (!booking) return res.status(404).json({ message: 'Booking not found' });

    // ✅ Authorization: allow owner or admin
    const isOwner = String(booking.user?._id || booking.user) === String(req.user.id);
    const isAdmin =
      !!req.user?.isAdmin || req.user?.role === 'admin' || req.user?.role === 'superadmin';
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    return res.json(booking);
  } catch (err) {
    console.error('getByTicketId error:', err);
    return res.status(500).json({ message: 'Failed to load booking', error: err.message });
  }
});

// ==========================
// GET MY BOOKINGS
// GET /api/bookings/my
// ==========================
router.get('/my', protect, async (req, res) => {
  try {
    const bookings = await Booking.find({ user: req.user.id })
      .populate('event', 'title date venue price');
    return res.json(bookings);
  } catch (err) {
    console.error('my bookings error:', err);
    return res.status(500).json({ message: 'Failed to load bookings', error: err.message });
  }
});

// ==========================
// GET ALL BOOKINGS (ADMIN) OR OWN BOOKINGS (USER)
// GET /api/bookings
// ==========================
router.get('/', protect, async (req, res) => {
  try {
    const isAdmin =
      !!req.user?.isAdmin || req.user?.role === 'admin' || req.user?.role === 'superadmin';
    const query = isAdmin ? {} : { user: req.user.id };
    const { page, limit, skip, paged } = parsePagination(req);

    if (!paged) {
      const bookings = await Booking.find(query)
        .populate('event', 'title date venue price')
        .populate('user', 'name email');

      return res.json(bookings);
    }

    const [total, bookings] = await Promise.all([
      Booking.countDocuments(query),
      Booking.find(query)
        .populate('event', 'title date venue price')
        .populate('user', 'name email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
    ]);

    const totalPages = Math.max(1, Math.ceil(total / limit));
    return res.json({ data: bookings, page, limit, total, totalPages });
  } catch (err) {
    console.error('bookings error:', err);
    return res.status(500).json({ message: 'Failed to load bookings', error: err.message });
  }
});

// ==========================
// GET SINGLE BOOKING BY DB ID
// GET /api/bookings/:id
// ==========================
router.get('/:id', protect, async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id)
      .populate('event', 'title date venue price')
      .populate('user', 'name email');

    if (!booking) return res.status(404).json({ message: 'Booking not found' });

    const isOwner = String(booking.user?._id || booking.user) === String(req.user.id);
    const isAdmin =
      !!req.user?.isAdmin || req.user?.role === 'admin' || req.user?.role === 'superadmin';
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    return res.json(booking);
  } catch (err) {
    console.error('booking by id error:', err);
    return res.status(500).json({ message: 'Failed to load booking', error: err.message });
  }
});

// ==========================
// DELETE BOOKING (ADMIN OR OWNER)
// DELETE /api/bookings/:id
// ==========================
router.delete('/:id', protect, async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ message: 'Booking not found' });

    const isOwner = String(booking.user) === String(req.user.id);
    const isAdmin = !!req.user?.isAdmin || req.user?.role === 'admin' || req.user?.role === 'superadmin';
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    // decrement booked seats on event (never below 0)
    const seatsToRelease = Math.max(Number(booking.seats || 0), 0);
    if (seatsToRelease > 0) {
      await Event.findByIdAndUpdate(
        booking.event,
        { $inc: { bookedSeats: -seatsToRelease } },
        { new: true }
      );
    }

    await booking.deleteOne();
    return res.json({ message: 'Booking deleted' });
  } catch (err) {
    console.error('delete booking error:', err);
    return res.status(500).json({ message: 'Failed to delete booking', error: err.message });
  }
});

module.exports = router;





