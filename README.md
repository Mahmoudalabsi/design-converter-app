# أدوات التصاميم - تحويل ورندر

تطبيق ويب بسيط لتحويل ورندر تصاميم Antigravity.

## المتطلبات

- **Node.js** الإصدار 18 أو أحدث

## التثبيت والتشغيل

```bash
# 1. فك ضغط الملف
# 2. الدخول للمجلد
cd design-app

# 3. تثبيت المكتبات
npm install

# 4. تشغيل التطبيق
npm start
```

افتح المتصفح على: **http://localhost:3000**

## الأدوات

### أداة التحويل (Convert)
- رفع ملف ZIP الخاص بالتصميم الأصلي
- تحويله إلى هيكلية Export Pro
- تنزيل الملف المحول

### أداة الرندر (Render)
- رفع ملف ZIP بهيكلية Export Pro
- عرض التصميم على Canvas
- تنزيل التصميم كصورة PNG

## الملفات

```
design-app/
├── server.js          # خادم Express
├── package.json       # إعدادات المشروع
├── lib/
│   ├── converter.js   # منطق التحويل
│   └── file-utils.js  # أدوات الملفات
└── public/
    └── index.html     # الواجهة الأمامية
```

## الصيغ المدعومة

الصور: JPG, PNG, SVG, WebP, GIF, AVIF, BMP, TIFF, HEIC, ICO
الخطوط: TTF, OTF, WOFF, WOFF2
