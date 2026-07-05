const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const JSZip = require('jszip');
const { convertDesign, createZipFromDir, extractZip } = require('./lib/converter');
const { getMimeType, isFontFile, collectFiles, ensureDir } = require('./lib/file-utils');

// Prevent crashes from uncaught errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

const app = express();
const PORT = process.env.PORT || 3000;

// Multer setup - store in memory
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Sessions directory for render images
const SESSIONS_DIR = path.join(os.tmpdir(), 'render_sessions');

// ==================== Convert API ====================

app.post('/api/convert', upload.single('file'), async (req, res) => {
  const tempDir = path.join(os.tmpdir(), 'design-convert-' + Date.now());
  const extractDir = path.join(tempDir, 'input');
  const outputDir = path.join(tempDir, 'output');
  const zipOutputPath = path.join(tempDir, 'result.zip');

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'لم يتم رفع أي ملف' });
    }

    const buffer = req.file.buffer;
    const isZip = buffer.length >= 4 &&
      buffer[0] === 0x50 && buffer[1] === 0x4B &&
      (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07);

    if (!isZip) {
      return res.status(400).json({ error: 'الملف ليس ملف ANDALUSI صالح' });
    }

    const uploadPath = path.join(tempDir, 'input.zip');
    fs.mkdirSync(tempDir, { recursive: true });
    fs.mkdirSync(extractDir, { recursive: true });
    fs.writeFileSync(uploadPath, buffer);

    await extractZip(uploadPath, extractDir);

    const customDesignName = req.body.designName || undefined;
    const sourceFileName = customDesignName ? undefined : (req.file.originalname || undefined);
    const result = await convertDesign(extractDir, outputDir, sourceFileName, customDesignName);

    await createZipFromDir(outputDir, zipOutputPath);

    const zipBuffer = fs.readFileSync(zipOutputPath);

    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}

    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="' + result.templateName + '.zip"',
      'X-Template-Name': result.templateName,
      'X-Layers-Count': String(result.layersCount),
      'X-Warnings': JSON.stringify(result.warnings),
    });
    res.send(zipBuffer);
  } catch (error) {
    console.error('Conversion error:', error);
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
    res.status(500).json({ error: error.message || 'حدث خطأ أثناء التحويل' });
  }
});

// ==================== Render API ====================

