const mongoose = require('mongoose');
const Booking = require('../models/Booking');
const Event = require('../models/Event');
const User = require('../models/User');

/* ======================================================
   HELPERS
====================================================== */

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function monthKeyExpr(dateField) {
  return {
    $dateToString: { format: '%Y-%m', date: dateField },
  };
}

/* ======================================================
   CREATOR DASHBOARD
====================================================== */

exports.getCreatorDashboard = async (req, res) => {
  try {
    const creatorId = req.user?._id;
    if (!creatorId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to);

    const myEvents = await Event.find({ createdBy: creatorId });

    const eventIds = myEvents.map(e => e._id);

    if (!eventIds.length) {
      return res.json({
        totals: { events: 0, bookings: 0, seatsBooked: 0, revenue: 0 },
        topEvent: null,
        perEvent: [],
        monthlyTrend: [],
      });
    }

    const bookingMatch = {
      event: { $in: eventIds }
    };

    if (from || to) {
      bookingMatch.createdAt = {};
      if (from) bookingMatch.createdAt.$gte = from;
      if (to) bookingMatch.createdAt.$lte = to;
    }

    const bookings = await Booking.find(bookingMatch)
      .populate('event', 'title price totalSeats')
      .populate('user', 'name email');

    let revenue = 0;
    let seatsBooked = 0;

    const perEventMap = {};

    // Seed all events so zero-booking events still appear
    myEvents.forEach((ev) => {
      const eid = String(ev._id);
      perEventMap[eid] = {
        eventId: eid,
        title: ev.title,
        date: ev.date,
        startDate: ev.startDate,
        endDate: ev.endDate,
        showTimes: ev.showTimes,
        venue: ev.venue,
        price: ev.price ?? 0,
        bookings: 0,
        seatsBooked: 0,
        totalSeats: ev.totalSeats ?? 0,
        bookedSeats: ev.bookedSeats ?? 0,
        category: ev.category,
        revenue: 0,
      };
    });

    bookings.forEach(b => {
      const eid = String(b.event._id);

      if (!perEventMap[eid]) {
        perEventMap[eid] = {
          eventId: eid,
          title: b.event.title,
          date: null,
          startDate: null,
          endDate: null,
          showTimes: [],
          venue: '',
          price: b.event.price ?? 0,
          bookings: 0,
          seatsBooked: 0,
          totalSeats: b.event.totalSeats ?? 0,
          bookedSeats: 0,
          category: '',
          revenue: 0,
        };
      }

      const seats = b.seats || 1;

      perEventMap[eid].bookings += 1;
      perEventMap[eid].seatsBooked += seats;
      perEventMap[eid].revenue += seats * (b.event.price || 0);

      revenue += seats * (b.event.price || 0);
      seatsBooked += seats;
    });

    const perEvent = Object.values(perEventMap).sort(
      (a, b) => b.revenue - a.revenue
    );

    const monthlyTrend = await Booking.aggregate([
      { $match: bookingMatch },
      {
        $lookup: {
          from: 'events',
          localField: 'event',
          foreignField: '_id',
          as: 'event'
        }
      },
      { $unwind: '$event' },
      {
        $group: {
          _id: monthKeyExpr('$createdAt'),
          bookings: { $sum: 1 },
          seatsBooked: { $sum: { $ifNull: ['$seats', 1] } },
          revenue: {
            $sum: {
              $multiply: [
                { $ifNull: ['$seats', 1] },
                { $ifNull: ['$event.price', 0] }
              ]
            }
          }
        }
      },
      { $project: { _id: 0, month: '$_id', bookings: 1, seatsBooked: 1, revenue: 1 } },
      { $sort: { month: 1 } }
    ]);

    const bookingSummaries = bookings.map((b) => ({
      _id: b._id,
      event: b.event,
      user: b.user,
      name: b.name,
      email: b.email,
      seats: b.seats,
      createdAt: b.createdAt
    }));

    res.json({
      totals: {
        events: myEvents.length,
        bookings: bookings.length,
        seatsBooked,
        revenue
      },
      topEvent: perEvent[0] || null,
      perEvent,
      monthlyTrend,
      bookings: bookingSummaries
    });

  } catch (err) {
    console.error('Creator Dashboard Error:', err);
    res.status(500).json({ message: 'Creator dashboard failed' });
  }
};


/* ======================================================
   SUPERADMIN DASHBOARD
====================================================== */

exports.getSuperadminDashboard = async (req, res) => {
  try {

    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to);

    const bookingMatch = {};
    if (from || to) {
      bookingMatch.createdAt = {};
      if (from) bookingMatch.createdAt.$gte = from;
      if (to) bookingMatch.createdAt.$lte = to;
    }

    const [
      totalUsers,
      totalCreators,
      totalEvents,
      totalBookings
    ] = await Promise.all([
      User.countDocuments({ role: 'user' }),
      User.countDocuments({ role: 'creator' }),
      Event.countDocuments(),
      Booking.countDocuments(bookingMatch),
    ]);

    const revenueAgg = await Booking.aggregate([
      { $match: bookingMatch },
      {
        $lookup: {
          from: 'events',
          localField: 'event',
          foreignField: '_id',
          as: 'event'
        }
      },
      { $unwind: '$event' },
      {
        $group: {
          _id: null,
          revenue: {
            $sum: {
              $multiply: [
                { $ifNull: ['$seats', 1] },
                { $ifNull: ['$event.price', 0] }
              ]
            }
          },
          seatsBooked: { $sum: { $ifNull: ['$seats', 1] } }
        }
      }
    ]);

    const totals = {
      users: totalUsers,
      creators: totalCreators,
      events: totalEvents,
      bookings: totalBookings,
      seatsBooked: revenueAgg?.[0]?.seatsBooked || 0,
      revenue: revenueAgg?.[0]?.revenue || 0,
    };

    const monthlyTrend = await Booking.aggregate([
      { $match: bookingMatch },
      {
        $lookup: {
          from: 'events',
          localField: 'event',
          foreignField: '_id',
          as: 'event'
        }
      },
      { $unwind: '$event' },
      {
        $group: {
          _id: monthKeyExpr('$createdAt'),
          bookings: { $sum: 1 },
          seatsBooked: { $sum: { $ifNull: ['$seats', 1] } },
          revenue: {
            $sum: {
              $multiply: [
                { $ifNull: ['$seats', 1] },
                { $ifNull: ['$event.price', 0] }
              ]
            }
          }
        }
      },
      { $project: { _id: 0, month: '$_id', bookings: 1, seatsBooked: 1, revenue: 1 } },
      { $sort: { month: 1 } }
    ]);

    const topEvents = await Booking.aggregate([
      { $match: bookingMatch },
      {
        $group: {
          _id: '$event',
          bookings: { $sum: 1 },
          seatsBooked: { $sum: { $ifNull: ['$seats', 1] } }
        }
      },
      {
        $lookup: {
          from: 'events',
          localField: '_id',
          foreignField: '_id',
          as: 'event'
        }
      },
      { $unwind: '$event' },
      {
        $project: {
          _id: 0,
          eventId: '$_id',
          title: '$event.title',
          revenue: {
            $multiply: ['$seatsBooked', { $ifNull: ['$event.price', 0] }]
          },
          bookings: 1,
          seatsBooked: 1
        }
      },
      { $sort: { revenue: -1, bookings: -1 } },
      { $limit: 10 }
    ]);

    res.json({
      totals,
      monthlyTrend,
      topEvents
    });

  } catch (err) {
    console.error('Superadmin Dashboard Error:', err);
    res.status(500).json({ message: 'Superadmin dashboard failed' });
  }
};
