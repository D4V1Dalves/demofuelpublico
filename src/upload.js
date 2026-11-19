const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const {
  MAX_UPLOAD_BYTES,
  MAX_AVATAR_BYTES,
  AVATAR_MIME,
  AVATAR_EXT,
  ALLOWED_MIME,
  ALLOWED_EXT,
} = require('./config');

function storedName(file) {
  const extension = path.extname(file.originalname).toLowerCase();
  return `${Date.now()}-${crypto.randomBytes(12).toString('hex')}${extension}`;
}

// Assinaturas reais dos formatos aceitos. Extensão e Content-Type declarados
// pelo cliente não bastam: um HTML renomeado para .png passaria pelo filtro.
function avatarSignature(file) {
  const buffer = Buffer.alloc(12);
  let handle;
  try {
    handle = fs.openSync(file.path, 'r');
    const read = fs.readSync(handle, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read);
  } catch {
    return null;
  } finally {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle);
      } catch {
        /* ignore */
      }
    }
  }
}

function isValidAvatarContent(file) {
  const bytes = avatarSignature(file);
  if (!bytes || bytes.length < 3) return false;
  const extension = path.extname(file.originalname).toLowerCase();

  const isPng =
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a;
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isWebp =
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP';

  if (extension === '.png') return isPng;
  if (extension === '.jpg' || extension === '.jpeg') return isJpeg;
  if (extension === '.webp') return isWebp;
  return isPng || isJpeg || isWebp;
}

function removeQuietly(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* arquivo já removido */
  }
}

function createUploadMiddleware(uploadDir) {
  fs.mkdirSync(uploadDir, { recursive: true });

  const parser = multer({
    storage: multer.diskStorage({
      destination: (req, file, callback) => callback(null, uploadDir),
      filename: (req, file, callback) => callback(null, storedName(file)),
    }),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    fileFilter: (req, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase();
      if (ALLOWED_EXT.has(extension) && ALLOWED_MIME.has(file.mimetype)) return callback(null, true);
      return callback(new Error('Tipo de arquivo não permitido.'));
    },
  }).single('file');

  return (req, res, next) => {
    parser(req, res, (error) => {
      if (error) {
        req.uploadError =
          error.code === 'LIMIT_FILE_SIZE'
            ? 'Arquivo maior que 10 MB.'
            : 'Tipo de arquivo não permitido.';
      }
      next();
    });
  };
}

function createAvatarUploadMiddleware(uploadDir) {
  const avatarDir = path.join(uploadDir, 'avatars');
  fs.mkdirSync(avatarDir, { recursive: true });

  const parser = multer({
    storage: multer.diskStorage({
      destination: (req, file, callback) => callback(null, avatarDir),
      filename: (req, file, callback) => callback(null, storedName(file)),
    }),
    limits: { fileSize: MAX_AVATAR_BYTES, files: 1 },
    fileFilter: (req, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase();
      if (AVATAR_EXT.has(extension) && AVATAR_MIME.has(file.mimetype)) return callback(null, true);
      return callback(new Error('Formato de foto não permitido.'));
    },
  }).single('photo');

  return (req, res, next) => {
    parser(req, res, (error) => {
      if (error) {
        req.uploadError =
          error.code === 'LIMIT_FILE_SIZE'
            ? 'A foto deve ter no máximo 3 MB.'
            : 'Use uma foto PNG, JPG ou WebP.';
        return next();
      }
      if (req.file && !isValidAvatarContent(req.file)) {
        removeQuietly(req.file.path);
        req.file = undefined;
        req.uploadError = 'Use uma foto PNG, JPG ou WebP.';
      }
      next();
    });
  };
}

module.exports = { createUploadMiddleware, createAvatarUploadMiddleware };
