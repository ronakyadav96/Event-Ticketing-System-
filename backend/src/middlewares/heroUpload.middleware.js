const multer = require('multer');
const path = require('path');

// Store in memory; controller persists to GridFS (deploy-safe on Render)
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const allowed = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowed.includes(file.mimetype)) {
    cb(new Error('Only JPG, PNG, WEBP allowed'), false);
  } else {
    cb(null, true);
  }
};

module.exports = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});
