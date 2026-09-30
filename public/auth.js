/**
 * ───────────────────────────────────────────────────────────
 *  نظام المصادقة - مصمم الصور
 * ───────────────────────────────────────────────────────────
 *  يستخدم Netlify Functions للتحقق من كلمة المرور بشكل آمن.
 *  كلمة المرور لا تُخزَّن في المتصفح إطلاقاً.
 * ───────────────────────────────────────────────────────────
 */
(function () {
  'use strict';

  if (typeof window.AUTH_CONFIG === 'undefined') {
    console.error('AUTH_CONFIG not loaded. Make sure auth-config.js is included before auth.js');
    return;
  }

  var CFG = window.AUTH_CONFIG;

  // ⚠️ تعطيل مؤقت: إذا كان enabled === false، لا نحمي الصفحات
  // لكن نظل نوفّر دوال login/logout للاستخدام الاختياري
  var AUTH_DISABLED = CFG.enabled === false;
  if (AUTH_DISABLED) {
    console.warn('[Auth] المصادقة معطّلة مؤقتاً (enabled: false في auth-config.js). لإعادة التفعيل: ضع enabled: true.');
    // نظل نسجّل الدوال العامة كـ no-op حتى لا تنكسر صفحة login.html
    window.loginUser = async function () { return { success: true }; };
    window.logoutUser = function () { localStorage.removeItem(CFG.storageKey); };
    window.isAuthenticated = function () { return true; };
    window.isAuthenticatedAsync = async function () { return true; };
    return; // لا حماية، لا زر خروج، لا redirect
  }

  // الحصول على اسم الصفحة الحالية
  function currentPage() {
    var path = window.location.pathname.split('/').pop();
    return path || 'index.html';
  }

  // التحقق من كون الصفحة عامة
  function isPublicPage() {
    var page = currentPage();
    return CFG.publicPages.indexOf(page) !== -1;
  }

  // التحقق من وجود جلسة محلية صالحة (تحقق سريع دون اتصال بالخادم)
  function hasLocalSession() {
    try {
      var raw = localStorage.getItem(CFG.storageKey);
      if (!raw) return false;
      var session = JSON.parse(raw);
      // التحقق من انتهاء الصلاحية
      if (!session.expiresAt || Date.now() > session.expiresAt) {
        localStorage.removeItem(CFG.storageKey);
        return false;
      }
      // التحقق من وجود التوكن
      if (!session.token) {
        localStorage.removeItem(CFG.storageKey);
        return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  // التحقق من الجلسة عبر الخادم (للأمان العالي - اختياري)
  async function verifySessionWithServer() {
    try {
      var raw = localStorage.getItem(CFG.storageKey);
      if (!raw) return false;
      var session = JSON.parse(raw);
      var response = await fetch(CFG.verifyEndpoint, {
        method: 'GET',
        headers: {
          'Authorization': 'Bearer ' + session.token,
          'Content-Type': 'application/json'
        }
      });
      if (!response.ok) {
        localStorage.removeItem(CFG.storageKey);
        return false;
      }
      var data = await response.json();
      return data.valid === true;
    } catch (e) {
      // في حال فشل الشبكة، نعتمد على التحقق المحلي
      return hasLocalSession();
    }
  }

  // تسجيل الدخول (إرسال كلمة المرور للخادم)
  window.loginUser = async function (password) {
    try {
      var response = await fetch(CFG.loginEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: password })
      });

      var data = await response.json();

      if (response.ok && data.success && data.token) {
        var session = {
          token: data.token,
          createdAt: Date.now(),
          expiresAt: data.expiresAt
        };
        localStorage.setItem(CFG.storageKey, JSON.stringify(session));
        return { success: true };
      } else {
        return {
          success: false,
          error: data.error || 'كلمة المرور غير صحيحة.'
        };
      }
    } catch (e) {
      console.error('Login error:', e);
      return {
        success: false,
        error: 'تعذّر الاتصال بالخادم. تحقق من اتصالك بالإنترنت وحاول مرة أخرى.'
      };
    }
  };

  // تسجيل الخروج
  window.logoutUser = function () {
    localStorage.removeItem(CFG.storageKey);
    window.location.href = CFG.loginPage;
  };

  // التحقق من حالة الدخول (محلياً فقط - سريع)
  window.isAuthenticated = function () {
    return hasLocalSession();
  };

  // التحقق من حالة الدخول عبر الخادم (آمن - اختياري)
  window.isAuthenticatedAsync = async function () {
    if (!hasLocalSession()) return false;
    return await verifySessionWithServer();
  };

  // إضافة زر تسجيل الخروج إلى الرأس
  function injectLogoutButton() {
    if (!hasLocalSession()) return;
    var header = document.querySelector('header .header-inner');
    if (!header) return;
    if (document.querySelector('.auth-logout-btn')) return;

    var nav = header.querySelector('nav');
    var btn = document.createElement('button');
    btn.className = 'auth-logout-btn';
    btn.type = 'button';
    btn.innerHTML = 'تسجيل الخروج';
    btn.setAttribute('aria-label', 'تسجيل الخروج');
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      if (confirm('هل أنت متأكد من تسجيل الخروج؟')) {
        window.logoutUser();
      }
    });

    if (nav) {
      nav.appendChild(btn);
    } else {
      header.appendChild(btn);
    }
  }

  // حماية الصفحة
  function protectPage() {
    if (isPublicPage()) return;
    if (!hasLocalSession()) {
      var currentUrl = window.location.href;
      window.location.href = CFG.loginPage + '?redirect=' + encodeURIComponent(currentUrl);
    }
  }

  // تشغيل الحماية فوراً
  protectPage();

  // إضافة زر الخروج بعد تحميل DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectLogoutButton);
  } else {
    injectLogoutButton();
  }
})();
