// routes/event.routes.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const path = require('path');
const { GridFSBucket } = require('mongodb');

const { protect, authorizeRoles } = require('../middlewares/auth.middleware');
const eventController = require('../controllers/event.controller');
const upload = require('../middlewares/eventUploadGridfs.middleware');

const Event = require('../models/Event');

// =======================
// GridFS Bucket
// =======================
let bucket;
function getBucket() {
  if (!bucket) {
    if (!mongoose.connection?.db) throw new Error('MongoDB not connected');
    bucket = new GridFSBucket(mongoose.connection.db, {
      bucketName: 'eventImages',
    });
  }
  return bucket;
}

// =======================
// PUBLIC ROUTES
// =======================

// Get all events
router.get('/', eventController.getAllEvents);

// Get categories
router.get('/categories', eventController.getCategories);

// Catalog facets (categories, venues) for the AI assistant
router.get('/facets', eventController.getFacets);

// Header search dropdown suggestions (events + movies)
router.get('/suggest', eventController.getSuggestions);

// Get single movie-backed event by source movie id
router.get('/movie-source/:movieId', eventController.getMovieEventBySource);

// Get single event
router.get('/:id', eventController.getEventById);

// Upcoming show slots and live seat availability
router.get('/:id/schedule', eventController.getEventSchedule);
router.get('/:id/availability', eventController.getSeatAvailability);

// Stream event image
// Browser caching (10 min) is set here so images are not re-downloaded on every page visit.
router.get('/:id/image', async (req, res) => {
  try {
    const ev = await Event.findById(req.params.id);
    if (!ev) return res.status(404).send('Event not found');

    // Allow browsers and CDNs to cache event images for 10 minutes
    res.set('Cache-Control', 'public, max-age=600');

    // 1️⃣ GridFS
    if (ev.imageFileId) {
      const fileId = new mongoose.Types.ObjectId(ev.imageFileId);
      const gfsBucket = getBucket();

      try {
        const files = await gfsBucket.find({ _id: fileId }).toArray();
        const file = files?.[0];
        if (file?.contentType) {
          res.set('Content-Type', file.contentType);
        }
      } catch {}

      const stream = gfsBucket.openDownloadStream(fileId);
      stream.on('error', () => res.status(404).send('Image not found'));
      return stream.pipe(res);
    }

    // 2️⃣ Disk fallback
    if (ev.imageUrl && ev.imageUrl.startsWith('/uploads/')) {
      const rel = ev.imageUrl.replace(/^\//, '');
      const absPath = path.join(__dirname, '..', rel);

      return res.sendFile(absPath, (err) => {
        if (err) return res.status(404).send('Image not found');
      });
    }

    return res.status(404).send('No image');
  } catch {
    return res.status(400).send('Invalid request');
  }
});

// =======================
// PROTECTED ROUTES
// =======================

// Create Event (creator + superadmin)
router.post(
  '/',
  protect,
  authorizeRoles('creator', 'superadmin'),
  upload.single('image'),
  eventController.createEvent
);

// Update Event
router.put(
  '/:id',
  protect,
  authorizeRoles('creator', 'superadmin'),
  upload.single('image'),
  eventController.updateEvent
);

// Delete Event
router.delete(
  '/:id',
  protect,
  authorizeRoles('creator', 'superadmin'),
  eventController.deleteEvent
);

module.exports = router;
