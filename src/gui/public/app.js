// ─────────────────────────────────────────────────────────────────────
// SMART CLAUDE MEMORY · M7 Graduations dashboard
// Vanilla JS — no libraries. Drives:
//   • lifecycle lanes (proposed / composed / approved / rejected)
//   • interactive 2.5D knowledge graph (zoom, pan, drag, hover-dim)
//   • Settings drawer (time zone, auto-refresh, node size, edge opacity, glow)
// All preferences persist under localStorage key  scm.settings
// ─────────────────────────────────────────────────────────────────────

const STATES = ['proposed', 'composed', 'approved', 'rejected'];
    const $ = (s, p = document) => p.querySelector(s);
    const $$ = (s, p = document) => Array.from(p.querySelectorAll(s));

    function toast(msg, kind) {
      const t = $('#toast');
      t.textContent = msg;
      t.className = 'show ' + (kind || '');
      setTimeout(() => { t.className = ''; }, 3200);
    }

    async function jsonFetch(url, opts) {
      const r = await fetch(url, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
      const body = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, body };
    }

    async function loadHealth() {
      const r = await jsonFetch('/api/health');
      $('#health').textContent = r.ok ? 'connected · v' + (r.body.version || '?') : 'disconnected';
      const modelEl = document.getElementById('model-name');
      if (modelEl) {
        const m = r.body && r.body.last_model ? String(r.body.last_model) : '—';
        modelEl.textContent = m.toUpperCase();
      }
    }

    // SCM-S39-D1 (v2.2.2): Agentic Resource Manager ticker. Polls /api/budget
    // on the same cadence as health/graduations and renders the worst-of
    // daemon burn ratio in the header tele row.
    async function loadBudget() {
      const el = document.getElementById('tele-budget');
      if (!el) return;
      const r = await jsonFetch('/api/budget');
      if (!r.ok || !r.body || !Array.isArray(r.body.daemons)) {
        el.textContent = '—';
        el.className = 'v';
        return;
      }
      const mode = r.body.mode || 'off';
      if (mode === 'off') {
        el.textContent = 'off';
        el.className = 'v muted';
        el.parentElement && el.parentElement.setAttribute('title',
          'Agentic Resource Manager — SCM_BUDGET_ENFORCEMENT_MODE=off');
        return;
      }
      let worst = 0;
      let worstDaemon = '—';
      for (const row of r.body.daemons) {
        const ratio = typeof row.burn_ratio === 'number' ? row.burn_ratio : 0;
        if (ratio > worst) { worst = ratio; worstDaemon = row.daemon; }
      }
      const pct = Math.round(worst * 100);
      el.textContent = pct + '%';
      el.className = 'v ' + (worst >= 1 ? 'err' : worst >= 0.8 ? 'accent' : 'ok');
      el.parentElement && el.parentElement.setAttribute('title',
        'Agentic Resource Manager — mode=' + mode +
        ' · worst burn: ' + worstDaemon + ' ' + pct + '%');
    }

    function makeEl(tag, opts) {
      const el = document.createElement(tag);
      if (opts && opts.cls) el.className = opts.cls;
      if (opts && opts.text != null) el.textContent = String(opts.text);
      return el;
    }

    // ─── Epic F (M8) — Active Backlog Kanban ───────────────────────────
    // Pulls /api/backlog (defaults to the server's resolved project_id),
    // renders 4 columns (todo / in_progress / blocked / done). Rows
    // arrive pre-grouped and pre-sorted by (priority asc, age asc) per
    // column, so we just render — no client-side sort.
    const BACKLOG_COLUMNS = ['todo', 'in_progress', 'blocked', 'done'];

    function renderBacklogCard(row) {
      const li = makeEl('li', { cls: 'kanban-card' });
      // Drag-drop persistence (Phase 1): each card carries its id + current
      // status so the delegated drop handler can compute a move + revert.
      li.draggable = true;
      li.dataset.id = String(row.id);
      li.dataset.status = String(row.status);
      const title = makeEl('div', { cls: 'card-title', text: row.title || '(untitled)' });
      const meta = makeEl('div', { cls: 'card-meta' });
      const pri = makeEl('span', { cls: 'pri', text: 'p' + row.priority });
      pri.setAttribute('data-priority', String(row.priority));
      const id = makeEl('span', { cls: 'id', text: '#' + row.id });
      meta.appendChild(pri);
      meta.appendChild(id);
      if (row.created_at) {
        const d = new Date(row.created_at);
        if (!Number.isNaN(d.getTime())) {
          const age = makeEl('span', { cls: 'age', text: d.toISOString().slice(0, 10) });
          meta.appendChild(age);
        }
      }
      li.appendChild(title);
      li.appendChild(meta);
      if (row.notes) {
        li.appendChild(makeEl('div', { cls: 'card-notes', text: String(row.notes) }));
      }
      return li;
    }

    // Recompute per-column counts + grand total from the live DOM. Counts only
    // real .kanban-card nodes (the (empty) placeholder is excluded), so it is
    // correct both after a full loadBacklog render and after an optimistic
    // drag-drop move. Shared by loadBacklog and the drop handler (DRY).
    function recomputeBacklogCounts() {
      const grid = document.getElementById('kanban-grid');
      if (!grid) return;
      const totalEl = document.getElementById('backlog-total');
      let total = 0;
      for (const status of BACKLOG_COLUMNS) {
        const list = grid.querySelector('[data-kanban-list="' + status + '"]');
        const count = grid.querySelector('[data-kanban-count="' + status + '"]');
        const n = list ? list.querySelectorAll('.kanban-card').length : 0;
        if (count) count.textContent = String(n);
        total += n;
      }
      if (totalEl) totalEl.textContent = total === 0 ? 'empty' : '· ' + total;
    }

    // Keep a list's empty-state placeholder in sync: add the (empty) marker
    // when it has no cards, remove it the moment a card lands. Markup matches
    // loadBacklog's exact empty node so renders + moves stay visually identical.
    function syncBacklogPlaceholder(list) {
      if (!list) return;
      const hasCards = list.querySelector('.kanban-card') !== null;
      const placeholder = list.querySelector('.kanban-empty');
      if (hasCards) {
        if (placeholder) placeholder.remove();
      } else if (!placeholder) {
        list.appendChild(makeEl('li', { cls: 'kanban-empty', text: '(empty)' }));
      }
    }

    function backlogError(msg) {
      // Reuse the existing toast surface for inline error feedback (no alert()).
      toast(msg, 'err');
    }

    async function loadBacklog() {
      const grid = document.getElementById('kanban-grid');
      if (!grid) return;
      const totalEl = document.getElementById('backlog-total');
      const projectEl = document.getElementById('backlog-project');
      const r = await jsonFetch('/api/backlog');
      if (!r.ok || !r.body || r.body.ok !== true) {
        if (totalEl) totalEl.textContent = '(error)';
        return;
      }
      const cols = r.body.columns || {};
      for (const status of BACKLOG_COLUMNS) {
        const list = grid.querySelector('[data-kanban-list="' + status + '"]');
        const rows = Array.isArray(cols[status]) ? cols[status] : [];
        if (list) {
          list.replaceChildren();
          if (rows.length === 0) {
            list.appendChild(makeEl('li', { cls: 'kanban-empty', text: '(empty)' }));
          } else {
            for (const row of rows) list.appendChild(renderBacklogCard(row));
          }
        }
      }
      recomputeBacklogCounts();
      if (projectEl && r.body.project_id) projectEl.textContent = String(r.body.project_id);
    }

    // ── Drag-drop persistence (Phase 1) ───────────────────────────────────
    // Bound ONCE on the grid root via event delegation so it survives every
    // loadBacklog() replaceChildren re-render. Dropping a card on a different
    // column optimistically moves the DOM, recomputes counts, then PATCHes
    // /api/backlog/:id; a failed PATCH reverts the move + counts.
    function initBacklogDnD() {
      const grid = document.getElementById('kanban-grid');
      if (!grid || grid.dataset.dndBound === '1') return;
      grid.dataset.dndBound = '1';

      grid.addEventListener('dragstart', (ev) => {
        const card = ev.target && ev.target.closest ? ev.target.closest('.kanban-card') : null;
        if (!card) return;
        card.classList.add('dragging');
        if (ev.dataTransfer) {
          ev.dataTransfer.effectAllowed = 'move';
          ev.dataTransfer.setData('text/plain', card.dataset.id || '');
        }
      });

      grid.addEventListener('dragend', (ev) => {
        const card = ev.target && ev.target.closest ? ev.target.closest('.kanban-card') : null;
        if (card) card.classList.remove('dragging');
      });

      grid.addEventListener('dragover', (ev) => {
        const list = ev.target && ev.target.closest ? ev.target.closest('[data-kanban-list]') : null;
        if (!list) return;
        ev.preventDefault();
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
        list.classList.add('drag-over');
      });

      grid.addEventListener('dragleave', (ev) => {
        const list = ev.target && ev.target.closest ? ev.target.closest('[data-kanban-list]') : null;
        if (!list) return;
        // Only clear when the pointer actually left the list subtree (dragleave
        // also fires when moving onto a child node).
        if (!list.contains(ev.relatedTarget)) list.classList.remove('drag-over');
      });

      grid.addEventListener('drop', async (ev) => {
        const list = ev.target && ev.target.closest ? ev.target.closest('[data-kanban-list]') : null;
        if (!list) return;
        ev.preventDefault();
        list.classList.remove('drag-over');

        const targetStatus = list.dataset.kanbanList;
        const id = ev.dataTransfer ? ev.dataTransfer.getData('text/plain') : '';
        const card = id
          ? grid.querySelector('.kanban-card[data-id="' + id + '"]')
          : grid.querySelector('.kanban-card.dragging');
        if (!card || !targetStatus) return;

        const fromStatus = card.dataset.status;
        if (fromStatus === targetStatus) return; // no-op: same column

        const sourceList = grid.querySelector('[data-kanban-list="' + fromStatus + '"]');
        const nextSibling = card.nextSibling; // for precise revert positioning

        // Optimistic move: relocate the card, fix both placeholders + counts.
        list.appendChild(card);
        card.dataset.status = targetStatus;
        syncBacklogPlaceholder(list);
        syncBacklogPlaceholder(sourceList);
        recomputeBacklogCounts();

        const r = await jsonFetch('/api/backlog/' + id, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: targetStatus }),
        });

        if (!r.ok || !r.body || r.body.ok !== true) {
          // Revert: put the card back exactly where it was, restore counts.
          if (sourceList) {
            if (nextSibling && nextSibling.parentNode === sourceList) {
              sourceList.insertBefore(card, nextSibling);
            } else {
              sourceList.appendChild(card);
            }
          }
          card.dataset.status = fromStatus;
          syncBacklogPlaceholder(sourceList);
          syncBacklogPlaceholder(list);
          recomputeBacklogCounts();
          const reason = (r.body && r.body.reason) || r.status;
          backlogError('move failed: ' + reason);
        }
      });
    }

    function renderCard(row) {
      const card = makeEl('div', { cls: 'card' });

      const head = makeEl('div');
      const idSpan = makeEl('span', { cls: 'id', text: '#' + row.id });
      head.appendChild(idSpan);
      head.appendChild(document.createTextNode(' · ' + (row.project_id ?? '') + ' · skill ' + row.source_skill_id));
      card.appendChild(head);

      const ratio = (Number(row.success_rate_at_propose) * 100).toFixed(0);
      let metaText = 'freq ' + row.frequency_at_propose +
        ' · sr ' + ratio + '%' +
        ' · age ' + row.age_days_at_propose + 'd';
      if (row.cross_project_verdict) metaText += ' · verdict ' + row.cross_project_verdict;
      card.appendChild(makeEl('div', { cls: 'meta', text: metaText }));

      if (row.proposed_global_rationale) {
        card.appendChild(makeEl('div', { cls: 'rationale', text: row.proposed_global_rationale }));
      }

      const actionDefs = [];
      if (row.state === 'proposed') {
        actionDefs.push({ label: 'compose', cls: 'compose', action: 'compose' });
        actionDefs.push({ label: 'reject', cls: 'reject', action: 'reject' });
      } else if (row.state === 'composed') {
        actionDefs.push({ label: 'confirm promote', cls: 'confirm', action: 'confirm' });
        actionDefs.push({ label: 'reject', cls: 'reject', action: 'reject' });
      }
      if (actionDefs.length) {
        const actions = makeEl('div', { cls: 'actions' });
        for (const def of actionDefs) {
          const btn = makeEl('button', { cls: def.cls, text: def.label });
          btn.dataset.action = def.action;
          btn.addEventListener('click', () => handleAction(row, def.action));
          actions.appendChild(btn);
        }
        card.appendChild(actions);
      }
      return card;
    }

    async function loadGraduations() {
      const r = await jsonFetch('/api/graduations?k=50');
      if (!r.ok) { toast('failed to load: ' + (r.body.reason || r.status), 'err'); return; }
      const byState = { proposed: [], composed: [], approved: [], rejected: [] };
      for (const row of (r.body.results || [])) {
        if (byState[row.state]) byState[row.state].push(row);
      }
      for (const s of STATES) {
        const lane = $('[data-cards="' + s + '"]');
        while (lane.firstChild) lane.removeChild(lane.firstChild);
        $('[data-count="' + s + '"]').textContent = String(byState[s].length);
        if (!byState[s].length) {
          lane.appendChild(makeEl('div', { cls: 'empty', text: 'no candidates' }));
          continue;
        }
        for (const row of byState[s]) lane.appendChild(renderCard(row));
      }
    }

    async function handleAction(row, action) {
      if (action === 'confirm') {
        if (!confirm('Promote #' + row.id + ' to GLOBAL? This mints an is_global=true row.')) return;
        const r = await jsonFetch('/api/graduations/' + row.id + '/confirm', { method: 'POST' });
        toast(r.ok ? 'promoted #' + row.id : 'failed: ' + (r.body.reason || r.status), r.ok ? 'ok' : 'err');
        loadGraduations();
      } else if (action === 'reject') {
        const dlg = $('#rejectDialog');
        dlg.querySelector('[name=graduation_id]').value = String(row.id);
        dlg.showModal();
      } else if (action === 'compose') {
        const dlg = $('#composeDialog');
        dlg.querySelector('[name=graduation_id]').value = String(row.id);
        dlg.showModal();
      }
    }

    $$('button[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));

    $('#composeForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const id = fd.get('graduation_id');
      const body = {
        verdict: fd.get('verdict'),
        evidence: fd.get('evidence'),
        global_rationale: fd.get('global_rationale') || null,
        model: fd.get('model'),
      };
      const r = await jsonFetch('/api/graduations/' + id + '/compose', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      toast(r.ok ? 'composed #' + id : 'failed: ' + (r.body.reason || r.status), r.ok ? 'ok' : 'err');
      $('#composeDialog').close();
      loadGraduations();
    });

    $('#rejectForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const id = fd.get('graduation_id');
      const body = { reason: fd.get('reason') };
      const r = await jsonFetch('/api/graduations/' + id + '/reject', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      toast(r.ok ? 'rejected #' + id : 'failed: ' + (r.body.reason || r.status), r.ok ? 'ok' : 'err');
      $('#rejectDialog').close();
      loadGraduations();
    });

    $('#refresh').addEventListener('click', () => { loadHealth(); loadGraduations(); loadBudget(); loadBacklog(); });
    const backlogReloadBtn = document.getElementById('backlog-reload');
    if (backlogReloadBtn) backlogReloadBtn.addEventListener('click', loadBacklog);

    loadHealth();
    loadGraduations();
    loadBudget();
    initBacklogDnD();
    loadBacklog();
    /* auto-refresh interval is now driven by Settings (see initSettings) */
    // Expose loadBudget so the Settings polling loop (initSettings/applyAutoRefresh)
    // can include it in the tick set without re-declaring the IIFE scope.
    window.SCM_LOAD_BUDGET = loadBudget;

    // ─── Knowledge Graph Panel (M8.1 Phase 2) ────────────────────────────
    // Interactive 2.5D viewport: live force-directed sim, draggable nodes,
    // pan + wheel-zoom, radial-gradient glowing spheres, hover-dim adjacency.
    (function initGraphPanel() {
      const svg = document.getElementById('graph-svg');
      const stats = document.getElementById('g-stats');
      const detail = document.getElementById('graph-detail');
      const closeBtn = document.getElementById('gd-close');
      const reload = document.getElementById('g-reload');
      const nodeInput = document.getElementById('g-node-limit');
      const edgeInput = document.getElementById('g-edge-limit');
      const typeInput = document.getElementById('g-type-filter');
      const zoomIn = document.getElementById('g-zoom-in');
      const zoomOut = document.getElementById('g-zoom-out');
      const zoomFit = document.getElementById('g-zoom-fit');
      const hudZoom = document.getElementById('g-hud-zoom');
      const hudPan  = document.getElementById('g-hud-pan');
      const hudTemp = document.getElementById('g-hud-temp');
      // M8.3 — Cluster View controls. Absent in older index.html → graceful no-op.
      const clusterToggle = document.getElementById('g-cluster-toggle');
      const clusterBack   = document.getElementById('g-cluster-back');
      const clusterCrumb  = document.getElementById('g-cluster-crumb');
      if (!svg || !stats || !detail || !closeBtn || !reload || !nodeInput || !edgeInput || !typeInput) {
        return;
      }

      const SVG_NS = 'http://www.w3.org/2000/svg';
      const W = 1000, H = 600;
      const PAD = 30;
      const K_REP = 1800;
      const K_ATTR = 0.015;
      const K_CENTER = 0.006;
      const DAMPING = 0.78;
      const MIN_TEMP = 0.05;

      // SPHERE_PALETTE: highlight (top inner) · mid (sphere body) · rim (dark outer).
      // Each entry produces a radial gradient + matching aura color.
      // SUPER/COMMUNITY are M8.3 cluster-view-only node types.
      const SPHERE_PALETTE = {
        DECISION:  { hi: '#e8fcff', mid: '#00e0ff', lo: '#003644', aura: '#00e0ff' },
        PATTERN:   { hi: '#e8fff4', mid: '#36d399', lo: '#063826', aura: '#36d399' },
        ERROR:     { hi: '#ffe8eb', mid: '#ff5d6b', lo: '#3b0f15', aura: '#ff5d6b' },
        FILE:      { hi: '#fff3df', mid: '#f6ad55', lo: '#3b250a', aura: '#f6ad55' },
        NOTE:      { hi: '#f1e8ff', mid: '#a06bff', lo: '#1e1240', aura: '#a06bff' },
        SUPER:     { hi: '#fffae0', mid: '#ffd23a', lo: '#3f2d05', aura: '#ffd23a' },
        COMMUNITY: { hi: '#e6f0ff', mid: '#6aa9ff', lo: '#0c1d3a', aura: '#6aa9ff' },
      };

      function makeSvg(name, attrs) {
        const el = document.createElementNS(SVG_NS, name);
        if (attrs) {
          for (const k of Object.keys(attrs)) el.setAttribute(k, String(attrs[k]));
        }
        return el;
      }

      function truncate(s, n) {
        const str = String(s == null ? '' : s);
        if (str.length <= n) return str;
        return str.slice(0, n - 1) + '…';
      }

      function radiusForType(type, node) {
        // Cluster-view nodes scale with their member count (log2) so big
        // supernodes/communities visually dominate small ones.
        if (type === 'SUPER' || type === 'COMMUNITY') {
          const n = Math.max(1, Number((node && node.node_count) || 1));
          return Math.min(28, 10 + Math.log2(n) * 2.4);
        }
        if (type === 'DECISION') return 12;
        if (type === 'PATTERN')  return 11;
        if (type === 'ERROR')    return 11;
        if (type === 'FILE')     return 10;
        return 9;
      }

      function paletteFor(type) {
        return SPHERE_PALETTE[type] || SPHERE_PALETTE.NOTE;
      }

      function seededRand(seed) {
        let x = (Number(seed) * 9301 + 49297) % 233280;
        return function next() {
          x = (x * 9301 + 49297) % 233280;
          return x / 233280;
        };
      }

      // ── State ──────────────────────────────────────────────────────────
      let nodes = [];
      let edges = [];
      let nodeById = new Map();
      // adjacency: nodeId -> { edges:Set<edgeIdx>, neighbors:Set<nodeId> }
      let adjacency = new Map();

      let viewport = null;
      let edgesLayer = null;
      let nodesLayer = null;
      let bgRect = null;

      // viewport transform
      let tx = 0, ty = 0, scale = 1;

      // interaction
      let dragNode = null;
      let dragOffset = { x: 0, y: 0 };
      let isPanning = false;
      let panStart = null;

      // sim
      let temp = 1.0;
      let rafId = null;
      let lastFrame = 0;
      let energy = 1;
      let hoveredNodeId = null;
      const activePointers = new Map();

      function applyTransform() {
        if (viewport) viewport.setAttribute('transform', 'translate(' + tx + ' ' + ty + ') scale(' + scale + ')');
        if (hudZoom) hudZoom.textContent = scale.toFixed(2) + '×';
        if (hudPan)  hudPan.textContent  = Math.round(tx) + ',' + Math.round(ty);
      }

      // svg-viewBox coords for a client (mouse) point
      function clientToSvg(clientX, clientY) {
        const pt = svg.createSVGPoint ? svg.createSVGPoint() : null;
        const ctm = svg.getScreenCTM ? svg.getScreenCTM() : null;
        if (pt && ctm) {
          pt.x = clientX; pt.y = clientY;
          const inv = ctm.inverse();
          const sp = pt.matrixTransform(inv);
          return { x: sp.x, y: sp.y };
        }
        // fallback via bounding rect
        const rect = svg.getBoundingClientRect();
        return {
          x: (clientX - rect.left) * (W / rect.width),
          y: (clientY - rect.top)  * (H / rect.height),
        };
      }

      // content (inside-viewport) coords for a client point
      function clientToContent(clientX, clientY) {
        const p = clientToSvg(clientX, clientY);
        return { x: (p.x - tx) / scale, y: (p.y - ty) / scale };
      }

      // ── Defs: one radial gradient per type, plus shared filters ───────
      function buildDefs() {
        const defs = makeSvg('defs');

        for (const t of Object.keys(SPHERE_PALETTE)) {
          const p = SPHERE_PALETTE[t];
          const grad = makeSvg('radialGradient', {
            id: 'sphereGrad-' + t,
            cx: '35%', cy: '30%', r: '70%',
          });
          grad.appendChild(makeSvg('stop', { offset: '0%',  'stop-color': p.hi,  'stop-opacity': '1' }));
          grad.appendChild(makeSvg('stop', { offset: '38%', 'stop-color': p.mid, 'stop-opacity': '1' }));
          grad.appendChild(makeSvg('stop', { offset: '100%','stop-color': p.lo,  'stop-opacity': '1' }));
          defs.appendChild(grad);

          const aura = makeSvg('radialGradient', {
            id: 'auraGrad-' + t,
            cx: '50%', cy: '50%', r: '50%',
          });
          aura.appendChild(makeSvg('stop', { offset: '0%',  'stop-color': p.aura, 'stop-opacity': '0.55' }));
          aura.appendChild(makeSvg('stop', { offset: '60%', 'stop-color': p.aura, 'stop-opacity': '0.10' }));
          aura.appendChild(makeSvg('stop', { offset: '100%','stop-color': p.aura, 'stop-opacity': '0' }));
          defs.appendChild(aura);
        }

        // glow filter for hovered nodes (not used universally to keep perf high)
        const glow = makeSvg('filter', {
          id: 'sphereGlow', x: '-50%', y: '-50%', width: '200%', height: '200%',
        });
        glow.appendChild(makeSvg('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: '2.5', result: 'blur' }));
        const merge = makeSvg('feMerge');
        merge.appendChild(makeSvg('feMergeNode', { in: 'blur' }));
        merge.appendChild(makeSvg('feMergeNode', { in: 'SourceGraphic' }));
        glow.appendChild(merge);
        defs.appendChild(glow);

        // soft starfield background — sparse dots
        const star = makeSvg('pattern', {
          id: 'starfield',
          x: '0', y: '0', width: '60', height: '60',
          patternUnits: 'userSpaceOnUse',
        });
        star.appendChild(makeSvg('rect', { width: '60', height: '60', fill: 'transparent' }));
        star.appendChild(makeSvg('circle', { cx: '12', cy: '18', r: '0.6', fill: 'rgba(255,255,255,0.18)' }));
        star.appendChild(makeSvg('circle', { cx: '44', cy: '38', r: '0.4', fill: 'rgba(0,224,255,0.25)' }));
        star.appendChild(makeSvg('circle', { cx: '28', cy: '52', r: '0.5', fill: 'rgba(160,107,255,0.20)' }));
        defs.appendChild(star);

        return defs;
      }

      // ── Detail panel ──────────────────────────────────────────────────
      function showDetail(node) {
        const lblEl  = document.getElementById('gd-label');
        const typeEl = document.getElementById('gd-type');
        const srcEl  = document.getElementById('gd-src');
        const propsEl= document.getElementById('gd-props');
        if (lblEl)  lblEl.textContent  = String(node.label == null ? '' : node.label);
        if (typeEl) typeEl.textContent = String(node.type  == null ? '' : node.type);
        if (srcEl)  srcEl.textContent  = node.source_chunk_id == null ? '—' : String(node.source_chunk_id);
        if (propsEl) {
          try { propsEl.textContent = JSON.stringify(node.properties || {}, null, 2); }
          catch (e) { propsEl.textContent = '{}'; }
        }
        detail.hidden = false;
      }

      // ── Initial seeded layout (warm start) ────────────────────────────
      function seedLayout(ns) {
        for (const node of ns) {
          const rng = seededRand(Number(node.id) || 1);
          node.x = PAD + rng() * (W - 2 * PAD);
          node.y = PAD + rng() * (H - 2 * PAD);
          node.vx = 0; node.vy = 0;
          node.fx = 0; node.fy = 0;
        }
      }

      // ── Force step ────────────────────────────────────────────────────
      function simStep() {
        const n = nodes.length;
        if (n === 0) return 0;

        for (const node of nodes) { node.fx = 0; node.fy = 0; }

        // O(n²) repulsion — fine up to ~200 nodes per frame.
        for (let i = 0; i < n; i++) {
          const a = nodes[i];
          for (let j = i + 1; j < n; j++) {
            const b = nodes[j];
            let dx = a.x - b.x;
            let dy = a.y - b.y;
            let d2 = dx * dx + dy * dy;
            if (d2 < 25) d2 = 25;
            const dist = Math.sqrt(d2);
            const f = K_REP / d2;
            const ux = dx / dist, uy = dy / dist;
            a.fx += ux * f; a.fy += uy * f;
            b.fx -= ux * f; b.fy -= uy * f;
          }
        }

        // Edge attraction.
        for (const e of edges) {
          const s = nodeById.get(e.source_id);
          const t = nodeById.get(e.target_id);
          if (!s || !t) continue;
          const dx = t.x - s.x;
          const dy = t.y - s.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const f = K_ATTR * dist;
          const ux = dx / dist, uy = dy / dist;
          s.fx += ux * f; s.fy += uy * f;
          t.fx -= ux * f; t.fy -= uy * f;
        }

        // Weak center gravity keeps the graph from drifting.
        for (const node of nodes) {
          node.fx += (W / 2 - node.x) * K_CENTER;
          node.fy += (H / 2 - node.y) * K_CENTER;
        }

        // Integrate (dragged node is pinned to pointer).
        let kinetic = 0;
        for (const node of nodes) {
          if (node === dragNode) { node.vx = 0; node.vy = 0; continue; }
          node.vx = (node.vx + node.fx) * DAMPING;
          node.vy = (node.vy + node.fy) * DAMPING;
          node.x += node.vx * temp;
          node.y += node.vy * temp;
          kinetic += node.vx * node.vx + node.vy * node.vy;
        }

        // Cool slowly.
        temp *= 0.992;
        if (temp < MIN_TEMP) temp = MIN_TEMP;

        return kinetic / Math.max(1, n);
      }

      function paint() {
        // Node groups
        for (const node of nodes) {
          if (node._group) {
            node._group.setAttribute('transform', 'translate(' + node.x + ' ' + node.y + ')');
          }
        }
        // Edges
        for (const e of edges) {
          const s = nodeById.get(e.source_id);
          const t = nodeById.get(e.target_id);
          if (!e._line || !s || !t) continue;
          e._line.setAttribute('x1', s.x); e._line.setAttribute('y1', s.y);
          e._line.setAttribute('x2', t.x); e._line.setAttribute('y2', t.y);
        }
      }

      function tick(ts) {
        const dt = ts - lastFrame; lastFrame = ts;
        // Run 1–2 sim sub-steps per frame to keep things lively.
        energy = simStep();
        if (dragNode) { temp = Math.max(temp, 0.6); }
        paint();
        if (hudTemp) hudTemp.textContent = temp.toFixed(2);

        // Keep RAF alive while interaction is happening or system is warm.
        const alive = dragNode || isPanning || temp > 0.08 || energy > 0.4;
        if (alive) {
          rafId = requestAnimationFrame(tick);
        } else {
          rafId = null;
        }
      }
      function kickSim() {
        if (rafId == null) {
          lastFrame = performance.now();
          rafId = requestAnimationFrame(tick);
        }
      }
      function reheat(amount) {
        temp = Math.max(temp, amount == null ? 0.7 : amount);
        kickSim();
      }

      // ── Hover-highlight (adjacency dim) ───────────────────────────────
      function setHover(nodeId) {
        if (hoveredNodeId === nodeId) return;
        // clear prior
        if (hoveredNodeId != null) {
          const prev = nodeById.get(hoveredNodeId);
          if (prev && prev._group) prev._group.classList.remove('is-hover');
          const adj = adjacency.get(hoveredNodeId);
          if (adj) {
            adj.neighbors.forEach((nid) => {
              const nb = nodeById.get(nid);
              if (nb && nb._group) nb._group.classList.remove('is-adjacent');
            });
            adj.edges.forEach((idx) => {
              const e = edges[idx];
              if (e && e._line) e._line.classList.remove('is-adjacent');
            });
          }
        }
        hoveredNodeId = nodeId;
        if (nodeId == null) {
          svg.classList.remove('is-hovering');
          return;
        }
        svg.classList.add('is-hovering');
        const cur = nodeById.get(nodeId);
        if (cur && cur._group) cur._group.classList.add('is-hover');
        const adj = adjacency.get(nodeId);
        if (adj) {
          adj.neighbors.forEach((nid) => {
            const nb = nodeById.get(nid);
            if (nb && nb._group) nb._group.classList.add('is-adjacent');
          });
          adj.edges.forEach((idx) => {
            const e = edges[idx];
            if (e && e._line) e._line.classList.add('is-adjacent');
          });
        }
      }

      // ── Build a single node group (aura + sphere + specular highlight) ─
      function buildNodeGroup(node) {
        const r = radiusForType(node.type, node);
        const g = makeSvg('g', {
          'class': 'node',
          'data-type': node.type == null ? '' : String(node.type),
          'data-id': String(node.id),
          transform: 'translate(' + node.x + ' ' + node.y + ')',
        });

        // Outer aura (large, soft).
        const aura = makeSvg('circle', {
          'class': 'node-aura',
          r: r * 2.6,
          fill: 'url(#auraGrad-' + (SPHERE_PALETTE[node.type] ? node.type : 'NOTE') + ')',
        });
        g.appendChild(aura);

        // Sphere body (radial gradient).
        const sphere = makeSvg('circle', {
          'class': 'node-sphere',
          'data-type': node.type == null ? '' : String(node.type),
          r: r,
          fill: 'url(#sphereGrad-' + (SPHERE_PALETTE[node.type] ? node.type : 'NOTE') + ')',
        });
        g.appendChild(sphere);

        // Subtle dark rim to deepen the sphere edge.
        const rim = makeSvg('circle', { 'class': 'node-rim', r: r });
        g.appendChild(rim);

        // Specular highlight — small white-ish ellipse top-left.
        const spec = makeSvg('ellipse', {
          'class': 'node-spec',
          cx: -r * 0.32, cy: -r * 0.42,
          rx: r * 0.38,  ry: r * 0.22,
        });
        g.appendChild(spec);

        // Label.
        const lbl = makeSvg('text', {
          'class': 'node-label',
          dy: -(r + 6),
          'text-anchor': 'middle',
        });
        lbl.textContent = truncate(node.label, 24);
        g.appendChild(lbl);

        // Invisible hit target — slightly larger than sphere for easier grabbing.
        const hit = makeSvg('circle', { 'class': 'node-hit', r: r + 4 });
        g.appendChild(hit);

        node._group = g;
        node._radius = r;

        // ── Interactions ────────────────────────────────────────────────
        g.addEventListener('pointerenter', function () { setHover(node.id); });
        g.addEventListener('pointerleave', function () { setHover(null); });

        g.addEventListener('pointerdown', function (ev) {
          ev.stopPropagation();
          if (ev.button !== 0 && ev.pointerType === 'mouse') return;
          dragNode = node;
          const p = clientToContent(ev.clientX, ev.clientY);
          dragOffset.x = p.x - node.x;
          dragOffset.y = p.y - node.y;
          g.classList.add('is-dragging');
          svg.classList.add('is-dragging');
          try { g.setPointerCapture(ev.pointerId); } catch (e) {}
          activePointers.set(ev.pointerId, 'drag');
          reheat(0.8);
        });

        g.addEventListener('pointermove', function (ev) {
          if (dragNode !== node) return;
          ev.preventDefault();
          const p = clientToContent(ev.clientX, ev.clientY);
          node.x = p.x - dragOffset.x;
          node.y = p.y - dragOffset.y;
          // Soft bounds — but allow some drift past edges so dragging feels free.
          if (node.x < -W * 0.2) node.x = -W * 0.2;
          if (node.x > W * 1.2)  node.x = W * 1.2;
          if (node.y < -H * 0.2) node.y = -H * 0.2;
          if (node.y > H * 1.2)  node.y = H * 1.2;
          reheat(0.6);
        });

        function endDrag(ev) {
          if (dragNode === node) {
            dragNode = null;
            g.classList.remove('is-dragging');
            svg.classList.remove('is-dragging');
            try { g.releasePointerCapture(ev.pointerId); } catch (e) {}
            activePointers.delete(ev.pointerId);
            reheat(0.4);
          }
        }
        g.addEventListener('pointerup', endDrag);
        g.addEventListener('pointercancel', endDrag);

        // Click → detail (suppressed during real drag).
        let downAt = null;
        g.addEventListener('pointerdown', function (ev) { downAt = { x: ev.clientX, y: ev.clientY }; });
        g.addEventListener('pointerup', function (ev) {
          if (!downAt) return;
          const dx = ev.clientX - downAt.x, dy = ev.clientY - downAt.y;
          downAt = null;
          if (dx * dx + dy * dy < 25) handleNodeClick(node);
        });

        return g;
      }

      // ── Render entire graph ───────────────────────────────────────────
      function render(graph) {
        // tear down
        if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
        while (svg.firstChild) svg.removeChild(svg.firstChild);
        hoveredNodeId = null;
        svg.classList.remove('is-hovering');

        nodes = Array.isArray(graph.nodes) ? graph.nodes.slice() : [];
        edges = Array.isArray(graph.edges) ? graph.edges.slice() : [];
        nodeById = new Map();
        for (const nn of nodes) nodeById.set(nn.id, nn);

        // adjacency
        adjacency = new Map();
        for (const nn of nodes) adjacency.set(nn.id, { edges: new Set(), neighbors: new Set() });
        for (let i = 0; i < edges.length; i++) {
          const e = edges[i];
          const sa = adjacency.get(e.source_id);
          const ta = adjacency.get(e.target_id);
          if (sa) { sa.edges.add(i); sa.neighbors.add(e.target_id); }
          if (ta) { ta.edges.add(i); ta.neighbors.add(e.source_id); }
        }

        // defs
        svg.appendChild(buildDefs());

        // starfield backdrop sits BELOW the viewport so it doesn't pan
        svg.appendChild(makeSvg('rect', {
          x: 0, y: 0, width: W, height: H,
          fill: 'url(#starfield)',
          'pointer-events': 'none',
        }));

        // hit-target for pan
        bgRect = makeSvg('rect', { id: 'graph-bg', x: 0, y: 0, width: W, height: H });
        svg.appendChild(bgRect);

        // viewport <g> — everything zoom/panned lives here.
        viewport = makeSvg('g', { id: 'graph-viewport' });
        svg.appendChild(viewport);

        edgesLayer = makeSvg('g', { 'class': 'edges-layer' });
        nodesLayer = makeSvg('g', { 'class': 'nodes-layer' });
        viewport.appendChild(edgesLayer);
        viewport.appendChild(nodesLayer);

        // Seed positions (warm start).
        seedLayout(nodes);

        // Edges (lines first so they render below nodes).
        for (let i = 0; i < edges.length; i++) {
          const e = edges[i];
          const s = nodeById.get(e.source_id);
          const t = nodeById.get(e.target_id);
          if (!s || !t) { e._line = null; continue; }
          const line = makeSvg('line', {
            x1: s.x, y1: s.y, x2: t.x, y2: t.y,
            'class': 'edge-line',
            'data-relation': e.relation == null ? '' : String(e.relation),
          });
          e._line = line;
          edgesLayer.appendChild(line);
        }

        // Node groups.
        for (const n of nodes) nodesLayer.appendChild(buildNodeGroup(n));

        // Reset view + kick sim.
        tx = 0; ty = 0; scale = 1;
        applyTransform();
        temp = 1.0;
        kickSim();
      }

      // ── Pan / zoom on the SVG canvas ───────────────────────────────────
      svg.addEventListener('pointerdown', function (ev) {
        // Only start a pan when the press lands on the background, not a node.
        if (dragNode) return;
        const target = ev.target;
        const onNode = target && (target.closest && target.closest('.node'));
        if (onNode) return;
        isPanning = true;
        svg.classList.add('is-panning');
        panStart = { x: ev.clientX, y: ev.clientY, tx: tx, ty: ty };
        try { svg.setPointerCapture(ev.pointerId); } catch (e) {}
        activePointers.set(ev.pointerId, 'pan');
        kickSim();
      });
      svg.addEventListener('pointermove', function (ev) {
        if (!isPanning || !panStart) return;
        const rect = svg.getBoundingClientRect();
        const sx = W / rect.width;
        const sy = H / rect.height;
        tx = panStart.tx + (ev.clientX - panStart.x) * sx;
        ty = panStart.ty + (ev.clientY - panStart.y) * sy;
        applyTransform();
      });
      function endPan(ev) {
        if (!isPanning) return;
        isPanning = false;
        svg.classList.remove('is-panning');
        try { svg.releasePointerCapture(ev.pointerId); } catch (e) {}
        activePointers.delete(ev.pointerId);
      }
      svg.addEventListener('pointerup',     endPan);
      svg.addEventListener('pointercancel', endPan);
      svg.addEventListener('pointerleave',  endPan);

      // Wheel zoom anchored at cursor.
      svg.addEventListener('wheel', function (ev) {
        ev.preventDefault();
        const p = clientToSvg(ev.clientX, ev.clientY);
        const dir = ev.deltaY < 0 ? 1 : -1;
        const factor = Math.exp(dir * 0.12);
        const newScale = Math.min(4, Math.max(0.25, scale * factor));
        const real = newScale / scale;
        tx = p.x - (p.x - tx) * real;
        ty = p.y - (p.y - ty) * real;
        scale = newScale;
        applyTransform();
      }, { passive: false });

      // Zoom buttons.
      function zoomBy(factor) {
        const p = { x: W / 2, y: H / 2 };
        const newScale = Math.min(4, Math.max(0.25, scale * factor));
        const real = newScale / scale;
        tx = p.x - (p.x - tx) * real;
        ty = p.y - (p.y - ty) * real;
        scale = newScale;
        applyTransform();
      }
      if (zoomIn)  zoomIn.addEventListener('click',  function () { zoomBy(1.2); });
      if (zoomOut) zoomOut.addEventListener('click', function () { zoomBy(1 / 1.2); });
      if (zoomFit) zoomFit.addEventListener('click', function () {
        tx = 0; ty = 0; scale = 1; applyTransform();
        reheat(0.6);
      });

      closeBtn.addEventListener('click', function () { detail.hidden = true; });

      // ── Cluster View state (M8.3) ──────────────────────────────────────
      // viewMode: 'kg' (default, existing /api/graph) | 'super' | 'drill'
      // currentSupernodeId: int when viewMode==='drill', null otherwise.
      // The cluster routes return string IDs ("S:N", "N:M", "S:N:C:K") and
      // edge {source,target} fields — we shim them into the kg renderer's
      // {nodes:[{id,label,type,...}], edges:[{source_id,target_id,...}]}
      // contract so the same render() pipeline drives both views.
      let viewMode = 'kg';
      let currentSupernodeId = null;

      function transformClusterPayload(payload) {
        const lvl = payload && payload.level;
        const mode = payload && payload.mode;
        const rawNodes = Array.isArray(payload && payload.nodes) ? payload.nodes : [];
        const rawEdges = Array.isArray(payload && payload.edges) ? payload.edges : [];
        const nodes = rawNodes.map((n) => {
          if (lvl === 'super') {
            return {
              id: n.id, label: n.label, type: 'SUPER',
              node_count: n.node_count,
              supernode_id: n.supernode_id,
              properties: { supernode_id: n.supernode_id, node_count: n.node_count },
            };
          }
          if (mode === 'community-nested') {
            return {
              id: n.id, label: n.label, type: 'COMMUNITY',
              node_count: n.node_count,
              supernode_id: n.supernode_id,
              community_id: n.community_id,
              properties: { community_id: n.community_id, node_count: n.node_count },
            };
          }
          // members: pass through with the real kg type and id mapping.
          return {
            id: n.id, label: n.label, type: n.type,
            node_id: n.node_id,
            community_id: n.community_id,
            properties: { community_id: n.community_id, node_id: n.node_id },
          };
        });
        const edges = rawEdges.map((e, i) => ({
          id: i,
          source_id: e.source, target_id: e.target,
          weight: e.weight, relation: e.relation,
        }));
        return { nodes, edges, stats: { node_count: nodes.length, edge_count: edges.length } };
      }

      function updateClusterChrome() {
        if (!clusterCrumb) return;
        if (viewMode === 'kg') {
          clusterCrumb.textContent = 'KG';
          clusterCrumb.dataset.view = 'kg';
          if (clusterToggle) {
            clusterToggle.dataset.mode = 'kg';
            clusterToggle.textContent = 'Cluster View';
          }
          if (clusterBack) clusterBack.hidden = true;
        } else if (viewMode === 'super') {
          clusterCrumb.textContent = 'Super Nodes';
          clusterCrumb.dataset.view = 'super';
          if (clusterToggle) {
            clusterToggle.dataset.mode = 'super';
            clusterToggle.textContent = 'Back to KG';
          }
          if (clusterBack) clusterBack.hidden = true;
        } else if (viewMode === 'drill') {
          clusterCrumb.textContent = 'Super #' + String(currentSupernodeId) + ' · members';
          clusterCrumb.dataset.view = 'drill';
          if (clusterToggle) {
            clusterToggle.dataset.mode = 'drill';
            clusterToggle.textContent = 'Back to KG';
          }
          if (clusterBack) clusterBack.hidden = false;
        }
      }

      function setClusterMode(next, opts) {
        viewMode = next;
        currentSupernodeId = (opts && Object.prototype.hasOwnProperty.call(opts, 'supernodeId'))
          ? opts.supernodeId : null;
        const inputsDisabled = (next !== 'kg');
        nodeInput.disabled = inputsDisabled;
        edgeInput.disabled = inputsDisabled;
        typeInput.disabled = inputsDisabled;
        updateClusterChrome();
        loadGraph();
      }

      // Cluster-aware click: in super mode, clicking a SUPER node drills into
      // it; otherwise (and in kg/drill modes) defer to the standard detail
      // panel via showDetail(node).
      function handleNodeClick(node) {
        if (viewMode === 'super' && node && node.type === 'SUPER' && node.supernode_id != null) {
          setClusterMode('drill', { supernodeId: Number(node.supernode_id) });
          return;
        }
        showDetail(node);
      }

      // ── Loader ─────────────────────────────────────────────────────────
      async function loadGraph() {
        stats.textContent = 'Loading…';
        try {
          let body;
          if (viewMode === 'kg') {
            const params = new URLSearchParams();
            params.set('node_limit', String(nodeInput.value));
            params.set('edge_limit', String(edgeInput.value));
            const t = String(typeInput.value || '').trim();
            if (t) params.set('type', t);
            const r = await jsonFetch('/api/graph?' + params.toString());
            body = r.body || {};
            if (!r.ok || body.ok === false) {
              stats.textContent = 'Error: ' + (body.reason || r.status);
              return;
            }
          } else {
            const params = new URLSearchParams();
            params.set('level', viewMode === 'drill' ? 'drill' : 'super');
            if (viewMode === 'drill' && currentSupernodeId != null) {
              params.set('supernode_id', String(currentSupernodeId));
            }
            const r = await jsonFetch('/api/graph/clusters?' + params.toString());
            const payload = r.body || {};
            if (!r.ok || payload.ok === false) {
              stats.textContent = 'Error: ' + (payload.reason || r.status);
              return;
            }
            body = transformClusterPayload(payload);
            if (viewMode === 'drill' && payload.mode === 'community-nested') {
              stats.textContent = body.nodes.length + ' communities · nested view';
            }
          }
          const s = body.stats || { node_count: 0, edge_count: 0 };
          if (!(viewMode === 'drill' && body.stats && body.nodes.some((n) => n.type === 'COMMUNITY'))) {
            stats.textContent = s.node_count + ' nodes · ' + s.edge_count + ' edges';
          }
          render(body);
        } catch (err) {
          stats.textContent = 'Error: ' + String(err);
        }
      }

      reload.addEventListener('click', loadGraph);
      if (clusterToggle) {
        clusterToggle.addEventListener('click', function () {
          setClusterMode(viewMode === 'kg' ? 'super' : 'kg');
        });
      }
      if (clusterBack) {
        clusterBack.addEventListener('click', function () { setClusterMode('super'); });
      }
      updateClusterChrome();
      loadGraph();
    })();

// ─── Header live clock + lane-count mirror ────────────────────────────
(function liveChrome() {
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function tzAbbrev() {
    try {
      const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(new Date());
      const tz = parts.find(p => p.type === 'timeZoneName');
      return tz ? tz.value : '';
    } catch (e) { return ''; }
  }
  function tick() {
    const tz = (window.SCM_SETTINGS && window.SCM_SETTINGS.timezone) || 'local';
    const d = new Date();
    let text;
    if (tz === 'utc') {
      text = pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + ' UTC';
    } else {
      const abbr = tzAbbrev();
      text = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + (abbr ? ' ' + abbr : '');
    }
    const labelEl = document.getElementById('tele-tz-label');
    if (labelEl) labelEl.textContent = tz === 'utc' ? 'utc' : 'local';
    const el = document.getElementById('tele-utc');
    if (el) el.textContent = text;
  }
  window.__scmClockTick = tick;
  tick();
  setInterval(tick, 1000);

  // Mirror lane counts → header telemetry.
  const mirror = { proposed: 'tele-proposed', composed: 'tele-composed', approved: 'tele-approved', rejected: 'tele-rejected' };
  const observer = new MutationObserver(() => {
    for (const s of Object.keys(mirror)) {
      const src = document.querySelector('[data-count="' + s + '"]');
      const dst = document.getElementById(mirror[s]);
      if (src && dst) dst.textContent = src.textContent || '·';
    }
  });
  document.addEventListener('DOMContentLoaded', () => {
    for (const s of Object.keys(mirror)) {
      const src = document.querySelector('[data-count="' + s + '"]');
      if (src) observer.observe(src, { childList: true, characterData: true, subtree: true });
    }
  });
})();


// ─── Settings · localStorage-persisted preferences ───────────────────
(function initSettings() {
  const KEY = 'scm.settings';
  const DEFAULTS = {
    timezone:     'local',   // 'local' | 'utc'
    autoRefresh:  '30s',     // 'off' | '1s' | '5s' | '10s' | '15s' | '30s' | '1m' | '5m'
    nodeSize:     1.0,       // 0.5 .. 1.8
    edgeOpacity:  1.0,       // 0.05 .. 1
    glow:         1.0,       // 0 .. 2
  };
  const REFRESH_MS = {
    'off': 0, '1s': 1000, '5s': 5000, '10s': 10000,
    '15s': 15000, '30s': 30000, '1m': 60000, '5m': 300000,
  };

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return Object.assign({}, DEFAULTS);
      const parsed = JSON.parse(raw);
      return Object.assign({}, DEFAULTS, parsed);
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  }
  function save(s) {
    try { localStorage.setItem(KEY, JSON.stringify(s)); }
    catch (e) { /* quota, private mode, etc */ }
  }

  const settings = load();
  window.SCM_SETTINGS = settings;

  // ── Apply functions ───────────────────────────────────────────────
  let refreshTimer = null;
  function applyAutoRefresh() {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    const ms = REFRESH_MS[settings.autoRefresh] || 0;
    if (ms > 0 && typeof loadHealth === 'function' && typeof loadGraduations === 'function') {
      refreshTimer = setInterval(() => { loadHealth(); loadGraduations(); }, ms);
    }
  }
  function applyVisuals() {
    const root = document.documentElement;
    root.style.setProperty('--ui-node-scale',   String(settings.nodeSize));
    root.style.setProperty('--ui-edge-opacity', String(settings.edgeOpacity));
    root.style.setProperty('--ui-glow',         String(settings.glow));
  }
  function applyClock() {
    if (typeof window.__scmClockTick === 'function') window.__scmClockTick();
  }
  function applyAll() {
    applyVisuals();
    applyClock();
    applyAutoRefresh();
  }

  // ── DOM wiring ────────────────────────────────────────────────────
  function setRangeFill(input) {
    const min = Number(input.min), max = Number(input.max), v = Number(input.value);
    const pct = ((v - min) / (max - min)) * 100;
    input.style.setProperty('--pct', pct + '%');
  }
  function fmtNodeSize(v)    { return Number(v).toFixed(2) + '×'; }
  function fmtEdgeOpacity(v) { return Number(v).toFixed(2); }
  function fmtGlow(v)        { return Number(v).toFixed(2) + '×'; }

  function syncUiFromSettings() {
    // Time zone segmented buttons
    document.querySelectorAll('[data-set="timezone"]').forEach((btn) => {
      btn.setAttribute('aria-pressed', btn.dataset.value === settings.timezone ? 'true' : 'false');
    });
    // Auto-refresh select
    const refreshSel = document.getElementById('set-refresh');
    if (refreshSel) refreshSel.value = settings.autoRefresh;
    // Sliders
    const ns = document.getElementById('set-node-size');
    if (ns) { ns.value = String(settings.nodeSize); setRangeFill(ns);
      const o = document.getElementById('out-node-size'); if (o) o.textContent = fmtNodeSize(ns.value); }
    const eo = document.getElementById('set-edge-opacity');
    if (eo) { eo.value = String(settings.edgeOpacity); setRangeFill(eo);
      const o = document.getElementById('out-edge-opacity'); if (o) o.textContent = fmtEdgeOpacity(eo.value); }
    const gl = document.getElementById('set-glow');
    if (gl) { gl.value = String(settings.glow); setRangeFill(gl);
      const o = document.getElementById('out-glow'); if (o) o.textContent = fmtGlow(gl.value); }
  }

  // Time zone
  document.querySelectorAll('[data-set="timezone"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      settings.timezone = btn.dataset.value;
      save(settings);
      syncUiFromSettings();
      applyClock();
    });
  });

  // Auto-refresh
  const refreshSel = document.getElementById('set-refresh');
  if (refreshSel) {
    refreshSel.addEventListener('change', () => {
      settings.autoRefresh = refreshSel.value;
      save(settings);
      applyAutoRefresh();
    });
  }

  // Sliders — live update CSS vars
  function bindSlider(id, key, outId, fmt) {
    const input = document.getElementById(id);
    const out = document.getElementById(outId);
    if (!input) return;
    input.addEventListener('input', () => {
      settings[key] = Number(input.value);
      out && (out.textContent = fmt(input.value));
      setRangeFill(input);
      applyVisuals();
    });
    input.addEventListener('change', () => save(settings));
  }
  bindSlider('set-node-size',    'nodeSize',    'out-node-size',    fmtNodeSize);
  bindSlider('set-edge-opacity', 'edgeOpacity', 'out-edge-opacity', fmtEdgeOpacity);
  bindSlider('set-glow',         'glow',        'out-glow',         fmtGlow);

  // Reset
  const resetBtn = document.getElementById('set-reset');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      Object.assign(settings, DEFAULTS);
      save(settings);
      syncUiFromSettings();
      applyAll();
    });
  }

  // Drawer open / close
  const drawer   = document.getElementById('settings-drawer');
  const backdrop = document.getElementById('drawer-backdrop');
  const openBtn  = document.getElementById('settings-open');
  function openDrawer() {
    if (!drawer) return;
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    if (backdrop) backdrop.classList.add('open');
  }
  function closeDrawer() {
    if (!drawer) return;
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    if (backdrop) backdrop.classList.remove('open');
  }
  if (openBtn) openBtn.addEventListener('click', openDrawer);
  document.querySelectorAll('[data-settings-close]').forEach((el) => {
    el.addEventListener('click', closeDrawer);
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeDrawer();
  });

  // Boot
  syncUiFromSettings();
  applyAll();
})();
