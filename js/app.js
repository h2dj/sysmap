(() => {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // ---------------------------------------------------------------------
  // Small DOM/SVG helpers
  // ---------------------------------------------------------------------
  function svgEl(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    if (attrs) setAttrs(el, attrs);
    return el;
  }
  function setAttrs(el, attrs) {
    for (const k in attrs) {
      if (attrs[k] === undefined || attrs[k] === null) continue;
      el.setAttribute(k, attrs[k]);
    }
  }
  function uid() {
    return (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
  }
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  const FONT_STACK = '-apple-system, "Apple SD Gothic Neo", "Segoe UI", Roboto, sans-serif';
  const SHAPE_TOOLS = ['rect', 'circle', 'diamond', 'text', 'loop', 'bubble'];
  // 툴바가 아이콘만 남는 좁은 화면(css의 720px 분기와 동일 기준)을 "모바일"로 취급한다.
  function isMobileViewport() { return window.matchMedia('(max-width: 720px)').matches; }
  const NODE_DEFAULT_SIZES = { rect: [150, 90], circle: [110, 110], diamond: [140, 100], bubble: [180, 120] };
  const NODE_DEFAULT_LABELS = { rect: '시스템', circle: '사용자', diamond: '분기', text: '텍스트', loop: 'R1', bubble: '말풍선' };
  // 말풍선(주석용 회색 노드)은 사각형/원/마름모와 다른 기본 배색을 쓴다.
  function defaultFillStroke(shape) {
    if (shape === 'bubble') return { fill: cssVar('--bubble-fill') || '#e3e3e9', stroke: cssVar('--bubble-stroke') || '#8b8b96' };
    return { fill: cssVar('--node-fill') || '#eef2ff', stroke: cssVar('--node-stroke') || '#4f6df5' };
  }
  const LOOP_ICON = { R: '↻', B: '↺' };

  // 텍스트·루프 노드는 배경 도형이 없어 글자 크기에 딱 맞게 자동으로 커진다.
  const measureCtx = document.createElement('canvas').getContext('2d');
  function loopDisplayText(label, loopType) { return `${LOOP_ICON[loopType] || LOOP_ICON.R} ${label || ''}`; }
  function defaultNodeFontSize(shape) { return shape === 'loop' ? 15 : 13; }
  function measureNodeSize(shape, label, loopType, fontSize) {
    const isLoop = shape === 'loop';
    fontSize = fontSize || defaultNodeFontSize(shape);
    const fontWeight = isLoop ? 700 : 400;
    measureCtx.font = `${fontWeight} ${fontSize}px ${FONT_STACK}`;
    const display = isLoop ? loopDisplayText(label, loopType) : (label || '');
    const textW = measureCtx.measureText(display || ' ').width;
    const w = Math.max(30, Math.ceil(textW) + 20);
    const h = Math.ceil(fontSize * 1.5) + 16;
    return { w, h };
  }
  // 원형(archetype) 템플릿 배치용: 사각형·원·마름모 노드도 라벨 길이에 맞춰
  // 대략적인 크기를 미리 계산해, 긴 한글 라벨이라도 서로 겹치지 않게 배치한다.
  function autoNodeSize(shape, label) {
    if (shape === 'text' || shape === 'loop') return measureNodeSize(shape, label, 'R');
    measureCtx.font = `400 13px ${FONT_STACK}`;
    const textW = measureCtx.measureText(label || '').width;
    const w = clamp(Math.ceil(textW) + 56, 130, 230);
    const h = shape === 'circle' ? Math.max(96, Math.round(w * 0.62)) : 74;
    return { w, h };
  }

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  // 탭마다 지도 하나(state) + 화면(view) + 실행취소 이력(history)을 따로 가진다.
  // 현재 활성 탭의 값은 아래 state/view/history/historyIndex 변수에 "풀어서" 담아두고,
  // 다른 탭으로 전환하기 직전에만 flushActiveTab()으로 tabs[] 배열에 도로 저장한다 —
  // 매번 tabs 배열을 통해 간접 참조하지 않아도 기존의 모든 편집 로직이 그대로 동작한다.
  let state = { title: '새 시스템 지도', nodes: [], edges: [] };
  const view = { x: 0, y: 0, scale: 1 };
  let tool = 'select';
  let selection = { type: null, id: null };
  // 다중 선택: Shift+클릭으로 항목을 하나씩 추가/제거하거나, Shift+드래그로
  // 사각 영역(마퀴)을 그려 한꺼번에 담는다. 2개 이상일 때만 활성 상태로 취급하고
  // (1개로 줄면 기존 단일 선택 흐름으로 되돌아감) — {type,id} 객체 배열.
  let multiSelection = [];
  let connectPendingId = null;
  let history = [];
  let historyIndex = -1;
  let autosaveTimer = null;

  // ---- 탭 -----------------------------------------------------------------------------------
  let tabs = [];
  let activeTabId = null;

  const STORAGE_KEY = 'sysmap.tabs.v1';
  const LEGACY_STORAGE_KEY = 'sysmap.autosave.v1';
  const THEME_KEY = 'sysmap.theme';
  const DEFAULT_MAP_TITLE = '새 시스템 지도';

  // ---------------------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------------------
  const canvas = document.getElementById('canvas');
  const viewport = document.getElementById('viewport');
  const edgesLayer = document.getElementById('edgesLayer');
  const nodesLayer = document.getElementById('nodesLayer');
  const overlayLayer = document.getElementById('overlayLayer');
  const canvasWrap = document.getElementById('canvasWrap');
  const emptyHint = document.getElementById('emptyHint');
  const zoomLabel = document.getElementById('zoomLabel');
  const hintEl = document.getElementById('hint');
  const countsEl = document.getElementById('counts');
  const mapTitleInput = document.getElementById('mapTitle');
  const tabBarEl = document.getElementById('tabbar');
  const propsPanel = document.getElementById('propsPanel');
  const panelBody = document.getElementById('panelBody');
  const panelTitle = document.getElementById('panelTitle');

  // ===========================================================================================
  // Geometry helpers
  // ===========================================================================================
  function nodeCenter(n) { return { x: n.x + n.w / 2, y: n.y + n.h / 2 }; }

  function boundaryPoint(node, towardX, towardY) {
    const c = nodeCenter(node);
    let dx = towardX - c.x, dy = towardY - c.y;
    if (dx === 0 && dy === 0) dx = 1;
    const hw = node.w / 2, hh = node.h / 2;
    let t;
    if (node.shape === 'circle' || node.shape === 'bubble') {
      t = 1 / Math.sqrt((dx / hw) ** 2 + (dy / hh) ** 2);
    } else if (node.shape === 'diamond') {
      t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
    } else {
      t = 1 / Math.max(Math.abs(dx) / hw, Math.abs(dy) / hh);
    }
    t = Math.max(t, 0);
    return { x: c.x + dx * t, y: c.y + dy * t };
  }

  // 두 노드를 잇는 곡선(2차 베지어) 앵커점 계산: 경계 접점 p1/p2, 제어점 ctrl,
  // 접선 방향(ux,uy), 수직 방향(px,py — 곡률·지연 표시·극성 표시 오프셋에 사용).
  function edgeAnchorPoints(edge, from, to) {
    const cFrom = nodeCenter(from), cTo = nodeCenter(to);
    const dxC = cTo.x - cFrom.x, dyC = cTo.y - cFrom.y;
    const lenC = Math.hypot(dxC, dyC) || 1;
    const uxC = dxC / lenC, uyC = dyC / lenC;
    const pxC = -uyC, pyC = uxC;
    const midC = { x: (cFrom.x + cTo.x) / 2, y: (cFrom.y + cTo.y) / 2 };
    const bend = edge.bend || 0;
    const ctrl = { x: midC.x + pxC * bend, y: midC.y + pyC * bend };

    // 경계 접점은 상대 노드의 "중심"이 아니라 곡선의 제어점을 향해 겨냥해서 구한다.
    // 이렇게 해야 같은 두 노드를 잇는 곡률이 다른(반대로 휜) 연결선이 여러 개 있을 때
    // 접점이 노드 위 한 점에서 서로 겹치지 않고 곡선이 휘는 방향으로 자연스럽게 벌어진다.
    // (bend=0이면 ctrl은 두 중심의 중점이 되는데, 그 방향은 상대 중심을 향한 방향과
    // 같은 직선상에 있으므로 결과는 기존과 동일하다.)
    const p1 = boundaryPoint(from, ctrl.x, ctrl.y);
    const p2 = boundaryPoint(to, ctrl.x, ctrl.y);

    // 지연·극성 표시는 실제로 그려지는 곡선의 접선 방향(≈ p2-p1)에 맞춰 놓는다.
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const px = -uy, py = ux;
    return { p1, p2, ctrl, ux, uy, px, py };
  }
  function bezierPoint(p1, ctrl, p2, t) {
    const mt = 1 - t;
    return {
      x: mt * mt * p1.x + 2 * mt * t * ctrl.x + t * t * p2.x,
      y: mt * mt * p1.y + 2 * mt * t * ctrl.y + t * t * p2.y,
    };
  }

  function screenToWorld(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const lx = clientX - rect.left;
    const ly = clientY - rect.top;
    return { x: (lx - view.x) / view.scale, y: (ly - view.y) / view.scale };
  }

  function worldFromEvent(evt) { return screenToWorld(evt.clientX, evt.clientY); }

  function applyViewTransform() {
    viewport.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.scale})`);
    zoomLabel.textContent = Math.round(view.scale * 100) + '%';
  }

  function contentBBox() {
    if (state.nodes.length === 0) return { minX: 0, minY: 0, maxX: 800, maxY: 500 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of state.nodes) {
      minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h);
    }
    // 휘어진 연결선의 제어점도 포함해야 큰 곡선이 화면 맞춤/내보내기에서 잘리지 않는다.
    // (2차 베지어 곡선은 항상 p1/ctrl/p2 세 점의 볼록 껍질 안에 있음)
    for (const e of state.edges) {
      if (!e.bend) continue;
      const from = state.nodes.find(n => n.id === e.from);
      const to = state.nodes.find(n => n.id === e.to);
      if (!from || !to) continue;
      const { ctrl } = edgeAnchorPoints(e, from, to);
      minX = Math.min(minX, ctrl.x); minY = Math.min(minY, ctrl.y);
      maxX = Math.max(maxX, ctrl.x); maxY = Math.max(maxY, ctrl.y);
    }
    return { minX, minY, maxX, maxY };
  }

  function zoomToFit() {
    const b = contentBBox();
    const pad = 60;
    const bw = Math.max(1, b.maxX - b.minX + pad * 2);
    const bh = Math.max(1, b.maxY - b.minY + pad * 2);
    const rect = canvasWrap.getBoundingClientRect();
    const scale = clamp(Math.min(rect.width / bw, rect.height / bh), 0.15, 1.5);
    view.scale = scale;
    view.x = rect.width / 2 - ((b.minX + b.maxX) / 2) * scale;
    view.y = rect.height / 2 - ((b.minY + b.maxY) / 2) * scale;
    applyViewTransform();
  }

  // ===========================================================================================
  // History (undo/redo)
  // ===========================================================================================
  function snapshot() {
    return JSON.stringify({ title: state.title, nodes: state.nodes, edges: state.edges });
  }
  function pushHistory() {
    const snap = snapshot();
    if (history[historyIndex] === snap) return;
    history = history.slice(0, historyIndex + 1);
    history.push(snap);
    if (history.length > 150) history.shift();
    historyIndex = history.length - 1;
    scheduleAutosave();
  }
  function restoreSnapshot(snap) {
    const data = JSON.parse(snap);
    state.title = data.title; state.nodes = data.nodes; state.edges = data.edges;
    mapTitleInput.value = state.title;
    clearSelection();
    render();
    scheduleAutosave();
  }
  function undo() { if (historyIndex > 0) { historyIndex--; restoreSnapshot(history[historyIndex]); } }
  function redo() { if (historyIndex < history.length - 1) { historyIndex++; restoreSnapshot(history[historyIndex]); } }

  // ===========================================================================================
  // Autosave
  // ===========================================================================================
  function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      try {
        flushActiveTab();
        const payload = {
          activeId: activeTabId,
          tabs: tabs.map(t => ({ id: t.id, state: t.state, view: t.view })),
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      } catch (e) { /* storage full or unavailable — ignore */ }
    }, 300);
  }
  // 새 탭 형식(sysmap.tabs.v1)을 우선 읽고, 없으면 이전 버전(단일 지도) 자동저장을
  // 탭 하나로 옮겨온 뒤 지운다 — 탭 기능 도입 전 사용자도 기존 지도를 잃지 않는다.
  function loadTabs() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        if (data && Array.isArray(data.tabs) && data.tabs.length > 0) {
          tabs = data.tabs.map(t => {
            const st = (t && t.state && Array.isArray(t.state.nodes) && Array.isArray(t.state.edges))
              ? { title: t.state.title || '새 시스템 지도', nodes: t.state.nodes, edges: t.state.edges }
              : { title: '새 시스템 지도', nodes: [], edges: [] };
            const view = (t && t.view && typeof t.view.scale === 'number')
              ? { x: t.view.x || 0, y: t.view.y || 0, scale: t.view.scale }
              : { x: 0, y: 0, scale: 1 };
            const snap = JSON.stringify(st);
            return { id: (t && t.id) || uid(), state: st, view, history: [snap], historyIndex: 0 };
          });
          activeTabId = tabs.some(t => t.id === data.activeId) ? data.activeId : tabs[0].id;
          return true;
        }
      }
      const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacyRaw) {
        const data = JSON.parse(legacyRaw);
        if (data && Array.isArray(data.nodes) && Array.isArray(data.edges)) {
          const st = { title: data.title || '새 시스템 지도', nodes: data.nodes, edges: data.edges };
          const t = createTab(st);
          tabs = [t];
          activeTabId = t.id;
          // 새 형식으로 먼저 저장한 뒤에 옛 키를 지운다 — 편집 없이 바로 새로고침/종료해도
          // 마이그레이션 과정에서 데이터가 통째로 사라지는 순간이 생기지 않게 한다.
          localStorage.setItem(STORAGE_KEY, JSON.stringify({ activeId: t.id, tabs: [{ id: t.id, state: t.state, view: t.view }] }));
          localStorage.removeItem(LEGACY_STORAGE_KEY);
          return true;
        }
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  function starterTemplate() {
    const fill = cssVar('--node-fill') || '#eef2ff';
    const stroke = cssVar('--node-stroke') || '#4f6df5';
    const n1 = { id: uid(), shape: 'circle', x: 60, y: 140, w: 120, h: 90, label: '클라이언트', fill, stroke };
    const n2 = { id: uid(), shape: 'rect', x: 320, y: 130, w: 160, h: 100, label: 'API 서버', fill, stroke };
    const n3 = { id: uid(), shape: 'rect', x: 620, y: 130, w: 160, h: 100, label: '데이터베이스', fill, stroke };
    return {
      title: '새 시스템 지도',
      nodes: [n1, n2, n3],
      edges: [
        { id: uid(), from: n1.id, to: n2.id, label: '요청', dashed: false, arrowStart: false, arrowEnd: true },
        { id: uid(), from: n2.id, to: n1.id, label: '응답', dashed: true, arrowStart: false, arrowEnd: true },
        { id: uid(), from: n2.id, to: n3.id, label: '쿼리', dashed: false, arrowStart: false, arrowEnd: true },
      ],
    };
  }

  // ===========================================================================================
  // 탭 — 한 창에서 여러 지도를 열어두고 전환
  // ===========================================================================================
  // 활성 탭의 값은 state/view/history/historyIndex 변수에 "풀어서" 담아 쓰다가, 다른
  // 탭으로 넘어가거나 저장하기 직전에만 tabs[] 배열의 해당 항목에 도로 채워 넣는다.
  function flushActiveTab() {
    const t = tabs.find(x => x.id === activeTabId);
    if (!t) return;
    t.state = state;
    t.view = { x: view.x, y: view.y, scale: view.scale };
    t.history = history;
    t.historyIndex = historyIndex;
  }

  function createTab(initialState) {
    const st = initialState || { title: '새 시스템 지도', nodes: [], edges: [] };
    const snap = JSON.stringify(st);
    return { id: uid(), state: st, view: { x: 0, y: 0, scale: 1 }, history: [snap], historyIndex: 0 };
  }

  // tabs[] 배열에서 이미 만들어진 탭 하나를 활성 탭으로 불러온다 (전환·부팅 공용).
  function activateTab(id, opts) {
    const t = tabs.find(x => x.id === id);
    if (!t) return;
    activeTabId = id;
    state = t.state;
    view.x = t.view.x; view.y = t.view.y; view.scale = t.view.scale;
    history = t.history;
    historyIndex = t.historyIndex;
    mapTitleInput.value = state.title;
    clearSelection();
    render();
    if (opts && opts.fit) zoomToFit(); else applyViewTransform();
    renderTabBar();
  }

  function switchToTab(id) {
    if (id === activeTabId) return;
    flushActiveTab();
    activateTab(id);
    scheduleAutosave();
  }

  function addNewTabAndSwitch() {
    flushActiveTab();
    const t = createTab();
    tabs.push(t);
    activateTab(t.id, { fit: true });
    scheduleAutosave();
  }

  // 탭을 새로 만들어 그 안에 지도를 담고 바로 전환한다 (JSON 불러오기 등에서 사용).
  function openInNewTab(st) {
    flushActiveTab();
    const t = createTab(st);
    tabs.push(t);
    activateTab(t.id, { fit: true });
    pushHistory();
    scheduleAutosave();
  }

  function closeTab(id) {
    const t = tabs.find(x => x.id === id);
    if (!t) return;
    const content = id === activeTabId ? state : t.state;
    if (content.nodes.length > 0 || content.edges.length > 0) {
      const name = content.title && content.title.trim() ? content.title.trim() : '제목 없음';
      if (!confirm(`"${name}" 탭을 닫을까요? 저장된 내용이 사라집니다.`)) return;
    }
    const idx = tabs.findIndex(x => x.id === id);
    const wasActive = id === activeTabId;
    tabs.splice(idx, 1);
    if (tabs.length === 0) tabs.push(createTab());
    if (wasActive) {
      const nextIdx = Math.min(idx, tabs.length - 1);
      activateTab(tabs[nextIdx].id, { fit: true });
    } else {
      renderTabBar();
    }
    scheduleAutosave();
  }

  function renderTabBar() {
    if (!tabBarEl) return;
    tabBarEl.innerHTML = '';
    for (const t of tabs) {
      const isActive = t.id === activeTabId;
      const title = isActive ? state.title : t.state.title;
      const el = document.createElement('div');
      el.className = 'tab' + (isActive ? ' active' : '');
      el.dataset.id = t.id;
      el.title = title && title.trim() ? title.trim() : '제목 없음';
      const label = document.createElement('span');
      label.className = 'tab-label';
      label.textContent = title && title.trim() ? title.trim() : '제목 없음';
      el.appendChild(label);
      const closeBtn = document.createElement('button');
      closeBtn.className = 'tab-close';
      closeBtn.type = 'button';
      closeBtn.title = '탭 닫기';
      closeBtn.textContent = '×';
      closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeTab(t.id); });
      el.appendChild(closeBtn);
      el.addEventListener('click', () => switchToTab(t.id));
      el.addEventListener('dblclick', (e) => { e.stopPropagation(); startRenameTab(t.id); });
      tabBarEl.appendChild(el);
    }
    const addBtn = document.createElement('button');
    addBtn.id = 'btnAddTab';
    addBtn.className = 'tab-add';
    addBtn.type = 'button';
    addBtn.title = '새 탭';
    addBtn.textContent = '+';
    addBtn.addEventListener('click', addNewTabAndSwitch);
    tabBarEl.appendChild(addBtn);
  }

  // 제목 입력창에 매 키입력마다 전체 탭바를 다시 그리는 대신, 활성 탭 라벨 텍스트만 갱신.
  function updateActiveTabLabel() {
    if (!tabBarEl) return;
    const el = tabBarEl.querySelector('.tab.active .tab-label');
    const parent = tabBarEl.querySelector('.tab.active');
    const title = state.title && state.title.trim() ? state.title.trim() : '제목 없음';
    if (el) el.textContent = title;
    if (parent) parent.title = title;
  }

  // 탭을 더블클릭하면 그 자리에서 이름을 바로 고칠 수 있다 (활성 탭이 아니어도 가능 —
  // 그 경우 전환 없이 배경 탭의 저장된 상태만 바꾼다).
  function startRenameTab(id) {
    const t = tabs.find(x => x.id === id);
    const el = tabBarEl && tabBarEl.querySelector(`.tab[data-id="${id}"]`);
    if (!t || !el) return;
    const labelEl = el.querySelector('.tab-label');
    if (!labelEl) return;
    const isActive = id === activeTabId;
    const current = isActive ? state.title : t.state.title;
    const input = document.createElement('input');
    input.className = 'tab-rename-input';
    input.type = 'text';
    input.value = current || '';
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
    input.addEventListener('click', (e) => e.stopPropagation());
    labelEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return; done = true;
      if (save) {
        const newTitle = input.value.trim() || DEFAULT_MAP_TITLE;
        if (isActive) {
          state.title = newTitle;
          mapTitleInput.value = newTitle;
          pushHistory();
        } else {
          t.state.title = newTitle;
          scheduleAutosave();
        }
      }
      renderTabBar();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
      e.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
  }

  // ===========================================================================================
  // 시스템 원형(archetype) 템플릿 — 자주 쓰는 인과 지도 패턴을 원클릭으로 삽입
  // ===========================================================================================
  // 작은 DSL: 로컬 좌표(중심 cx,cy 기준)로 노드/연결선을 선언하면 insertTemplate()이
  // 실제 uid를 부여하고 캔버스의 빈 자리로 평행이동해 배치한다.
  function tNode(ref, shape, label, cx, cy, loopType) {
    return { ref, shape, label, cx, cy, loopType };
  }
  function tEdge(from, to, opts) {
    return Object.assign({ from, to, bend: 0, dashed: false, delay: false, polarity: '', arrowEnd: true, arrowStart: false, label: '' }, opts || {});
  }

  const ARCHETYPE_TEMPLATES = [
    {
      id: 'reinforcing',
      name: '선순환/악순환 (강화 루프)',
      subtitle: '두 요인이 서로를 증폭시키는 가장 기본적인 강화 루프',
      implemented: false,
      build() {
        return {
          nodes: [
            tNode('a', 'text', '요인 A', 0, 0),
            tNode('b', 'text', '요인 B', 300, 0),
            tNode('r', 'loop', 'R1', 150, 0, 'R'),
          ],
          edges: [tEdge('a', 'b', { bend: 45 }), tEdge('b', 'a', { bend: 45 })],
        };
      },
    },
    {
      id: 'balancing',
      name: '균형 프로세스',
      subtitle: '목표와의 격차를 줄이려는 조정 행동이 반복되는 균형 루프',
      implemented: false,
      build() {
        return {
          nodes: [
            tNode('cur', 'text', '현재 상태', 0, 0),
            tNode('act', 'text', '조정 행동', 300, 0),
            tNode('b', 'loop', 'B1', 150, 0, 'B'),
          ],
          edges: [tEdge('cur', 'act', { bend: 45 }), tEdge('act', 'cur', { bend: 45, delay: true })],
        };
      },
    },
    {
      id: 'fixes-that-fail',
      name: '역효과를 낳는 해결책',
      subtitle: '임시방편이 지연을 두고 문제를 다시 악화시키는 구조',
      implemented: true,
      build() {
        return {
          nodes: [
            tNode('problem', 'rect', '문제 현상 또는 압력', 148, 182),
            tNode('fix', 'text', '단기적으로 효과가 있는 임시방편', 533, 181),
            tNode('b1', 'loop', 'B1', 344, 180, 'B'),
            tNode('improve', 'text', '현상 개선 프로세스', 340, 74),
            tNode('sideeffect', 'text', '문제를 악화시키는 의도치 않은 결과', 336, 362),
            tNode('r2', 'loop', 'R2', 335, 316, 'R'),
            tNode('delay', 'text', '지연', 543, 307),
            tNode('vicious', 'text', '악순환', 338, 404),
          ],
          // B1(균형 루프)은 위쪽에서 문제와 임시방편이 짧게 오가고, R2(강화 루프)는 임시방편에서
          // 지연을 두고 의도치 않은 부작용으로 갔다가 문제를 다시 악화시키며 돌아와 두 루프가
          // "문제 현상"·"임시방편" 노드를 공유하며 하나로 이어진다.
          edges: [
            tEdge('problem', 'fix', { bend: -117 }),
            tEdge('fix', 'problem', { bend: -109 }),
            tEdge('fix', 'sideeffect', { bend: -108, delay: true }),
            tEdge('sideeffect', 'problem', { bend: -97 }),
          ],
        };
      },
    },
    {
      id: 'shifting-the-burden',
      name: '부담 떠넘기기',
      subtitle: '임시방편의 부작용이 장기적 해결책을 약화시키는 구조',
      implemented: true,
      build() {
        return {
          nodes: [
            tNode('problem', 'rect', '문제 현상', 267, 161),
            tNode('fix', 'text', '임시 방편', 271, 27),
            tNode('longterm', 'text', '장기적인 해결책', 265, 296),
            tNode('b1', 'loop', 'B1', 267, 95, 'B'),
            tNode('b2', 'loop', 'B2', 266, 227, 'B'),
            tNode('sideeffect', 'text', '부작용', 442, 160),
            tNode('r3', 'loop', 'R3', 380, 165, 'R'),
            tNode('fixlabel', 'text', '현상만 다룰 수 있음', 144, 82),
            tNode('longtermlabel', 'text', '더 근본적으로 접근가능', 128, 229),
          ],
          // B1(균형 루프)은 위쪽에서 문제와 임시방편이 짧게 오가고, B2(균형 루프)는 아래쪽에서
          // 문제와 장기적인 해결책이 지연을 두고 오간다. R3(강화 루프)는 임시방편의 부작용이
          // 장기적인 해결책을 약화시키는 길을 그려 세 루프가 "문제 현상"·"임시 방편" 노드를
          // 매개로 하나로 이어진다.
          edges: [
            tEdge('problem', 'fix', { bend: 63 }),
            tEdge('fix', 'problem', { bend: 69 }),
            tEdge('problem', 'longterm', { bend: -66 }),
            tEdge('longterm', 'problem', { bend: -67, delay: true }),
            tEdge('fix', 'sideeffect', { bend: -61 }),
            tEdge('sideeffect', 'longterm', { bend: -59 }),
          ],
        };
      },
    },
    {
      id: 'limits-to-growth',
      name: '성장의 한계',
      subtitle: '성장을 이끄는 행동이 결국 제약 요인에 부딪히는 구조',
      implemented: true,
      build() {
        return {
          nodes: [
            tNode('action', 'text', '증가하는 행동', 68, 105),
            tNode('perf', 'rect', '성과 또는 조건', 339, 116),
            tNode('constraint', 'text', '제약하는 행동', 615, 105),
            tNode('r1', 'loop', 'R1', 195, 118, 'R'),
            tNode('b2', 'loop', 'B2', 476, 112, 'B'),
            tNode('vicious', 'text', '악순환', 207, 218),
            tNode('limiting', 'text', '제한 프로세스', 489, 217),
            tNode('reason', 'text', '성과의 제한 또는 제약', 711, 188),
            tNode('delay', 'text', '지연', 443, 45),
          ],
          // R1(강화 루프)은 안쪽의 짧은 두 화살표로, B2(균형 루프)는 그 오른쪽에서 지연을
          // 두고 성과를 제약하는 두 화살표로, 그리고 제약하는 행동에서 증가하는 행동까지
          // 크게 바깥으로 돌아나가는 화살표로 전체 구조가 하나로 이어짐을 보여준다.
          edges: [
            tEdge('action', 'perf', { bend: -86 }),
            tEdge('perf', 'action', { bend: -111 }),
            tEdge('perf', 'constraint', { bend: 114 }),
            tEdge('constraint', 'perf', { bend: 84, delay: true }),
            tEdge('constraint', 'action', { bend: 241 }),
            tEdge('reason', 'constraint', { bend: 0 }),
          ],
        };
      },
    },
    {
      id: 'success-to-successful',
      name: '성공한 쪽에 몰아주기',
      subtitle: '한쪽에 자원이 쏠릴수록 다른 쪽의 성공 기회가 줄어드는 구조',
      implemented: true,
      build() {
        return {
          nodes: [
            tNode('alloc', 'rect', 'B대신 A에게 자원이 할당됨', 362, 147),
            tNode('bSuccess', 'text', 'B의 성공', 598, 147),
            tNode('aSuccess', 'text', 'A의 성공', 113, 147),
            tNode('r1', 'loop', 'R1', 212, 146, 'R'),
            tNode('r2', 'loop', 'R2', 502, 147, 'R'),
            tNode('increase', 'text', '점차 증가', 73, 186),
            tNode('decrease', 'text', '점차 감소', 624, 190),
          ],
          // R1(강화 루프)은 A 쪽에서 자원 배분과 A의 성공이 서로를 밀어올리고, R2(강화 루프)는
          // B 쪽에서 같은 자원을 두고 반대 방향으로 서로를 끌어내려, 한쪽(A)이 점차 늘고
          // 다른 쪽(B)은 점차 줄어드는 비대칭이 벌어짐을 보여준다.
          edges: [
            tEdge('alloc', 'bSuccess', { bend: -121 }),
            tEdge('alloc', 'aSuccess', { bend: -103 }),
            tEdge('bSuccess', 'alloc', { bend: -112 }),
            tEdge('aSuccess', 'alloc', { bend: -122 }),
          ],
        };
      },
    },
    {
      id: 'accidental-adversaries',
      name: '뜻하지 않은 적수',
      subtitle: '선의로 시작한 협력 관계가 서로 모르는 사이에 적대적으로 변하는 구조',
      implemented: false,
      build() {
        return {
          nodes: [
            tNode('aSuccess', 'rect', 'A의 성공', 0, 0),
            tNode('aJoint', 'text', 'B와 함께하는 A의 활동', 0, 230),
            tNode('aAction', 'text', '자신의 결과를 개선하기 위한 A의 조치', 0, -230),
            tNode('aHarmsB', 'text', 'A가 B의 성공을 의도치 않게 방해함', 330, -150),
            tNode('bSuccess', 'rect', 'B의 성공', 660, 0),
            tNode('bJoint', 'text', 'A와 함께하는 B의 행동', 660, 230),
            tNode('bAction', 'text', '자신의 결과를 개선하기 위한 B의 조치', 660, -230),
            tNode('bHarmsA', 'text', 'B가 A의 성공을 의도치 않게 방해함', 330, 150),
            tNode('r1', 'loop', 'R1', 0, 115, 'R'),
            tNode('b2', 'loop', 'B2', 0, -115, 'B'),
            tNode('r4', 'loop', 'R4', 660, 115, 'R'),
            tNode('b3', 'loop', 'B3', 660, -115, 'B'),
          ],
          edges: [
            tEdge('aSuccess', 'aJoint', { bend: 40 }),
            tEdge('aJoint', 'aSuccess', { bend: 40 }),
            tEdge('aSuccess', 'aAction', { bend: -40 }),
            tEdge('aAction', 'aSuccess', { bend: -40 }),
            tEdge('aAction', 'aHarmsB', { bend: 20 }),
            tEdge('aHarmsB', 'bSuccess', { bend: -20, polarity: '-' }),
            tEdge('bSuccess', 'bJoint', { bend: 40 }),
            tEdge('bJoint', 'bSuccess', { bend: 40 }),
            tEdge('bSuccess', 'bAction', { bend: -40 }),
            tEdge('bAction', 'bSuccess', { bend: -40 }),
            tEdge('bAction', 'bHarmsA', { bend: -20 }),
            tEdge('bHarmsA', 'aSuccess', { bend: 20, polarity: '-' }),
          ],
        };
      },
    },
    {
      id: 'drifting-goals',
      name: '표류하는 목표',
      subtitle: '의도치 않은 낮은 성과: 실제 수준과 기대하는 성과 수준의 점진적 감소',
      implemented: false,
    },
    {
      id: 'competing-goals',
      name: '경쟁하는 목표',
      subtitle: '상충하는 목표 또는 다수의 목표: 상충하는 목표를 충족하거나 너무 많은 목표를 성취하려고 애쓰다가 아무것도 성취하지 못하는 상황',
      implemented: false,
    },
    {
      id: 'escalation',
      name: '단계적 확대',
      subtitle: '의도치 않은 확산: 어느 한쪽이 더 강하게 밀어붙일수록 다른 쪽이 더 강력히 반발하는 상황',
      implemented: false,
    },
    {
      id: 'tragedy-of-the-commons',
      name: '공유지의 비극',
      subtitle: '전체를 해치는 각 부분의 최적화: 모든 사람이 그 누구의 것도 아닌 자원에서 혜택을 얻는 상황',
      implemented: false,
    },
    {
      id: 'growth-and-underinvestment',
      name: '성장과 투자부족',
      subtitle: '자기가 만든 한계: 성장하도록 밀어붙이지만, 성장 역량에는 충분히 투자하지 않는 상황',
      implemented: false,
    },
  ];

  function templateBBox(nodes) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      const { w, h } = autoNodeSize(n.shape, n.label);
      minX = Math.min(minX, n.cx - w / 2); minY = Math.min(minY, n.cy - h / 2);
      maxX = Math.max(maxX, n.cx + w / 2); maxY = Math.max(maxY, n.cy + h / 2);
    }
    return { minX, minY, maxX, maxY };
  }

  function insertTemplate(tpl) {
    const def = tpl.build();
    const bbox = templateBBox(def.nodes);
    const bw = bbox.maxX - bbox.minX, bh = bbox.maxY - bbox.minY;

    // 현재 보이는 화면 중앙에 놓되, 기존 요소와 겹치면 findFreeSpot과 같은 방식으로 아래로 내린다.
    const rect = canvasWrap.getBoundingClientRect();
    const centerWorld = screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const spot = findFreeSpot(centerWorld.x - bw / 2, centerWorld.y - bh / 2, bw, bh);
    const offX = spot.x - bbox.minX, offY = spot.y - bbox.minY;

    const idMap = {};
    const newNodes = def.nodes.map(n => {
      const { w, h } = autoNodeSize(n.shape, n.label);
      const id = uid();
      idMap[n.ref] = id;
      const node = {
        id, shape: n.shape, label: n.label,
        x: n.cx + offX - w / 2, y: n.cy + offY - h / 2, w, h,
      };
      if (n.shape === 'loop') {
        node.loopType = n.loopType || 'R';
        node.textColor = cssVar('--text') || '#1c2128';
        node.fill = 'transparent'; node.stroke = node.textColor;
      } else if (n.shape === 'text') {
        node.textColor = cssVar('--text') || '#1c2128';
        node.fill = 'transparent'; node.stroke = node.textColor;
      } else {
        const fs = defaultFillStroke(n.shape);
        node.fill = fs.fill; node.stroke = fs.stroke;
      }
      return node;
    });
    const newEdges = def.edges.map(e => ({
      id: uid(), from: idMap[e.from], to: idMap[e.to], label: e.label || '',
      dashed: !!e.dashed, arrowStart: !!e.arrowStart, arrowEnd: e.arrowEnd !== false,
      bend: e.bend || 0, delay: !!e.delay, polarity: e.polarity || '', bubble: !!e.bubble,
      color: e.color || '',
    }));

    state.nodes.push(...newNodes);
    state.edges.push(...newEdges);
    clearSelection();
    render();
    ensureNodeVisible({ x: spot.x, y: spot.y, w: bw, h: bh });
    pushHistory();
  }

  // ===========================================================================================
  // CRUD
  // ===========================================================================================
  function addNode(shape, worldX, worldY) {
    const label = NODE_DEFAULT_LABELS[shape] || '노드';
    const isTextLike = shape === 'text' || shape === 'loop';
    let w, h, fill, stroke;
    const node = { id: uid(), shape, label };
    if (isTextLike) {
      if (shape === 'loop') node.loopType = 'R';
      node.textColor = cssVar('--text') || '#1c2128';
      ({ w, h } = measureNodeSize(shape, label, node.loopType, node.fontSize));
      fill = 'transparent';
      stroke = node.textColor;
    } else {
      [w, h] = NODE_DEFAULT_SIZES[shape] || [150, 90];
      ({ fill, stroke } = defaultFillStroke(shape));
    }
    Object.assign(node, { x: worldX - w / 2, y: worldY - h / 2, w, h, fill, stroke });
    state.nodes.push(node);
    render();
    pushHistory();
    selectItem('node', node.id);
    return node;
  }

  function addEdge(fromId, toId) {
    if (fromId === toId) return null;
    const exists = state.edges.some(e => e.from === fromId && e.to === toId);
    if (exists) return null;
    const edge = {
      id: uid(), from: fromId, to: toId, label: '',
      dashed: false, arrowStart: false, arrowEnd: true,
      bend: 0, delay: false, polarity: '', bubble: false, color: '',
    };
    state.edges.push(edge);
    render();
    pushHistory();
    selectItem('edge', edge.id);
    return edge;
  }

  // Insert key: duplicate the selected node (same shape/size/style) and
  // connect it with an arrow, mimicking chain-building diagram tools.
  function nodeOverlaps(x, y, w, h) {
    const pad = 20;
    return state.nodes.some(n =>
      !(x + w + pad < n.x || x > n.x + n.w + pad || y + h + pad < n.y || y > n.y + n.h + pad));
  }
  function findFreeSpot(x, y, w, h) {
    let ny = y;
    for (let i = 0; i < 20 && nodeOverlaps(x, ny, w, h); i++) ny += h + 40;
    return { x, y: ny };
  }

  function duplicateConnected(sourceId) {
    const source = state.nodes.find(n => n.id === sourceId);
    if (!source) return null;
    const gap = 80;
    const spot = findFreeSpot(source.x + source.w + gap, source.y, source.w, source.h);
    const clone = {
      id: uid(), shape: source.shape,
      x: spot.x, y: spot.y, w: source.w, h: source.h,
      label: source.label, fill: source.fill, stroke: source.stroke,
    };
    if (source.loopType) clone.loopType = source.loopType;
    if (source.textColor) clone.textColor = source.textColor;
    state.nodes.push(clone);
    state.edges.push({
      id: uid(), from: source.id, to: clone.id,
      label: '', dashed: false, arrowStart: false, arrowEnd: true,
      bend: 0, delay: false, polarity: '', bubble: false,
    });
    selection = { type: 'node', id: clone.id };
    render();
    pushHistory();
    return clone;
  }

  function removeNode(id) {
    state.nodes = state.nodes.filter(n => n.id !== id);
    state.edges = state.edges.filter(e => e.from !== id && e.to !== id);
  }
  function removeEdge(id) {
    state.edges = state.edges.filter(e => e.id !== id);
  }

  // 멤버가 1명만 남은 그룹은 의미가 없으므로 groupId를 지워 평범한 노드로 되돌린다.
  function cleanupDegenerateGroups() {
    const counts = {};
    for (const n of state.nodes) if (n.groupId) counts[n.groupId] = (counts[n.groupId] || 0) + 1;
    for (const n of state.nodes) if (n.groupId && counts[n.groupId] < 2) delete n.groupId;
  }

  function deleteSelection() {
    if (multiSelection.length >= 2) {
      for (const item of multiSelection) {
        if (item.type === 'node') removeNode(item.id); else removeEdge(item.id);
      }
      cleanupDegenerateGroups();
      clearSelection();
      render();
      pushHistory();
      return;
    }
    if (!selection.type) return;
    if (selection.type === 'node') removeNode(selection.id);
    else removeEdge(selection.id);
    cleanupDegenerateGroups();
    clearSelection();
    render();
    pushHistory();
  }

  // ---- 그룹화 -----------------------------------------------------------------------------------
  // 여러 노드를 하나의 그룹으로 묶으면, 이후 그중 아무거나 하나만 (Shift 없이) 클릭해도
  // 그룹 전체가 선택되어 함께 움직이거나 삭제된다. 연결선은 묶지 않는다 — 어차피 양 끝
  // 노드가 함께 움직이면 따라오므로 독립적인 groupId가 필요 없다.
  function groupSelection() {
    const nodeItems = multiSelection.filter(it => it.type === 'node');
    if (nodeItems.length < 2) return;
    const gid = uid();
    for (const it of nodeItems) {
      const node = state.nodes.find(n => n.id === it.id);
      if (node) node.groupId = gid;
    }
    render();
    pushHistory();
    updatePanel();
  }
  function ungroupSelection() {
    const items = multiSelection.length ? multiSelection : (selection.type ? [selection] : []);
    let changed = false;
    for (const it of items) {
      if (it.type !== 'node') continue;
      const node = state.nodes.find(n => n.id === it.id);
      if (node && node.groupId) { delete node.groupId; changed = true; }
    }
    if (changed) { render(); pushHistory(); updatePanel(); }
  }

  // ---- 정렬·배치 ---------------------------------------------------------------------------------
  function alignNodes(mode) {
    const nodes = multiSelection.filter(it => it.type === 'node')
      .map(it => state.nodes.find(n => n.id === it.id)).filter(Boolean);
    if (nodes.length < 2) return;
    if (mode === 'left') {
      const v = Math.min(...nodes.map(n => n.x));
      nodes.forEach(n => { n.x = v; });
    } else if (mode === 'right') {
      const v = Math.max(...nodes.map(n => n.x + n.w));
      nodes.forEach(n => { n.x = v - n.w; });
    } else if (mode === 'top') {
      const v = Math.min(...nodes.map(n => n.y));
      nodes.forEach(n => { n.y = v; });
    } else if (mode === 'bottom') {
      const v = Math.max(...nodes.map(n => n.y + n.h));
      nodes.forEach(n => { n.y = v - n.h; });
    } else if (mode === 'center-x') {
      const avg = nodes.reduce((s, n) => s + n.x + n.w / 2, 0) / nodes.length;
      nodes.forEach(n => { n.x = avg - n.w / 2; });
    } else if (mode === 'center-y') {
      const avg = nodes.reduce((s, n) => s + n.y + n.h / 2, 0) / nodes.length;
      nodes.forEach(n => { n.y = avg - n.h / 2; });
    } else if (mode === 'distribute-x') {
      if (nodes.length < 3) return;
      const sorted = [...nodes].sort((a, b) => (a.x + a.w / 2) - (b.x + b.w / 2));
      const firstC = sorted[0].x + sorted[0].w / 2, lastC = sorted[sorted.length - 1].x + sorted[sorted.length - 1].w / 2;
      const step = (lastC - firstC) / (sorted.length - 1);
      sorted.forEach((n, i) => { n.x = (firstC + step * i) - n.w / 2; });
    } else if (mode === 'distribute-y') {
      if (nodes.length < 3) return;
      const sorted = [...nodes].sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2));
      const firstC = sorted[0].y + sorted[0].h / 2, lastC = sorted[sorted.length - 1].y + sorted[sorted.length - 1].h / 2;
      const step = (lastC - firstC) / (sorted.length - 1);
      sorted.forEach((n, i) => { n.y = (firstC + step * i) - n.h / 2; });
    }
    render();
    pushHistory();
  }

  // ---- 순환 구조(고리) 만들기 --------------------------------------------------------------------
  // 선택한 노드들을 화면상 위치(가로로 더 넓게 퍼져 있으면 x, 세로로 더 퍼져 있으면 y) 순서로
  // "사슬"로 간주해, 맨 끝(마지막) 노드에서 맨 앞(처음) 노드로 향하는 연결을 새로 만든다.
  function chainAxisIsHorizontal(nodes) {
    const minX = Math.min(...nodes.map(n => n.x)), maxX = Math.max(...nodes.map(n => n.x + n.w));
    const minY = Math.min(...nodes.map(n => n.y)), maxY = Math.max(...nodes.map(n => n.y + n.h));
    return (maxX - minX) >= (maxY - minY);
  }
  function orderNodesByPosition(nodes) {
    const horizontal = chainAxisIsHorizontal(nodes);
    return [...nodes].sort((a, b) => {
      const ca = nodeCenter(a), cb = nodeCenter(b);
      return horizontal ? ca.x - cb.x : ca.y - cb.y;
    });
  }
  // 선택한 노드들 사이에 실제로 그어진 연결선만 모아, 그것이 정확히 하나의 사슬(각 노드가
  // 이웃 1~2개, 끝 2개는 이웃 1개)을 이루는지 확인한다. 이루면 그 연결 순서를 그대로 따르고
  // (양방향 연결은 이웃 하나로 취급), 아니라면(가지가 있거나 끊겨 있는 등) 기존처럼 화면
  // 위치 순서로 대신한다 — 위치만으로는 노드들이 가로세로로 애매하게 놓였을 때 실제 연결
  // 순서와 어긋나 고리가 서로 겹치며 꼬일 수 있어, 실제 연결 정보가 있으면 그걸 우선한다.
  function orderNodesByChain(nodes) {
    const idSet = new Set(nodes.map(n => n.id));
    const neighbors = new Map(nodes.map(n => [n.id, new Set()]));
    for (const e of state.edges) {
      if (e.from === e.to || !idSet.has(e.from) || !idSet.has(e.to)) continue;
      neighbors.get(e.from).add(e.to);
      neighbors.get(e.to).add(e.from);
    }
    const endpoints = nodes.filter(n => neighbors.get(n.id).size === 1);
    const isSimplePath = endpoints.length === 2 && nodes.every(n => {
      const d = neighbors.get(n.id).size;
      return d === 1 || d === 2;
    });
    if (isSimplePath) {
      const byId = new Map(nodes.map(n => [n.id, n]));
      const order = [endpoints[0].id];
      const visited = new Set(order);
      let prev = null, cur = endpoints[0].id;
      while (true) {
        const next = [...neighbors.get(cur)].find(id => id !== prev && !visited.has(id));
        if (next === undefined) break;
        order.push(next);
        visited.add(next);
        prev = cur;
        cur = next;
      }
      if (order.length === nodes.length) {
        const chain = order.map(id => byId.get(id));
        const a = chain[0], b = chain[chain.length - 1];
        const horizontal = chainAxisIsHorizontal(nodes);
        const ca = nodeCenter(a), cb = nodeCenter(b);
        const aIsFirst = horizontal ? ca.x <= cb.x : ca.y <= cb.y;
        return aIsFirst ? chain : chain.slice().reverse();
      }
    }
    return orderNodesByPosition(nodes);
  }
  function makeChainEdge(fromId, toId) {
    return {
      id: uid(), from: fromId, to: toId, label: '',
      dashed: false, arrowStart: false, arrowEnd: true,
      bend: 0, delay: false, polarity: '', bubble: false,
    };
  }
  // 두 노드 사이의 연결선 두 개(정방향·역방향)가 서로 반대쪽으로 휘어 렌즈(원) 모양을
  // 이루도록 같은 부호의 곡률을 준다 — edgeAnchorPoints()의 계산 방식상, 방향이 반대인
  // 두 연결선에 같은 bend 값을 주면 저절로 반대 방향으로 벌어진다 (강화 루프 원형 템플릿과 동일한 원리).
  function closeLoopPair(first, last) {
    let forward = state.edges.find(e => e.from === first.id && e.to === last.id);
    let backward = state.edges.find(e => e.from === last.id && e.to === first.id);
    if (backward) return; // 이미 고리로 닫혀 있음 — 할 일 없음
    const dist = Math.hypot(nodeCenter(last).x - nodeCenter(first).x, nodeCenter(last).y - nodeCenter(first).y);
    const mag = clamp(dist * 0.3, 30, 130);
    if (!forward) {
      forward = makeChainEdge(first.id, last.id);
      state.edges.push(forward);
    }
    backward = makeChainEdge(last.id, first.id);
    state.edges.push(backward);
    forward.bend = mag;
    backward.bend = mag;
  }

  // 노드 3개 이상: 선택한 노드들을 원 둘레에 고르게 재배치하고, 이웃한 노드끼리의 연결선을
  // 모두 원 중심 바깥쪽으로 휘게 만들어 전체적으로 둥근 고리 모양이 되게 한다. 마지막 노드에서
  // 처음 노드로 이어지는 연결이 없으면 새로 만들어 고리를 닫는다.
  function closeLoopRing(ordered) {
    const count = ordered.length;
    let cx = 0, cy = 0;
    for (const n of ordered) { const c = nodeCenter(n); cx += c.x; cy += c.y; }
    cx /= count; cy /= count;
    const center = { x: cx, y: cy };

    const avgSpan = ordered.reduce((s, n) => s + Math.max(n.w, n.h), 0) / count;
    const gap = 70;
    const radius = Math.max(160, (count * (avgSpan + gap)) / (2 * Math.PI));

    const startAngle = -Math.PI / 2; // 12시 방향부터 시계 방향으로 배치
    ordered.forEach((n, i) => {
      const angle = startAngle + (i * 2 * Math.PI) / count;
      const px = cx + radius * Math.cos(angle), py = cy + radius * Math.sin(angle);
      n.x = px - n.w / 2;
      n.y = py - n.h / 2;
    });

    const bendMag = clamp(radius * 0.35, 26, 110);
    // 연결선의 제어점이 원 중심에서 먼 쪽(바깥쪽)으로 밀리도록 곡률 부호를 기하학적으로 계산한다
    // (연결 방향이 반대여도 항상 같은 물리적 바깥쪽으로 휘게 됨 — edgeAnchorPoints()와 동일한
    // 수직 벡터 공식을 그대로 써서 부호만 바깥쪽 기준으로 다시 정한다).
    function bendOutward(edge, from, to, factor) {
      const cF = nodeCenter(from), cT = nodeCenter(to);
      const midx = (cF.x + cT.x) / 2, midy = (cF.y + cT.y) / 2;
      const dxC = cT.x - cF.x, dyC = cT.y - cF.y;
      const lenC = Math.hypot(dxC, dyC) || 1;
      const pxC = -dyC / lenC, pyC = dxC / lenC;
      const outX = midx - center.x, outY = midy - center.y;
      const sign = (outX * pxC + outY * pyC) >= 0 ? 1 : -1;
      edge.bend = sign * bendMag * factor;
    }

    for (let i = 0; i < count; i++) {
      const a = ordered[i], b = ordered[(i + 1) % count];
      let fwd = state.edges.find(e => e.from === a.id && e.to === b.id);
      const bwd = state.edges.find(e => e.from === b.id && e.to === a.id);
      const isClosingGap = i === count - 1; // 마지막 -> 처음 구간
      if (!fwd && !bwd) {
        if (!isClosingGap) continue; // 사슬 중간이 끊겨 있으면 손대지 않는다 (전제조건 밖)
        fwd = makeChainEdge(a.id, b.id); // 요청하신 "고리 닫기" 연결을 새로 만든다
        state.edges.push(fwd);
      }
      if (fwd) bendOutward(fwd, a, b, bwd ? 1.6 : 1);
      if (bwd) bendOutward(bwd, b, a, 1);
    }
  }

  function closeLoop() {
    const nodes = multiSelection.filter(it => it.type === 'node')
      .map(it => state.nodes.find(n => n.id === it.id)).filter(Boolean);
    if (nodes.length < 2) return;
    const ordered = orderNodesByChain(nodes);
    if (ordered.length === 2) closeLoopPair(ordered[0], ordered[1]);
    else closeLoopRing(ordered);
    render();
    pushHistory();
  }

  // ===========================================================================================
  // Rendering
  // ===========================================================================================
  function render() {
    nodesLayer.innerHTML = '';
    edgesLayer.innerHTML = '';
    for (const e of state.edges) edgesLayer.appendChild(buildEdgeEl(e));
    for (const n of state.nodes) nodesLayer.appendChild(buildNodeEl(n));
    renderGroupOutlines();
    emptyHint.classList.toggle('hidden', state.nodes.length > 0);
    countsEl.textContent = `노드 ${state.nodes.length}개 · 연결 ${state.edges.length}개`;
    updatePanel();
  }

  // 그룹에 속한 노드들 주위에 은은한 점선 테두리를 그려, 선택하지 않아도 어떤 노드끼리
  // 묶여 있는지 알아볼 수 있게 한다. (overlayLayer는 ui-only라 내보내기에서는 자동 제외됨)
  function renderGroupOutlines() {
    const groups = {};
    for (const n of state.nodes) {
      if (!n.groupId) continue;
      (groups[n.groupId] || (groups[n.groupId] = [])).push(n);
    }
    const frag = document.createDocumentFragment();
    for (const gid in groups) {
      const members = groups[gid];
      if (members.length < 2) continue;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of members) {
        minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
        maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h);
      }
      const pad = 14;
      frag.appendChild(svgEl('rect', {
        x: minX - pad, y: minY - pad, width: (maxX - minX) + pad * 2, height: (maxY - minY) + pad * 2,
        rx: 10, class: 'group-outline',
      }));
    }
    overlayLayer.innerHTML = '';
    overlayLayer.appendChild(frag);
  }

  // 텍스트·루프 노드는 배경 도형이 없다 — 글자만 떠 있는 인과 지도 변수명 표기.
  function isTextLikeShape(shape) { return shape === 'text' || shape === 'loop'; }

  function shapeEl(node) {
    const w = node.w, h = node.h;
    if (isTextLikeShape(node.shape)) {
      // 텍스트·루프 노드는 화면에 보이는 도형이 없다. <text>는 pointer-events:none이라
      // 그것만으로는 클릭·드래그·연결이 전혀 안 걸리므로, 투명한 히트 영역을 깔아준다.
      // fill:none이 아니라 fill:transparent를 써야 visiblePainted 히트테스트에 걸린다.
      return svgEl('rect', { x: 0, y: 0, width: w, height: h, fill: 'transparent', stroke: 'none', class: 'node-hit' });
    }
    let el;
    if (node.shape === 'circle' || node.shape === 'bubble') {
      el = svgEl('ellipse', { cx: w / 2, cy: h / 2, rx: w / 2, ry: h / 2 });
    } else if (node.shape === 'diamond') {
      el = svgEl('path', { d: `M${w / 2},0 L${w},${h / 2} L${w / 2},${h} L0,${h / 2} Z` });
    } else {
      el = svgEl('rect', { x: 0, y: 0, width: w, height: h, rx: 10, ry: 10 });
    }
    el.setAttribute('class', 'node-shape');
    el.setAttribute('fill', node.fill);
    el.setAttribute('stroke', node.stroke);
    return el;
  }

  // 프레젠테이션 속성(fill=, font-size=)은 스타일시트의 .node-label 규칙보다
  // 우선순위가 낮아 덮어써진다 — 인라인 style로 지정해야 커스텀 글자색·글자크기가
  // 실제로 적용된다. 도형 노드(사각형/원/마름모/말풍선)도 글자색·크기를 바꿀 수
  // 있도록 모든 노드 타입에 공통으로 적용한다.
  function applyNodeTextStyle(text, node) {
    text.style.fill = node.textColor || cssVar('--text') || '#1c2128';
    text.style.fontSize = (node.fontSize || defaultNodeFontSize(node.shape)) + 'px';
  }

  function nodeDisplayText(node) {
    return node.shape === 'loop' ? loopDisplayText(node.label, node.loopType) : node.label;
  }

  function buildNodeEl(node) {
    const g = svgEl('g', { class: 'node', 'data-id': node.id, transform: `translate(${node.x} ${node.y})` });
    const shape = shapeEl(node);
    if (shape) g.appendChild(shape);
    const isTextLike = isTextLikeShape(node.shape);
    const text = svgEl('text', {
      x: node.w / 2, y: node.h / 2,
      class: 'node-label' + (node.shape === 'loop' ? ' loop-label' : ''),
    });
    applyNodeTextStyle(text, node);
    text.textContent = nodeDisplayText(node);
    g.appendChild(text);
    const isSingleSelected = selection.type === 'node' && selection.id === node.id;
    if (isSingleSelected || isMultiSelected('node', node.id)) {
      g.classList.add('selected');
      // 크기 조절 손잡이는 노드 하나만 선택됐을 때만 — 여러 개일 땐 어느 걸
      // 조절하는 건지 모호하므로 대신 점선 박스로만 선택 표시한다.
      if (isTextLike || !isSingleSelected) {
        const box = svgEl('rect', {
          x: -4, y: -4, width: node.w + 8, height: node.h + 8, rx: 4,
          class: 'text-select-box',
        });
        g.insertBefore(box, g.firstChild);
      } else {
        const handle = svgEl('rect', {
          x: node.w - 8, y: node.h - 8, width: 14, height: 14,
          class: 'resize-handle', 'data-resize': node.id,
        });
        g.appendChild(handle);
      }
    }
    if (connectPendingId === node.id) g.classList.add('connect-pending');
    return g;
  }

  // 화살촉(<marker>)은 CSS 클래스(.arrow-fill)로 공통 테마색을 쓰지만, 연결선마다
  // 색을 다르게 지정하려면 그 색으로 칠해진 marker가 따로 필요하다 — 같은 색을 쓰는
  // 연결선끼리는 재사용하도록 캐시해둔다. 커스텀 색이 없으면 기존 공용 #arrowHead를 쓴다.
  const customArrowMarkers = new Set();
  function ensureArrowMarker(color) {
    if (!color) return 'arrowHead';
    const id = 'arrowHead-' + color.replace(/[^a-zA-Z0-9]/g, '');
    if (!customArrowMarkers.has(id)) {
      const defs = canvas.querySelector('defs');
      const marker = svgEl('marker', {
        id, viewBox: '0 0 10 10', refX: 8.5, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse',
      });
      const path = svgEl('path', { d: 'M0,0 L10,5 L0,10 z' });
      path.style.fill = color;
      marker.appendChild(path);
      defs.appendChild(marker);
      customArrowMarkers.add(id);
    }
    return id;
  }

  function buildEdgeEl(edge) {
    const from = state.nodes.find(n => n.id === edge.from);
    const to = state.nodes.find(n => n.id === edge.to);
    const g = svgEl('g', { class: 'edge', 'data-id': edge.id });
    if (!from || !to) return g;
    const { p1, p2, ctrl, ux, uy, px, py } = edgeAnchorPoints(edge, from, to);
    const d = `M${p1.x},${p1.y} Q${ctrl.x},${ctrl.y} ${p2.x},${p2.y}`;

    // 클릭·드래그·연결선 선택을 위한 히트 영역은 말풍선 꼬리에도 그대로 필요.
    const hit = svgEl('path', { d, class: 'edge-hit' });
    g.appendChild(hit);

    if (edge.bubble) {
      // 말풍선 꼬리: 화살표 대신 시작점 쪽은 작고 끝점(말풍선) 쪽으로 갈수록
      // 커지는 점들을 곡선을 따라 늘어놓는다 — 화살표/지연/극성 표시는 쓰지 않는다.
      const dotCount = 5;
      for (let i = 1; i <= dotCount; i++) {
        const t = i / (dotCount + 1);
        const pt = bezierPoint(p1, ctrl, p2, t);
        const r = 1.8 + t * 5.2;
        const dot = svgEl('circle', { cx: pt.x, cy: pt.y, r, class: 'edge-bubble-dot' });
        if (edge.color) dot.style.fill = edge.color;
        g.appendChild(dot);
      }
    } else {
      const line = svgEl('path', { d, class: 'edge-line' });
      if (edge.dashed) line.setAttribute('stroke-dasharray', '7 5');
      if (edge.color) line.style.stroke = edge.color;
      const markerId = ensureArrowMarker(edge.color);
      if (edge.arrowEnd) line.setAttribute('marker-end', `url(#${markerId})`);
      if (edge.arrowStart) line.setAttribute('marker-start', `url(#${markerId})`);
      g.appendChild(line);

      // 인과 지도 표기: 지연 표시(‖, 곡선 중앙을 가로지르는 두 짧은 선)
      if (edge.delay) {
        const mid = bezierPoint(p1, ctrl, p2, 0.5);
        const tickLen = 9, gap = 4;
        for (const off of [-gap, gap]) {
          const bx = mid.x + ux * off, by = mid.y + uy * off;
          const tick = svgEl('line', {
            x1: bx - px * tickLen / 2, y1: by - py * tickLen / 2,
            x2: bx + px * tickLen / 2, y2: by + py * tickLen / 2,
            class: 'edge-delay-mark',
          });
          if (edge.color) tick.style.stroke = edge.color;
          g.appendChild(tick);
        }
      }

      // 극성 표시(+/-): 화살촉 쪽에 가깝게, 선 옆으로 살짝 띄워서 표시
      if (edge.polarity) {
        const q = bezierPoint(p1, ctrl, p2, 0.78);
        const label = svgEl('text', { x: q.x + px * 11, y: q.y + py * 11, class: 'edge-polarity' });
        label.textContent = edge.polarity;
        if (edge.color) label.style.fill = edge.color;
        g.appendChild(label);
      }
    }

    if (edge.label) {
      const mid = bezierPoint(p1, ctrl, p2, 0.5);
      const text = svgEl('text', { x: mid.x, y: mid.y, class: 'edge-label' });
      text.textContent = edge.label;
      g.appendChild(text);
      // measure after insertion into live DOM for accurate bbox
      requestAnimationFrame(() => {
        try {
          const bbox = text.getBBox();
          const bg = svgEl('rect', {
            x: bbox.x - 4, y: bbox.y - 2, width: bbox.width + 8, height: bbox.height + 4,
            rx: 3, class: 'edge-label-bg',
          });
          g.insertBefore(bg, text);
        } catch (e) { /* not yet laid out */ }
      });
    }
    const isSingleSelectedEdge = selection.type === 'edge' && selection.id === edge.id;
    if (isSingleSelectedEdge || isMultiSelected('edge', edge.id)) {
      g.classList.add('selected');
      // 곡률 손잡이도 단일 선택일 때만 (다중 선택 중엔 개별 곡률 조절 대상이 모호함).
      if (isSingleSelectedEdge && tool === 'select') {
        const handle = svgEl('circle', {
          cx: ctrl.x, cy: ctrl.y, r: 6, class: 'bend-handle', 'data-bend': edge.id,
        });
        g.appendChild(handle);
      }
    }
    return g;
  }

  function updateEdgesTouching(nodeId) {
    for (const edge of state.edges) {
      if (edge.from !== nodeId && edge.to !== nodeId) continue;
      const el = edgesLayer.querySelector(`.edge[data-id="${edge.id}"]`);
      if (!el) continue;
      const fresh = buildEdgeEl(edge);
      el.replaceWith(fresh);
    }
  }

  // ===========================================================================================
  // Selection & properties panel
  // ===========================================================================================
  function clearSelection() {
    selection = { type: null, id: null };
    multiSelection = [];
    connectPendingId = null;
    propsPanel.hidden = true;
    document.querySelectorAll('.node.selected, .edge.selected').forEach(el => el.classList.remove('selected'));
    document.querySelectorAll('.resize-handle').forEach(el => el.remove());
  }

  function selectItem(type, id) {
    selection = { type, id };
    multiSelection = [];
    render();
    updatePanel();
  }

  // ---- 다중 선택 -------------------------------------------------------------------------------
  function isMultiSelected(type, id) {
    return multiSelection.some(it => it.type === type && it.id === id);
  }
  // Shift+클릭으로 항목 하나를 토글. 최종적으로 1개만 남으면 일반 단일 선택으로
  // 자연스럽게 넘어가고(속성 패널 전체 기능 사용 가능), 2개 이상이면 다중 선택 모드 유지.
  function toggleMultiSelect(type, id) {
    const idx = multiSelection.findIndex(it => it.type === type && it.id === id);
    if (idx >= 0) multiSelection.splice(idx, 1);
    else {
      // 기존에 단일 선택돼 있던 항목이 있으면 다중 선택 목록으로 흡수.
      if (selection.type && !isMultiSelected(selection.type, selection.id)) {
        multiSelection.push({ type: selection.type, id: selection.id });
      }
      multiSelection.push({ type, id });
    }
    if (multiSelection.length === 1) {
      const only = multiSelection[0];
      selection = { type: only.type, id: only.id };
      multiSelection = [];
    } else {
      selection = { type: null, id: null };
    }
    render();
    updatePanel();
  }

  // ---- Arrow-key navigation between nodes -----------------------------------------------------
  // Lets you hop the selection to the nearest node in a direction — handy
  // once Insert (or manual drawing) has produced a chain of several nodes.
  // Edges are deliberately excluded: their midpoints usually sit almost
  // exactly between two nodes, which would make every hop stop on the
  // connecting edge first instead of reaching the next node.
  function spatialItems() {
    return state.nodes.map(n => ({ type: 'node', id: n.id, c: nodeCenter(n) }));
  }
  function ensureNodeVisible(node) {
    const rect = canvasWrap.getBoundingClientRect();
    const pad = 50;
    const sx = node.x * view.scale + view.x, sy = node.y * view.scale + view.y;
    const sw = node.w * view.scale, sh = node.h * view.scale;
    let dx = 0, dy = 0;
    if (sx < pad) dx = pad - sx;
    else if (sx + sw > rect.width - pad) dx = (rect.width - pad) - (sx + sw);
    if (sy < pad) dy = pad - sy;
    else if (sy + sh > rect.height - pad) dy = (rect.height - pad) - (sy + sh);
    if (dx || dy) { view.x += dx; view.y += dy; applyViewTransform(); }
  }
  function ensureSelectionVisible() {
    if (selection.type === 'node') {
      const node = state.nodes.find(n => n.id === selection.id);
      if (node) ensureNodeVisible(node);
    } else if (selection.type === 'edge') {
      const edge = state.edges.find(e => e.id === selection.id);
      const from = edge && state.nodes.find(n => n.id === edge.from);
      const to = edge && state.nodes.find(n => n.id === edge.to);
      if (from && to) {
        const c1 = nodeCenter(from), c2 = nodeCenter(to);
        ensureNodeVisible({ x: (c1.x + c2.x) / 2 - 1, y: (c1.y + c2.y) / 2 - 1, w: 2, h: 2 });
      }
    }
  }

  function moveSelectionByArrow(dir) {
    const items = spatialItems();
    if (!items.length) return;
    const current = items.find(it => it.type === selection.type && it.id === selection.id);
    if (!current) {
      // Nothing selected (or the selection vanished) — just pick something.
      selectItem(items[0].type, items[0].id);
      ensureSelectionVisible();
      return;
    }
    let best = null, bestScore = Infinity;
    for (const it of items) {
      if (it === current) continue;
      const dx = it.c.x - current.c.x, dy = it.c.y - current.c.y;
      let primary, perp;
      if (dir === 'right') { if (dx <= 0) continue; primary = dx; perp = dy; }
      else if (dir === 'left') { if (dx >= 0) continue; primary = -dx; perp = dy; }
      else if (dir === 'down') { if (dy <= 0) continue; primary = dy; perp = dx; }
      else { if (dy >= 0) continue; primary = -dy; perp = dx; } // 'up'
      const score = primary + Math.abs(perp) * 2;
      if (score < bestScore) { bestScore = score; best = it; }
    }
    if (best) { selectItem(best.type, best.id); ensureSelectionVisible(); }
  }

  function updatePanel() {
    if (multiSelection.length >= 2) { propsPanel.hidden = false; renderMultiPanel(); return; }
    if (!selection.type) { propsPanel.hidden = true; return; }
    propsPanel.hidden = false;
    if (selection.type === 'node') renderNodePanel();
    else renderEdgePanel();
  }

  // 노드 모양을 바꿀 때 가운데 위치는 유지한 채 크기를 새 모양에 맞게 조정.
  function convertNodeShape(node, newShape) {
    const wasTextLike = isTextLikeShape(node.shape);
    const c = nodeCenter(node);
    node.shape = newShape;
    if (isTextLikeShape(newShape)) {
      if (newShape === 'loop' && !node.loopType) node.loopType = 'R';
      if (!node.textColor) node.textColor = cssVar('--text') || '#1c2128';
      const size = measureNodeSize(newShape, node.label, node.loopType, node.fontSize);
      node.w = size.w; node.h = size.h;
    } else {
      const [w, h] = NODE_DEFAULT_SIZES[newShape] || [150, 90];
      node.w = w; node.h = h;
      // fill/stroke는 텍스트 노드였을 때 "글자색" 용도로 쓰였을 수 있으므로
      // (값이 있어도) 도형으로 바뀌는 경우엔 항상 기본 배색으로 되돌린다.
      if (wasTextLike || !node.fill || node.fill === 'transparent') {
        node.fill = defaultFillStroke(newShape).fill;
      }
      if (wasTextLike || !node.stroke) {
        node.stroke = defaultFillStroke(newShape).stroke;
      }
    }
    node.x = c.x - node.w / 2;
    node.y = c.y - node.h / 2;
  }

  function renderNodePanel() {
    const node = state.nodes.find(n => n.id === selection.id);
    if (!node) { clearSelection(); return; }
    panelTitle.textContent = '노드 속성';
    panelBody.innerHTML = '';
    const isTextLike = isTextLikeShape(node.shape);

    panelBody.appendChild(field(node.shape === 'loop' ? '루프 이름 (예: R1, B2)' : '이름', () => {
      const input = document.createElement('input');
      input.type = 'text'; input.value = node.label;
      if (node.shape === 'loop') input.placeholder = '예: R1';
      input.addEventListener('input', () => { setNodeLabel(node, input.value); patchNodeVisual(node); });
      input.addEventListener('change', () => pushHistory());
      return input;
    }));

    panelBody.appendChild(field('모양', () => {
      const sel = document.createElement('select');
      [['rect', '사각형'], ['circle', '원'], ['diamond', '마름모'], ['text', '텍스트'], ['loop', '루프 라벨 (R/B)'], ['bubble', '말풍선']].forEach(([v, l]) => {
        const opt = document.createElement('option'); opt.value = v; opt.textContent = l;
        if (node.shape === v) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener('change', () => { convertNodeShape(node, sel.value); render(); pushHistory(); });
      return sel;
    }));

    if (node.shape === 'loop') {
      panelBody.appendChild(field('루프 유형', () => {
        const sel = document.createElement('select');
        [['R', 'R · 강화(Reinforcing) ↻'], ['B', 'B · 균형(Balancing) ↺']].forEach(([v, l]) => {
          const opt = document.createElement('option'); opt.value = v; opt.textContent = l;
          if ((node.loopType || 'R') === v) opt.selected = true;
          sel.appendChild(opt);
        });
        sel.addEventListener('change', () => {
          node.loopType = sel.value;
          setNodeLabel(node, node.label);
          patchNodeVisual(node);
          pushHistory();
        });
        return sel;
      }));
    }

    if (!isTextLike) {
      const row = document.createElement('div');
      row.className = 'row2';
      row.appendChild(field('채우기 색', () => {
        const input = document.createElement('input');
        input.type = 'color'; input.value = toHex(node.fill);
        input.addEventListener('input', () => { node.fill = input.value; render(); });
        input.addEventListener('change', () => pushHistory());
        return input;
      }));
      row.appendChild(field('테두리 색', () => {
        const input = document.createElement('input');
        input.type = 'color'; input.value = toHex(node.stroke);
        input.addEventListener('input', () => { node.stroke = input.value; render(); });
        input.addEventListener('change', () => pushHistory());
        return input;
      }));
      panelBody.appendChild(row);
    }

    const textRow = document.createElement('div');
    textRow.className = 'row2';
    textRow.appendChild(field('글자 색', () => {
      const input = document.createElement('input');
      input.type = 'color'; input.value = toHex(node.textColor || cssVar('--text') || '#1c2128');
      input.addEventListener('input', () => { node.textColor = input.value; patchNodeVisual(node); });
      input.addEventListener('change', () => pushHistory());
      return input;
    }));
    textRow.appendChild(field('글자 크기', () => {
      const input = document.createElement('input');
      input.type = 'number'; input.min = '8'; input.max = '72'; input.step = '1';
      input.value = node.fontSize || defaultNodeFontSize(node.shape);
      input.addEventListener('input', () => {
        const v = parseInt(input.value, 10);
        node.fontSize = Number.isFinite(v) && v > 0 ? clamp(v, 8, 72) : undefined;
        resizeTextLikeNode(node);
        patchNodeVisual(node);
      });
      input.addEventListener('change', () => pushHistory());
      return input;
    }));
    panelBody.appendChild(textRow);

    const delBtn = document.createElement('button');
    delBtn.className = 'danger-btn';
    delBtn.textContent = '이 노드 삭제';
    delBtn.addEventListener('click', deleteSelection);
    panelBody.appendChild(delBtn);
  }

  function renderEdgePanel() {
    const edge = state.edges.find(e => e.id === selection.id);
    if (!edge) { clearSelection(); return; }
    panelTitle.textContent = '연결선 속성';
    panelBody.innerHTML = '';

    panelBody.appendChild(field('레이블', () => {
      const input = document.createElement('input');
      input.type = 'text'; input.value = edge.label;
      input.placeholder = '예: API 호출';
      input.addEventListener('input', () => { edge.label = input.value; render(); });
      input.addEventListener('change', () => pushHistory());
      return input;
    }));

    panelBody.appendChild(field('선 색', () => {
      const input = document.createElement('input');
      input.type = 'color'; input.value = toHex(edge.color || cssVar('--edge-color') || '#5b6472');
      input.addEventListener('input', () => { edge.color = input.value; patchEdgeColor(edge); });
      input.addEventListener('change', () => pushHistory());
      return input;
    }));

    panelBody.appendChild(field('선 스타일', () => {
      const sel = document.createElement('select');
      const cur = edge.bubble ? 'bubble' : (edge.dashed ? 'dashed' : 'solid');
      [['solid', '실선'], ['dashed', '파선'], ['bubble', '말풍선 꼬리 (⋯○)']].forEach(([v, l]) => {
        const opt = document.createElement('option'); opt.value = v; opt.textContent = l;
        if (cur === v) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener('change', () => {
        edge.bubble = sel.value === 'bubble';
        edge.dashed = sel.value === 'dashed';
        render(); pushHistory();
      });
      return sel;
    }));

    // 말풍선 꼬리는 화살표·극성·지연 표시를 쓰지 않는다 (점만 커지며 이어짐).
    if (!edge.bubble) {
      panelBody.appendChild(field('화살표', () => {
        const sel = document.createElement('select');
        const cur = edge.arrowStart && edge.arrowEnd ? 'both' : edge.arrowEnd ? 'end' : edge.arrowStart ? 'start' : 'none';
        [['end', '단방향 →'], ['both', '양방향 ↔'], ['none', '없음 —']].forEach(([v, l]) => {
          const opt = document.createElement('option'); opt.value = v; opt.textContent = l;
          if (cur === v) opt.selected = true;
          sel.appendChild(opt);
        });
        sel.addEventListener('change', () => {
          edge.arrowEnd = sel.value === 'end' || sel.value === 'both';
          edge.arrowStart = sel.value === 'both';
          render(); pushHistory();
        });
        return sel;
      }));

      // 인과 지도(causal loop diagram) 표기용 극성·지연 표시
      panelBody.appendChild(field('극성 (인과 지도)', () => {
        const sel = document.createElement('select');
        [['', '표시 안 함'], ['+', '+ (같은 방향)'], ['-', '− (반대 방향)']].forEach(([v, l]) => {
          const opt = document.createElement('option'); opt.value = v; opt.textContent = l;
          if ((edge.polarity || '') === v) opt.selected = true;
          sel.appendChild(opt);
        });
        sel.addEventListener('change', () => { edge.polarity = sel.value; render(); pushHistory(); });
        return sel;
      }));

      panelBody.appendChild(field('지연 표시', () => {
        const sel = document.createElement('select');
        [['no', '표시 안 함'], ['yes', '지연 있음 (‖)']].forEach(([v, l]) => {
          const opt = document.createElement('option'); opt.value = v; opt.textContent = l;
          if ((edge.delay ? 'yes' : 'no') === v) opt.selected = true;
          sel.appendChild(opt);
        });
        sel.addEventListener('change', () => { edge.delay = sel.value === 'yes'; render(); pushHistory(); });
        return sel;
      }));
    }

    if (edge.bend) {
      const resetBtn = document.createElement('button');
      resetBtn.className = 'btn';
      resetBtn.textContent = '직선으로 펴기';
      resetBtn.addEventListener('click', () => { edge.bend = 0; render(); pushHistory(); });
      panelBody.appendChild(resetBtn);
    }

    const hintP = document.createElement('p');
    hintP.style.cssText = 'font-size:12px;color:var(--text-muted);margin:0;';
    hintP.textContent = '연결선을 캔버스에서 선택하면 가운데 손잡이를 드래그해 곡률을 조절할 수 있습니다.';
    panelBody.appendChild(hintP);

    const delBtn = document.createElement('button');
    delBtn.className = 'danger-btn';
    delBtn.textContent = '이 연결선 삭제';
    delBtn.addEventListener('click', deleteSelection);
    panelBody.appendChild(delBtn);
  }

  // 패널을 통째로 다시 그리지 않고 색만 반영 — <input type="color">를 드래그하는
  // 도중 계속 발생하는 input 이벤트마다 render()로 패널을 재생성하면 브라우저의
  // 네이티브 색상 선택 팝업이 끊길 수 있어, SVG 쪽만 가볍게 패치한다.
  function patchNodeColor(node) {
    const g = nodesLayer.querySelector(`.node[data-id="${node.id}"]`);
    if (!g) return;
    const shape = g.querySelector('.node-shape');
    if (shape) { shape.setAttribute('fill', node.fill); shape.setAttribute('stroke', node.stroke); }
    const text = g.querySelector('.node-label');
    if (text) applyNodeTextStyle(text, node);
  }

  // 연결선 색도 노드 색과 같은 이유로 <input type=color> 드래그 중엔 패널을
  // 통째로 다시 그리지 않고 SVG만 가볍게 패치한다.
  function patchEdgeColor(edge) {
    const g = edgesLayer.querySelector(`.edge[data-id="${edge.id}"]`);
    if (!g) return;
    const line = g.querySelector('.edge-line');
    if (line) {
      line.style.stroke = edge.color || '';
      const markerId = ensureArrowMarker(edge.color);
      if (edge.arrowEnd) line.setAttribute('marker-end', `url(#${markerId})`);
      if (edge.arrowStart) line.setAttribute('marker-start', `url(#${markerId})`);
    }
    g.querySelectorAll('.edge-delay-mark').forEach(el => { el.style.stroke = edge.color || ''; });
    const polarity = g.querySelector('.edge-polarity');
    if (polarity) polarity.style.fill = edge.color || '';
    g.querySelectorAll('.edge-bubble-dot').forEach(el => { el.style.fill = edge.color || ''; });
  }

  function renderMultiPanel() {
    panelTitle.textContent = `${multiSelection.length}개 선택됨`;
    panelBody.innerHTML = '';

    const nodeItems = multiSelection.filter(it => it.type === 'node');
    const edgeItems = multiSelection.filter(it => it.type === 'edge');

    const summary = document.createElement('p');
    summary.style.cssText = 'font-size:12px;color:var(--text-muted);margin:0;';
    summary.textContent = `노드 ${nodeItems.length}개 · 연결선 ${edgeItems.length}개`;
    panelBody.appendChild(summary);

    if (nodeItems.length > 0) {
      const hasShaped = nodeItems.some(it => {
        const n = state.nodes.find(x => x.id === it.id);
        return n && !isTextLikeShape(n.shape);
      });
      if (hasShaped) {
        panelBody.appendChild(field('채우기 색 (선택한 노드 전체)', () => {
          const input = document.createElement('input');
          input.type = 'color'; input.value = cssVar('--node-fill') || '#eef2ff';
          input.addEventListener('input', () => {
            for (const it of nodeItems) {
              const node = state.nodes.find(n => n.id === it.id);
              if (node && !isTextLikeShape(node.shape)) { node.fill = input.value; patchNodeColor(node); }
            }
          });
          input.addEventListener('change', () => pushHistory());
          return input;
        }));
      }
      panelBody.appendChild(field('테두리·글자 색 (선택한 노드 전체)', () => {
        const input = document.createElement('input');
        input.type = 'color'; input.value = cssVar('--node-stroke') || '#4f6df5';
        input.addEventListener('input', () => {
          for (const it of nodeItems) {
            const node = state.nodes.find(n => n.id === it.id);
            if (!node) continue;
            if (isTextLikeShape(node.shape)) node.textColor = input.value; else node.stroke = input.value;
            patchNodeColor(node);
          }
        });
        input.addEventListener('change', () => pushHistory());
        return input;
      }));
    }

    if (nodeItems.length >= 2) {
      const alignLabel = document.createElement('p');
      alignLabel.className = 'panel-section-label';
      alignLabel.textContent = '정렬';
      panelBody.appendChild(alignLabel);

      const alignGrid = document.createElement('div');
      alignGrid.className = 'align-grid';
      const alignBtns = [
        ['왼쪽 맞춤', 'left'], ['가로 중앙', 'center-x'], ['오른쪽 맞춤', 'right'],
        ['위쪽 맞춤', 'top'], ['세로 중앙', 'center-y'], ['아래쪽 맞춤', 'bottom'],
      ];
      for (const [label, mode] of alignBtns) {
        const b = document.createElement('button');
        b.className = 'align-btn';
        b.type = 'button';
        b.textContent = label;
        b.addEventListener('click', () => alignNodes(mode));
        alignGrid.appendChild(b);
      }
      panelBody.appendChild(alignGrid);

      if (nodeItems.length >= 3) {
        const distGrid = document.createElement('div');
        distGrid.className = 'align-grid align-grid-2';
        const distBtns = [['가로 균등 배치', 'distribute-x'], ['세로 균등 배치', 'distribute-y']];
        for (const [label, mode] of distBtns) {
          const b = document.createElement('button');
          b.className = 'align-btn';
          b.type = 'button';
          b.textContent = label;
          b.addEventListener('click', () => alignNodes(mode));
          distGrid.appendChild(b);
        }
        panelBody.appendChild(distGrid);
      }

      const groupLabel = document.createElement('p');
      groupLabel.className = 'panel-section-label';
      groupLabel.textContent = '그룹';
      panelBody.appendChild(groupLabel);

      const hasGroupedMember = nodeItems.some(it => {
        const n = state.nodes.find(x => x.id === it.id);
        return n && n.groupId;
      });
      const groupBtn = document.createElement('button');
      groupBtn.className = 'btn';
      groupBtn.type = 'button';
      groupBtn.textContent = '그룹으로 묶기';
      groupBtn.addEventListener('click', groupSelection);
      panelBody.appendChild(groupBtn);

      if (hasGroupedMember) {
        const ungroupBtn = document.createElement('button');
        ungroupBtn.className = 'btn';
        ungroupBtn.type = 'button';
        ungroupBtn.textContent = '그룹 해제';
        ungroupBtn.addEventListener('click', ungroupSelection);
        panelBody.appendChild(ungroupBtn);
      }

      const loopLabel = document.createElement('p');
      loopLabel.className = 'panel-section-label';
      loopLabel.textContent = '순환 구조';
      panelBody.appendChild(loopLabel);

      const loopBtn = document.createElement('button');
      loopBtn.className = 'btn';
      loopBtn.type = 'button';
      loopBtn.textContent = '고리 만들기';
      loopBtn.title = '마지막 노드에서 첫 노드로 연결을 만들어 순환 구조로 바꿉니다 (Ctrl+Shift+L)';
      loopBtn.addEventListener('click', closeLoop);
      panelBody.appendChild(loopBtn);
    }

    const hintP = document.createElement('p');
    hintP.style.cssText = 'font-size:12px;color:var(--text-muted);margin:0;';
    hintP.textContent = 'Shift+클릭으로 선택을 추가·제거하거나 Shift+드래그로 영역을 지정해 여러 요소를 한꺼번에 담을 수 있습니다. 선택된 노드를 드래그하면 함께 이동합니다. 그룹으로 묶으면 이후 아무 멤버나 클릭해도 전체가 함께 선택됩니다.';
    panelBody.appendChild(hintP);

    const delBtn = document.createElement('button');
    delBtn.className = 'danger-btn';
    delBtn.textContent = `선택한 ${multiSelection.length}개 삭제`;
    delBtn.addEventListener('click', deleteSelection);
    panelBody.appendChild(delBtn);
  }

  function field(labelText, buildInput) {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const label = document.createElement('label');
    label.textContent = labelText;
    wrap.appendChild(label);
    wrap.appendChild(buildInput());
    return wrap;
  }

  function toHex(color) {
    if (/^#[0-9a-f]{6}$/i.test(color)) return color;
    // fall back for named/rgb colors: paint on canvas to normalize
    const d = document.createElement('div');
    d.style.color = color;
    document.body.appendChild(d);
    const rgb = getComputedStyle(d).color.match(/\d+/g);
    document.body.removeChild(d);
    if (!rgb) return '#4f6df5';
    return '#' + rgb.slice(0, 3).map(n => (+n).toString(16).padStart(2, '0')).join('');
  }

  // 텍스트·루프 노드는 글자가 바뀌면 박스 크기(가운데 정렬 유지)도 다시 잰다.
  function setNodeLabel(node, text) {
    node.label = text;
    if (isTextLikeShape(node.shape)) {
      const c = nodeCenter(node);
      const { w, h } = measureNodeSize(node.shape, node.label, node.loopType, node.fontSize);
      node.w = w; node.h = h;
      node.x = c.x - w / 2; node.y = c.y - h / 2;
    }
  }

  // 텍스트·루프 노드는 글자 크기가 바뀌면 박스도 그에 맞춰 다시 계산해야 한다.
  function resizeTextLikeNode(node) {
    if (!isTextLikeShape(node.shape)) return;
    const c = nodeCenter(node);
    const { w, h } = measureNodeSize(node.shape, node.label, node.loopType, node.fontSize);
    node.w = w; node.h = h;
    node.x = c.x - w / 2; node.y = c.y - h / 2;
  }

  // 속성 패널의 입력창은 SVG 밖에 있으므로, 매 타이핑마다 render()로 패널까지
  // 통째로 다시 그리면 입력 포커스가 끊긴다 — SVG 쪽만 가볍게 갱신한다.
  function patchNodeVisual(node) {
    const g = nodesLayer.querySelector(`.node[data-id="${node.id}"]`);
    if (g) {
      g.setAttribute('transform', `translate(${node.x} ${node.y})`);
      const text = g.querySelector('.node-label');
      if (text) {
        text.setAttribute('x', node.w / 2);
        text.setAttribute('y', node.h / 2);
        text.textContent = nodeDisplayText(node);
        applyNodeTextStyle(text, node);
      }
      const box = g.querySelector('.text-select-box');
      if (box) setAttrs(box, { x: -4, y: -4, width: node.w + 8, height: node.h + 8 });
      // 텍스트·루프 노드는 배경 도형이 없어 클릭 판정용 투명 히트 영역(.node-hit)의
      // 크기도 글자 크기·내용 변화에 맞춰 같이 늘어나야 한다 (안 그러면 커진 글자의
      // 바깥쪽을 클릭했을 때 선택이 안 됨).
      if (isTextLikeShape(node.shape)) {
        const hit = g.querySelector('.node-hit');
        if (hit) setAttrs(hit, { width: node.w, height: node.h });
      }
    }
    updateEdgesTouching(node.id);
  }

  // ===========================================================================================
  // Inline label editing (double-click)
  // ===========================================================================================
  function startInlineEdit(type, id) {
    let worldRect, currentText, commit;
    if (type === 'node') {
      const node = state.nodes.find(n => n.id === id);
      if (!node) return;
      worldRect = { x: node.x, y: node.y, w: node.w, h: node.h };
      currentText = node.label;
      commit = (val) => { setNodeLabel(node, val); render(); pushHistory(); };
    } else {
      const edge = state.edges.find(e => e.id === id);
      if (!edge) return;
      const from = state.nodes.find(n => n.id === edge.from);
      const to = state.nodes.find(n => n.id === edge.to);
      if (!from || !to) return;
      const c1 = nodeCenter(from), c2 = nodeCenter(to);
      const mx = (c1.x + c2.x) / 2, my = (c1.y + c2.y) / 2;
      worldRect = { x: mx - 70, y: my - 12, w: 140, h: 24 };
      currentText = edge.label;
      commit = (val) => { edge.label = val; render(); pushHistory(); };
    }
    const rect = canvas.getBoundingClientRect();
    const screenX = worldRect.x * view.scale + view.x + rect.left;
    const screenY = worldRect.y * view.scale + view.y + rect.top;
    const input = document.createElement('input');
    input.className = 'edit-input';
    input.value = currentText;
    input.style.left = screenX + 'px';
    input.style.top = screenY + 'px';
    input.style.width = Math.max(40, worldRect.w * view.scale) + 'px';
    document.body.appendChild(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return; done = true;
      if (save) commit(input.value.trim());
      input.remove();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
      e.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
  }

  // ===========================================================================================
  // Pointer interaction
  // ===========================================================================================
  let drag = null; // {type, ...}
  const activePointers = new Map(); // pointerId -> {x,y} — 모바일 두 손가락 핀치 확대/축소 추적용
  let pinch = null; // { startDist, baseScale }
  let lastClick = null; // {type, id, time} — manual double-click/tap detection.
  // Chromium suppresses the native `dblclick` event when the first click's
  // pointerdown called setPointerCapture (as ours does for drag/pan), which
  // affects both real touch input and automated testing — so double-click
  // editing is detected manually here instead of relying on `dblclick`.
  function checkDoubleClick(type, id) {
    const now = Date.now();
    const isDouble = lastClick && lastClick.type === type && lastClick.id === id && (now - lastClick.time) < 400;
    lastClick = isDouble ? null : { type, id, time: now };
    return isDouble;
  }

  canvas.addEventListener('pointerdown', (evt) => {
    if (evt.button === 2) return;
    // Prevent the browser's default focus/drag/text-selection handling for
    // this pointerdown — otherwise Chrome reasserts focus on `canvas` right
    // after we focus() an inline-edit <input>, which immediately blurs it.
    evt.preventDefault();

    // 두 손가락 핀치 확대/축소: 두 번째 손가락이 닿는 순간 감지해서, 진행 중이던
    // 단일 포인터 동작(패닝 등)을 취소하고 핀치 모드로 전환한다.
    if (evt.pointerType === 'touch') {
      activePointers.set(evt.pointerId, { x: evt.clientX, y: evt.clientY });
      if (activePointers.size === 2) {
        drag = null;
        canvas.classList.remove('panning');
        for (const pid of activePointers.keys()) {
          try { canvas.setPointerCapture(pid); } catch (e) {}
        }
        const pts = [...activePointers.values()];
        pinch = { startDist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), baseScale: view.scale };
        return;
      }
      if (activePointers.size > 2) return; // 세 손가락 이상은 무시
    }

    const target = evt.target;
    const resizeHandle = target.closest && target.closest('[data-resize]');
    const bendHandle = target.closest && target.closest('[data-bend]');
    const nodeGroup = target.closest && target.closest('.node');
    const edgeGroup = target.closest && target.closest('.edge');
    const world = worldFromEvent(evt);

    if (SHAPE_TOOLS.includes(tool)) {
      const placedShape = tool;
      const created = addNode(placedShape, world.x, world.y);
      setTool('select');
      // 텍스트·루프·말풍선 노드는 놓자마자 라벨을 입력하도록 바로 편집 모드로 진입.
      if (placedShape === 'text' || placedShape === 'loop' || placedShape === 'bubble') startInlineEdit('node', created.id);
      return;
    }

    if (tool === 'connect') {
      if (nodeGroup) {
        const id = nodeGroup.dataset.id;
        if (!connectPendingId) {
          connectPendingId = id;
          render();
        } else if (connectPendingId === id) {
          connectPendingId = null;
          render();
        } else {
          const fromId = connectPendingId;
          connectPendingId = null;
          addEdge(fromId, id);
        }
      } else {
        connectPendingId = null;
        render();
      }
      return;
    }

    // select tool
    if (resizeHandle) {
      const node = state.nodes.find(n => n.id === resizeHandle.dataset.resize);
      if (!node) return;
      drag = { type: 'resize', id: node.id, startW: node.w, startH: node.h, startWorld: world };
      canvas.setPointerCapture(evt.pointerId);
      return;
    }
    if (bendHandle) {
      const edge = state.edges.find(e => e.id === bendHandle.dataset.bend);
      const from = edge && state.nodes.find(n => n.id === edge.from);
      const to = edge && state.nodes.find(n => n.id === edge.to);
      if (!edge || !from || !to) return;
      const { p1, p2, px, py } = edgeAnchorPoints(edge, from, to);
      const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      drag = { type: 'bend', id: edge.id, mid, perp: { x: px, y: py } };
      canvas.setPointerCapture(evt.pointerId);
      return;
    }
    // Shift+클릭: 항목을 다중 선택 목록에 토글 (드래그는 시작하지 않음).
    if (evt.shiftKey && nodeGroup) {
      toggleMultiSelect('node', nodeGroup.dataset.id);
      return;
    }
    if (evt.shiftKey && edgeGroup) {
      toggleMultiSelect('edge', edgeGroup.dataset.id);
      return;
    }
    // Shift+빈 곳 드래그: 사각 영역(마퀴)으로 여러 노드를 한꺼번에 담는다.
    if (evt.shiftKey && !nodeGroup && !edgeGroup) {
      const rect = svgEl('rect', { x: world.x, y: world.y, width: 0, height: 0, class: 'marquee-rect' });
      overlayLayer.appendChild(rect);
      drag = { type: 'marquee', start: world, el: rect };
      canvas.setPointerCapture(evt.pointerId);
      return;
    }
    if (nodeGroup) {
      const node = state.nodes.find(n => n.id === nodeGroup.dataset.id);
      if (!node) return;
      // 그룹으로 묶인 노드는 (Shift 없이) 하나만 눌러도 그룹 전체가 선택된다.
      if (node.groupId) {
        const members = state.nodes.filter(n => n.groupId === node.groupId);
        if (members.length >= 2) {
          multiSelection = members.map(n => ({ type: 'node', id: n.id }));
          selection = { type: null, id: null };
        } else {
          // 멤버가 하나뿐이면 의미 없는 그룹이니 정리하고 평범한 단일 선택으로.
          delete node.groupId;
          multiSelection = [];
          selection = { type: 'node', id: node.id };
        }
        render();
        updatePanel();
      }
      // 이미 다중 선택된(혹은 방금 그룹 전체가 선택된) 노드를 (Shift 없이) 누르면
      // 선택 그룹 전체를 함께 드래그할 수 있게 한다 — 임시 다중 선택은 움직이지
      // 않고 떼면 그 노드 하나로 선택이 좁혀지고, 정식 그룹은 그대로 유지된다.
      if (multiSelection.length >= 2 && isMultiSelected('node', node.id)) {
        const offsets = multiSelection
          .filter(it => it.type === 'node')
          .map(it => {
            const n = state.nodes.find(x => x.id === it.id);
            return n ? { id: n.id, offX: world.x - n.x, offY: world.y - n.y } : null;
          })
          .filter(Boolean);
        drag = { type: 'move-multi', offsets, clickedId: node.id, moved: false, isGroup: !!node.groupId };
        canvas.setPointerCapture(evt.pointerId);
        return;
      }
      selectItem('node', node.id);
      if (checkDoubleClick('node', node.id)) { startInlineEdit('node', node.id); return; }
      drag = { type: 'move', id: node.id, offX: world.x - node.x, offY: world.y - node.y, moved: false };
      canvas.setPointerCapture(evt.pointerId);
      return;
    }
    if (edgeGroup) {
      selectItem('edge', edgeGroup.dataset.id);
      if (checkDoubleClick('edge', edgeGroup.dataset.id)) { startInlineEdit('edge', edgeGroup.dataset.id); }
      return;
    }
    // empty space -> pan, clear selection
    clearSelection();
    drag = { type: 'pan', startClientX: evt.clientX, startClientY: evt.clientY, startViewX: view.x, startViewY: view.y };
    canvas.classList.add('panning');
    canvas.setPointerCapture(evt.pointerId);
  });

  canvas.addEventListener('pointermove', (evt) => {
    if (evt.pointerType === 'touch' && activePointers.has(evt.pointerId)) {
      activePointers.set(evt.pointerId, { x: evt.clientX, y: evt.clientY });
    }
    if (pinch && activePointers.size === 2) {
      const pts = [...activePointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const midX = (pts[0].x + pts[1].x) / 2, midY = (pts[0].y + pts[1].y) / 2;
      const rect = canvas.getBoundingClientRect();
      const lx = midX - rect.left, ly = midY - rect.top;
      const worldX = (lx - view.x) / view.scale, worldY = (ly - view.y) / view.scale;
      view.scale = clamp(pinch.baseScale * (dist / pinch.startDist), 0.15, 3);
      view.x = lx - worldX * view.scale;
      view.y = ly - worldY * view.scale;
      applyViewTransform();
      return;
    }
    if (!drag) return;
    if (drag.type === 'pan') {
      view.x = drag.startViewX + (evt.clientX - drag.startClientX);
      view.y = drag.startViewY + (evt.clientY - drag.startClientY);
      applyViewTransform();
    } else if (drag.type === 'move') {
      const world = worldFromEvent(evt);
      const node = state.nodes.find(n => n.id === drag.id);
      if (!node) return;
      node.x = world.x - drag.offX;
      node.y = world.y - drag.offY;
      drag.moved = true;
      const g = nodesLayer.querySelector(`.node[data-id="${node.id}"]`);
      if (g) g.setAttribute('transform', `translate(${node.x} ${node.y})`);
      updateEdgesTouching(node.id);
    } else if (drag.type === 'resize') {
      const node = state.nodes.find(n => n.id === drag.id);
      if (!node) return;
      const world = worldFromEvent(evt);
      node.w = clamp(drag.startW + (world.x - drag.startWorld.x), 40, 2000);
      node.h = clamp(drag.startH + (world.y - drag.startWorld.y), 30, 2000);
      const g = nodesLayer.querySelector(`.node[data-id="${node.id}"]`);
      if (g) {
        g.querySelector('.node-shape')?.remove();
        g.prepend(shapeEl(node));
        const text = g.querySelector('.node-label');
        if (text) { text.setAttribute('x', node.w / 2); text.setAttribute('y', node.h / 2); }
        const handle = g.querySelector('[data-resize]');
        if (handle) { handle.setAttribute('x', node.w - 8); handle.setAttribute('y', node.h - 8); }
      }
      updateEdgesTouching(node.id);
    } else if (drag.type === 'bend') {
      const edge = state.edges.find(e => e.id === drag.id);
      if (!edge) return;
      const world = worldFromEvent(evt);
      const relX = world.x - drag.mid.x, relY = world.y - drag.mid.y;
      edge.bend = relX * drag.perp.x + relY * drag.perp.y;
      const el = edgesLayer.querySelector(`.edge[data-id="${edge.id}"]`);
      if (el) el.replaceWith(buildEdgeEl(edge));
    } else if (drag.type === 'move-multi') {
      const world = worldFromEvent(evt);
      drag.moved = true;
      for (const off of drag.offsets) {
        const node = state.nodes.find(n => n.id === off.id);
        if (!node) continue;
        node.x = world.x - off.offX;
        node.y = world.y - off.offY;
        const g = nodesLayer.querySelector(`.node[data-id="${node.id}"]`);
        if (g) g.setAttribute('transform', `translate(${node.x} ${node.y})`);
        updateEdgesTouching(node.id);
      }
    } else if (drag.type === 'marquee') {
      const world = worldFromEvent(evt);
      const x = Math.min(drag.start.x, world.x), y = Math.min(drag.start.y, world.y);
      const w = Math.abs(world.x - drag.start.x), h = Math.abs(world.y - drag.start.y);
      setAttrs(drag.el, { x, y, width: w, height: h });
    }
  });

  function endDrag(evt) {
    if (evt.pointerType === 'touch') {
      activePointers.delete(evt.pointerId);
      if (pinch && activePointers.size < 2) pinch = null;
    }
    if (!drag) return;
    const wasStructural = drag.type === 'move' || drag.type === 'resize' || drag.type === 'bend' || (drag.type === 'move-multi' && drag.moved);
    const wasBend = drag.type === 'bend';
    const finishedDrag = drag;
    canvas.classList.remove('panning');
    try { canvas.releasePointerCapture(evt.pointerId); } catch (e) {}
    drag = null;

    if (finishedDrag.type === 'move-multi') {
      if (!finishedDrag.moved && !finishedDrag.isGroup) {
        // 그냥 클릭이었다면(안 움직였으면) 임시 다중 선택은 그 노드 하나로 좁힌다.
        // 단, 영구 그룹은 클릭만 해도 전체가 계속 선택된 상태를 유지한다.
        selectItem('node', finishedDrag.clickedId);
      }
    } else if (finishedDrag.type === 'marquee') {
      const x = parseFloat(finishedDrag.el.getAttribute('x'));
      const y = parseFloat(finishedDrag.el.getAttribute('y'));
      const w = parseFloat(finishedDrag.el.getAttribute('width'));
      const h = parseFloat(finishedDrag.el.getAttribute('height'));
      finishedDrag.el.remove();
      // 노드 중심점이 마퀴 영역 안에 들어오면 선택 — 살짝 스친 정도로는 안 딸려오게.
      const picked = state.nodes
        .filter(n => {
          const c = nodeCenter(n);
          return c.x >= x && c.x <= x + w && c.y >= y && c.y <= y + h;
        })
        .map(n => ({ type: 'node', id: n.id }));
      if (picked.length >= 2) {
        multiSelection = picked;
        selection = { type: null, id: null };
      } else if (picked.length === 1) {
        selection = { type: 'node', id: picked[0].id };
        multiSelection = [];
      } else {
        clearSelection();
      }
      render();
      updatePanel();
    }

    if (wasStructural) pushHistory();
    // 곡률을 드래그하는 동안은 패널을 건드리지 않다가, 끝나면 "직선으로 펴기"
    // 버튼이 새 bend 값에 맞춰 나타나도록 패널을 갱신한다.
    if (wasBend) updatePanel();
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  canvas.addEventListener('wheel', (evt) => {
    evt.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const lx = evt.clientX - rect.left, ly = evt.clientY - rect.top;
    const worldX = (lx - view.x) / view.scale, worldY = (ly - view.y) / view.scale;
    const factor = evt.deltaY < 0 ? 1.1 : 1 / 1.1;
    view.scale = clamp(view.scale * factor, 0.15, 3);
    view.x = lx - worldX * view.scale;
    view.y = ly - worldY * view.scale;
    applyViewTransform();
  }, { passive: false });

  // ===========================================================================================
  // Toolbar / top bar wiring
  // ===========================================================================================
  function setTool(name) {
    tool = name;
    connectPendingId = null;
    document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
      btn.setAttribute('aria-pressed', String(btn.dataset.tool === name));
    });
    canvas.classList.toggle('tool-connect', name === 'connect');
    canvas.classList.toggle('tool-add', SHAPE_TOOLS.includes(name));
    const hints = {
      select: '요소를 클릭해 선택하거나 드래그해 이동하세요. 빈 곳을 드래그하면 화면이 이동합니다. Shift+클릭이나 Shift+드래그로 여러 요소를 한꺼번에 선택할 수 있습니다. 방향키로 요소 사이를 이동하고, Insert 키로 동일한 노드를 추가·연결할 수 있습니다.',
      rect: '캔버스를 클릭해 사각형 노드를 추가하세요.',
      circle: '캔버스를 클릭해 원형 노드를 추가하세요.',
      diamond: '캔버스를 클릭해 마름모 노드를 추가하세요.',
      text: '캔버스를 클릭해 테두리 없는 텍스트 노드를 추가하세요. 인과 지도의 변수명 표기에 적합합니다.',
      loop: '캔버스를 클릭해 루프 라벨(R11, B7 등)을 추가하세요. 속성 패널에서 강화(R)/균형(B)을 선택할 수 있습니다.',
      bubble: '캔버스를 클릭해 말풍선(회색 주석 노드)을 추가하세요. 연결선을 "말풍선 꼬리" 스타일로 설정하면 화살표 대신 점점 커지는 점으로 이어집니다.',
      connect: '연결할 시작 노드를 클릭한 다음 도착 노드를 클릭하세요. 선택 후 가운데 손잡이를 드래그하면 곡선으로 휘어집니다. (Esc로 취소)',
    };
    hintEl.textContent = hints[name] || hints.select;
    render();
  }

  // 모바일(좁은 화면)에서 도형 도구를 탭하면, 캔버스를 다시 탭하지 않고
  // 바로 화면 가운데에 노드를 놓는다 — 확대/축소했던 배율도 기본값(100%)으로
  // 되돌리되, 방금 보던 자리가 그대로 화면 중앙에 오도록 축척만 바꾼다.
  // (작은 화면에서 정확한 위치를 두 번 탭해 지정하기 어렵기 때문 — 놓은 뒤
  // 손가락으로 끌어 원하는 위치로 옮기는 편이 더 쉽다.)
  function addNodeMobileCentered(shape) {
    // 먼저 select 도구로 전환해 하단 힌트 문구를 최종 상태로 안정시킨다 — 안
    // 그러면 지금 이 도구의 짧은 힌트 문구 높이 기준으로 중앙을 계산했다가,
    // select 힌트 문구가 더 길어 줄바꿈되며 캔버스 높이가 바뀌어 살짝 어긋난다.
    setTool('select');
    const rect = canvasWrap.getBoundingClientRect();
    const cx = rect.width / 2, cy = rect.height / 2;
    const worldCenter = { x: (cx - view.x) / view.scale, y: (cy - view.y) / view.scale };
    view.scale = 1;
    view.x = cx - worldCenter.x * view.scale;
    view.y = cy - worldCenter.y * view.scale;
    applyViewTransform();
    const created = addNode(shape, worldCenter.x, worldCenter.y);
    if (shape === 'text' || shape === 'loop' || shape === 'bubble') startInlineEdit('node', created.id);
  }

  document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.tool;
      if (SHAPE_TOOLS.includes(t) && isMobileViewport()) addNodeMobileCentered(t);
      else setTool(t);
    });
  });

  document.getElementById('btnDelete').addEventListener('click', deleteSelection);
  document.getElementById('btnUndo').addEventListener('click', undo);
  document.getElementById('btnRedo').addEventListener('click', redo);
  document.getElementById('btnZoomIn').addEventListener('click', () => zoomBy(1.2));
  document.getElementById('btnZoomOut').addEventListener('click', () => zoomBy(1 / 1.2));
  document.getElementById('btnZoomReset').addEventListener('click', zoomToFit);
  document.getElementById('panelClose').addEventListener('click', clearSelection);
  // 패널 안의 빈 여백(필드 사이 간격, 헤더 제목, 안내 문구 등 — 입력칸·버튼·
  // 드롭다운이 아닌 곳)을 눌러도 선택 해제. 모바일에서는 패널이 캔버스 대부분을
  // 덮어버려 "빈 캔버스를 눌러 선택 해제"할 자리가 거의 남지 않기 때문에 필요함.
  // 단, 캔버스에서 시작된 드래그(노드 이동 등)가 패널 쪽에서 끝나며 발생하는
  // click까지 반응하면 안 되므로 — pointerdown도 패널 빈 곳에서 시작됐을 때만
  // 인정한다 (캔버스에서 노드를 끌어 패널 밑으로 옮겨 넣고 손을 뗄 때 실수로
  // 선택이 풀리는 것을 방지).
  let panelBlankPointerDown = false;
  propsPanel.addEventListener('pointerdown', (evt) => {
    panelBlankPointerDown = !evt.target.closest('input, select, textarea, button, a');
  });
  propsPanel.addEventListener('click', (evt) => {
    if (panelBlankPointerDown && !evt.target.closest('input, select, textarea, button, a')) clearSelection();
    panelBlankPointerDown = false;
  });

  function zoomBy(factor) {
    const rect = canvasWrap.getBoundingClientRect();
    const cx = rect.width / 2, cy = rect.height / 2;
    const worldX = (cx - view.x) / view.scale, worldY = (cy - view.y) / view.scale;
    view.scale = clamp(view.scale * factor, 0.15, 3);
    view.x = cx - worldX * view.scale;
    view.y = cy - worldY * view.scale;
    applyViewTransform();
  }

  mapTitleInput.addEventListener('input', () => { state.title = mapTitleInput.value; updateActiveTabLabel(); });
  mapTitleInput.addEventListener('change', () => pushHistory());

  // "새로 만들기"는 현재 지도를 지우는 대신 새 탭을 열어 기존 지도를 그대로 남겨둔다.
  document.getElementById('btnNew').addEventListener('click', addNewTabAndSwitch);

  // 드롭다운 메뉴(원형/내보내기)를 트리거 버튼 기준으로 열되, 화면 밖으로
  // 잘리지 않도록 뷰포트 안쪽으로 clamp한다. 모바일에서 트리거 버튼이
  // 툴바 중간에 위치해 `right:0` 앵커만으로는 왼쪽 가장자리가 잘리는
  // 문제(첨부 스크린샷)를 해결하기 위함.
  function positionDropdownMenu(menu, trigger) {
    const margin = 8;
    const triggerRect = trigger.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = (triggerRect.bottom + 6) + 'px';
    menu.style.right = 'auto';
    menu.style.left = '0px';
    const menuWidth = menu.offsetWidth;
    let left = triggerRect.right - menuWidth;
    left = Math.max(margin, Math.min(left, window.innerWidth - menuWidth - margin));
    menu.style.left = left + 'px';
  }

  // 시스템 원형(archetype) 템플릿 드롭다운
  const archetypeMenu = document.getElementById('archetypeMenu');
  for (const tpl of ARCHETYPE_TEMPLATES) {
    const btn = document.createElement('button');
    const nameRow = document.createElement('span');
    nameRow.className = 'archetype-name-row';
    const nameEl = document.createElement('span');
    nameEl.className = 'archetype-name';
    nameEl.textContent = tpl.name;
    nameRow.appendChild(nameEl);
    if (!tpl.implemented) {
      const badge = document.createElement('span');
      badge.className = 'archetype-badge';
      badge.textContent = '구현중';
      nameRow.appendChild(badge);
    }
    const subEl = document.createElement('span');
    subEl.className = 'archetype-subtitle';
    subEl.textContent = tpl.subtitle;
    btn.appendChild(nameRow);
    btn.appendChild(subEl);
    if (tpl.implemented) {
      btn.addEventListener('click', () => { insertTemplate(tpl); archetypeMenu.hidden = true; });
    } else {
      // 아직 다듬는 중인 원형 — 목록에는 보이되 선택은 막아둔다.
      btn.disabled = true;
      btn.classList.add('archetype-disabled');
    }
    archetypeMenu.appendChild(btn);
  }
  document.getElementById('btnArchetype').addEventListener('click', (e) => {
    e.stopPropagation();
    exportMenu.hidden = true;
    const willOpen = archetypeMenu.hidden;
    archetypeMenu.hidden = !archetypeMenu.hidden;
    if (willOpen) positionDropdownMenu(archetypeMenu, e.currentTarget);
  });

  // Export dropdown
  const exportMenu = document.getElementById('exportMenu');
  document.getElementById('btnExport').addEventListener('click', (e) => {
    e.stopPropagation();
    archetypeMenu.hidden = true;
    const willOpen = exportMenu.hidden;
    exportMenu.hidden = !exportMenu.hidden;
    if (willOpen) positionDropdownMenu(exportMenu, e.currentTarget);
  });
  document.addEventListener('click', () => { exportMenu.hidden = true; archetypeMenu.hidden = true; });
  window.addEventListener('resize', () => {
    if (!archetypeMenu.hidden) positionDropdownMenu(archetypeMenu, document.getElementById('btnArchetype'));
    if (!exportMenu.hidden) positionDropdownMenu(exportMenu, document.getElementById('btnExport'));
  });

  document.getElementById('btnExportJson').addEventListener('click', () => {
    exportFile(`${exportBaseName()}.json`, 'JSON 파일', { 'application/json': ['.json'] },
      () => new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }));
  });
  document.getElementById('btnExportSvg').addEventListener('click', exportSVG);
  document.getElementById('btnExportPng').addEventListener('click', exportPNG);

  document.getElementById('btnImport').addEventListener('click', () => document.getElementById('fileInput').click());
  document.getElementById('fileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) throw new Error('invalid');
        // 현재 탭을 덮어쓰지 않고 새 탭에 불러와서, 작업 중이던 지도를 잃지 않게 한다.
        openInNewTab({ title: data.title || '가져온 지도', nodes: data.nodes, edges: data.edges });
      } catch (err) {
        alert('올바른 JSON 지도 파일이 아닙니다.');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  function safeName(name) {
    return (name || 'sysmap').trim().replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'sysmap';
  }

  // 내보내기 파일 이름 기본값: 탭(지도) 이름을 기본값("새 시스템 지도")에서 직접 바꿔뒀다면
  // 그 이름을 최우선으로 쓴다. 아직 이름을 따로 정하지 않았다면, 사각형 노드가 정확히
  // 하나뿐일 때 그 노드의 텍스트를 쓰고, 그 외에는 지도 제목(기본값)을 그대로 쓴다.
  function exportBaseName() {
    const title = (state.title || '').trim();
    if (title && title !== DEFAULT_MAP_TITLE) return safeName(title);
    const rectNodes = state.nodes.filter(n => n.shape === 'rect');
    if (rectNodes.length === 1 && rectNodes[0].label && rectNodes[0].label.trim()) {
      return safeName(rectNodes[0].label);
    }
    return safeName(state.title);
  }

  // 내보내기 파일을 저장한다. 지원하는 브라우저(Chrome/Edge 등)에서는
  // showSaveFilePicker로 네이티브 "다른 이름으로 저장" 대화상자를 띄워 사용자가 위치·파일명을
  // 직접 고를 수 있게 하고, 지원하지 않는 브라우저(Firefox, Safari 등)에서는 기존처럼
  // <a download> 방식으로 즉시 다운로드한다.
  // buildBlob: () => Blob | Promise<Blob> — 사용자 제스처가 만료되기 전에 대화상자부터 띄우기
  // 위해 blob 생성은 대화상자를 연 "이후"에 수행한다.
  async function exportFile(suggestedName, description, accept, buildBlob) {
    if (window.showSaveFilePicker) {
      let handle = null;
      try {
        handle = await window.showSaveFilePicker({
          suggestedName,
          types: [{ description, accept }],
        });
      } catch (err) {
        if (err && err.name === 'AbortError') return; // 사용자가 대화상자를 취소함
        handle = null; // 다른 오류(예: 미지원 컨텍스트)면 기존 다운로드 방식으로 대체
      }
      if (handle) {
        try {
          const blob = await buildBlob();
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
        } catch (err) {
          alert('파일을 저장하는 중 오류가 발생했습니다.');
        }
        return;
      }
    }
    const blob = await buildBlob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = suggestedName;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function buildExportSvgString() {
    const b = contentBBox();
    const pad = 40;
    const x = b.minX - pad, y = b.minY - pad;
    const w = (b.maxX - b.minX) + pad * 2, h = (b.maxY - b.minY) + pad * 2;

    const clone = canvas.cloneNode(true);
    clone.querySelectorAll('.ui-only').forEach(el => el.remove());
    clone.querySelectorAll('.selected').forEach(el => el.classList.remove('selected'));
    clone.querySelectorAll('[data-resize]').forEach(el => el.remove());
    clone.querySelectorAll('[data-bend]').forEach(el => el.remove());
    clone.querySelectorAll('.text-select-box').forEach(el => el.remove());
    // 클릭 판정용 투명 히트 영역들 — 정적 내보내기에는 필요 없고, 남겨두면
    // 스타일시트 없이 브라우저 기본값(fill:black)으로 그려져 시커멓게 보인다.
    clone.querySelectorAll('.edge-hit, .node-hit').forEach(el => el.remove());
    const bg = cssVar('--bg') || '#ffffff';
    const textColor = cssVar('--text') || '#1c2128';
    const edgeColor = cssVar('--edge-color') || '#5b6472';
    const textMuted = cssVar('--text-muted') || '#6b7280';
    setAttrs(clone, { width: w, height: h, viewBox: `${x} ${y} ${w} ${h}` });
    clone.querySelector('#viewport').removeAttribute('transform');
    clone.style.background = bg;
    // Inline a minimal stylesheet so the exported file renders standalone.
    const style = document.createElementNS(SVG_NS, 'style');
    style.textContent = `
      text { font-family: -apple-system, "Apple SD Gothic Neo", "Segoe UI", Roboto, sans-serif; }
      .node-label { fill: ${textColor}; font-size: 13px; text-anchor: middle; dominant-baseline: central; }
      .node-label.loop-label { font-size: 15px; font-weight: 700; }
      .arrow-fill { fill: ${edgeColor}; }
      .edge-line { stroke: ${edgeColor}; stroke-width: 2; fill: none; }
      .edge-label { fill: ${textColor}; font-size: 11.5px; text-anchor: middle; dominant-baseline: central; }
      .edge-label-bg { fill: ${bg}; opacity: 0.92; }
      .edge-delay-mark { stroke: ${edgeColor}; stroke-width: 2; }
      .edge-polarity { fill: ${edgeColor}; font-size: 13px; font-weight: 700; text-anchor: middle; dominant-baseline: central; }
      .edge-bubble-dot { fill: ${textMuted}; }
      rect.bgrect { fill: ${bg}; }
    `;
    clone.insertBefore(style, clone.firstChild);
    const bgRect = svgEl('rect', { x, y, width: w, height: h, class: 'bgrect' });
    clone.querySelector('#viewport').insertBefore(bgRect, clone.querySelector('#viewport').firstChild);

    const serializer = new XMLSerializer();
    let src = serializer.serializeToString(clone);
    if (!src.match(/^<svg[^>]+xmlns=/)) {
      src = src.replace('<svg', `<svg xmlns="${SVG_NS}"`);
    }
    return { src, w, h };
  }

  function exportSVG() {
    exportFile(`${exportBaseName()}.svg`, 'SVG 파일', { 'image/svg+xml': ['.svg'] }, () => {
      const { src } = buildExportSvgString();
      return new Blob(['<?xml version="1.0" standalone="no"?>\r\n' + src], { type: 'image/svg+xml' });
    });
  }

  // buildExportSvgString()으로 만든 SVG를 캔버스에 그려 PNG Blob으로 변환한다 (Promise).
  function buildPngBlob() {
    return new Promise((resolve, reject) => {
      const { src, w, h } = buildExportSvgString();
      const scaleFactor = 2;
      const img = new Image();
      const svgBlob = new Blob([src], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(svgBlob);
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = w * scaleFactor; c.height = h * scaleFactor;
        const ctx = c.getContext('2d');
        ctx.scale(scaleFactor, scaleFactor);
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        c.toBlob((blob) => {
          if (blob) resolve(blob); else reject(new Error('PNG 변환 실패'));
        }, 'image/png');
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('이미지 로드 실패')); };
      img.src = url;
    });
  }

  function exportPNG() {
    exportFile(`${exportBaseName()}.png`, 'PNG 이미지', { 'image/png': ['.png'] }, buildPngBlob)
      .catch(() => alert('PNG로 내보내는 중 오류가 발생했습니다.'));
  }

  // ===========================================================================================
  // Theme
  // ===========================================================================================
  const themeToggle = document.getElementById('themeToggle');
  function applyTheme(mode) {
    if (mode === 'light' || mode === 'dark') document.documentElement.setAttribute('data-theme', mode);
    else document.documentElement.removeAttribute('data-theme');
    themeToggle.textContent = currentIsDark() ? '☀️' : '🌙';
  }
  function currentIsDark() {
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr) return attr === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  themeToggle.addEventListener('click', () => {
    const next = currentIsDark() ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });
  applyTheme(localStorage.getItem(THEME_KEY));

  // ===========================================================================================
  // Keyboard shortcuts
  // ===========================================================================================
  window.addEventListener('keydown', (evt) => {
    const activeTag = (document.activeElement && document.activeElement.tagName) || '';
    const typing = activeTag === 'INPUT' || activeTag === 'TEXTAREA' || document.activeElement?.isContentEditable;
    if (typing) return;

    if ((evt.ctrlKey || evt.metaKey) && evt.key.toLowerCase() === 'z') {
      evt.preventDefault();
      if (evt.shiftKey) redo(); else undo();
      return;
    }
    if ((evt.ctrlKey || evt.metaKey) && evt.key.toLowerCase() === 'y') { evt.preventDefault(); redo(); return; }

    if (evt.key === 'Delete' || evt.key === 'Backspace') { evt.preventDefault(); deleteSelection(); return; }
    if (evt.key === 'Escape') { clearSelection(); setTool('select'); return; }
    if (evt.key === 'Insert' && selection.type === 'node') { evt.preventDefault(); duplicateConnected(selection.id); return; }
    // F2: 더블클릭과 동일하게 선택된 노드·연결선의 텍스트를 바로 편집 모드로 연다.
    if (evt.key === 'F2' && selection.type) { evt.preventDefault(); startInlineEdit(selection.type, selection.id); return; }

    if ((evt.ctrlKey || evt.metaKey) && evt.key.toLowerCase() === 'g') {
      evt.preventDefault();
      // Ctrl+G: 선택한 노드가 이미 그룹에 속해 있으면 해제, 아니면(2개 이상일 때) 새로 그룹으로 묶는다.
      const nodeItems = multiSelection.length
        ? multiSelection.filter(it => it.type === 'node')
        : (selection.type === 'node' ? [selection] : []);
      const hasGrouped = nodeItems.some(it => {
        const n = state.nodes.find(x => x.id === it.id);
        return n && n.groupId;
      });
      if (hasGrouped) ungroupSelection();
      else if (nodeItems.length >= 2) groupSelection();
      return;
    }
    // Ctrl+Shift+L: 선택한 노드 2개 이상을 순환 구조(고리)로 닫는다.
    if ((evt.ctrlKey || evt.metaKey) && evt.shiftKey && evt.key.toLowerCase() === 'l') {
      evt.preventDefault();
      closeLoop();
      return;
    }

    const arrowDirs = { ArrowRight: 'right', ArrowLeft: 'left', ArrowDown: 'down', ArrowUp: 'up' };
    if (arrowDirs[evt.key] && state.nodes.length > 0 && multiSelection.length < 2) {
      evt.preventDefault();
      moveSelectionByArrow(arrowDirs[evt.key]);
      return;
    }

    const map = { v: 'select', r: 'rect', o: 'circle', d: 'diamond', t: 'text', l: 'loop', b: 'bubble', c: 'connect' };
    const t = map[evt.key.toLowerCase()];
    if (t) setTool(t);
    if (evt.key === '+' || evt.key === '=') zoomBy(1.2);
    if (evt.key === '-') zoomBy(1 / 1.2);
    if (evt.key === '0') zoomToFit();
  });

  window.addEventListener('resize', () => applyViewTransform());

  // ===========================================================================================
  // Boot
  // ===========================================================================================
  function boot() {
    const hadSaved = loadTabs();
    if (!hadSaved) {
      const t = createTab(starterTemplate());
      tabs = [t];
      activeTabId = t.id;
    }
    activateTab(activeTabId, { fit: true });
  }
  boot();

})();
