/**
 * محول التصاميم - نسخة تعمل في المتصفح بالكامل (لا تحتاج خادم)
 * يستبدل sharp بـ Canvas API لمعالجة الصور
 */

const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.woff', '.woff2', '.eof']);
const VECTOR_EXTENSIONS = new Set(['.svg']);

const MIME_TYPE_MAP = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.bmp': 'image/bmp', '.tiff': 'image/tiff', '.tif': 'image/tiff',
  '.ico': 'image/x-icon', '.heic': 'image/heic', '.heif': 'image/heif',
  '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.eot': 'application/vnd.ms-fontobject',
};

function getExt(path) {
  const idx = path.lastIndexOf('.');
  return idx >= 0 ? path.slice(idx).toLowerCase() : '';
}

function getBaseName(path) {
  const idx = path.lastIndexOf('/');
  const name = idx >= 0 ? path.slice(idx + 1) : path;
  const dotIdx = name.lastIndexOf('.');
  return dotIdx >= 0 ? name.slice(0, dotIdx) : name;
}

function isFontFile(path) {
  return FONT_EXTENSIONS.has(getExt(path));
}

function rgbToHex(red, green, blue) {
  const r = Math.round(Math.abs(red) * 255).toString(16).padStart(2, '0');
  const g = Math.round(Math.abs(green) * 255).toString(16).padStart(2, '0');
  const b = Math.round(Math.abs(blue) * 255).toString(16).padStart(2, '0');
  return '0x' + r + g + b;
}

// ==================== File System Helpers (in-memory) ====================

class VirtualFS {
  constructor() {
    this.files = new Map(); // path -> Uint8Array
  }

  writeFile(path, data) {
    this.files.set(path, data);
  }

  readFile(path) {
    return this.files.get(path);
  }

  exists(path) {
    return this.files.has(path);
  }

  listDir(prefix) {
    const result = [];
    for (const path of this.files.keys()) {
      if (path.startsWith(prefix)) {
        result.push(path);
      }
    }
    return result;
  }

  collectFiles(baseDir) {
    const results = [];
    const normalizedBase = baseDir.endsWith('/') ? baseDir : baseDir + '/';
    for (const [path, data] of this.files.entries()) {
      if (path.startsWith(normalizedBase) || path === baseDir) {
        results.push({
          relativePath: path.startsWith(normalizedBase) ? path.slice(normalizedBase.length) : '',
          fullPath: path,
          data,
        });
      }
    }
    return results;
  }
}

// ==================== ZIP Helpers (browser-based) ====================

async function extractZipToVFS(file, vfs, baseDir = '') {
  const zipData = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(zipData);
  const promises = [];
  zip.forEach((relativePath, entry) => {
    if (entry.dir) return;
    promises.push(
      entry.async('uint8array').then((data) => {
        const fullPath = baseDir ? baseDir + '/' + relativePath : relativePath;
        vfs.writeFile(fullPath, data);
      })
    );
  });
  await Promise.all(promises);
}

async function createZipFromVFS(vfs) {
  const zip = new JSZip();
  for (const [path, data] of vfs.files.entries()) {
    zip.file(path, data);
  }
  return await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

// ==================== Image Processing (Canvas-based replacement for sharp) ====================

async function loadImageFromBuffer(buffer, mimeType) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([buffer], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image'));
    };
    img.src = url;
  });
}

async function canvasToBlob(canvas, type = 'image/png', quality = 1) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

async function canvasToUint8Array(canvas, type = 'image/png') {
  const blob = await canvasToBlob(canvas, type);
  return new Uint8Array(await blob.arrayBuffer());
}

