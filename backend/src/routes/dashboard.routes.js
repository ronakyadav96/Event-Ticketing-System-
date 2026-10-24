const express = require('express');
const router = express.Router();

const { protect, authorizeRoles } = require('../middlewares/auth.middleware');

const {
  getCreatorDashboard,
  getSuperadminDashboard
} = require('../controllers/dashboard.controller');

/* ======================================================
   CREATOR DASHBOARD
====================================================== */

router.get(
  '/creator',
  protect,
  authorizeRoles('creator', 'superadmin'),
  getCreatorDashboard
);

/* ======================================================
   SUPERADMIN DASHBOARD
====================================================== */

router.get(
  '/superadmin',
  protect,
  authorizeRoles('superadmin'),
  getSuperadminDashboard
);

module.exports = router;