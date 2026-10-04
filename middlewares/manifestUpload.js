'use strict';

const multer = require('multer');
const path = require('path');

/**
 * Accepting a manifest file upload.
 *
 * A manifest is a .csv or .xlsx, up to 10 MB, held in memory for the logic to
 * parse — never written to disk by multer. The browser's mime type is not
 * trusted: a CSV arrives as text/csv, application/vnd.ms-excel, text/plain or
 * application/octet-stream depending on the OS, so the extension is the gate
 * here and the xlsx zip signature is checked later, in the parser.
 */

const ALLOWED_EXTENSIONS = ['.csv', '.xlsx'];

const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (ALLOWED_EXTENSIONS.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Upload a .csv or .xlsx manifest file.'));
  }
};

const manifestUpload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 },
});

/**
 * Runs a multer middleware and turns a filter or size rejection into a plain
 * 400 { error }, rather than letting it fall through to the global 500 handler.
 * Wrap both this module's uploader and the photo uploader with it.
 *
 * @param {import('express').RequestHandler} multerMiddleware e.g. manifestUpload.single('file')
 */
const handleUploadErrors = (multerMiddleware) => (req, res, next) => {
  multerMiddleware(req, res, (err) => {
    if (!err) return next();
    const message =
      err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
        ? 'That file is too large.'
        : err.message || 'That file could not be accepted.';
    return res.status(400).json({ error: message });
  });
};

module.exports = { manifestUpload, handleUploadErrors, ALLOWED_EXTENSIONS };
