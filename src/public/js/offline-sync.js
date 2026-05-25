'use strict';

(function initOfflineSync(global) {
  function create(config) {
    const store = config?.store;
    if (!store) {
      return {
        start() {},
        stop() {},
        trigger() {}
      };
    }

    let running = false;
    let timer = null;
    let inFlight = false;

    function emitState(state) {
      if (typeof config?.onStateChange === 'function') {
        config.onStateChange(state);
      }
    }

    function isOnline() {
      return navigator.onLine && (typeof config?.isEffectivelyOnline !== 'function' || config.isEffectivelyOnline());
    }

    async function processOnce() {
      if (!running || inFlight || !isOnline()) return;
      inFlight = true;
      try {
        const ops = await store.listPendingOps(config?.scorecardId);
        if (!ops.length) {
          emitState({ status: 'idle', pending: 0 });
          return;
        }
        emitState({ status: 'syncing', pending: ops.length });

        for (const op of ops) {
          try {
            let result = null;
            if (op.type === 'gross' && typeof config?.sendGross === 'function') {
              result = await config.sendGross(op);
            } else if (op.type === 'drive' && typeof config?.sendDrive === 'function') {
              result = await config.sendDrive(op);
            } else {
              await store.markAcked(op.id);
              continue;
            }

            if (result?.ok) {
              await store.markAcked(op.id);
              if (typeof config?.onAck === 'function') config.onAck(op, result);
              continue;
            }

            if (Number(result?.status) === 409) {
              await store.markConflict(op.id, result?.payload || null);
              if (typeof config?.onConflict === 'function') {
                config.onConflict(op, result?.payload || {});
              }
              continue;
            }

            // 404 = scorecard no longer exists (e.g. round was reset). Retrying
            // will never succeed — discard and notify so the UI can react.
            if (Number(result?.status) === 404) {
              await store.markAcked(op.id);
              if (typeof config?.onPermanentFail === 'function') config.onPermanentFail(op, result);
              continue;
            }

            await store.markFailed(op.id, result?.error || 'sync_failed');
          } catch (error) {
            await store.markFailed(op.id, error?.message || String(error));
            if (typeof config?.onError === 'function') config.onError(op, error);
          }
        }

        const remaining = await store.listPendingOps(config?.scorecardId);
        emitState({ status: remaining.length ? 'pending' : 'idle', pending: remaining.length });
      } finally {
        inFlight = false;
      }
    }

    function start() {
      if (running) return;
      running = true;
      timer = setInterval(() => {
        processOnce().catch(() => {});
      }, 4000);
      processOnce().catch(() => {});
    }

    function stop() {
      running = false;
      if (timer) clearInterval(timer);
      timer = null;
    }

    function trigger() {
      processOnce().catch(() => {});
    }

    return { start, stop, trigger };
  }

  global.ForeScoreOfflineSync = { create };
})(window);

