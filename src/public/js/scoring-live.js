'use strict';

(function init() {
  const state = window.__SCORECARD_LIVE__;
  const dayStatus = window.__DAY_STATUS__ || 'draft';
  const offlineTestAllowed = Boolean(window.__OFFLINE_TEST_ALLOWED__);
  const tenantSlug = window.__TENANT_PATH__ || '';
  const tp = (path) => `/${tenantSlug}${path}`;
  if (!state) return;
  const offlineTestStorageKey = 'forescore_scoring_offline_test_mode';
  const searchParams = new URLSearchParams(window.location.search || '');
  const requestedOfflineTestMode = searchParams.get('offline_test');

  const holeNumberEl = document.getElementById('holeNumber');
  const holeParEl = document.getElementById('holePar');
  const holeSiEl = document.getElementById('holeSi');
  const entriesContainer = document.getElementById('entriesContainer');
  const groupMetaEl = document.getElementById('groupMeta');
  const offlineCacheStatusEl = document.getElementById('offlineCacheStatus');
  const prevHoleBtn = document.getElementById('prevHoleBtn');
  const nextHoleBtn = document.getElementById('nextHoleBtn');
  const offlineTestToggleBtn = document.getElementById('offlineTestToggleBtn');
  let transientStatusEl = null;

  let touchStartX = null;
  let currentHole = Number(state.holeNumber || state.startingHole || 1);
  let currentPar = Number(state.hole?.par || 0);
  let currentSiPrimary = Number(state.hole?.strokeIndexPrimary || 0);
  let currentSiSecondary = Number(state.hole?.strokeIndexSecondary || 0);
  const localConflicts = new Map();
  const localExpectedGross = new Map();
  let conflictPollTimer = null;
  let currentHoleData = null;
  let offlineStore = null;
  let offlineSync = null;
  let warmCachePromise = null;
  const warmedHoles = new Set();
  const holeOrder = holeSequenceFrom(Number(state.startingHole || 1));
  const conflictStorageKey = `scorecardConflictState:${Number(state.scorecardId)}`;
  let forceOfflineTestMode = false;

  function hydrateOfflineTestMode() {
    if (!offlineTestAllowed) {
      forceOfflineTestMode = false;
      return;
    }
    try {
      if (requestedOfflineTestMode === '1' || requestedOfflineTestMode === 'true') {
        localStorage.setItem(offlineTestStorageKey, '1');
      } else if (requestedOfflineTestMode === '0' || requestedOfflineTestMode === 'false') {
        localStorage.removeItem(offlineTestStorageKey);
      }
      forceOfflineTestMode = localStorage.getItem(offlineTestStorageKey) === '1';
    } catch (_error) {
      forceOfflineTestMode = false;
    }
  }

  function isEffectivelyOnline() {
    return navigator.onLine && !forceOfflineTestMode;
  }

  function isEditingEnabled() {
    return dayStatus === 'open';
  }

  function updateOfflineTestModeUi() {
    if (!offlineTestToggleBtn) return;
    offlineTestToggleBtn.textContent = forceOfflineTestMode ? 'Disable Offline Test' : 'Enable Offline Test';
    offlineTestToggleBtn.classList.toggle('btn-outline-secondary', !forceOfflineTestMode);
    offlineTestToggleBtn.classList.toggle('btn-warning', forceOfflineTestMode);
  }

  function ensureTransientStatusEl() {
    if (transientStatusEl || !entriesContainer || !entriesContainer.parentElement) return transientStatusEl;
    transientStatusEl = document.createElement('div');
    transientStatusEl.className = 'alert py-2 px-3 small d-none';
    transientStatusEl.setAttribute('role', 'status');
    entriesContainer.parentElement.insertBefore(transientStatusEl, entriesContainer);
    return transientStatusEl;
  }

  function setTransientStatus(message, variant) {
    const el = ensureTransientStatusEl();
    if (!el) return;
    el.className = `alert alert-${variant || 'warning'} py-2 px-3 small`;
    el.textContent = String(message || '');
  }

  function clearTransientStatus() {
    if (!transientStatusEl) return;
    transientStatusEl.textContent = '';
    transientStatusEl.className = 'alert py-2 px-3 small d-none';
  }

  function updateOfflineCacheStatus(options) {
    if (!offlineCacheStatusEl) return;
    const total = holeOrder.length;
    const cached = warmedHoles.size;
    const ready = cached >= total;
    const online = isEffectivelyOnline();
    const warming = Boolean(options && options.warming);

    if (ready) {
      offlineCacheStatusEl.textContent = '✔ ready';
      offlineCacheStatusEl.className = 'offline-cache-status is-ready';
      return;
    }

    if (warming && online) {
      offlineCacheStatusEl.textContent = `caching for offline ${cached}/${total}`;
      offlineCacheStatusEl.className = 'offline-cache-status';
      return;
    }

    if (!online && cached > 0) {
      offlineCacheStatusEl.textContent = `offline cache ${cached}/${total}`;
      offlineCacheStatusEl.className = 'offline-cache-status';
      return;
    }

    offlineCacheStatusEl.textContent = '';
    offlineCacheStatusEl.className = 'offline-cache-status d-none';
  }

  function newOpId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return `op_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function conflictKey(scorecardId, holeNumber) {
    return `${Number(scorecardId)}:${Number(holeNumber)}`;
  }

  function normalizeGross(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) return 0;
    return num;
  }

  function holeSequenceFrom(startingHole) {
    const start = Math.min(18, Math.max(1, Number(startingHole) || 1));
    const seq = [];
    for (let i = 0; i < 18; i += 1) {
      seq.push(((start - 1 + i) % 18) + 1);
    }
    return seq;
  }

  function persistConflictState() {
    try {
      const payload = {
        conflicts: [...localConflicts.values()],
        expected: [...localExpectedGross.entries()]
      };
      sessionStorage.setItem(conflictStorageKey, JSON.stringify(payload));
    } catch (_error) {
      // no-op
    }
  }

  function hydrateConflictState() {
    try {
      const raw = sessionStorage.getItem(conflictStorageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.conflicts)) {
        parsed.conflicts.forEach((item) => {
          if (!item) return;
          localConflicts.set(conflictKey(item.scorecardId, item.holeNumber), item);
        });
      }
      if (Array.isArray(parsed?.expected)) {
        parsed.expected.forEach((tuple) => {
          if (!Array.isArray(tuple) || tuple.length < 2) return;
          localExpectedGross.set(tuple[0], normalizeGross(tuple[1]));
        });
      }
      if (localConflicts.size) ensureConflictPolling();
    } catch (_error) {
      // no-op
    }
  }

  function upsertConflict(scorecardId, holeNumber, attemptedGross, payload) {
    localConflicts.set(conflictKey(scorecardId, holeNumber), {
      scorecardId: Number(scorecardId),
      holeNumber: Number(holeNumber),
      attemptedGross: Number(attemptedGross),
      canonicalGross: payload?.canonicalGross ?? null,
      ownerName: payload?.ownerName || null
    });
    ensureConflictPolling();
    persistConflictState();
  }

  function clearConflict(scorecardId, holeNumber) {
    localConflicts.delete(conflictKey(scorecardId, holeNumber));
    if (!localConflicts.size && conflictPollTimer) {
      clearInterval(conflictPollTimer);
      conflictPollTimer = null;
    }
    persistConflictState();
  }

  function getConflict(scorecardId, holeNumber) {
    return localConflicts.get(conflictKey(scorecardId, holeNumber)) || null;
  }

  function hasConflictsForHole(holeNumber) {
    const hole = Number(holeNumber);
    for (const conflict of localConflicts.values()) {
      if (Number(conflict.holeNumber) === hole) return true;
    }
    return false;
  }

  function setExpectedGross(scorecardId, holeNumber, gross) {
    localExpectedGross.set(conflictKey(scorecardId, holeNumber), normalizeGross(gross));
    persistConflictState();
  }

  function getExpectedGross(scorecardId, holeNumber) {
    if (!localExpectedGross.has(conflictKey(scorecardId, holeNumber))) return null;
    return localExpectedGross.get(conflictKey(scorecardId, holeNumber));
  }

  function clampHole(hole) {
    if (hole < 1) return 1;
    if (hole > 18) return 18;
    return hole;
  }

  function strokesForHole(playingHandicap, strokeIndexPrimary, strokeIndexSecondary) {
    const handicap = Math.trunc(Number(playingHandicap) || 0);
    const primary = Number(strokeIndexPrimary);
    const secondary = Number(strokeIndexSecondary);

    if (handicap >= 0) {
      let strokes = 0;
      if (Number.isFinite(primary) && primary >= 1 && primary <= 18 && handicap >= primary) {
        strokes += 1;
      }
      if (Number.isFinite(secondary) && secondary >= 19 && secondary <= 36 && handicap >= secondary) {
        strokes += 1;
      }
      return strokes;
    }

    const plusSize = Math.min(18, Math.abs(handicap));
    if (!Number.isFinite(primary) || primary < 1 || primary > 18) return 0;
    return primary > 18 - plusSize ? -1 : 0;
  }

  function stablefordForGross(gross, par, strokeIndexPrimary, strokeIndexSecondary, playingHandicap) {
    const shots = strokesForHole(playingHandicap, strokeIndexPrimary, strokeIndexSecondary);
    const netScore = Number(gross || 0) - shots;
    const toPar = netScore - Number(par || 0);
    return Math.max(0, 2 - toPar);
  }

  async function fetchHoleData(holeNumber) {
    const hole = Number(holeNumber);
    if (!isEffectivelyOnline()) {
      if (offlineStore) {
        const cached = await offlineStore.getSnapshot(state.scorecardId, hole);
        if (cached) return cached;
      }
      throw new Error('Offline');
    }

    return fetchHoleDataFromServer(hole);
  }

  async function fetchHoleDataFromServer(holeNumber) {
    const hole = Number(holeNumber);
    const res = await fetch(tp(`/scoring/api/live/${state.scorecardId}/hole/${hole}`));
    if (!res.ok) {
      if (offlineStore) {
        const cached = await offlineStore.getSnapshot(state.scorecardId, hole);
        if (cached) return cached;
      }
      throw new Error('Failed to load hole data');
    }
    const json = await res.json();
    if (offlineStore) {
      offlineStore.saveSnapshot(state.scorecardId, hole, json).catch(() => {});
    }
    warmedHoles.add(hole);
    updateOfflineCacheStatus();
    return json;
  }

  function warmOfflineCache(options) {
    const force = Boolean(options && options.force);
    if (!offlineStore || !isEffectivelyOnline()) return Promise.resolve();
    if (warmCachePromise) return warmCachePromise;

    warmCachePromise = (async () => {
      updateOfflineCacheStatus({ warming: true });
      for (const hole of holeOrder) {
        if (!force && warmedHoles.has(Number(hole))) continue;
        try {
          await fetchHoleDataFromServer(hole);
          updateOfflineCacheStatus({ warming: true });
        } catch (_error) {
          break;
        }
      }
    })();

    return warmCachePromise.finally(() => {
      warmCachePromise = null;
      updateOfflineCacheStatus();
    });
  }

  function entryCard(entry) {
    const conflict = getConflict(entry.scorecardId, currentHole);
    const gross = conflict ? Number(conflict.attemptedGross || 0) : (entry.grossScore || 0);
    const holePar = Number(currentPar || 0);
    const stableford = entry.stableford === null || entry.stableford === undefined ? '-' : entry.stableford;
    const hasScorecard = Number.isFinite(Number(entry.scorecardId));
    const shotDots = (hcp) => {
      const n = strokesForHole(hcp, currentSiPrimary, currentSiSecondary);
      if (n > 0) return `<span class="text-success ms-1" style="font-size:1.4rem;line-height:1">${'•'.repeat(n)}</span>`;
      if (n < 0) return `<span class="text-danger ms-1">−</span>`;
      return '';
    };
    const label =
      entry.type === 'team'
        ? `${entry.displayName} (Hcp ${entry.teamHandicapDisplay || entry.teamHandicap || 0})`
        : `${entry.displayName} (${entry.handicapDisplay || '-'})${shotDots(entry.playingHandicap)}`;
    const formatRelative = (value) => {
      const num = Number(value || 0);
      if (!Number.isFinite(num) || num === 0) return 'E';
      return num > 0 ? `+${num}` : `${num}`;
    };
    const formatUpDn = (value) => {
      const num = Number(value || 0);
      if (!Number.isFinite(num) || num === 0) return 'E';
      return num > 0 ? `${num}up` : `${Math.abs(num)}dn`;
    };
    const relativeClass = (value) => {
      const num = Number(value || 0);
      return Number.isFinite(num) && num < 0 ? 'text-danger' : 'text-dark';
    };
    const upDnClass = (value) => {
      const num = Number(value || 0);
      if (!Number.isFinite(num) || num === 0) return 'text-dark';
      return num > 0 ? 'text-success' : 'text-danger';
    };
    const rightMetrics =
      entry.type === 'team'
        ? `
          <div class="text-end ms-2">
            <div class="small text-muted">To Par</div>
            <div class="small fw-semibold ${relativeClass(entry.grossToPar)}">${formatRelative(entry.grossToPar)}</div>
          </div>
        `
        : `
          <div class="d-flex align-items-start gap-3 ms-2 individual-metrics-inline">
            <div class="text-end">
              <div class="small text-muted">Total</div>
              <div class="small fw-semibold text-dark">${Number(entry.stablefordTotal || 0)}</div>
            </div>
            <div class="text-end">
              <div class="small text-muted">Relative</div>
              <div class="small fw-semibold ${upDnClass(entry.stablefordRelative)}">${formatUpDn(entry.stablefordRelative)}</div>
            </div>
          </div>
        `;

    const memberDrives =
      entry.type === 'team'
        ? `
      <div class="mt-2 d-flex flex-wrap gap-2">
        ${entry.members
          .map(
            (m) =>
              `<button class="btn btn-sm ${entry.selectedDriveUserId === m.userId ? 'btn-dark' : 'btn-outline-dark'} drive-btn" data-scorecard-id="${entry.scorecardId || ''}" data-user-id="${m.userId}" ${hasScorecard ? '' : 'disabled'}>${m.displayName} (${m.handicapDisplay || '-'})${shotDots(m.playingHandicap)} ${m.driveCount}</button>`
          )
          .join('')}
      </div>`
        : '';

    const driveLabel = entry.type === 'team' ? '<p class="small text-muted mb-1 mt-2">Drive taken by</p>' : '';
    const showPickup =
      entry.type !== 'team' &&
      Number(gross || 0) > 0 &&
      stablefordForGross(gross, currentPar, currentSiPrimary, currentSiSecondary, entry.playingHandicap) === 0;
    const grossDisplay = showPickup ? 'P' : gross;
    const grossPerformanceClass = (() => {
      if (conflict) return '';
      if (!Number.isFinite(gross) || gross <= 0) return '';
      if (gross === 1) return 'gross-pill-hole-in-one';
      if (!Number.isFinite(holePar) || holePar <= 0) return '';
      if (gross <= holePar - 2) return 'gross-pill-eagle';
      if (gross === holePar - 1) return 'gross-pill-birdie';
      return '';
    })();
    const grossDiscClass = grossPerformanceClass ? 'gross-pill-disc' : '';
    const grossPillClass = `${conflict ? 'gross-pill-conflict' : ''} ${grossPerformanceClass} ${grossDiscClass}`.trim();
    const conflictPanel = conflict
      ? `<div class="score-conflict-inline text-danger ms-2">
          <div class="d-flex align-items-start gap-1">
            <i class="fa-solid fa-triangle-exclamation mt-1" aria-hidden="true"></i>
            <div class="lh-sm">
              <div class="small fw-semibold">${conflict.ownerName || 'Server'} scored this as ${conflict.canonicalGross ?? '-'},</div>
              <div class="small score-conflict-action">
                resolve or
                <button type="button" class="btn btn-link btn-sm p-0 align-baseline conflict-accept-btn" data-scorecard-id="${entry.scorecardId}" data-hole-number="${currentHole}">
                  accept?
                </button>
              </div>
            </div>
          </div>
        </div>`
      : '';

    if (entry.type !== 'team') {
      return `
        <article class="card border-0 shadow-sm individual-entry-card">
          <div class="card-body py-2">
            <div class="d-flex justify-content-between align-items-center gap-2">
              <h2 class="h6 mb-0 individual-entry-title">${label}</h2>
              <div class="individual-stableford-chip">
                <span class="small text-muted me-1">Stb</span>
                <strong>${stableford}</strong>
              </div>
            </div>
            <div class="d-flex justify-content-between align-items-center mt-2 gap-2">
              <div class="score-adjuster ${conflict ? 'score-adjuster-conflict' : ''}" data-scorecard-id="${entry.scorecardId}">
                <button type="button" class="btn btn-outline-dark btn-lg adjust-btn" data-delta="-1" ${hasScorecard ? '' : 'disabled'}>-</button>
                <span class="gross-pill ${grossPillClass}" data-gross-value="${Number(gross || 0)}">${grossDisplay}</span>
                <button type="button" class="btn btn-outline-dark btn-lg adjust-btn" data-delta="1" ${hasScorecard ? '' : 'disabled'}>+</button>
                <button type="button" class="btn btn-outline-dark btn-lg pickup-btn" data-scorecard-id="${entry.scorecardId}" data-playing-handicap="${Number(entry.playingHandicap || 0)}" ${hasScorecard ? '' : 'disabled'}>P</button>
              </div>
              ${conflictPanel || rightMetrics}
            </div>
          </div>
        </article>
      `;
    }

    return `
      <article class="card border-0 shadow-sm">
        <div class="card-body py-3">
          <div class="d-flex justify-content-between align-items-center gap-2">
            <div>
              <h2 class="h6 mb-0">${label}</h2>
            </div>
            <div class="text-end">
              <div class="small text-muted">Stableford</div>
              <div class="h5 mb-0">${stableford}</div>
            </div>
          </div>
          <div class="d-flex justify-content-between align-items-center mt-3 gap-2">
            <div class="score-adjuster ${conflict ? 'score-adjuster-conflict' : ''}" data-scorecard-id="${entry.scorecardId}">
              <button type="button" class="btn btn-outline-dark btn-lg adjust-btn" data-delta="-1" ${hasScorecard ? '' : 'disabled'}>-</button>
              <span class="gross-pill ${grossPillClass}" data-gross-value="${Number(gross || 0)}">${grossDisplay}</span>
              <button type="button" class="btn btn-outline-dark btn-lg adjust-btn" data-delta="1" ${hasScorecard ? '' : 'disabled'}>+</button>
            </div>
            ${conflictPanel || rightMetrics}
          </div>
          ${driveLabel}
          ${memberDrives}
        </div>
      </article>
    `;
  }

  function findEntryForScorecard(scorecardId) {
    if (!currentHoleData || !Array.isArray(currentHoleData.entries)) return null;
    return currentHoleData.entries.find((entry) => Number(entry.scorecardId) === Number(scorecardId)) || null;
  }

  function getCurrentHoleVersion(scorecardId) {
    const entry = findEntryForScorecard(scorecardId);
    if (!entry) return 0;
    const version = Number(entry.holeVersion || 0);
    return Number.isFinite(version) && version >= 0 ? version : 0;
  }

  async function enqueueOfflineOp(type, scorecardId, holeNumber, payload) {
    if (!offlineStore) return null;
    const op = {
      type,
      scorecardId: Number(scorecardId),
      holeNumber: Number(holeNumber),
      payload: payload || {},
      opId: String(payload?.opId || '').trim() || newOpId()
    };
    const id = await offlineStore.enqueueOp(op);
    if (offlineSync) offlineSync.trigger();
    return { id, opId: op.opId };
  }

  function updateCurrentHoleEntry(scorecardId, updater) {
    if (!currentHoleData || !Array.isArray(currentHoleData.entries)) return;
    currentHoleData.entries = currentHoleData.entries.map((entry) => {
      if (Number(entry.scorecardId) !== Number(scorecardId)) return entry;
      return updater({ ...entry });
    });
  }

  async function render(holeData) {
    currentHoleData = holeData ? JSON.parse(JSON.stringify(holeData)) : null;
    currentHole = holeData.holeNumber;
    warmedHoles.add(Number(currentHole));
    updateOfflineCacheStatus();
    currentPar = Number(holeData.hole?.par || 0);
    currentSiPrimary = Number(holeData.hole?.strokeIndexPrimary || 0);
    currentSiSecondary = Number(holeData.hole?.strokeIndexSecondary || 0);
    holeNumberEl.textContent = String(holeData.holeNumber);
    holeParEl.textContent = String(holeData.hole.par);
    holeSiEl.textContent = `${holeData.hole.strokeIndexPrimary}/${holeData.hole.strokeIndexSecondary}`;
    clearTransientStatus();

    if (groupMetaEl) {
      const isAmbrose = holeData.mode === 'ambrose';
      const ctx = isAmbrose
        ? (holeData.ambroseContext || state.ambroseContext)
        : (holeData.individualContext || state.individualContext);
      if (ctx) {
        const who = state.requesterDisplay ? ` | ${state.requesterDisplay}` : '';
        const teeTimeDisplay = ctx.teeTime ? ctx.teeTime.slice(0, 5) : '-';
        groupMetaEl.textContent = `Group ${ctx.groupNumber || '-'} | ${teeTimeDisplay} | ${ctx.teeLocation || '-'}${who}`;
      } else {
        groupMetaEl.textContent = '';
      }
    }

    if (!holeData.entries || !holeData.entries.length) {
      entriesContainer.innerHTML = '<div class="alert alert-info mb-0">No entries are available for this scorecard yet.</div>';
      return;
    }

    holeData.entries.forEach((entry) => {
      const conflict = getConflict(entry.scorecardId, holeData.holeNumber);
      const expectedGross = getExpectedGross(entry.scorecardId, holeData.holeNumber);
      const canonicalGross = normalizeGross(entry.grossScore);

      if (expectedGross !== null && expectedGross !== canonicalGross) {
        upsertConflict(entry.scorecardId, holeData.holeNumber, expectedGross, {
          canonicalGross: canonicalGross,
          ownerName: conflict?.ownerName || null
        });
      }

      if (!conflict) return;
      if (Number(entry.grossScore || 0) === Number(conflict.attemptedGross || 0)) {
        // Silent auto-resolve when canonical now matches local attempted score.
        clearConflict(entry.scorecardId, holeData.holeNumber);
      } else {
        conflict.canonicalGross = entry.grossScore;
      }
    });

    entriesContainer.classList.toggle('entries-mode-ambrose', holeData.mode === 'ambrose');
    entriesContainer.classList.toggle('entries-mode-individual', holeData.mode !== 'ambrose');
    entriesContainer.innerHTML = holeData.entries.map(entryCard).join('');
    bindAdjustmentHandlers();
    bindPickupHandlers();
    bindDriveHandlers();
    bindGrossShortcutHandlers();
    bindConflictHandlers();
    persistConflictState();
    if (offlineStore) {
      offlineStore.saveSnapshot(state.scorecardId, currentHole, holeData).catch(() => {});
    }
  }

  async function adjustGross(scorecardId, delta) {
    if (!isEditingEnabled()) return;
    if (!Number.isFinite(Number(scorecardId))) return;
    const card = entriesContainer.querySelector(`.score-adjuster[data-scorecard-id="${scorecardId}"]`);
    const grossEl = card ? card.querySelector('.gross-pill') : null;
    if (!grossEl) return;

    const currentGross = Number(grossEl.dataset.grossValue || grossEl.textContent || 0);
    const nextGross = Math.min(20, Math.max(0, currentGross + delta));
    await setGross(scorecardId, nextGross);
  }

  async function setGross(scorecardId, grossScore) {
    if (dayStatus !== 'open') return;
    if (!Number.isFinite(Number(scorecardId))) return;
    const normalizedGross = normalizeGross(grossScore);
    const baseVersion = getCurrentHoleVersion(scorecardId);

    if (!isEffectivelyOnline()) {
      const queued = await enqueueOfflineOp('gross', scorecardId, currentHole, {
        scorecardId: Number(scorecardId),
        holeNumber: Number(currentHole),
        grossScore: normalizedGross,
        baseVersion
      });
      if (queued && queued.opId) {
        updateCurrentHoleEntry(scorecardId, (entry) => {
          const isPlayer = entry.type !== 'team';
          const playingHandicap = isPlayer ? Number(entry.playingHandicap || 0) : Number(entry.teamHandicap || 0);
          const nextStableford = stablefordForGross(
            normalizedGross,
            currentPar,
            currentSiPrimary,
            currentSiSecondary,
            playingHandicap
          );
          entry.grossScore = normalizedGross;
          entry.stableford = nextStableford;
          entry.holeVersion = baseVersion;
          return entry;
        });
        if (currentHoleData) await render(currentHoleData);
      }
      return;
    }

    const opId = newOpId();
    const res = await fetch(tp('/scoring/api/live/gross'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scorecardId,
        holeNumber: currentHole,
        grossScore: normalizedGross,
        opId,
        baseVersion
      })
    });

    if (res.status === 409) {
      const data = await res.json().catch(() => ({}));
      if (data?.error === 'conflict') {
        setExpectedGross(scorecardId, currentHole, normalizedGross);
        upsertConflict(scorecardId, currentHole, normalizedGross, data);
        const holeData = await fetchHoleData(currentHole);
        await render(holeData);
      }
      return;
    }

    if (!res.ok) return;
    const successPayload = await res.json().catch(() => ({}));
    setExpectedGross(scorecardId, currentHole, normalizedGross);
    clearConflict(scorecardId, currentHole);
    if (successPayload && Number.isFinite(Number(successPayload.holeVersion))) {
      updateCurrentHoleEntry(scorecardId, (entry) => {
        entry.holeVersion = Number(successPayload.holeVersion);
        return entry;
      });
    }
    const holeData = await fetchHoleData(currentHole);
    await render(holeData);
  }

  async function setDrive(scorecardId, driveTakenUserId) {
    if (dayStatus !== 'open') return;
    if (!Number.isFinite(Number(scorecardId))) return;

    if (!isEffectivelyOnline()) {
      const queued = await enqueueOfflineOp('drive', scorecardId, currentHole, {
        scorecardId: Number(scorecardId),
        holeNumber: Number(currentHole),
        driveTakenUserId: driveTakenUserId == null ? null : Number(driveTakenUserId)
      });
      if (queued) {
        updateCurrentHoleEntry(scorecardId, (entry) => {
          entry.selectedDriveUserId = driveTakenUserId == null ? null : Number(driveTakenUserId);
          return entry;
        });
        if (currentHoleData) await render(currentHoleData);
      }
      return;
    }

    const res = await fetch(tp('/scoring/api/live/drive'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scorecardId,
        holeNumber: currentHole,
        driveTakenUserId
      })
    });
    if (!res.ok) return;
    const holeData = await fetchHoleData(currentHole);
    await render(holeData);
  }

  function bindAdjustmentHandlers() {
    entriesContainer.querySelectorAll('.adjust-btn').forEach((btn) => {
      if (!isEditingEnabled()) btn.setAttribute('disabled', 'disabled');
      btn.addEventListener('click', async () => {
        const delta = Number(btn.dataset.delta || 0);
        const scorecardId = Number(btn.closest('.score-adjuster').dataset.scorecardId);
        await adjustGross(scorecardId, delta);
      });
    });
  }

  function minGrossForPickup(par, strokeIndexPrimary, strokeIndexSecondary, playingHandicap) {
    const parNum = Number(par || 0);
    if (!Number.isFinite(parNum) || parNum < 1) return 1;
    for (let gross = 1; gross <= 20; gross += 1) {
      if (stablefordForGross(gross, parNum, strokeIndexPrimary, strokeIndexSecondary, playingHandicap) === 0) {
        return gross;
      }
    }
    return 20;
  }

  function bindPickupHandlers() {
    entriesContainer.querySelectorAll('.pickup-btn').forEach((btn) => {
      if (!isEditingEnabled()) btn.setAttribute('disabled', 'disabled');
      btn.addEventListener('click', async () => {
        if (!isEditingEnabled()) return;
        const scorecardId = Number(btn.dataset.scorecardId);
        const playingHandicap = Number(btn.dataset.playingHandicap || 0);
        if (!Number.isFinite(scorecardId)) return;
        const pickupGross = minGrossForPickup(currentPar, currentSiPrimary, currentSiSecondary, playingHandicap);
        await setGross(scorecardId, pickupGross);
      });
    });
  }

  function bindDriveHandlers() {
    entriesContainer.querySelectorAll('.drive-btn').forEach((btn) => {
      if (!isEditingEnabled()) btn.setAttribute('disabled', 'disabled');
      btn.addEventListener('click', async () => {
        const scorecardId = Number(btn.dataset.scorecardId);
        const userId = Number(btn.dataset.userId);
        const clear = btn.classList.contains('btn-dark');
        await setDrive(scorecardId, clear ? null : userId);
      });
    });
  }

  function bindGrossShortcutHandlers() {
    entriesContainer.querySelectorAll('.gross-pill').forEach((pill) => {
      pill.style.cursor = 'pointer';
      pill.title = 'Tap to set par when empty';
      pill.addEventListener('click', async () => {
        if (!isEditingEnabled()) return;
        const adjuster = pill.closest('.score-adjuster');
        if (!adjuster) return;
        const scorecardId = Number(adjuster.dataset.scorecardId);
        if (!Number.isFinite(scorecardId)) return;
        const currentGross = Number(pill.dataset.grossValue || pill.textContent || 0);
        if (currentGross !== 0) return;
        const par = Number(holeParEl.textContent || 0);
        if (!Number.isFinite(par) || par < 1) return;
        await setGross(scorecardId, par);
      });
    });
  }

  function bindConflictHandlers() {
    entriesContainer.querySelectorAll('.conflict-accept-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const scorecardId = Number(btn.dataset.scorecardId);
        const holeNumber = Number(btn.dataset.holeNumber || currentHole);
        if (!Number.isFinite(scorecardId) || !Number.isFinite(holeNumber)) return;
        const conflict = getConflict(scorecardId, holeNumber);
        if (conflict && conflict.canonicalGross !== null && conflict.canonicalGross !== undefined) {
          setExpectedGross(scorecardId, holeNumber, conflict.canonicalGross);
        }
        clearConflict(scorecardId, holeNumber);
        const holeData = await fetchHoleData(currentHole);
        await render(holeData);
      });
    });
  }

  function currentHoleIndex() {
    const idx = holeOrder.indexOf(Number(currentHole));
    return idx >= 0 ? idx : 0;
  }

  function goToConfirmation() {
    persistConflictState();
    window.location.assign(tp(`/scoring/confirm/${state.scorecardId}`));
  }

  async function navigateByOffset(offset) {
    try {
      const beforeNav = await fetchHoleData(currentHole);
      await render(beforeNav);
      if (hasConflictsForHole(currentHole)) return;
    } catch (_error) {
      // continue navigation even if pre-check fails
    }
    const nextIndex = currentHoleIndex() + Number(offset || 0);
    if (nextIndex > holeOrder.length - 1) {
      goToConfirmation();
      return;
    }
    if (nextIndex < 0) return;
    const nextHole = holeOrder[nextIndex];
    try {
      const holeData = await fetchHoleData(nextHole);
      await render(holeData);
    } catch (error) {
      if (error && error.message === 'Offline') {
        setTransientStatus(`Hole ${nextHole} is not cached for offline yet.`, 'warning');
      } else {
        setTransientStatus(`Could not load hole ${nextHole}. Please try again.`, 'danger');
      }
    }
  }

  prevHoleBtn.addEventListener('click', () => navigateByOffset(-1));
  nextHoleBtn.addEventListener('click', () => navigateByOffset(1));

  function ensureConflictPolling() {
    if (conflictPollTimer || !localConflicts.size) return;
    conflictPollTimer = setInterval(async () => {
      if (!localConflicts.size) return;
      if (document.hidden) return;
      if (!isEffectivelyOnline()) return;
      try {
        const holeData = await fetchHoleData(currentHole);
        await render(holeData);
      } catch (_error) {
        // keep current conflict state and try again on next interval
      }
    }, 3000);
  }

  async function refreshCurrentHole() {
    try {
      const holeData = await fetchHoleData(currentHole);
      await render(holeData);
    } catch (_error) {
      // no-op
    }
  }

  async function sendQueuedGrossOp(op) {
    const payload = {
      scorecardId: Number(op.payload?.scorecardId || op.scorecardId),
      holeNumber: Number(op.payload?.holeNumber || op.holeNumber),
      grossScore: Number(op.payload?.grossScore || 0),
      opId: String(op.opId || op.payload?.opId || ''),
      baseVersion: Number(op.payload?.baseVersion || 0)
    };
    const res = await fetch(tp('/scoring/api/live/gross'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, payload: body, status: res.status };
    if (res.status === 409) return { ok: false, status: 409, payload: body, error: 'conflict' };
    return { ok: false, status: res.status, payload: body, error: body?.error || 'request_failed' };
  }

  async function sendQueuedDriveOp(op) {
    const payload = {
      scorecardId: Number(op.payload?.scorecardId || op.scorecardId),
      holeNumber: Number(op.payload?.holeNumber || op.holeNumber),
      driveTakenUserId:
        op.payload?.driveTakenUserId === null || op.payload?.driveTakenUserId === undefined
          ? null
          : Number(op.payload.driveTakenUserId)
    };
    const res = await fetch(tp('/scoring/api/live/drive'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, payload: body, status: res.status };
    return { ok: false, status: res.status, payload: body, error: body?.error || 'request_failed' };
  }

  function initializeOfflineSync() {
    if (!window.ForeScoreOfflineStore || typeof window.ForeScoreOfflineStore.create !== 'function') return;
    offlineStore = window.ForeScoreOfflineStore.create();
    if (!window.ForeScoreOfflineSync || typeof window.ForeScoreOfflineSync.create !== 'function') return;
    offlineSync = window.ForeScoreOfflineSync.create({
      store: offlineStore,
      scorecardId: Number(state.scorecardId),
      isEffectivelyOnline,
      sendGross: sendQueuedGrossOp,
      sendDrive: sendQueuedDriveOp,
      onAck: async (op) => {
        if (Number(op.holeNumber) === Number(currentHole)) {
          await refreshCurrentHole();
        }
      },
      onConflict: async (op, payload) => {
        if (op.type === 'gross') {
          upsertConflict(
            Number(op.scorecardId),
            Number(op.holeNumber),
            Number(op.payload?.grossScore || 0),
            payload || {}
          );
        }
        if (Number(op.holeNumber) === Number(currentHole)) {
          await refreshCurrentHole();
        }
      }
    });
    offlineSync.start();
  }

  window.addEventListener('focus', () => {
    updateOfflineCacheStatus();
    if (!localConflicts.size) return;
    if (!isEffectivelyOnline()) return;
    refreshCurrentHole();
  });

  window.addEventListener('online', () => {
    updateOfflineCacheStatus();
    if (!localConflicts.size) return;
    if (!isEffectivelyOnline()) return;
    refreshCurrentHole();
  });

  window.addEventListener('online', () => {
    updateOfflineCacheStatus();
    if (offlineSync) offlineSync.trigger();
    warmOfflineCache({ force: true }).catch(() => {});
  });

  window.addEventListener('offline', () => {
    updateOfflineCacheStatus();
  });

  if (offlineTestToggleBtn && offlineTestAllowed) {
    offlineTestToggleBtn.addEventListener('click', async () => {
      forceOfflineTestMode = !forceOfflineTestMode;
      try {
        if (forceOfflineTestMode) {
          localStorage.setItem(offlineTestStorageKey, '1');
        } else {
          localStorage.removeItem(offlineTestStorageKey);
        }
      } catch (_error) {
        // no-op
      }
      updateOfflineTestModeUi();
      await refreshCurrentHole();
      if (offlineSync) offlineSync.trigger();
    });
  }

  document.addEventListener('touchstart', (event) => {
    touchStartX = event.changedTouches[0].clientX;
  });

  document.addEventListener('touchend', (event) => {
    if (touchStartX === null) return;
    const deltaX = event.changedTouches[0].clientX - touchStartX;
    touchStartX = null;

    if (Math.abs(deltaX) < 40) return;
    if (deltaX < 0) {
      navigateByOffset(1);
    } else {
      navigateByOffset(-1);
    }
  });

  hydrateOfflineTestMode();
  updateOfflineTestModeUi();
  updateOfflineCacheStatus();
  initializeOfflineSync();
  hydrateConflictState();

  (async () => {
    try {
      const holeData = await fetchHoleData(currentHole);
      await render(holeData);
      warmOfflineCache().catch(() => {});
    } catch (_error) {
      await render({
        mode: state.mode,
        holeNumber: currentHole,
        hole: state.hole,
        entries: state.entries || [],
        ambroseContext: state.ambroseContext || null,
        individualContext: state.individualContext || null
      });
      warmOfflineCache().catch(() => {});
    }
  })();
})();
