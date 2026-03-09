'use strict';

if (!window.__LEGENDS_APP_INIT__) {
  window.__LEGENDS_APP_INIT__ = true;
  const AUTH_MARKER_COOKIE = 'legends_auth=1';
  const AUTH_MARKER_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/service-worker.js').catch(() => {});
    });
  }

  function ensureToastContainer() {
    let container = document.getElementById('legendsToastContainer');
    if (container) return container;
    container = document.createElement('div');
    container.id = 'legendsToastContainer';
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
