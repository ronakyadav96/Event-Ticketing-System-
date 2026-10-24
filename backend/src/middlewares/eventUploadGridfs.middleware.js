// middlewares/eventUploadGridfs.middleware.js
const multer = require('multer');

const allowed = ['image/jpeg', 'image/png', 'image/webp'];

const storage = multer.memoryStorage();

function fileFilter(req, file, cb) {
  if (!allowed.includes(file.mimetype)) {
    return cb(new Error('Only JPG, PNG, or WEBP images are allowed.'), false);
  }
  cb(null, true);
}

module.exports = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});
