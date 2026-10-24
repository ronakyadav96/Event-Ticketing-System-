const express = require('express');
const router = express.Router();

const heroCtrl = require('../controllers/heroImage.controller');

// Public: used on Home/Events page carousel
router.get('/', heroCtrl.listPublic);

// Public: serve image bytes (GridFS-backed)
router.get('/:id/image', heroCtrl.getImage);

module.exports = router;
