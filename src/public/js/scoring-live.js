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
  const fromConfirm = searchParams.get('from') === 'confirm';

  const holeNumberEl = document.getElementById('holeNumber');
  const holeParEl = document.getElementById('holePar');
  const holeSiEl = document.getElementById('holeSi');
  const entriesContainer = document.getElementById('entriesContainer');
  const groupMetaEl = document.getElementById('groupMeta');
  const offlineCacheStatusEl = document.getElementById('offlineCacheStatus');
  const prevHoleBtn = document.getElementById('prevHoleBtn');
  const nextHoleBtn = document.getElementById('nextHoleBtn');
  const prevHoleLabelEl = document.getElementById('prevHoleLabel');
  const nextHoleLabelEl = document.getElementById('nextHoleLabel');
  const prevArrowIconEl = document.getElementById('prevArrowIcon');
  const offlineTestToggleBtn = document.getElementById('offlineTestToggleBtn');
  let transientStatusEl = null;

  let touchStartX = null;
  let isNavigating = false;
  let ctx = null; // static context from /init — players, holes, individualContext
  const requestedHole = parseInt(searchParams.get('hole'), 10);
  let currentHole = (requestedHole >= 1 && requestedHole <= 18) ? requestedHole : Number(state.holeNumber || state.startingHole || 1);
  let currentPar = Number(state.hole?.par || 0);
  let currentSiPrimary = Number(state.hole?.strokeIndexPrimary || 0);
  let currentSiSecondary = Number(state.hole?.strokeIndexSecondary || 0);
  const localConflicts = new Map();
  const localExpectedGross = new Map();
  const scoredHoles = new Set();
  const pendingGrossSends = new Map();
  let conflictPollTimer = null;
  let currentHoleData = null;
  let offlineStore = null;
  let offlineSync = null;
  let warmCachePromise = null;
  const warmedHoles = new Set();
  let holeOrder = holeSequenceFrom(Number(state.startingHole || 1));
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
    offlineTestToggleBtn.textContent = forceOfflineTestMode ? 'Go Online' : 'Go Offline';
    offlineTestToggleBtn.classList.toggle('btn-outline-secondary', !forceOfflineTestMode);
    offlineTestToggleBtn.classList.toggle('btn-warning', forceOfflineTestMode);
    if (forceOfflineTestMode) {
      setTransientStatus('OFFLINE TEST MODE — scores are not syncing to the server.', 'warning');
    } else {
      clearTransientStatus();
    }
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

  const holeLoadingOverlay = document.getElementById('holeLoadingOverlay');
  let overlayShowTimer = null;

  function setHoleLoading(loading) {
    isNavigating = loading;
    if (prevHoleBtn) prevHoleBtn.disabled = loading;
    if (nextHoleBtn) nextHoleBtn.disabled = loading;

    clearTimeout(overlayShowTimer);
    if (loading) {
      // Brief delay so instant cache hits don't flash the overlay
      overlayShowTimer = setTimeout(() => {
        if (holeLoadingOverlay) holeLoadingOverlay.classList.add('is-visible');
      }, 120);
    } else {
      if (holeLoadingOverlay) holeLoadingOverlay.classList.remove('is-visible');
    }
  }

  function holeOrdinal(n) {
    const num = Number(n);
    const mod10 = num % 10;
    const mod100 = num % 100;
    let suffix = 'th';
    if (mod100 < 11 || mod100 > 13) {
      if (mod10 === 1) suffix = 'st';
      else if (mod10 === 2) suffix = 'nd';
      else if (mod10 === 3) suffix = 'rd';
    }
    return `${num}${suffix}`;
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

  // ── Init fetch ────────────────────────────────────────────────────────────
  async function fetchInitFromServer() {
    const res = await fetch(tp(`/scoring/api/live/${state.scorecardId}/init`));
    if (!res.ok) {
      if (offlineStore) {
        const cached = await offlineStore.getInit(state.scorecardId);
        if (cached) return cached;
      }
      throw new Error('Failed to load scorecard context');
    }
    const json = await res.json();
    if (offlineStore) offlineStore.saveInit(state.scorecardId, json).catch(() => {});
    return json;
  }

  async function fetchInit() {
    if (!isEffectivelyOnline()) {
      if (offlineStore) {
        const cached = await offlineStore.getInit(state.scorecardId);
        if (cached) return cached;
      }
      throw new Error('Offline');
    }
    return fetchInitFromServer();
  }

  // ── Hole view builder: merges static ctx with live scores ─────────────────
  function buildHoleView(holeNumber, scores) {
    const hole = ctx.holes[Number(holeNumber)] || {};
    const scoreByCard = new Map((scores || []).map((s) => [Number(s.scorecardId), s]));
    const entries = ctx.players.map((player) => {
      const score = scoreByCard.get(Number(player.scorecardId)) || {};
      return {
        type: 'player',
        scorecardId: player.scorecardId,
        participantId: player.participantId,
        displayName: player.displayName,
        fullName: player.fullName,
        playingHandicap: player.playingHandicap,
        handicapDisplay: player.handicapDisplay,
        grossScore: score.grossScore ?? null,
        holeVersion: score.version || 0,
        stableford: score.stablefordPoints ?? null,
        stablefordTotal: score.stablefordTotal || 0,
        stablefordRelative: score.stablefordRelative || 0,
        ownerUserId: score.ownerUserId ?? null
      };
    });
    return {
      mode: ctx.mode,
      holeNumber: Number(holeNumber),
      hole: {
        par: hole.par || 0,
        strokeIndexPrimary: hole.strokeIndexPrimary || 0,
        strokeIndexSecondary: hole.strokeIndexSecondary || 0
      },
      entries,
      individualContext: ctx.individualContext || null,
      ambroseContext: null
    };
  }

  // ── Lean hole fetch (used when ctx is loaded) ─────────────────────────────
  async function fetchHoleLeanFromServer(holeNumber) {
    const hole = Number(holeNumber);
    const sids = (ctx.scorecardIds || []).join(',');
    const start = ctx.startingHole || 1;
    const res = await fetch(tp(`/scoring/api/live/${state.scorecardId}/hole/${hole}?sids=${sids}&start=${start}`));
    if (!res.ok) {
      if (offlineStore) {
        const cached = await offlineStore.getSnapshot(state.scorecardId, hole);
        if (cached) return buildHoleView(hole, cached.scores || []);
      }
      throw new Error('Failed to load hole data');
    }
    const json = await res.json();
    if (offlineStore) offlineStore.saveSnapshot(state.scorecardId, hole, json).catch(() => {});
    warmedHoles.add(hole);
    updateOfflineCacheStatus();
    return buildHoleView(hole, json.scores);
  }

  // ── Hole data fetch: lean when ctx available, full legacy otherwise ────────
  async function fetchHoleData(holeNumber) {
    const hole = Number(holeNumber);
    if (!isEffectivelyOnline()) {
      if (offlineStore) {
        const cached = await offlineStore.getSnapshot(state.scorecardId, hole);
        if (cached) {
          // Cached data is lean (post-refactor) or full (pre-refactor / legacy)
          if (ctx && cached.scores) return buildHoleView(hole, cached.scores);
          return cached;
        }
      }
      throw new Error('Offline');
    }
    if (ctx) return fetchHoleLeanFromServer(hole);
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
    if (offlineStore) offlineStore.saveSnapshot(state.scorecardId, hole, json).catch(() => {});
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
      const MAX_ATTEMPTS = 3;
      let pending = holeOrder.filter((h) => force || !warmedHoles.has(Number(h)));

      for (let attempt = 0; attempt < MAX_ATTEMPTS && pending.length > 0; attempt++) {
        if (!isEffectivelyOnline()) break;
        if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt));

        const failed = [];
        await Promise.all(pending.map(async (hole) => {
          if (!isEffectivelyOnline()) { failed.push(hole); return; }
          try {
            // Use lean fetch when ctx is loaded (much cheaper per hole)
            if (ctx) {
              await fetchHoleLeanFromServer(hole);
            } else {
              await fetchHoleDataFromServer(hole);
            }
            updateOfflineCacheStatus({ warming: true });
          } catch (_error) {
            failed.push(hole);
          }
        }));
        pending = failed;
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
      if (n > 0) return `<span class="text-success ms-1" style="font-size:2.5rem;line-height:0;vertical-align:-0.05em">${'•'.repeat(n)}</span>`;
      if (n < 0) return `<span class="text-danger ms-1">−</span>`;
      return '';
    };
    const label =
      entry.type === 'team'
        ? `${entry.displayName} (Hcp ${entry.teamHandicapDisplay || entry.teamHandicap || 0})`
        : `${entry.fullName || entry.displayName} (${entry.handicapDisplay || '-'})${shotDots(entry.playingHandicap)}`;
    const formatRelative = (value) => {
      const num = Number(value || 0);
      if (!Number.isFinite(num) || num === 0) return 'E';
      return num > 0 ? `+${num}` : `${num}`;
    };
    const formatUpDn = (value) => {
      const num = Number(value || 0);
      if (!Number.isFinite(num) || num === 0) return 'E';
      return num > 0 ? `+${num}` : `${num}`;
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
        : '';

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
            <div class="d-flex justify-content-between align-items-center mb-2">
              <h2 class="h6 mb-0 individual-entry-title flex-grow-1">${label}</h2>
              <div class="d-flex align-items-center gap-2 flex-shrink-0">
                <span class="fw-bold entry-rel ${upDnClass(entry.stablefordRelative)}">${formatUpDn(entry.stablefordRelative)}</span>
                ${hasScorecard ? `<button type="button" class="btn btn-sm btn-link text-muted p-0 round-summary-btn" data-scorecard-id="${entry.scorecardId}" aria-label="Round summary"><i class="fa-solid fa-table-list" aria-hidden="true"></i></button>` : ''}
              </div>
            </div>
            <div class="d-flex align-items-center justify-content-between gap-2">
              <div class="score-adjuster ${conflict ? 'score-adjuster-conflict' : ''}" data-scorecard-id="${entry.scorecardId}">
                <button type="button" class="btn btn-outline-dark btn-lg adjust-btn" data-delta="-1" ${hasScorecard ? '' : 'disabled'}>-</button>
                <span class="gross-pill ${grossPillClass}" data-gross-value="${Number(gross || 0)}">${grossDisplay}</span>
                <button type="button" class="btn btn-outline-dark btn-lg adjust-btn" data-delta="1" ${hasScorecard ? '' : 'disabled'}>+</button>
                <button type="button" class="btn btn-outline-dark btn-lg pickup-btn" data-scorecard-id="${entry.scorecardId}" data-playing-handicap="${Number(entry.playingHandicap || 0)}" ${hasScorecard ? '' : 'disabled'}>P</button>
              </div>
              <div class="d-flex gap-3 flex-shrink-0 entry-metrics text-center">
                <div>
                  <div class="entry-metrics-label">Stb</div>
                  <div class="entry-metrics-value entry-stb text-dark">${stableford}</div>
                </div>
                <div>
                  <div class="entry-metrics-label">Total</div>
                  <div class="entry-metrics-value entry-total text-dark">${Number(entry.stablefordTotal || 0)}</div>
                </div>
              </div>
            </div>
            ${conflictPanel ? `<div class="mt-1">${conflictPanel}</div>` : ''}
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

  // Runs conflict detection against a fetched holeData without touching the display.
  // Used for silent background checks of holes we've navigated away from.
  function detectConflictsFromData(holeData) {
    if (!holeData || !Array.isArray(holeData.entries)) return;
    holeData.entries.forEach((entry) => {
      const conflict = getConflict(entry.scorecardId, holeData.holeNumber);
      const expectedGross = getExpectedGross(entry.scorecardId, holeData.holeNumber);
      const canonicalGross = normalizeGross(entry.grossScore);
      if (expectedGross !== null && expectedGross !== canonicalGross) {
        // Same user from another session — silently accept; no conflict needed.
        if (ctx?.currentUserId && entry.ownerUserId === ctx.currentUserId) {
          setExpectedGross(entry.scorecardId, holeData.holeNumber, canonicalGross);
          clearConflict(entry.scorecardId, holeData.holeNumber);
          return;
        }
        upsertConflict(entry.scorecardId, holeData.holeNumber, expectedGross, {
          canonicalGross,
          ownerName: conflict?.ownerName || null
        });
      }
      if (!conflict) return;
      if (Number(entry.grossScore || 0) === Number(conflict.attemptedGross || 0)) {
        clearConflict(entry.scorecardId, holeData.holeNumber);
      } else {
        conflict.canonicalGross = entry.grossScore;
      }
    });
    ensureConflictPolling();
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
    const _hIdx = holeOrder.indexOf(Number(holeData.holeNumber));
    const _isFirst = _hIdx <= 0;
    const _isLast = _hIdx >= holeOrder.length - 1;
    if (prevHoleLabelEl) prevHoleLabelEl.textContent = _isFirst ? 'Start' : String(holeOrder[_hIdx - 1]);
    if (prevArrowIconEl) prevArrowIconEl.classList.toggle('d-none', _isFirst);
    if (nextHoleLabelEl) nextHoleLabelEl.textContent = _isLast ? 'Finish' : String(holeOrder[_hIdx + 1]);
    clearTransientStatus();

    if (groupMetaEl) {
      if (fromConfirm) {
        groupMetaEl.innerHTML = `<a href="${tp(`/scoring/confirm/${state.scorecardId}`)}" class="btn btn-sm btn-outline-secondary"><i class="fa-solid fa-list-check me-1"></i>Back to Review</a>`;
      } else {
        const isAmbrose = holeData.mode === 'ambrose';
        const groupCtx = isAmbrose
          ? (holeData.ambroseContext || state.ambroseContext)
          : (holeData.individualContext || state.individualContext);
        if (groupCtx) {
          const requesterDisplay = ctx?.requesterDisplay || state.requesterDisplay || '';
          const who = requesterDisplay ? ` | ${requesterDisplay}` : '';
          const teeTimeDisplay = groupCtx.teeTime ? groupCtx.teeTime.slice(0, 5) : '-';
          groupMetaEl.textContent = `Group ${groupCtx.groupNumber || '-'} | ${teeTimeDisplay} | ${groupCtx.teeLocation || '-'}${who}`;
        } else {
          groupMetaEl.textContent = '';
        }
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
        // Same user from another session — silently accept; no conflict needed.
        if (ctx?.currentUserId && entry.ownerUserId === ctx.currentUserId) {
          setExpectedGross(entry.scorecardId, holeData.holeNumber, canonicalGross);
          clearConflict(entry.scorecardId, holeData.holeNumber);
          return;
        }
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
    const showTeamDivider = ctx?.twoBallEnabled && holeData.mode !== 'ambrose' && holeData.entries.length === 4;
    const teamDivider = `<div class="two-ball-team-divider" aria-hidden="true">
      <span></span><i class="fa-solid fa-chevron-down"></i><span></span>
    </div>`;
    entriesContainer.innerHTML = holeData.entries.map((entry, i) => {
      const card = entryCard(entry);
      return (showTeamDivider && i === 2) ? teamDivider + card : card;
    }).join('');
    bindAdjustmentHandlers();
    bindPickupHandlers();
    bindDriveHandlers();
    bindGrossShortcutHandlers();
    bindConflictHandlers();
    bindSummaryHandlers();
    persistConflictState();
    if (offlineStore) {
      offlineStore.saveSnapshot(state.scorecardId, currentHole, holeData).catch(() => {});
    }
  }

  // Surgically update a player's score display in the current DOM without a full re-render.
  // Returns true if the card was found and updated; false if a full render is needed.
  function updateScoreDisplay(scorecardId, grossScore, stableford, stablefordTotal, stablefordRelative) {
    const adjuster = entriesContainer.querySelector(`.score-adjuster[data-scorecard-id="${Number(scorecardId)}"]`);
    if (!adjuster) return false;
    const card = adjuster.closest('.individual-entry-card');
    if (!card) return false;

    const gross = Number(grossScore || 0);
    const playingHandicap = Number(adjuster.querySelector('.pickup-btn')?.dataset.playingHandicap || 0);
    const showPickup = gross > 0 && stablefordForGross(gross, currentPar, currentSiPrimary, currentSiSecondary, playingHandicap) === 0;

    const perfClass = (() => {
      if (!gross) return '';
      if (gross === 1) return 'gross-pill-hole-in-one';
      if (currentPar > 0) {
        if (gross <= currentPar - 2) return 'gross-pill-eagle';
        if (gross === currentPar - 1) return 'gross-pill-birdie';
      }
      return '';
    })();

    const grossEl = adjuster.querySelector('.gross-pill');
    if (grossEl) {
      grossEl.dataset.grossValue = String(gross);
      grossEl.textContent = String(showPickup ? 'P' : gross);
      grossEl.className = ['gross-pill', perfClass, perfClass ? 'gross-pill-disc' : ''].filter(Boolean).join(' ');
    }

    const stbEl = card.querySelector('.entry-stb');
    if (stbEl) stbEl.textContent = stableford !== null && stableford !== undefined ? String(stableford) : '-';

    const totalEl = card.querySelector('.entry-total');
    if (totalEl) totalEl.textContent = String(Number(stablefordTotal || 0));

    const relEl = card.querySelector('.entry-rel');
    if (relEl) {
      const rel = Number(stablefordRelative || 0);
      relEl.textContent = rel === 0 ? 'E' : (rel > 0 ? `+${rel}` : `${rel}`);
      relEl.className = `fw-bold entry-rel ${rel > 0 ? 'text-success' : (rel < 0 ? 'text-danger' : 'text-dark')}`;
    }
    return true;
  }

  async function showRoundSummary(scorecardId, playerName) {
    const offcanvasEl = document.getElementById('roundSummaryOffcanvas');
    if (!offcanvasEl) return;

    const titleEl = offcanvasEl.querySelector('#roundSummaryTitle');
    if (titleEl) titleEl.textContent = playerName;
    const bodyEl = offcanvasEl.querySelector('#roundSummaryBody');
    if (bodyEl) bodyEl.innerHTML = '<p class="text-center text-muted py-3"><span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>Loading…</p>';

    const oc = window.bootstrap.Offcanvas.getOrCreateInstance(offcanvasEl);
    oc.show();

    try {
      const res = await fetch(tp(`/scoring/api/live/${scorecardId}/round-scores`));
      if (!res.ok) throw new Error('fetch failed');
      const data = await res.json();

      const holeMap = new Map(data.holes.map((h) => [h.holeNumber, h]));
      const holeNumbers = ctx?.holes ? Object.keys(ctx.holes).map(Number).sort((a, b) => a - b) : [];

      let totalGross = 0;
      let totalStb = 0;
      let holesPlayed = 0;
      const rows = holeNumbers.map((num) => {
        const hole = ctx.holes[num] || {};
        const score = holeMap.get(num);
        const gross = score?.grossScore ?? null;
        const stb = score?.stablefordPoints ?? null;
        if (gross !== null) { totalGross += gross; holesPlayed++; }
        if (stb !== null) totalStb += stb;
        const isCurrent = num === currentHole;
        return `<tr class="hole-nav-row ${isCurrent ? 'table-warning fw-semibold' : ''}" data-hole="${num}" role="button">
          <td>${num}</td>
          <td>${hole.par || '–'}</td>
          <td>${gross !== null ? gross : '–'}</td>
          <td>${stb !== null ? stb : '–'}</td>
          <td class="text-muted" style="font-size:0.75rem"><i class="fa-solid fa-chevron-right"></i></td>
        </tr>`;
      });

      if (bodyEl) {
        bodyEl.innerHTML = `
          <div class="table-responsive">
            <table class="table table-sm table-bordered table-hover mb-0 round-summary-table">
              <thead class="table-light">
                <tr><th>Hole</th><th>Par</th><th>Gross</th><th>Stb</th><th></th></tr>
              </thead>
              <tbody>${rows.join('')}</tbody>
              <tfoot class="table-light fw-semibold">
                <tr>
                  <td colspan="2">Total</td>
                  <td>${holesPlayed > 0 ? totalGross : '–'}</td>
                  <td>${holesPlayed > 0 ? totalStb : '–'}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>`;

        bodyEl.querySelectorAll('.hole-nav-row').forEach((row) => {
          row.addEventListener('click', () => {
            const holeNum = Number(row.dataset.hole);
            const oc = window.bootstrap.Offcanvas.getInstance(offcanvasEl);
            if (oc) {
              offcanvasEl.addEventListener('hidden.bs.offcanvas', () => navigateToHole(holeNum), { once: true });
              oc.hide();
            } else {
              navigateToHole(holeNum);
            }
          });
        });

        const currentRow = bodyEl.querySelector('.hole-nav-row.table-warning');
        if (currentRow) currentRow.scrollIntoView({ block: 'center' });
      }
    } catch (_err) {
      if (bodyEl) bodyEl.innerHTML = '<p class="text-danger small py-3 mb-0 text-center">Could not load round scores.</p>';
    }
  }

  function bindSummaryHandlers() {
    entriesContainer.querySelectorAll('.round-summary-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const scorecardId = Number(btn.dataset.scorecardId);
        const player = ctx?.players?.find((p) => Number(p.scorecardId) === scorecardId);
        const playerName = player ? (player.fullName || player.displayName) : 'Player';
        showRoundSummary(scorecardId, playerName);
      });
    });
  }

  function renderTwoBallStatus(data) {
    const { twoBallType, teamA, teamB, firstHalf, secondHalf, match } = data;
    const typeLabel = twoBallType === 'aggregate' ? 'Aggregate' : 'Best Ball';
    const t1Name = teamA.players.map((p) => p.displayName).join(' & ');
    const t2Name = teamB.players.map((p) => p.displayName).join(' & ');

    function holeRangeLabel(holes) {
      const sorted = [...holes].sort((a, b) => a - b);
      return `Holes ${sorted[0]}–${sorted[sorted.length - 1]}`;
    }

    // Compute match play status for each half from byHole data
    const firstSet = new Set(firstHalf.holes);
    const secondSet = new Set(secondHalf.holes);
    let front9Status = 0, front9Played = 0;
    let back9Status = 0, back9Played = 0;
    for (const row of match.byHole) {
      if (firstSet.has(row.holeNumber)) { front9Status += row.holeDelta; front9Played++; }
      else if (secondSet.has(row.holeNumber)) { back9Status += row.holeDelta; back9Played++; }
    }

    function matchSummaryLabel(status, played) {
      if (played === 0) return '—';
      if (status === 0) return 'All Square';
      return status > 0 ? `T1 &nbsp;<strong>${status} UP</strong>` : `T2 &nbsp;<strong>${Math.abs(status)} UP</strong>`;
    }

    const titleEl = document.getElementById('twoBallOffcanvasTitle');
    if (titleEl) titleEl.textContent = `2-Ball · ${typeLabel}`;

    return `
      <div class="row g-0 text-center border rounded mb-3 overflow-hidden">
        <div class="col border-end py-3">
          <div class="small text-muted fw-semibold text-uppercase mb-2" style="letter-spacing:.05em;font-size:.65rem">Team 1</div>
          <div class="small fw-semibold">${t1Name}</div>
          <div class="h3 fw-bold mt-2 mb-0">${teamA.total}</div>
          <div class="text-muted" style="font-size:0.7rem">pts</div>
        </div>
        <div class="col py-3">
          <div class="small text-muted fw-semibold text-uppercase mb-2" style="letter-spacing:.05em;font-size:.65rem">Team 2</div>
          <div class="small fw-semibold">${t2Name}</div>
          <div class="h3 fw-bold mt-2 mb-0">${teamB.total}</div>
          <div class="text-muted" style="font-size:0.7rem">pts</div>
        </div>
      </div>

      <div class="row g-2 mb-3">
        <div class="col-6">
          <div class="border rounded p-2 text-center">
            <div class="small fw-semibold text-muted text-uppercase mb-2" style="letter-spacing:.05em;font-size:.65rem">First 9 · ${holeRangeLabel(firstHalf.holes)}</div>
            <div class="d-flex justify-content-around">
              <div><div class="text-muted" style="font-size:0.7rem">Team 1</div><div class="h5 fw-bold mb-0">${firstHalf.teamA}</div></div>
              <div><div class="text-muted" style="font-size:0.7rem">Team 2</div><div class="h5 fw-bold mb-0">${firstHalf.teamB}</div></div>
            </div>
          </div>
        </div>
        <div class="col-6">
          <div class="border rounded p-2 text-center">
            <div class="small fw-semibold text-muted text-uppercase mb-2" style="letter-spacing:.05em;font-size:.65rem">Second 9 · ${holeRangeLabel(secondHalf.holes)}</div>
            <div class="d-flex justify-content-around">
              <div><div class="text-muted" style="font-size:0.7rem">Team 1</div><div class="h5 fw-bold mb-0">${secondHalf.teamA}</div></div>
              <div><div class="text-muted" style="font-size:0.7rem">Team 2</div><div class="h5 fw-bold mb-0">${secondHalf.teamB}</div></div>
            </div>
          </div>
        </div>
      </div>

      <div class="border rounded p-2">
        <div class="small fw-semibold text-muted text-uppercase mb-2" style="letter-spacing:.05em;font-size:.65rem">Match Play</div>
        <div class="row g-0 text-center">
          <div class="col border-end">
            <div class="text-muted mb-1" style="font-size:0.7rem">Front 9</div>
            <div class="small">${matchSummaryLabel(front9Status, front9Played)}</div>
          </div>
          <div class="col border-end">
            <div class="text-muted mb-1" style="font-size:0.7rem">Back 9</div>
            <div class="small">${matchSummaryLabel(back9Status, back9Played)}</div>
          </div>
          <div class="col">
            <div class="text-muted mb-1" style="font-size:0.7rem">Overall</div>
            <div class="small">${matchSummaryLabel(match.status, match.holesPlayed)}</div>
          </div>
        </div>
      </div>
    `;
  }

  async function showTwoBallStatus() {
    const offcanvasEl = document.getElementById('twoBallOffcanvas');
    if (!offcanvasEl) return;

    const bodyEl = document.getElementById('twoBallOffcanvasBody');
    if (bodyEl) bodyEl.innerHTML = '<p class="text-center text-muted py-3"><span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>Loading…</p>';

    const oc = window.bootstrap.Offcanvas.getOrCreateInstance(offcanvasEl);
    oc.show();

    try {
      const res = await fetch(tp(`/scoring/api/live/${state.scorecardId}/two-ball-status`));
      if (!res.ok) throw new Error('fetch failed');
      const data = await res.json();
      if (bodyEl) bodyEl.innerHTML = renderTwoBallStatus(data);
    } catch (_err) {
      if (bodyEl) bodyEl.innerHTML = '<p class="text-danger small py-3 mb-0 text-center">Could not load team scores.</p>';
    }
  }

  function adjustGross(scorecardId, delta) {
    if (!isEditingEnabled()) return;
    if (!Number.isFinite(Number(scorecardId))) return;
    const entry = currentHoleData?.entries?.find((e) => Number(e.scorecardId) === Number(scorecardId));
    const currentGross = Number(entry?.grossScore || 0);
    const maxGross = delta > 0
      ? minGrossForPickup(currentPar, currentSiPrimary, currentSiSecondary, Number(entry?.playingHandicap || 0))
      : 20;
    const nextGross = Math.min(maxGross, Math.max(0, currentGross + delta));
    setGross(scorecardId, nextGross);
  }

  // Debounce gross sends so rapid +/- taps collapse into a single request.
  // Reads baseVersion on first press of a sequence (before any server response is
  // expected) and reuses it for the final send, avoiding spurious version conflicts.
  function scheduleGrossSend(scorecardId, holeNumber, grossScore) {
    const key = `${scorecardId}:${holeNumber}`;
    const existing = pendingGrossSends.get(key);
    if (existing) clearTimeout(existing.timer);
    const baseVersion = existing ? existing.baseVersion : getCurrentHoleVersion(scorecardId);
    const timer = setTimeout(() => {
      pendingGrossSends.delete(key);
      sendGrossNow(scorecardId, holeNumber, grossScore, newOpId(), baseVersion);
    }, 300);
    pendingGrossSends.set(key, { timer, baseVersion });
  }

  // When online, send directly to the server (fire-and-forget). Only fall back to the
  // IndexedDB queue when offline or when the direct send fails — this prevents stale ops
  // from old sessions from blocking current scores.
  function sendGrossNow(scorecardId, holeNumber, grossScore, opId, baseVersion) {
    if (!isEffectivelyOnline()) {
      enqueueOfflineOp('gross', scorecardId, holeNumber, { scorecardId, holeNumber, grossScore, opId, baseVersion }).catch(() => {});
      return;
    }
    const op = { opId, scorecardId: Number(scorecardId), holeNumber: Number(holeNumber), payload: { scorecardId, holeNumber, grossScore, opId, baseVersion } };
    sendQueuedGrossOp(op).then((result) => {
      if (result.ok) {
        if (!fromConfirm) setExpectedGross(Number(scorecardId), holeNumber, grossScore);
        clearConflict(Number(scorecardId), holeNumber);
        if (Number(holeNumber) === Number(currentHole) && result.payload?.holeVersion !== undefined) {
          updateCurrentHoleEntry(scorecardId, (entry) => {
            entry.holeVersion = Number(result.payload.holeVersion || 0);
            return entry;
          });
        }
        return;
      }
      if (result.status === 409) {
        upsertConflict(Number(scorecardId), holeNumber, grossScore, result.payload || {});
        if (Number(holeNumber) === Number(currentHole)) {
          fetchHoleData(currentHole).then((holeData) => render(holeData)).catch(() => {});
        }
        return;
      }
      if (result.status === 404) {
        const isCurrentGroup = ctx && Array.isArray(ctx.scorecardIds) && ctx.scorecardIds.some((s) => Number(s) === Number(scorecardId));
        if (isCurrentGroup) setTransientStatus('Scoring session is out of date — please reload the page.', 'danger');
        return;
      }
      // Transient server error — queue for retry.
      enqueueOfflineOp('gross', scorecardId, holeNumber, { scorecardId, holeNumber, grossScore, opId, baseVersion }).catch(() => {});
    }).catch(() => {
      // Network failure — queue for retry.
      enqueueOfflineOp('gross', scorecardId, holeNumber, { scorecardId, holeNumber, grossScore, opId, baseVersion }).catch(() => {});
    });
  }

  // Score entry is fully client-side: update local state + DOM immediately, then sync.
  function setGross(scorecardId, grossScore) {
    if (dayStatus !== 'open') return;
    if (!Number.isFinite(Number(scorecardId))) return;
    const normalizedGross = normalizeGross(grossScore);

    const prevEntry = currentHoleData?.entries?.find((e) => Number(e.scorecardId) === Number(scorecardId));
    const prevStableford = prevEntry?.stableford ?? null;
    const playingHandicap = Number(prevEntry?.playingHandicap || 0);
    const nextStableford = normalizedGross === 0 ? null
      : stablefordForGross(normalizedGross, currentPar, currentSiPrimary, currentSiSecondary, playingHandicap);
    const prevIsScored = prevStableford !== null;
    const nextIsScored = nextStableford !== null;
    const deltaTotal = (nextStableford ?? 0) - (prevStableford ?? 0);
    // stablefordRelative = stablefordTotal - (holesPlayed * 2). When the hole transitions
    // from unscored→scored or scored→unscored, holesPlayed changes by ±1, so add ∓2.
    const deltaRelative = deltaTotal + (!prevIsScored && nextIsScored ? -2 : prevIsScored && !nextIsScored ? 2 : 0);
    const nextTotal = Number(prevEntry?.stablefordTotal || 0) + deltaTotal;
    const nextRelative = Number(prevEntry?.stablefordRelative || 0) + deltaRelative;

    updateCurrentHoleEntry(scorecardId, (entry) => {
      entry.grossScore = normalizedGross;
      entry.stableford = nextStableford;
      entry.stablefordTotal = nextTotal;
      entry.stablefordRelative = nextRelative;
      return entry;
    });

    // Surgical DOM update — instant, no full re-render.
    const updated = updateScoreDisplay(scorecardId, normalizedGross, nextStableford, nextTotal, nextRelative);
    if (!updated && currentHoleData) render(currentHoleData).catch(() => {});

    scoredHoles.add(Number(currentHole));
    scheduleGrossSend(scorecardId, Number(currentHole), normalizedGross);
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
      btn.addEventListener('click', () => {
        const delta = Number(btn.dataset.delta || 0);
        const scorecardId = Number(btn.closest('.score-adjuster').dataset.scorecardId);
        adjustGross(scorecardId, delta);
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
      btn.addEventListener('click', () => {
        if (!isEditingEnabled()) return;
        const scorecardId = Number(btn.dataset.scorecardId);
        const playingHandicap = Number(btn.dataset.playingHandicap || 0);
        if (!Number.isFinite(scorecardId)) return;
        const pickupGross = minGrossForPickup(currentPar, currentSiPrimary, currentSiSecondary, playingHandicap);
        setGross(scorecardId, pickupGross);
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
      pill.addEventListener('click', () => {
        if (!isEditingEnabled()) return;
        const adjuster = pill.closest('.score-adjuster');
        if (!adjuster) return;
        const scorecardId = Number(adjuster.dataset.scorecardId);
        if (!Number.isFinite(scorecardId)) return;
        const currentGross = Number(pill.dataset.grossValue || pill.textContent || 0);
        if (currentGross !== 0) return;
        const par = Number(holeParEl.textContent || 0);
        if (!Number.isFinite(par) || par < 1) return;
        setGross(scorecardId, par);
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
    window.location.assign(tp(`/scoring/confirm/${state.scorecardId}?returnHole=${currentHole}`));
  }

  async function navigateByOffset(offset) {
    if (isNavigating) return;
    if (hasConflictsForHole(currentHole)) return;
    setHoleLoading(true);
    const prevHole = currentHole;
    try {
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
        // Silent background re-fetch of the hole we just left — detects any
        // same-group score changes that occurred during the navigation window
        // without re-rendering (which would visually jump back to that hole).
        if (isEffectivelyOnline() && prevHole !== nextHole && scoredHoles.has(prevHole)) {
          fetchHoleData(prevHole).then(detectConflictsFromData).catch(() => {});
        }
      } catch (error) {
        if (error && error.message === 'Offline') {
          setTransientStatus(`Hole ${nextHole} is not cached for offline yet.`, 'warning');
        } else {
          setTransientStatus(`Could not load hole ${nextHole}. Please try again.`, 'danger');
        }
      }
    } finally {
      setHoleLoading(false);
    }
  }

  async function navigateToHole(holeNumber) {
    if (isNavigating) return;
    if (hasConflictsForHole(currentHole)) return;
    const target = Number(holeNumber);
    if (!holeOrder.includes(target)) return;
    setHoleLoading(true);
    const prevHole = currentHole;
    try {
      const holeData = await fetchHoleData(target);
      await render(holeData);
      if (isEffectivelyOnline() && prevHole !== target && scoredHoles.has(prevHole)) {
        fetchHoleData(prevHole).then(detectConflictsFromData).catch(() => {});
      }
    } catch (error) {
      if (error && error.message === 'Offline') {
        setTransientStatus(`Hole ${target} is not cached for offline yet.`, 'warning');
      } else {
        setTransientStatus(`Could not load hole ${target}. Please try again.`, 'danger');
      }
    } finally {
      setHoleLoading(false);
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
    }, 8000);
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
      // No scorecardId filter — process ops for all group members, not just own scorecard.
      isEffectivelyOnline,
      sendGross: sendQueuedGrossOp,
      sendDrive: sendQueuedDriveOp,
      onAck: (op, result) => {
        const opSid = Number(op.payload?.scorecardId || op.scorecardId);
        const opHole = Number(op.payload?.holeNumber || op.holeNumber);
        const opGross = Number(op.payload?.grossScore || 0);
        // Mark this submission as accepted so conflict detection doesn't fire.
        setExpectedGross(opSid, opHole, opGross);
        clearConflict(opSid, opHole);
        // Silently record the server-confirmed version — no re-render needed.
        if (opHole === Number(currentHole) && result?.payload?.holeVersion !== undefined) {
          updateCurrentHoleEntry(opSid, (entry) => {
            entry.holeVersion = Number(result.payload.holeVersion || 0);
            return entry;
          });
        }
      },
      onConflict: async (op, payload) => {
        if (op.type === 'gross') {
          upsertConflict(
            Number(op.payload?.scorecardId || op.scorecardId),
            Number(op.holeNumber),
            Number(op.payload?.grossScore || 0),
            payload || {}
          );
        }
        if (Number(op.holeNumber) === Number(currentHole)) {
          const holeData = await fetchHoleData(currentHole);
          await render(holeData);
        }
      },
      onPermanentFail: (op) => {
        // 404 = scorecard deleted (e.g. round was reset). Silently discard stale
        // ops from old sessions; only surface an error if the op is for a scorecard
        // that belongs to the current group.
        const opSid = Number(op.payload?.scorecardId || op.scorecardId);
        const isCurrentGroup = ctx && Array.isArray(ctx.scorecardIds) && ctx.scorecardIds.some((s) => Number(s) === opSid);
        if (isCurrentGroup) {
          setTransientStatus('Scoring session is out of date — please reload the page.', 'danger');
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

  // Screen wake lock with user toggle (default on)
  const wakeLockStorageKey = 'forescore_wake_lock';
  let wakeLockEnabled = localStorage.getItem(wakeLockStorageKey) !== '0';
  let wakeLock = null;
  const wakeLockToggleBtn = document.getElementById('wakeLockToggleBtn');

  function updateWakeLockToggleUi() {
    if (!wakeLockToggleBtn) return;
    wakeLockToggleBtn.style.color = wakeLockEnabled ? 'var(--fs-green)' : '#adb5bd';
    wakeLockToggleBtn.title = wakeLockEnabled ? 'Screen wake lock on' : 'Screen wake lock off';
  }

  async function acquireWakeLock() {
    if (!wakeLockEnabled || !('wakeLock' in navigator)) return;
    if (wakeLock && !wakeLock.released) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
        updateWakeLockToggleUi();
        // Re-acquire if the page is still visible and user hasn't disabled it
        if (wakeLockEnabled && document.visibilityState === 'visible') acquireWakeLock();
      });
      updateWakeLockToggleUi();
    } catch (_err) {
      // denied or not supported — silently ignore
    }
  }

  async function releaseWakeLock() {
    const sentinel = wakeLock;
    wakeLock = null;
    if (sentinel && !sentinel.released) {
      try { await sentinel.release(); } catch (_err) { /* ignore */ }
    }
  }

  updateWakeLockToggleUi();
  acquireWakeLock();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') acquireWakeLock();
  });

  if (wakeLockToggleBtn) {
    wakeLockToggleBtn.addEventListener('click', async () => {
      wakeLockEnabled = !wakeLockEnabled;
      try {
        localStorage.setItem(wakeLockStorageKey, wakeLockEnabled ? '1' : '0');
      } catch (_err) { /* ignore */ }
      updateWakeLockToggleUi();
      if (wakeLockEnabled) {
        await acquireWakeLock();
      } else {
        await releaseWakeLock();
      }
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

  const twoBallBtn = document.getElementById('twoBallStatusBtn');
  if (twoBallBtn) {
    twoBallBtn.addEventListener('click', () => showTwoBallStatus());
  }

  if (screen.orientation?.lock) {
    screen.orientation.lock('portrait').catch(() => {});
  }

  (async () => {
    setHoleLoading(true);
    try {
      // Load static context (players, handicaps, all hole configs) once.
      // On success, ctx drives all subsequent rendering — no per-hole DB work for static data.
      ctx = await fetchInit();
      holeOrder = ctx.holeOrder || holeSequenceFrom(Number(ctx.startingHole || 1));
      currentHole = (requestedHole >= 1 && requestedHole <= 18) ? requestedHole : Number(ctx.currentHole || state.holeNumber || state.startingHole || 1);

      if (ctx.twoBallEnabled) {
        const navBar = document.getElementById('twoBallNavBar');
        if (navBar) navBar.classList.remove('d-none');
      }

      const holeData = await fetchHoleData(currentHole);
      await render(holeData);
    } catch (_error) {
      // If init failed (offline on first load), fall back to server-rendered state
      // so the page still shows something. First navigation will retry init.
      await render({
        mode: state.mode,
        holeNumber: currentHole,
        hole: state.hole,
        entries: state.entries || [],
        ambroseContext: state.ambroseContext || null,
        individualContext: state.individualContext || null
      });
    } finally {
      setHoleLoading(false);
      warmOfflineCache().catch(() => {});
    }
  })();
})();
