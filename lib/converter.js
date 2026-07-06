const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const JSZip = require('jszip');
const archiver = require('archiver');
const { ensureDir, isFontFile, collectFiles } = require('./file-utils');

// ==================== Image Type Maps ====================

const SHARP_IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.tiff', '.tif',
  '.svg', '.ico', '.bmp', '.dds', '.fits', '.heif', '.heic',
  '.jxl', '.pbm', '.pfm', '.pgm', '.ppm', '.raw',
]);

const VECTOR_EXTENSIONS = new Set(['.svg']);

// ==================== Helper Functions ====================

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(dest)) {
      resolve();
      return;
    }
    const file = fs.createWriteStream(dest);
    const doRequest = (requestUrl) => {
      const client = requestUrl.startsWith('https') ? https : http;
      client.get(requestUrl, (response) => {
        if ([301, 302, 307, 308].includes(response.statusCode)) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            doRequest(redirectUrl);
            return;
          }
        }
        if (response.statusCode !== 200) {
          reject(new Error('Download failed with status ' + response.statusCode));
          return;
        }
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
      }).on('error', reject);
    };
    doRequest(url);
  });
}

function rgbToHex(red, green, blue) {
  const r = Math.round(Math.abs(red) * 255).toString(16).padStart(2, '0');
  const g = Math.round(Math.abs(green) * 255).toString(16).padStart(2, '0');
  const b = Math.round(Math.abs(blue) * 255).toString(16).padStart(2, '0');
  return '0x' + r + g + b;
}

