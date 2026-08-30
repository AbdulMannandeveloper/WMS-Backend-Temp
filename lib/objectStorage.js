'use strict';

/**
 * S3-compatible object storage with local-disk fallback.
 * Set S3_BUCKET (+ optional S3_ENDPOINT / AWS credentials) to enable cloud storage.
 */

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

// UPLOAD_DIR lets the test suite write somewhere disposable. Unset everywhere
// else, so dev and production keep using ./uploads exactly as before.
const localUploadDir = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(__dirname, '../uploads');
if (!fs.existsSync(localUploadDir)) {
  fs.mkdirSync(localUploadDir, { recursive: true });
}

const isS3Enabled = () => Boolean(process.env.S3_BUCKET);

let s3Client = null;

const getS3Client = () => {
  if (s3Client) return s3Client;
  const { S3Client } = require('@aws-sdk/client-s3');
  const config = {
    region: process.env.S3_REGION || 'us-east-1',
  };
  if (process.env.S3_ENDPOINT) {
    config.endpoint = process.env.S3_ENDPOINT;
    config.forcePathStyle = String(process.env.S3_FORCE_PATH_STYLE || 'true') === 'true';
  }
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    config.credentials = {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    };
  }
  s3Client = new S3Client(config);
  return s3Client;
};

const uploadBuffer = async (key, buffer, contentType) => {
  if (!isS3Enabled()) {
    const dest = path.join(localUploadDir, key);
    await fs.promises.writeFile(dest, buffer);
    return { key, storage: 'local' };
  }

  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    }),
  );
  return { key, storage: 's3' };
};

const getObjectStream = async (key) => {
  if (!isS3Enabled()) {
    const filePath = path.join(localUploadDir, key);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(localUploadDir) + path.sep)) {
      throw new Error('Invalid file path');
    }
    if (!fs.existsSync(resolved)) {
      const err = new Error('File not found');
      err.code = 'ENOENT';
      throw err;
    }
    return { stream: fs.createReadStream(resolved), contentType: null };
  }

  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const result = await getS3Client().send(
    new GetObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
    }),
  );
  return {
    stream: result.Body instanceof Readable ? result.Body : Readable.from(result.Body),
    contentType: result.ContentType || null,
  };
};

const objectExists = async (key) => {
  if (!isS3Enabled()) {
    const filePath = path.join(localUploadDir, key);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(localUploadDir) + path.sep)) {
      return false;
    }
    return fs.existsSync(resolved);
  }

  try {
    const { HeadObjectCommand } = require('@aws-sdk/client-s3');
    await getS3Client().send(
      new HeadObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: key,
      }),
    );
    return true;
  } catch {
    return false;
  }
};

module.exports = {
  isS3Enabled,
  uploadBuffer,
  getObjectStream,
  objectExists,
  localUploadDir,
};