async function convertImageToFormat(srcBuffer, srcPath, width, height, outputFormat) {
  outputFormat = outputFormat || 'png';
  const ext = getExt(srcPath);
  const mimeType = MIME_TYPE_MAP[ext] || 'image/png';

  let img;
  try {
    img = await loadImageFromBuffer(srcBuffer, mimeType);
  } catch (e) {
    return srcBuffer;
  }

  let targetWidth = img.naturalWidth || img.width;
  let targetHeight = img.naturalHeight || img.height;

  if (width > 0 && height > 0) {
    const ratio = Math.min(width / targetWidth, height / targetHeight);
    if (ratio < 1) {
      targetWidth = Math.round(targetWidth * ratio);
      targetHeight = Math.round(targetHeight * ratio);
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, targetWidth);
  canvas.height = Math.max(1, targetHeight);
  const ctx = canvas.getContext('2d');

  if (outputFormat === 'png' || outputFormat === 'webp') {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  switch (outputFormat) {
    case 'jpeg':
      const jpegCanvas = document.createElement('canvas');
      jpegCanvas.width = canvas.width;
      jpegCanvas.height = canvas.height;
      const jpegCtx = jpegCanvas.getContext('2d');
      jpegCtx.fillStyle = '#ffffff';
      jpegCtx.fillRect(0, 0, jpegCanvas.width, jpegCanvas.height);
      jpegCtx.drawImage(canvas, 0, 0);
      return await canvasToUint8Array(jpegCanvas, 'image/jpeg', 0.95);
    case 'webp':
      return await canvasToUint8Array(canvas, 'image/webp', 0.95);
    case 'png':
    default:
      return await canvasToUint8Array(canvas, 'image/png');
  }
}

async function createBlankPng(width, height, bgColor) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  const ctx = canvas.getContext('2d');
  if (bgColor) {
    ctx.fillStyle = `rgba(${bgColor.r}, ${bgColor.g}, ${bgColor.b}, ${bgColor.alpha !== undefined ? bgColor.alpha : 1})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  } else {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  return await canvasToUint8Array(canvas, 'image/png');
}

async function downloadFile(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Download failed with status ' + response.status);
  return new Uint8Array(await response.arrayBuffer());
}

// ==================== Main Converter ====================

async function convertDesign(vfs, projectDir, outputBaseDir, sourceFileName, customDesignName, onProgress) {
  const log = (msg) => onProgress && onProgress(msg);
  log('بدء التحويل...');

  const outputJsonDir = outputBaseDir + '/json';
  const outputSkinsDir = outputBaseDir + '/skins';
  const outputFontsDir = outputBaseDir + '/fonts';
  const usedFonts = new Set();
  const warnings = [];

  let dataPath = projectDir + '/data.json';
  let titlePath = projectDir + '/title.data';
  let photosDir = projectDir + '/Photos';

  if (!vfs.exists(dataPath)) {
    const entries = vfs.listDir(projectDir + '/');
    for (const entry of entries) {
      const relPath = entry.slice(projectDir.length + 1);
      if (!relPath.includes('/')) continue;
      const subDir = projectDir + '/' + relPath.split('/')[0];
      const candidateDataPath = subDir + '/data.json';
      if (vfs.exists(candidateDataPath)) {
        dataPath = candidateDataPath;
        titlePath = subDir + '/title.data';
        photosDir = subDir + '/Photos';
        break;
      }
    }
  }

  if (!vfs.exists(dataPath)) {
    throw new Error('data.json not found in the uploaded ZIP');
  }

  log('تم العثور على data.json');

  let templateName = 'Exported_Design';
  if (customDesignName) {
    templateName = customDesignName.replace(/[^a-zA-Z0-9_\-\u0600-\u06FF]/g, '_');
  } else if (sourceFileName) {
    templateName = sourceFileName.replace(/\.zip$/i, '').replace(/[^a-zA-Z0-9_\-\u0600-\u06FF]/g, '_');
  } else if (vfs.exists(titlePath)) {
    const titleBytes = vfs.readFile(titlePath);
    const titleContent = new TextDecoder('utf-8').decode(titleBytes).trim();
    if (titleContent && titleContent !== 'New Design') {
      templateName = titleContent.replace(/\s+/g, '_');
    }
  }

  const skinsPath = outputSkinsDir + '/' + templateName;

  const dataBytes = vfs.readFile(dataPath);
  const data = JSON.parse(new TextDecoder('utf-8').decode(dataBytes));
  const size = data.size;
  const canvasWidth = parseInt(String(size.size[0]));
  const canvasHeight = parseInt(String(size.size[1]));

  const layers = [];
  const pendingImages = [];
  const pendingFontDownloads = [];

  log(`معالجة ${data.layers.length} طبقة...`);

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
          const baseBgPath = skinsPath + '/' + baseBgFilename;
          const bgFilename = 'backgroundImage.png';
          const bgPath = skinsPath + '/' + bgFilename;

          pendingImages.push({
            type: 'create-blank',
            destPath: baseBgPath,
            width: canvasWidth,
            height: canvasHeight,
            bgColor: null,
          });
          pendingImages.push({
            type: 'create-blank',
            destPath: bgPath,
            width: canvasWidth,
            height: canvasHeight,
            bgColor: { ...bgColor, alpha: 1 },
          });

          layers.push({
            type: 'image', name: 'baseBackground',
            src: '../skins/' + templateName + '/' + baseBgFilename,
            x: 0, y: 0,
            width: canvasWidth, height: canvasHeight,
          });
          layers.push({
            type: 'image', name: 'backgroundImage',
            src: '../skins/' + templateName + '/' + bgFilename,
            x: 0, y: 0,
            width: canvasWidth, height: canvasHeight,
            rotation: 0,
          });
        }
      } else if (classType === 'image') {
        const layerId = value.layerId || 'image_' + layers.length;
        const mediaName = value.media && value.media.image && value.media.image.name;

        if (mediaName) {
          const srcPath = photosDir + '/' + mediaName;
          const ext = getExt(mediaName) || '.png';
          const destFilename = layerId + ext;
          const destPath = skinsPath + '/' + destFilename;

          if (vfs.exists(srcPath)) {
            const frame = value.frame;
            const transform = value.transform || {};
            const scaleX = transform.scale ? transform.scale[0] : 1;
            const scaleY = transform.scale ? transform.scale[1] : 1;
            const width = Math.max(1, Math.round(frame[1][0] * canvasWidth * Math.abs(scaleX)));
            const height = Math.max(1, Math.round(frame[1][1] * canvasHeight * Math.abs(scaleY)));
            const x = Math.round(frame[0][0] * canvasWidth - width / 2);
            const y = Math.round(frame[0][1] * canvasHeight - height / 2);
            const rotation = (transform.rotation || 0) * (180 / Math.PI);
            const extLower = ext.toLowerCase();

            if (VECTOR_EXTENSIONS.has(extLower)) {
              vfs.writeFile(destPath, vfs.readFile(srcPath));
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
                type: 'convert',
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
          const srcPath = photosDir + '/' + svgName;
          const ext = getExt(svgName) || '.svg';
          const destFilename = layerId + ext;
          const destPath = skinsPath + '/' + destFilename;

          if (vfs.exists(srcPath)) {
            const frame = value.frame;
            const transform = value.transform || {};
            const scaleX = transform.scale ? transform.scale[0] : 1;
            const scaleY = transform.scale ? transform.scale[1] : 1;
            const width = Math.max(1, Math.round(frame[1][0] * canvasWidth * Math.abs(scaleX)));
            const height = Math.max(1, Math.round(frame[1][1] * canvasHeight * Math.abs(scaleY)));
            const x = Math.round(frame[0][0] * canvasWidth - width / 2);
            const y = Math.round(frame[0][1] * canvasHeight - height / 2);

            vfs.writeFile(destPath, vfs.readFile(srcPath));
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
          if (fontUrl && !vfs.exists(outputFontsDir + '/' + fontFile)) {
            pendingFontDownloads.push({
              url: fontUrl,
              destPath: outputFontsDir + '/' + fontFile,
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

  log(`معالجة ${pendingImages.length} صورة...`);

  const IMAGE_CONCURRENCY = 4;
  for (let i = 0; i < pendingImages.length; i += IMAGE_CONCURRENCY) {
    const batch = pendingImages.slice(i, i + IMAGE_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (task) => {
        if (task.type === 'create-blank') {
          const pngData = await createBlankPng(task.width, task.height, task.bgColor);
          vfs.writeFile(task.destPath, pngData);
        } else {
          const srcBuffer = vfs.readFile(task.srcPath);
          const converted = await convertImageToFormat(srcBuffer, task.srcPath, task.width, task.height, task.format);
          vfs.writeFile(task.destPath, converted);
        }
        return task;
      })
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result.status === 'fulfilled') {
        const task = result.value;
        if (task.type === 'convert') {
          layers.push({
            type: 'image', name: task.layerId,
            src: '../skins/' + templateName + '/' + task.destFilename,
            x: task.x, y: task.y, width: task.width, height: task.height,
            rotation: task.rotation,
          });
        }
      } else {
        const task = batch[j];
        warnings.push('Image error (' + (task.layerId || 'blank') + '): ' + (result.reason && result.reason.message || 'Unknown'));
      }
    }
    log(`تم ${Math.min(i + IMAGE_CONCURRENCY, pendingImages.length)} / ${pendingImages.length} صورة`);
  }

  log('تنزيل الخطوط...');
  const fontResults = await Promise.allSettled(
    pendingFontDownloads.map(async (task) => {
      const data = await downloadFile(task.url);
      vfs.writeFile(task.destPath, data);
      return task;
    })
  );
  for (const r of fontResults) {
    if (r.status === 'rejected') {
      warnings.push('Font download failed: ' + (r.reason && r.reason.message || 'Unknown'));
    }
  }

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

  const outputJsonPath = outputJsonDir + '/' + templateName + '.json';
  vfs.writeFile(outputJsonPath, new TextEncoder().encode(JSON.stringify(templateJson, null, 2)));

  const exportFontsDir = outputBaseDir + '/fonts';
  for (const fontFile of usedFonts) {
    const srcFontPath = outputFontsDir + '/' + fontFile;
    if (vfs.exists(srcFontPath)) {
      vfs.writeFile(exportFontsDir + '/' + fontFile, vfs.readFile(srcFontPath));
    }
  }

  const srcFontsDir = (projectDir + '/fonts');
  const srcFontFiles = vfs.collectFiles(srcFontsDir);
  for (const f of srcFontFiles) {
    if (isFontFile(f.relativePath)) {
      const destPath = exportFontsDir + '/' + f.relativePath.split('/').pop();
      if (!vfs.exists(destPath)) {
        vfs.writeFile(destPath, f.data);
      }
    }
  }

  log('اكتمل التحويل!');
  return { templateName, layersCount: layers.length, outputPath: outputBaseDir, warnings };
}

// ==================== Render Preparation ====================

async function prepareRenderData(file, onProgress) {
  const log = (msg) => onProgress && onProgress(msg);
  log('فك ضغط الملف...');

  const vfs = new VirtualFS();
  await extractZipToVFS(file, vfs);

  const allFiles = Array.from(vfs.files.keys());
  log(`تم العثور على ${allFiles.length} ملف`);

  let jsonPath = allFiles.find((p) => p === 'data.json' || p.endsWith('/data.json'));
  if (!jsonPath) {
    jsonPath = allFiles.find((p) => p.endsWith('.json') && (p.includes('/') || p.includes('\\')));
  }
  if (!jsonPath) throw new Error('لم يتم العثور على ملف JSON');

  log(`قراءة ${jsonPath}...`);
  const jsonBytes = vfs.readFile(jsonPath);
  const jsonData = JSON.parse(new TextDecoder('utf-8').decode(jsonBytes));
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

  const fontList = [];
  const fontResources = {};

  for (const path of allFiles) {
    if (isFontFile(path)) {
      const filename = path.split('/').pop();
      const ext = getExt(path);
      let format = 'truetype';
      if (ext === '.otf') format = 'opentype';
      else if (ext === '.woff') format = 'woff';
      else if (ext === '.woff2') format = 'woff2';

      const fontName = getBaseName(filename);
      fontList.push({ name: fontName, path: 'fonts/' + filename, format });

      try {
        const fontBuffer = vfs.readFile(path);
        const mimeType = MIME_TYPE_MAP[ext] || 'font/ttf';
        let base64 = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < fontBuffer.length; i += chunkSize) {
          base64 += String.fromCharCode.apply(null, fontBuffer.subarray(i, i + chunkSize));
        }
        fontResources['fonts/' + filename] = 'data:' + mimeType + ';base64,' + btoa(base64);
      } catch (e) {
        warnings.push('Failed to encode font: ' + filename);
      }
    }
  }

  log(`تم العثور على ${fontList.length} خط`);

  const imageLayers = [];
  const textLayers = [];

  for (const layer of layers) {
    try {
      if (layer.type === 'image' && layer.src) {
        let imgPath = layer.src.replace('../', '');
        if (imgPath.startsWith('/')) imgPath = imgPath.slice(1);

        let foundPath = null;
        const candidates = [imgPath];
        const lastSegment = imgPath.split('/').pop();
        for (const p of allFiles) {
          if (p.endsWith(lastSegment)) candidates.push(p);
        }
        for (const p of candidates) {
          if (typeof p === 'string' && vfs.exists(p)) {
            foundPath = p;
            break;
          }
        }

        if (!foundPath) {
          warnings.push('Image not found: ' + layer.src);
          continue;
        }

        const imgBuffer = vfs.readFile(foundPath);
        const ext = getExt(foundPath);
        const mimeType = MIME_TYPE_MAP[ext] || 'image/png';
        let base64 = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < imgBuffer.length; i += chunkSize) {
          base64 += String.fromCharCode.apply(null, imgBuffer.subarray(i, i + chunkSize));
        }
        const dataUrl = 'data:' + mimeType + ';base64,' + btoa(base64);

        const imageKey = layer.name || 'img_' + imageLayers.length;
        imageLayers.push({
          name: layer.name,
          src: imageKey,
          dataUrl,
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

  log(`تم تحضير ${imageLayers.length} صورة و ${textLayers.length} نص`);

  return {
    templateName,
    canvasWidth,
    canvasHeight,
    imageLayers,
    textLayers,
    fonts: fontList,
    fontResources,
    totalLayers: layers.length,
    warnings,
  };
}

window.DesignConverter = {
  VirtualFS,
  extractZipToVFS,
  createZipFromVFS,
  convertDesign,
  prepareRenderData,
  isFontFile,
  getExt,
  getBaseName,
  MIME_TYPE_MAP,
};
