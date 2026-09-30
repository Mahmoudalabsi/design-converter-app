/**
 * ───────────────────────────────────────────────────────────
 *  إعدادات المصادقة - استوديو التصاميم
 * ───────────────────────────────────────────────────────────
 *  ✅ المصادقة مُفعّلة.
 *
 *  نظام المصادقة يستخدم Netlify Functions للتحقق من كلمة المرور.
 *  كلمة المرور مُخزّنة كـ SHA-256(SALT + password) — وليست كنص واضح.
 *
 *  يعمل النظام تلقائياً عبر جميع النطاقات:
 *    - designstudio-app.netlify.app  (نفس الأصل، طلبات نسبية)
 *    - designstudio-app.pages.dev    (طلبات cross-origin إلى Netlify)
 *    - design-converter-app.onrender.com (طلبات cross-origin إلى Netlify)
 *
 *  لتغيير كلمة المرور:
 *    1. شغّل: python3 update_password.py
 *    2. انسخ القيم الناتجة (PASSWORD_HASH, PASSWORD_SALT, AUTH_SECRET)
 *    3. Netlify Dashboard → Site settings → Environment variables
 *    4. أعد نشر الموقع
 *
 *  كلمة المرور الحالية الافتراضية: 123456
 *  ⚠️ يجب تغييرها فوراً للإنتاج.
 *
 *  للتعطيل المؤقت: غيّر `enabled` إلى `false` وأعد النشر.
 * ───────────────────────────────────────────────────────────
 */
window.AUTH_CONFIG = (function () {
  // Netlify Functions تعمل فقط على نطاق Netlify. باقي النطاقات تستخدم
  // روابط مطلقة (cross-origin) للوصول إليها — CORS مُفعّل في الدوال.
  var NETLIFY_ORIGIN = 'https://designstudio-app.netlify.app';

  var host = (location && location.hostname) || '';
  var isNetlify = host.indexOf('netlify') !== -1;

  // على Netlify نفسها، استخدم روابط نسبية (نفس الأصل) لتجنب قيود CORS.
  // على أي نطاق آخر (Cloudflare Pages, Render studio, مخصص)، استخدم روابط مطلقة.
  var base = isNetlify ? '' : NETLIFY_ORIGIN;

  // ⚠️ صفحة تسجيل الدخول يجب أن تكون محلية دائماً (نفس الأصل) لأن
  // localStorage محصور لكل نطاق: إذا تم تسجيل الدخول على نطاق Netlify
  // وتُخزّنت الجلسة هناك، فلن يراها نطاق Cloudflare/Render إطلاقاً
  // ← مما يسبب حلقة تحويل لا نهائية بين النطاقات.
  // الدالة نفسها (login/verify) تعمل عابرة للنطاقات بفضل CORS.
  return {
    // ✅ تفعيل المصادقة
    enabled: true,

    // روابط API للتحقق من كلمة المرور والجلسة
    loginEndpoint: base + '/.netlify/functions/login',
    verifyEndpoint: base + '/.netlify/functions/verify',

    // صفحة تسجيل الدخول (محلية على كل نطاق — إلزامي)
    loginPage: '/login.html',

    // مدة الجلسة بالمللي ثانية (24 ساعة) - مطابقة لإعداد الخادم
    sessionDuration: 24 * 60 * 60 * 1000,

    // الصفحات العامة (لا تحتاج مصادقة)
    publicPages: ['login.html'],

    // مفتاح تخزين الجلسة في localStorage
    storageKey: 'musammer_auth_session'
  };
})();