app.post('/api/render', upload.single('file'), async (req, res) => {
  const tempDir = path.join(os.tmpdir(), 'design-render-' + Date.now());

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'لم يتم رفع أي ملف' });
    }

    const uploadPath = path.join(tempDir, 'input.zip');
    const extractDir = path.join(tempDir, 'extracted');
    fs.mkdirSync(tempDir, { recursive: true });
    fs.mkdirSync(extractDir, { recursive: true });

    fs.writeFileSync(uploadPath, req.file.buffer);

    // Extract using JSZip
    try {
      const zipData = fs.readFileSync(uploadPath);
      const zip = await JSZip.loadAsync(zipData);
      const writePromises = [];
      zip.forEach((relativePath, entry) => {
        if (entry.dir) {
          fs.mkdirSync(path.join(extractDir, relativePath), { recursive: true });
          return;
        }
        const fullPath = path.join(extractDir, relativePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        writePromises.push(
          entry.async('nodebuffer').then((buf) => {
            fs.writeFileSync(fullPath, buf);
          })
        );
      });
      await Promise.all(writePromises);
    } catch (e) {
      throw new Error('فشل فك ضغط الملف');
    }

    // Find JSON
    const allFiles = collectFiles(extractDir);
    console.log('All files:', allFiles.map(f => f.relativePath));
    let jsonFile = allFiles.find((f) => f.relativePath === 'data.json');
    if (!jsonFile) {
      jsonFile = allFiles.find((f) => (f.relativePath.includes('/') || f.relativePath.includes('\\')) && f.relativePath.endsWith('.json'));
    }
    if (!jsonFile) throw new Error('لم يتم العثور على ملف JSON');

    const jsonData = JSON.parse(fs.readFileSync(jsonFile.fullPath, 'utf-8'));
    const templateName = jsonData.name || 'Design';
    const layers = jsonData.layers || [];

    let canvasWidth = 1080;
    let canvasHeight = 1080;
    const bgLayer = layers.find((l) => l.name === 'baseBackground');
    if (bgLayer) {
      canvasWidth = bgLayer.width || 1080;
      canvasHeight = bgLayer.height || 1080;
    }

    const warnings = [];

    // Create session
    const sessionId = crypto.randomBytes(8).toString('hex');
    const sessionDir = path.join(SESSIONS_DIR, sessionId);
    ensureDir(sessionDir);

    // Collect fonts
    const fontsDir = path.join(extractDir, 'fonts');
    const fontList = [];
    if (fs.existsSync(fontsDir)) {
      const fontFiles = collectFiles(fontsDir);
      for (const f of fontFiles) {
        const ext = path.extname(f.relativePath).toLowerCase();
        if (isFontFile(f.relativePath)) {
          const fontName = path.basename(f.relativePath, ext);
          let format = 'truetype';
          if (ext === '.otf') format = 'opentype';
          else if (ext === '.woff') format = 'woff';
          else if (ext === '.woff2') format = 'woff2';
          fontList.push({ name: fontName, path: 'fonts/' + f.relativePath, format });
          const fontDestDir = path.join(sessionDir, 'fonts');
          ensureDir(fontDestDir);
          fs.copyFileSync(f.fullPath, path.join(fontDestDir, path.basename(f.relativePath)));
        }
      }
    }

    // Process layers
    const imageLayers = [];
    const textLayers = [];
    const skinsDir = path.join(extractDir, 'skins');
    const imagesDir = path.join(sessionDir, 'images');
    ensureDir(imagesDir);

    for (const layer of layers) {
      try {
        if (layer.type === 'image' && layer.src) {
          const srcParts = layer.src.replace('../', '').split('/');
          let fullImagePath = path.join(extractDir, srcParts.join('/'));

          if (!fs.existsSync(fullImagePath)) {
            const altPath = srcParts.slice(1).join('/');
            fullImagePath = path.join(extractDir, altPath);
            if (!fs.existsSync(fullImagePath) && fs.existsSync(skinsDir)) {
              const filename = srcParts[srcParts.length - 1];
              const skinFiles = collectFiles(skinsDir);
              const found = skinFiles.find(f => f.relativePath.endsWith(filename));
              if (found) fullImagePath = found.fullPath;
            }
            if (!fs.existsSync(fullImagePath)) {
              warnings.push('Image not found: ' + layer.src);
              continue;
            }
          }

          const imageKey = layer.name || 'img_' + imageLayers.length;
          const ext = path.extname(fullImagePath) || '.png';
          const destFileName = imageKey + ext;
          fs.copyFileSync(fullImagePath, path.join(imagesDir, destFileName));

          imageLayers.push({
            name: layer.name,
            src: imageKey,
            imageFile: destFileName,
            x: layer.x || 0,
            y: layer.y || 0,
            width: layer.width || canvasWidth,
            height: layer.height || canvasHeight,
            rotation: layer.rotation || 0,
            opacity: layer.opacity,
          });
        } else if (layer.type === 'text') {
          textLayers.push({
            type: 'text',
            name: layer.name,
            text: layer.text,
            font: layer.font,
            x: layer.x || 0,
            y: layer.y || 0,
            width: layer.width || 0,
            height: layer.height || 0,
            rotation: layer.rotation || 0,
            size: layer.size,
            color: layer.color,
            justification: layer.justification,
            lineHeight: layer.lineHeight,
            weight: layer.weight,
            uppercase: layer.uppercase,
            opacity: layer.opacity,
          });
        }
      } catch (layerErr) {
        warnings.push('Layer error (' + layer.name + '): ' + layerErr.message);
      }
    }

    // Font resources as base64
    const fontResources = {};
    if (fs.existsSync(fontsDir)) {
      const fontFiles = collectFiles(fontsDir);
      for (const f of fontFiles) {
        if (isFontFile(f.relativePath)) {
          try {
            const fontBuffer = fs.readFileSync(f.fullPath);
            const mimeType = getMimeType(f.relativePath);
            fontResources['fonts/' + f.relativePath] = 'data:' + mimeType + ';base64,' + fontBuffer.toString('base64');
          } catch (e) {}
        }
      }
    }

    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}

    res.json({
      sessionId,
      templateName,
      canvasWidth,
      canvasHeight,
      imageLayers,
      textLayers,
      fonts: fontList,
      fontResources,
      totalLayers: layers.length,
      warnings,
    });
  } catch (error) {
    console.error('Render error:', error);
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
    res.status(500).json({ error: error.message || 'حدث خطأ أثناء التحضير للرندر' });
  }
});

// ==================== Render Image API ====================

app.get('/api/render-image/:sessionId/:imageName', (req, res) => {
  const { sessionId, imageName } = req.params;
  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9]/g, '');
  const safeImageName = imageName.replace(/[^a-zA-Z0-9._-]/g, '');
  const imagePath = path.join(SESSIONS_DIR, safeSessionId, 'images', safeImageName);

  if (!fs.existsSync(imagePath)) {
    return res.status(404).json({ error: 'Image not found' });
  }

  const buffer = fs.readFileSync(imagePath);
  const ext = path.extname(imagePath).toLowerCase();

  let contentType = 'application/octet-stream';
  if (ext === '.png') contentType = 'image/png';
  else if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
  else if (ext === '.svg') contentType = 'image/svg+xml';
  else if (ext === '.webp') contentType = 'image/webp';
  else if (ext === '.gif') contentType = 'image/gif';

  res.set({
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=3600',
  });
  res.send(buffer);
});

// ==================== Start Server ====================

app.listen(PORT, () => {
  console.log('Server running on http://localhost:' + PORT);
});
