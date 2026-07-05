const fs = require('fs');
const path = require('path');

const FONT_EXTENSIONS = new Set([
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
]);

const MIME_TYPE_MAP = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.ico': 'image/x-icon',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.eot': 'application/vnd.ms-fontobject',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.bin': 'application/octet-stream',
};

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPE_MAP[ext] || 'application/octet-stream';
}

function isFontFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return FONT_EXTENSIONS.has(ext);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function collectFiles(dir, baseDir) {
  baseDir = baseDir || dir;
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...collectFiles(fullPath, baseDir));
      } else {
        results.push({
          relativePath: path.relative(baseDir, fullPath),
          fullPath,
        });
      }
    }
  } catch (e) {
    // skip
  }
  return results;
}

module.exports = { getMimeType, isFontFile, ensureDir, collectFiles, FONT_EXTENSIONS, MIME_TYPE_MAP };
