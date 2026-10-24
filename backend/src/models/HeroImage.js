const mongoose = require('mongoose');

const heroImageSchema = new mongoose.Schema(
  {
    filename: { type: String, required: true },

    // Deploy-safe storage: GridFS file id (preferred)
    fileId: { type: mongoose.Schema.Types.ObjectId, default: null },
    contentType: { type: String, default: null },

    // Legacy local filesystem path (kept for backward compatibility)
    // e.g. /uploads/hero/<filename>
    path: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('HeroImage', heroImageSchema);
