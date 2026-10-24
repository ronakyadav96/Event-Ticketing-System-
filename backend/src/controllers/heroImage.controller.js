const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { GridFSBucket } = require('mongodb');

const HeroImage = require('../models/HeroImage');

const HERO_LIMIT = 6;

function toClient(img) {
  const url = img?.fileId ? `/api/hero-images/${img._id}/image` : img?.path || '';
  return {
    _id: img._id,
    url,
    createdAt: img.createdAt,
  };
}

function getBucket() {
  if (!mongoose.connection?.db) return null;
  return new GridFSBucket(mongoose.connection.db, { bucketName: 'heroImages' });
}

function buildFilename(originalname) {
  const ext = path.extname(originalname || '').toLowerCase() || '.jpg';
  const rand = crypto.randomBytes(10).toString('hex');
  return `hero-${Date.now()}-${rand}${ext}`;
}

async function uploadBufferToGridFS(file) {
  const bucket = getBucket();
  if (!bucket) throw new Error('MongoDB not connected');

  const filename = buildFilename(file.originalname);

  return await new Promise((resolve, reject) => {
    const uploadStream = bucket.openUploadStream(filename, {
      contentType: file.mimetype,
    });

    uploadStream.on('error', reject);
    uploadStream.on('finish', () => resolve({ fileId: uploadStream.id, filename }));

    uploadStream.end(file.buffer);
  });
}

exports.listPublic = async (req, res) => {
  try {
    const list = await HeroImage.find().sort({ createdAt: -1 }).limit(HERO_LIMIT);
    // Prefer GridFS-backed images in production (filesystem uploads disappear on Render)
    const anyGrid = list.some((img) => Boolean(img.fileId));
    const picked = anyGrid ? list.filter((img) => Boolean(img.fileId)) : list;
    const ordered = [...picked].reverse().map(toClient);
    res.json({ images: ordered });
  } catch {
    res.status(500).json({ message: 'Failed to fetch hero images' });
  }
};

exports.listAdmin = async (req, res) => {
  try {
    const list = await HeroImage.find().sort({ createdAt: -1 }).limit(HERO_LIMIT);
    const ordered = [...list].reverse().map(toClient);
    res.json({ images: ordered });
  } catch {
    res.status(500).json({ message: 'Failed to fetch hero images' });
  }
};

exports.upload = async (req, res) => {
  try {
    // Enforce limit on deploy-safe images; legacy filesystem docs may exist from older versions.
    const count = await HeroImage.countDocuments({ fileId: { $ne: null } });
    if (count >= HERO_LIMIT) {
      return res
        .status(400)
        .json({ message: `Max ${HERO_LIMIT} hero images allowed. Delete one first.` });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'Image file missing' });
    }

    const { fileId, filename } = await uploadBufferToGridFS(req.file);

    const doc = await HeroImage.create({
      filename,
      fileId,
      contentType: req.file.mimetype,
      path: null,
    });

    res.status(201).json({ image: toClient(doc) });
  } catch (err) {
    res.status(500).json({ message: err?.message || 'Failed to upload hero image' });
  }
};

exports.getImage = async (req, res) => {
  try {
    const id = String(req.params.id || '');
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid image id' });
    }

    const img = await HeroImage.findById(id);
    if (!img) return res.status(404).json({ message: 'Hero image not found' });

    if (!img.fileId && img.path) {
      const filePath = path.join(__dirname, '..', img.path.replace(/^\/+/, ''));
      return res.sendFile(filePath, (err) => {
        if (err) return res.status(404).end();
      });
    }

    if (!img.fileId) {
      return res.status(404).json({ message: 'Hero image data missing' });
    }

    const bucket = getBucket();
    if (!bucket) return res.status(500).json({ message: 'MongoDB not connected' });

    res.setHeader('Content-Type', img.contentType || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=86400');

    const stream = bucket.openDownloadStream(img.fileId);
    stream.on('error', () => res.status(404).end());
    stream.pipe(res);
  } catch {
    res.status(500).json({ message: 'Failed to fetch hero image' });
  }
};

exports.remove = async (req, res) => {
  try {
    const id = String(req.params.id || '');
    const img = await HeroImage.findById(id);
    if (!img) return res.status(404).json({ message: 'Hero image not found' });

    const bucket = getBucket();
    const fileId = img.fileId;
    const filePath = img.path
      ? path.join(__dirname, '..', img.path.replace(/^\/+/, ''))
      : null;

    await img.deleteOne();

    if (bucket && fileId) {
      bucket.delete(fileId, () => {
        // ignore delete errors
      });
    }

    if (filePath) {
      fs.unlink(filePath, () => {
        // ignore unlink errors (file might already be missing)
      });
    }

    res.json({ message: 'Hero image deleted' });
  } catch {
    res.status(500).json({ message: 'Failed to delete hero image' });
  }
};