async function convertImageToFormat(srcPath, destPath, width, height, outputFormat) {
  outputFormat = outputFormat || 'png';
  const ext = path.extname(srcPath).toLowerCase();

  if (VECTOR_EXTENSIONS.has(ext)) {
    try {
      const svgBuffer = fs.readFileSync(srcPath);
      await sharp(svgBuffer)
        .resize(width, height, { fit: 'inside', withoutEnlargement: true })
        .png()
        .toFile(destPath.replace(/\.\w+$/, '.png'));
      return;
    } catch (e) {
      fs.copyFileSync(srcPath, destPath);
      return;
    }
  }

  try {
    let pipeline = sharp(srcPath, {
      failOn: 'none',
      unlimited: true,
    });

    if (width > 0 && height > 0) {
      pipeline = pipeline.resize(width, height, {
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    switch (outputFormat) {
      case 'jpeg':
        await pipeline.jpeg({ quality: 100, mozjpeg: true }).toFile(destPath);
        break;
      case 'webp':
        await pipeline.webp({ quality: 100 }).toFile(destPath);
        break;
      case 'png':
      default:
        await pipeline.png({ compressionLevel: 6, effort: 7 }).toFile(destPath);
        break;
    }
  } catch (sharpError) {
    try {
      fs.copyFileSync(srcPath, destPath);
    } catch (copyError) {
      throw new Error('Cannot process image file: ' + srcPath);
    }
  }
}

// ==================== Main Converter ====================

async function convertDesign(projectDir, outputBaseDir, sourceFileName, customDesignName) {
  const outputJsonDir = path.join(outputBaseDir, 'json');
  const outputSkinsDir = path.join(outputBaseDir, 'skins');
  const outputFontsDir = path.join(outputBaseDir, 'fonts');
  const usedFonts = new Set();
  const warnings = [];

  ensureDir(outputJsonDir);
  ensureDir(outputFontsDir);

  let dataPath = path.join(projectDir, 'data.json');
  let titlePath = path.join(projectDir, 'title.data');
  let photosDir = path.join(projectDir, 'Photos');

  if (!fs.existsSync(dataPath)) {
    const entries = fs.readdirSync(projectDir);
    for (const entry of entries) {
      const entryPath = path.join(projectDir, entry);
      try {
        if (fs.statSync(entryPath).isDirectory()) {
          const candidateDataPath = path.join(entryPath, 'data.json');
          if (fs.existsSync(candidateDataPath)) {
            dataPath = candidateDataPath;
            titlePath = path.join(entryPath, 'title.data');
            photosDir = path.join(entryPath, 'Photos');
            break;
          }
        }
      } catch (e) {
        continue;
      }
    }
  }

  if (!fs.existsSync(dataPath)) {
    throw new Error('data.json not found in the uploaded ZIP');
  }

  let templateName = 'Exported_Design';
  if (customDesignName) {
    templateName = customDesignName.replace(/[^a-zA-Z0-9_\-\u0600-\u06FF]/g, '_');
  } else if (sourceFileName) {
    templateName = sourceFileName.replace(/\.zip$/i, '').replace(/[^a-zA-Z0-9_\-\u0600-\u06FF]/g, '_');
  } else if (fs.existsSync(titlePath)) {
    const titleContent = fs.readFileSync(titlePath, 'utf-8').trim();
    if (titleContent && titleContent !== 'New Design') {
      templateName = titleContent.replace(/\s+/g, '_');
    }
  }

  const skinsPath = path.join(outputSkinsDir, templateName);
  ensureDir(skinsPath);

  const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));

  // Defensive: data must be an object with at least a layers array.
  if (!data || typeof data !== 'object') {
    throw new Error('data.json ليس كائناً صالحاً');
  }
  if (!Array.isArray(data.layers)) {
    throw new Error('data.json يجب أن يحتوي على مصفوفة layers');
  }

  // Defensive: size may be missing in some test/simple designs.
  // Default to a 1080x1920 canvas so conversion still produces a valid template.
  const size = data.size || { size: [1080, 1920], unit: 'px' };
  if (!size.size || !Array.isArray(size.size) || size.size.length < 2) {
    throw new Error('data.json يجب أن يحتوي على size.size كزوج إحداثيات');
  }
  const canvasWidth = parseInt(String(size.size[0]), 10) || 1080;
  const canvasHeight = parseInt(String(size.size[1]), 10) || 1920;

  const layers = [];

  // ===== Phase 1: Collect all layer info =====
  const pendingImages = [];
  const pendingFontDownloads = [];

  for (const layer of data.layers) {
    const classType = layer.type || layer.classType;
    const value = layer.value;

    try {
      if (classType === 'background') {
        const fill = (value.fillType && value.fillType.basic && value.fillType.basic.fill &&
          value.fillType.basic.fill.content && value.fillType.basic.fill.content.value) ||
          (value.fill && value.fill.content && value.fill.content.value);
        if (fill && fill.paletteValue && fill.paletteValue.advancedColor &&
            fill.paletteValue.advancedColor.model && fill.paletteValue.advancedColor.model.value) {
          const rgb = fill.paletteValue.advancedColor.model.value;
          const bgColor = {
            r: Math.round(rgb.red * 255),
            g: Math.round(rgb.green * 255),
            b: Math.round(rgb.blue * 255),
          };

          const baseBgFilename = 'baseBackground.png';
          const baseBgDestPath = path.join(skinsPath, baseBgFilename);
          const bgFilename = 'backgroundImage.png';
          const bgDestPath = path.join(skinsPath, bgFilename);

          await Promise.all([
            sharp({
              create: {
                width: canvasWidth,
                height: canvasHeight,
                channels: 4,
                background: { r: 0, g: 0, b: 0, alpha: 0 },
              },
            }).png().toFile(baseBgDestPath),
            sharp({
              create: {
                width: canvasWidth,
                height: canvasHeight,
                channels: 4,
                background: { ...bgColor, alpha: 1 },
              },
            }).png().toFile(bgDestPath),
          ]);

          layers.push({
            type: 'image',
            name: 'baseBackground',
            src: '../skins/' + templateName + '/' + baseBgFilename,
            x: 0, y: 0,
            width: canvasWidth, height: canvasHeight,
          });
          layers.push({
            type: 'image',
            name: 'backgroundImage',
            src: '../skins/' + templateName + '/' + bgFilename,
            x: 0, y: 0,
            width: canvasWidth, height: canvasHeight,
            rotation: 0,
          });
        }
      } else if (classType === 'image') {
        const layerId = value.layerId || value.name || 'image_' + layers.length;
        // Support two media-name shapes:
        //   Antigravity: value.media.image.name
        //   Simplified:  value.image.fileName
        const mediaName = (value.media && value.media.image && value.media.image.name) ||
                          (value.image && value.image.fileName) ||
                          (value.image && value.image.name);

        if (mediaName) {
          const srcPath = path.join(photosDir, mediaName);
          const ext = path.extname(mediaName) || '.png';
          const destFilename = layerId + ext;
          const destPath = path.join(skinsPath, destFilename);

          if (fs.existsSync(srcPath)) {
            let width, height, x, y, rotation;
            if (value.frame && Array.isArray(value.frame) && value.frame.length === 2) {
              // Antigravity format: frame = [[cx, cy], [w, h]] (normalized 0..1)
              const transform = value.transform || {};
              const scaleX = transform.scale ? transform.scale[0] : 1;
              const scaleY = transform.scale ? transform.scale[1] : 1;
              width = Math.max(1, Math.round(value.frame[1][0] * canvasWidth * Math.abs(scaleX)));
              height = Math.max(1, Math.round(value.frame[1][1] * canvasHeight * Math.abs(scaleY)));
              x = Math.round(value.frame[0][0] * canvasWidth - width / 2);
              y = Math.round(value.frame[0][1] * canvasHeight - height / 2);
              rotation = (transform.rotation || 0) * (180 / Math.PI);
            } else if (value.position && value.size) {
              // Simplified format: position = {x, y}, size = {width, height} (pixels)
              width = Math.max(1, Math.round(value.size.width || 100));
              height = Math.max(1, Math.round(value.size.height || 100));
              x = Math.round(value.position.x || 0);
              y = Math.round(value.position.y || 0);
              rotation = 0;
            } else {
              // Fallback: place at origin with default size
              width = Math.max(1, Math.round(canvasWidth * 0.5));
              height = Math.max(1, Math.round(canvasHeight * 0.5));
              x = 0; y = 0; rotation = 0;
              warnings.push('Image layer missing frame/position: ' + mediaName + ' (placed at origin)');
            }
            const extLower = ext.toLowerCase();

            if (VECTOR_EXTENSIONS.has(extLower)) {
              fs.copyFileSync(srcPath, destPath);
              layers.push({
                type: 'image', name: layerId,
                src: '../skins/' + templateName + '/' + destFilename,
                x, y, width, height, rotation,
              });
            } else {
              let format = 'png';
              let needsPngRename = false;
              if (extLower === '.jpg' || extLower === '.jpeg') format = 'jpeg';
              else if (extLower === '.webp') format = 'webp';
              else if (extLower === '.png') format = 'png';
              else { format = 'png'; needsPngRename = true; }

              const actualDestFilename = needsPngRename ? destFilename.replace(/\.\w+$/, '.png') : destFilename;
              const actualDestPath = needsPngRename ? destPath.replace(/\.\w+$/, '.png') : destPath;

              pendingImages.push({
                layerId, srcPath, destFilename: actualDestFilename,
                destPath: actualDestPath, width, height, x, y, rotation, format,
              });
            }
          } else {
            warnings.push('Image file not found: ' + mediaName);
          }
        }
      } else if (classType === 'sticker') {
        const layerId = value.layerId || 'sticker_' + layers.length;
        const svgName = value.stickerInfo && value.stickerInfo.svg && value.stickerInfo.svg.name;

        if (svgName) {
          const srcPath = path.join(photosDir, svgName);
          const ext = path.extname(svgName) || '.svg';
          const destFilename = layerId + ext;
          const destPath = path.join(skinsPath, destFilename);

          if (fs.existsSync(srcPath)) {
            const frame = value.frame;
            const transform = value.transform || {};
            const scaleX = transform.scale ? transform.scale[0] : 1;
            const scaleY = transform.scale ? transform.scale[1] : 1;
            const width = Math.max(1, Math.round(frame[1][0] * canvasWidth * Math.abs(scaleX)));
            const height = Math.max(1, Math.round(frame[1][1] * canvasHeight * Math.abs(scaleY)));
            const x = Math.round(frame[0][0] * canvasWidth - width / 2);
            const y = Math.round(frame[0][1] * canvasHeight - height / 2);

            fs.copyFileSync(srcPath, destPath);
            layers.push({
              type: 'image', name: layerId,
              src: '../skins/' + templateName + '/' + destFilename,
              x, y, width, height,
              rotation: (transform.rotation || 0) * (180 / Math.PI),
            });
          } else {
            warnings.push('Sticker file not found: ' + svgName);
          }
        }
      } else if (classType === 'text') {
        const layerId = value.layerId || 'text_' + layers.length;
        const textContent = (value.text && value.text.text) || '';
        const fontFamily = value.font && value.font.family;
        const fontSizeNormalized = (value.font && value.font.size) || 0.05;
        const fill = value.fill && value.fill.content && value.fill.content.value;
        const frame = value.frame;
        const textAlignment = value.text && value.text.textAlignment;

        let fontName = 'doran_bold';
        let fontFile = 'doran_bold.ttf';

        if (fontFamily) {
          const saveName = fontFamily.save_name || 'kelk.ttf';
          const baseFontName = saveName.replace(/\.(ttf|otf|woff|woff2|eot)$/i, '').toLowerCase();

          if (baseFontName.includes('kelk')) {
            fontName = 'kelk';
            fontFile = 'kelk.ttf';
          } else if (baseFontName.includes('moshref')) {
            fontName = 'AMoshref-Naskh';
            fontFile = 'AMoshref-Naskh.ttf';
          } else if (baseFontName.includes('doran')) {
            fontName = baseFontName.includes('medium') ? 'doran_medium' : 'doran_bold';
            fontFile = fontName + '.ttf';
          } else {
            fontName = saveName.replace(/\.(ttf|otf|woff|woff2|eot)$/i, '');
            fontFile = saveName;
          }

          const fontUrl = fontFamily.url;
          if (fontUrl && !fs.existsSync(path.join(outputFontsDir, fontFile))) {
            pendingFontDownloads.push({
              url: fontUrl,
              dest: path.join(outputFontsDir, fontFile),
              fontFile,
            });
          }
          usedFonts.add(fontFile);
        }

        const transform = value.transform || {};
        const scaleX = transform.scale ? transform.scale[0] : 1;
        const scaleY = transform.scale ? transform.scale[1] : 1;
        const width = Math.max(1, Math.round(frame[1][0] * canvasWidth * scaleX));
        const height = Math.max(1, Math.round(frame[1][1] * canvasHeight * scaleY));
        const x = Math.round(frame[0][0] * canvasWidth - width / 2);
        const y = Math.round(frame[0][1] * canvasHeight - height / 2);
        const fontSize = Math.round(fontSizeNormalized * canvasHeight);

        let colorHex = '0xffffff';
        if (fill && fill.paletteValue && fill.paletteValue.advancedColor &&
            fill.paletteValue.advancedColor.model && fill.paletteValue.advancedColor.model.value) {
          const rgb = fill.paletteValue.advancedColor.model.value;
          colorHex = rgbToHex(rgb.red, rgb.green, rgb.blue);
        }

        let justification = 'center';
        if (textAlignment) {
          if (textAlignment.left) justification = 'left';
          else if (textAlignment.right) justification = 'right';
        }

        layers.push({
          type: 'text', name: layerId, font: fontName,
          x, y, width, height,
          text: textContent,
          size: fontSize.toString(),
          color: colorHex, justification,
          lineHeight: fontSize.toString(),
          weight: fontName.includes('bold') ? 'bold' : 'normal',
          uppercase: false,
          rotation: (transform.rotation || 0) * (180 / Math.PI),
        });
      }
    } catch (layerError) {
      const msg = 'Layer error (' + classType + ', ' + (value.layerId || 'unknown') + '): ' + layerError.message;
      console.error(msg);
      warnings.push(msg);
    }
  }

  // ===== Phase 2: Process images in parallel =====
  const IMAGE_CONCURRENCY = 4;
  for (let i = 0; i < pendingImages.length; i += IMAGE_CONCURRENCY) {
    const batch = pendingImages.slice(i, i + IMAGE_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (task) => {
        await convertImageToFormat(task.srcPath, task.destPath, task.width, task.height, task.format);
        return task;
      })
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result.status === 'fulfilled') {
        const task = result.value;
        layers.push({
          type: 'image', name: task.layerId,
          src: '../skins/' + templateName + '/' + task.destFilename,
          x: task.x, y: task.y, width: task.width, height: task.height,
          rotation: task.rotation,
        });
      } else {
        const task = batch[j];
        warnings.push('Image error (' + task.layerId + '): ' + (result.reason && result.reason.message || 'Unknown'));
      }
    }
  }

  // Download fonts in parallel
  const fontResults = await Promise.allSettled(
    pendingFontDownloads.map(async (task) => {
      await downloadFile(task.url, task.dest);
      return task;
    })
  );
  for (const r of fontResults) {
    if (r.status === 'rejected') {
      warnings.push('Font download failed: ' + (r.reason && r.reason.message || 'Unknown'));
    }
  }

  // Build output JSON
  const templateJson = {
    name: templateName,
    path: templateName + '/',
    info: {
      description: templateName.replace(/_/g, ' '),
      file: templateName,
      date: new Date().toISOString().split('T')[0],
      title: templateName.replace(/_/g, ' '),
      author: 'Antigravity Pro',
      keywords: 'template, exported',
      generator: 'Antigravity Export Kit v2.0',
    },
    layers,
  };

  const outputJsonPath = path.join(outputJsonDir, templateName + '.json');
  fs.writeFileSync(outputJsonPath, JSON.stringify(templateJson, null, 2));

  // Copy fonts
  const exportFontsDir = path.join(outputBaseDir, 'fonts');
  ensureDir(exportFontsDir);
  for (const fontFile of usedFonts) {
    const srcFont = path.join(outputFontsDir, fontFile);
    if (fs.existsSync(srcFont)) {
      fs.copyFileSync(srcFont, path.join(exportFontsDir, fontFile));
    }
  }

  const srcFontsDir = path.join(path.dirname(dataPath), 'fonts');
  if (fs.existsSync(srcFontsDir)) {
    const srcFontFiles = fs.readdirSync(srcFontsDir);
    for (const fontFile of srcFontFiles) {
      if (isFontFile(fontFile)) {
        const src = path.join(srcFontsDir, fontFile);
        const dest = path.join(exportFontsDir, fontFile);
        if (!fs.existsSync(dest)) {
          fs.copyFileSync(src, dest);
        }
      }
    }
  }

  return { templateName, layersCount: layers.length, outputPath: outputBaseDir, warnings };
}

// ==================== ZIP Functions ====================

function createZipFromDir(sourceDir, outputZipPath) {
  return new Promise((resolve, reject) => {
    ensureDir(path.dirname(outputZipPath));
    const output = fs.createWriteStream(outputZipPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    output.on('close', () => resolve());
    archive.on('error', (err) => reject(err));
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

async function extractZip(zipPath, destDir) {
  ensureDir(destDir);
  const data = fs.readFileSync(zipPath);
  const zip = await JSZip.loadAsync(data);

  const writePromises = [];
  zip.forEach((relativePath, entry) => {
    if (entry.dir) {
      ensureDir(path.join(destDir, relativePath));
      return;
    }
    const fullPath = path.join(destDir, relativePath);
    ensureDir(path.dirname(fullPath));
    writePromises.push(
      entry.async('nodebuffer').then((buffer) => {
        fs.writeFileSync(fullPath, buffer);
      })
    );
  });
  await Promise.all(writePromises);
}

module.exports = { convertDesign, createZipFromDir, extractZip };
