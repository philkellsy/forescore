'use strict';

(function initOfflineStore(global) {
  const DB_NAME = 'forescore-offline-scoring';
  const DB_VERSION = 1;
  const SNAPSHOT_STORE = 'scorecard_snapshots';
  const OP_STORE = 'score_ops_queue';

  function key(scorecardId, holeNumber) {
    return `${Number(scorecardId)}:${Number(holeNumber)}`;
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
          db.createObjectStore(SNAPSHOT_STORE, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(OP_STORE)) {
          const store = db.createObjectStore(OP_STORE, { keyPath: 'id', autoIncrement: true });
          store.createIndex('by_status', 'status', { unique: false });
          store.createIndex('by_scorecard', 'scorecardId', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function withStore(storeName, mode, run) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      let settled = false;
      tx.oncomplete = () => {
        db.close();
        if (!settled) resolve(undefined);
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
      tx.onabort = () => {
        db.close();
        reject(tx.error);
      };
      Promise.resolve(run(store))
        .then((result) => {
          settled = true;
          resolve(result);
        })
        .catch((error) => reject(error));
    });
  }

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function create() {
    return {
      async saveSnapshot(scorecardId, holeNumber, data) {
        const record = {
          key: key(scorecardId, holeNumber),
          scorecardId: Number(scorecardId),
          holeNumber: Number(holeNumber),
          data,
          updatedAt: Date.now()
        };
        await withStore(SNAPSHOT_STORE, 'readwrite', (store) => requestToPromise(store.put(record)));
      },

      async getSnapshot(scorecardId, holeNumber) {
        const record = await withStore(
          SNAPSHOT_STORE,
          'readonly',
          (store) => requestToPromise(store.get(key(scorecardId, holeNumber)))
        );
        return record ? record.data : null;
      },

      async enqueueOp(op) {
        const now = Date.now();
        const record = {
          scorecardId: Number(op.scorecardId),
          holeNumber: Number(op.holeNumber),
          type: String(op.type || ''),
          payload: op.payload || {},
          opId: String(op.opId || '').trim(),
          status: 'pending',
          attempts: 0,
          lastError: null,
          createdAt: now,
          updatedAt: now
        };
        return withStore(OP_STORE, 'readwrite', (store) => requestToPromise(store.add(record)));
      },

      async listPendingOps(scorecardId) {
        const list = await withStore(OP_STORE, 'readonly', (store) => requestToPromise(store.getAll()));
        return list
          .filter((row) => row && (row.status === 'pending' || row.status === 'failed'))
          .filter((row) => (scorecardId ? Number(row.scorecardId) === Number(scorecardId) : true))
          .sort((a, b) => Number(a.id) - Number(b.id));
      },

      async markAcked(id) {
        await withStore(OP_STORE, 'readwrite', async (store) => {
          const row = await requestToPromise(store.get(Number(id)));
          if (!row) return;
          row.status = 'acked';
          row.updatedAt = Date.now();
          await requestToPromise(store.put(row));
          await requestToPromise(store.delete(Number(id)));
        });
      },

      async markConflict(id, conflict) {
        await withStore(OP_STORE, 'readwrite', async (store) => {
          const row = await requestToPromise(store.get(Number(id)));
          if (!row) return;
          row.status = 'conflict';
          row.lastError = conflict || null;
          row.updatedAt = Date.now();
          await requestToPromise(store.put(row));
        });
      },

      async markFailed(id, errorMessage) {
        await withStore(OP_STORE, 'readwrite', async (store) => {
          const row = await requestToPromise(store.get(Number(id)));
          if (!row) return;
          row.status = 'failed';
          row.attempts = Number(row.attempts || 0) + 1;
          row.lastError = String(errorMessage || '').slice(0, 500) || null;
          row.updatedAt = Date.now();
          await requestToPromise(store.put(row));
        });
      }
    };
  }

  global.ForeScoreOfflineStore = { create };
})(window);

