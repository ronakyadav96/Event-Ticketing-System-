const express = require('express');
const router = express.Router();

const User = require('../models/User');
const Event = require('../models/Event');
const Booking = require('../models/Booking');

const { protect, authorizeRoles } = require('../middlewares/auth.middleware');
const heroUpload = require('../middlewares/heroUpload.middleware');
const heroCtrl = require('../controllers/heroImage.controller');

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



// =================================================
// ================= SUPERADMIN ====================
// =================================================

// 🔹 Get All Users (Superadmin Only)
router.get('/users', protect, authorizeRoles('superadmin'), async (req, res) => {
  try {
    const role = req.query.role ? String(req.query.role).trim().toLowerCase() : '';
    const filter = role ? { role } : {};
    const { page, limit, skip, paged } = parsePagination(req);

    if (!paged) {
      const users = await User.find(filter).select('-password');
      return res.json(users);
    }

    const [total, users] = await Promise.all([
      User.countDocuments(filter),
      User.find(filter).select('-password').sort({ createdAt: -1 }).skip(skip).limit(limit)
    ]);

    const totalPages = Math.max(1, Math.ceil(total / limit));
    return res.json({ data: users, page, limit, total, totalPages });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch users' });
  }
});

// 🔹 Update User (Superadmin Only)
router.put('/users/:id', protect, authorizeRoles('superadmin'), async (req, res) => {
  try {
    const { name, role } = req.body || {};
    const user = await User.findById(req.params.id).select('-password');

    if (!user) return res.status(404).json({ message: 'User not found' });

    if (name != null) user.name = String(name).trim();
    if (role != null) {
      const r = String(role).trim().toLowerCase();
      if (!['user', 'creator', 'superadmin'].includes(r)) {
        return res.status(400).json({ message: 'Invalid role' });
      }
      user.role = r;
    }

    await user.save();
    res.json({ message: 'User updated', user });
  } catch (err) {
    res.status(500).json({ message: 'Failed to update user' });
  }
});

// 🔹 Delete User (Superadmin Only)
router.delete('/users/:id', protect, authorizeRoles('superadmin'), async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const userId = user._id;

    // delete bookings made by user
    await Booking.deleteMany({ user: userId });

    // delete events created by user (if creator)
    const createdEvents = await Event.find({ createdBy: userId }).select('_id');
    const eventIds = createdEvents.map(e => e._id);
    if (eventIds.length) {
      await Booking.deleteMany({ event: { $in: eventIds } });
      await Event.deleteMany({ _id: { $in: eventIds } });
    }

    await user.deleteOne();
    res.json({ message: 'User deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete user' });
  }
});

// 🔹 Get All Bookings (Superadmin Only)
router.get('/bookings', protect, authorizeRoles('superadmin'), async (req, res) => {
  try {
    const { page, limit, skip, paged } = parsePagination(req);

    if (!paged) {
      const bookings = await Booking.find()
        .populate('user', 'name email')
        .populate('event', 'title');
      return res.json(bookings);
    }

    const [total, bookings] = await Promise.all([
      Booking.countDocuments(),
      Booking.find()
        .populate('user', 'name email')
        .populate('event', 'title')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
    ]);

    const totalPages = Math.max(1, Math.ceil(total / limit));
    return res.json({ data: bookings, page, limit, total, totalPages });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch bookings' });
  }
});


// =================================================
// ================= CREATOR =======================
// =================================================

// 🔹 Get My Events (Creator)
router.get('/my-events', protect, authorizeRoles('creator'), async (req, res) => {
  try {
    const events = await Event.find({ createdBy: req.user.id });
    res.json(events);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch events' });
  }
});

// 🔹 Update My Event
router.put('/events/:id', protect, authorizeRoles('creator', 'superadmin'), async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);

    if (!event) return res.status(404).json({ message: 'Event not found' });

    // If creator → allow only own event
    if (req.user.role === 'creator' && event.createdBy.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Not authorized for this event' });
    }

    Object.assign(event, req.body);
    await event.save();

    res.json({ message: 'Event updated', event });
  } catch (err) {
    res.status(500).json({ message: 'Update failed' });
  }
});

// 🔹 Delete My Event
router.delete('/events/:id', protect, authorizeRoles('creator', 'superadmin'), async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);

    if (!event) return res.status(404).json({ message: 'Event not found' });

    if (req.user.role === 'creator' && event.createdBy.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Not authorized for this event' });
    }

    await event.deleteOne();
    res.json({ message: 'Event deleted' });

  } catch (err) {
    res.status(500).json({ message: 'Delete failed' });
  }
});


// 🔹 Creator → See Only Bookings of Their Events
router.get('/my-bookings', protect, authorizeRoles('creator'), async (req, res) => {
  try {
    const myEvents = await Event.find({ createdBy: req.user.id }).select('_id');

    const eventIds = myEvents.map(e => e._id);

    const bookings = await Booking.find({ event: { $in: eventIds } })
      .populate('user', 'name email')
      .populate('event', 'title');

    res.json(bookings);

  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch bookings' });
  }
});

// =================================================
// ================= HERO IMAGES ===================
// =================================================

// Superadmin Only: list current hero images
router.get('/hero-images', protect, authorizeRoles('superadmin'), heroCtrl.listAdmin);

// Superadmin Only: upload single hero image (field: image)
router.post(
  '/hero-images',
  protect,
  authorizeRoles('superadmin'),
  heroUpload.single('image'),
  heroCtrl.upload
);

// Superadmin Only: delete hero image
router.delete('/hero-images/:id', protect, authorizeRoles('superadmin'), heroCtrl.remove);

module.exports = router;
