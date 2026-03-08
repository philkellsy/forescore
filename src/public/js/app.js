'use strict';

if (!window.__LEGENDS_APP_INIT__) {
  window.__LEGENDS_APP_INIT__ = true;

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
