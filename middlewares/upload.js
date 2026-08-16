const multer = require('multer');
const path = require('path');
const { localUploadDir } = require('../lib/objectStorage');

const ALLOWED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.pdf'];
const ALLOWED_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf',
];

// Memory storage — controller persists via objectStorage (local disk or S3).
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const mime = (file.mimetype || '').toLowerCase();
  if (ALLOWED_EXTENSIONS.includes(ext) && ALLOWED_MIME_TYPES.includes(mime)) {
    cb(null, true);
  } else {
    cb(new Error('Only images (png, jpg, jpeg, webp) and PDF documents are allowed.'));
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
});

module.exports = upload;
module.exports.uploadDir = localUploadDir;
module.exports.ALLOWED_EXTENSIONS = ALLOWED_EXTENSIONS;
