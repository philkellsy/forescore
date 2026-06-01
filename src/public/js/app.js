'use strict';

if (!window.__FORESCORE_APP_INIT__) {
  window.__FORESCORE_APP_INIT__ = true;
  const AUTH_MARKER_COOKIE = 'forescore_auth=1';
  const AUTH_MARKER_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

  // ── Page loading indicator (bar + overlay) ────────────────────────────────
  const loadingBar = (function () {
    const bar = document.createElement('div');
    bar.id = 'fs-loading-bar';
    document.documentElement.appendChild(bar);

    let t1 = null, t2 = null;

    function getOverlay() {
      let el = document.getElementById('fsPageOverlay');
      if (!el) {
        el = document.createElement('div');
        el.id = 'fsPageOverlay';
        el.className = 'page-loading-overlay';
        el.setAttribute('aria-hidden', 'true');
        el.innerHTML = '<div class="spinner-border page-loading-spinner" role="status"><span class="visually-hidden">Loading…</span></div>';
        document.body.appendChild(el);
      }
      return el;
    }

    function start() {
      clearTimeout(t1); clearTimeout(t2);
      bar.classList.remove('is-complete');
      bar.style.width = '0%';
      bar.classList.add('is-active');
      requestAnimationFrame(() => {
        bar.style.width = '30%';
        t1 = setTimeout(() => { bar.style.width = '60%'; }, 400);
        t2 = setTimeout(() => { bar.style.width = '85%'; }, 2500);
      });
      // Show overlay synchronously — the 80ms delay caused it to miss fast (cached) navigations.
      const overlay = getOverlay();
      if (overlay) overlay.classList.add('is-visible');
    }

    function done() {
      clearTimeout(t1); clearTimeout(t2);
      bar.classList.add('is-complete');
      const overlay = getOverlay();
      if (overlay) overlay.classList.remove('is-visible');
      setTimeout(() => {
        bar.classList.remove('is-active', 'is-complete');
        bar.style.width = '0%';
      }, 450);
    }

    return { start, done };
  })();

  // Trigger on navigating links (not same-page, not new-tab, not download).
  // Capture phase ensures we fire before Bootstrap can stopPropagation (e.g. inside offcanvas).
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[href]');
    if (!link) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (link.target === '_blank') return;
    if (link.hasAttribute('download')) return;
    const href = link.getAttribute('href') || '';
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return;

    // When the offcanvas nav is open, prevent the default navigation so we can sequence:
    // close nav → spinner visible → navigate. Without this the overlay and slide-out animation
    // compete visually and the spinner is never seen on mobile.
    const navMenu = document.getElementById('navMenu');
    if (navMenu && navMenu.classList.contains('show') && window.bootstrap) {
      const bsOffcanvas = window.bootstrap.Offcanvas.getInstance(navMenu);
      if (bsOffcanvas) {
        e.preventDefault();
        const target = link.href;
        let gone = false;
        const go = () => {
          if (gone) return;
          gone = true;
          loadingBar.start();
          window.location.assign(target);
        };
        navMenu.addEventListener('hidden.bs.offcanvas', go, { once: true });
        bsOffcanvas.hide();
        setTimeout(go, 400); // safety net if hidden event doesn't fire
        return;
      }
    }

    loadingBar.start();
  }, true);

  // Trigger on form submissions; disable submit button to prevent double-submit.
  // Add data-no-loading to a form or button to opt out (e.g. async-managed forms).
  document.addEventListener('submit', (e) => {
    if (e.defaultPrevented) return;
    const form = e.target;
    if (form.hasAttribute('data-no-loading')) return;

    const btn = form.querySelector('button[type=submit]:not([data-no-loading]), input[type=submit]:not([data-no-loading])');
    if (btn && !btn.disabled) {
      btn.disabled = true;
      if (btn.tagName === 'BUTTON') {
        const w = btn.offsetWidth;
        if (w) btn.style.minWidth = w + 'px';
        btn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>';
      }
    }
    loadingBar.start();
  });

  // Complete bar when page is shown (including back/forward cache)
  window.addEventListener('pageshow', (e) => {
    loadingBar.done();
    // If the page is restored from bfcache, the offcanvas may still be visually open — close it.
    if (e.persisted && window.bootstrap) {
      const navMenu = document.getElementById('navMenu');
      if (navMenu) {
        const bsOffcanvas = window.bootstrap.Offcanvas.getInstance(navMenu);
        if (bsOffcanvas) bsOffcanvas.hide();
      }
    }
  });
  // ── End loading bar ────────────────────────────────────────────────────────

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/service-worker.js').catch(() => {});
    });
  }

  // ── PWA install prompt ────────────────────────────────────────────────────
  // Capture early — browser fires this before DOMContentLoaded on many devices.
  let deferredInstallPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
  });

  function ensureToastContainer() {
    let container = document.getElementById('fsToastContainer');
    if (container) return container;
    container = document.createElement('div');
    container.id = 'fsToastContainer';
    container.className = 'legends-toast-container';
    document.body.appendChild(container);
    return container;
  }

  function showToast(message, tone) {
    const text = String(message || '').trim();
    if (!text) return;
    const container = ensureToastContainer();
    const toast = document.createElement('div');
    toast.className = `legends-toast legends-toast--${tone === 'danger' ? 'danger' : 'success'}`;
    toast.textContent = text;
    container.appendChild(toast);

    window.requestAnimationFrame(() => {
      toast.classList.add('is-visible');
    });

    window.setTimeout(() => {
      toast.classList.remove('is-visible');
      window.setTimeout(() => {
        toast.remove();
      }, 220);
    }, 2000);
  }

  document.addEventListener('DOMContentLoaded', () => {
    const codeInput = document.getElementById('code');
    if (codeInput) {
      const maxLength = Number(codeInput.getAttribute('maxlength') || 6);
      codeInput.addEventListener('input', function normalizeDigits() {
        this.value = String(this.value || '').replace(/\D/g, '').slice(0, maxLength);
      });
    }

    const resendButton = document.getElementById('resendCodeButton');
    const countdownText = document.getElementById('resendCountdownText');
    if (resendButton && countdownText) {
      const resendAtMs = Number(resendButton.getAttribute('data-resend-at') || 0);
      const updateCountdown = () => {
        const remaining = Math.ceil((resendAtMs - Date.now()) / 1000);
        if (remaining <= 0) {
          resendButton.disabled = false;
          countdownText.textContent = '';
          return;
        }
        resendButton.disabled = true;
        countdownText.textContent = `Send another code in ${remaining}s`;
        window.setTimeout(updateCountdown, 250);
      };

      if (Number.isFinite(resendAtMs) && resendAtMs > Date.now()) {
        updateCountdown();
      } else {
        resendButton.disabled = false;
        countdownText.textContent = '';
      }
    }

    // Write a lightweight, client-readable auth marker only when the logout form is present
    // (i.e. authenticated UI). Login page can poll this without needing server requests.
    if (document.querySelector('form[action="/auth/logout"]')) {
      document.cookie = `${AUTH_MARKER_COOKIE}; Path=/; Max-Age=${AUTH_MARKER_MAX_AGE_SECONDS}; SameSite=Lax`;
    }

    // Show "Install App" nav item when running in a browser (not as installed PWA).
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    if (!isStandalone) {
      const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
        (navigator.maxTouchPoints > 1 && /macintosh/i.test(navigator.userAgent));
      const installNavItem = document.getElementById('pwaInstallNavItem');
      const installBtn = document.getElementById('pwaInstallBtn');
      if (installNavItem && installBtn && (isIOS || deferredInstallPrompt)) {
        installNavItem.classList.remove('d-none');
        installBtn.addEventListener('click', () => {
          if (isIOS) {
            const modalEl = document.getElementById('iosInstallModal');
            if (modalEl && window.bootstrap) new window.bootstrap.Modal(modalEl).show();
          } else if (deferredInstallPrompt) {
            deferredInstallPrompt.prompt();
            deferredInstallPrompt.userChoice.then(() => {
              deferredInstallPrompt = null;
              installNavItem.classList.add('d-none');
            });
          }
        });
      }
    }

    const alerts = document.querySelectorAll('.alert.alert-success, .alert.alert-danger');
    alerts.forEach((alertEl) => {
      if (alertEl.hasAttribute('data-keep-alert')) return;
      // Hidden alerts are often placeholders (e.g. unresolved conflicts with zero items).
      if (alertEl.classList.contains('d-none') || alertEl.hidden) return;
      const tone = alertEl.classList.contains('alert-danger') ? 'danger' : 'success';
      showToast(alertEl.textContent, tone);
      alertEl.remove();
    });
  });
}
