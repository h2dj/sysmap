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

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  let state = { title: '새 시스템 지도', nodes: [], edges: [] };
  const view = { x: 0, y: 0, scale: 1 };
  let tool = 'select';
  let selection = { type: null, id: null };
  let connectPendingId = null;
  let history = [];
  let historyIndex = -1;
  let autosaveTimer = null;

  const STORAGE_KEY = 'sysmap.autosave.v1';
  const THEME_KEY = 'sysmap.theme';

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
    if (node.shape === 'circle') {
      t = 1 / Math.sqrt((dx / hw) ** 2 + (dy / hh) ** 2);
    } else if (node.shape === 'diamond') {
      t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
    } else {
      t = 1 / Math.max(Math.abs(dx) / hw, Math.abs(dy) / hh);
    }
    t = Math.max(t, 0);
    return { x: c.x + dx * t, y: c.y + dy * t };
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
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (e) { /* storage full or unavailable — ignore */ }
    }, 300);
  }
  function loadAutosave() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) return false;
      state = { title: data.title || '새 시스템 지도', nodes: data.nodes, edges: data.edges };
      return true;
    } catch (e) { return false; }
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
  // CRUD
  // ===========================================================================================
  function addNode(shape, worldX, worldY) {
    const sizes = { rect: [150, 90], circle: [110, 110], diamond: [140, 100] };
    const [w, h] = sizes[shape] || [150, 90];
    const labels = { rect: '시스템', circle: '사용자', diamond: '분기' };
    const node = {
      id: uid(), shape,
      x: worldX - w / 2, y: worldY - h / 2, w, h,
      label: labels[shape] || '노드',
      fill: cssVar('--node-fill') || '#eef2ff',
      stroke: cssVar('--node-stroke') || '#4f6df5',
    };
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
    const edge = { id: uid(), from: fromId, to: toId, label: '', dashed: false, arrowStart: false, arrowEnd: true };
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
    state.nodes.push(clone);
    state.edges.push({
      id: uid(), from: source.id, to: clone.id,
      label: '', dashed: false, arrowStart: false, arrowEnd: true,
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

  function deleteSelection() {
    if (!selection.type) return;
    if (selection.type === 'node') removeNode(selection.id);
    else removeEdge(selection.id);
    clearSelection();
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
    emptyHint.classList.toggle('hidden', state.nodes.length > 0);
    countsEl.textContent = `노드 ${state.nodes.length}개 · 연결 ${state.edges.length}개`;
    updatePanel();
  }

  function shapeEl(node) {
    const w = node.w, h = node.h;
    let el;
    if (node.shape === 'circle') {
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

  function buildNodeEl(node) {
    const g = svgEl('g', { class: 'node', 'data-id': node.id, transform: `translate(${node.x} ${node.y})` });
    g.appendChild(shapeEl(node));
    const text = svgEl('text', { x: node.w / 2, y: node.h / 2, class: 'node-label' });
    text.textContent = node.label;
    g.appendChild(text);
    if (selection.type === 'node' && selection.id === node.id) {
      g.classList.add('selected');
      const handle = svgEl('rect', {
        x: node.w - 8, y: node.h - 8, width: 14, height: 14,
        class: 'resize-handle', 'data-resize': node.id,
      });
      g.appendChild(handle);
    }
    if (connectPendingId === node.id) g.classList.add('connect-pending');
    return g;
  }

  function buildEdgeEl(edge) {
    const from = state.nodes.find(n => n.id === edge.from);
    const to = state.nodes.find(n => n.id === edge.to);
    const g = svgEl('g', { class: 'edge', 'data-id': edge.id });
    if (!from || !to) return g;
    const cFrom = nodeCenter(from), cTo = nodeCenter(to);
    const p1 = boundaryPoint(from, cTo.x, cTo.y);
    const p2 = boundaryPoint(to, cFrom.x, cFrom.y);

    const hit = svgEl('line', { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, class: 'edge-hit' });
    const line = svgEl('line', { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, class: 'edge-line' });
    if (edge.dashed) line.setAttribute('stroke-dasharray', '7 5');
    if (edge.arrowEnd) line.setAttribute('marker-end', 'url(#arrowHead)');
    if (edge.arrowStart) line.setAttribute('marker-start', 'url(#arrowHead)');
    g.appendChild(hit);
    g.appendChild(line);

    if (edge.label) {
      const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
      const text = svgEl('text', { x: mx, y: my, class: 'edge-label' });
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
    if (selection.type === 'edge' && selection.id === edge.id) g.classList.add('selected');
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
    connectPendingId = null;
    propsPanel.hidden = true;
    document.querySelectorAll('.node.selected, .edge.selected').forEach(el => el.classList.remove('selected'));
    document.querySelectorAll('.resize-handle').forEach(el => el.remove());
  }

  function selectItem(type, id) {
    selection = { type, id };
    render();
    updatePanel();
  }

  function updatePanel() {
    if (!selection.type) { propsPanel.hidden = true; return; }
    propsPanel.hidden = false;
    if (selection.type === 'node') renderNodePanel();
    else renderEdgePanel();
  }

  function renderNodePanel() {
    const node = state.nodes.find(n => n.id === selection.id);
    if (!node) { clearSelection(); return; }
    panelTitle.textContent = '노드 속성';
    panelBody.innerHTML = '';

    panelBody.appendChild(field('이름', () => {
      const input = document.createElement('input');
      input.type = 'text'; input.value = node.label;
      input.addEventListener('input', () => { node.label = input.value; updateNodeLabel(node); });
      input.addEventListener('change', () => pushHistory());
      return input;
    }));

    panelBody.appendChild(field('모양', () => {
      const sel = document.createElement('select');
      [['rect', '사각형'], ['circle', '원'], ['diamond', '마름모']].forEach(([v, l]) => {
        const opt = document.createElement('option'); opt.value = v; opt.textContent = l;
        if (node.shape === v) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener('change', () => { node.shape = sel.value; render(); pushHistory(); });
      return sel;
    }));

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

    panelBody.appendChild(field('선 스타일', () => {
      const sel = document.createElement('select');
      [['solid', '실선'], ['dashed', '파선']].forEach(([v, l]) => {
        const opt = document.createElement('option'); opt.value = v; opt.textContent = l;
        if ((edge.dashed ? 'dashed' : 'solid') === v) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener('change', () => { edge.dashed = sel.value === 'dashed'; render(); pushHistory(); });
      return sel;
    }));

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

    const delBtn = document.createElement('button');
    delBtn.className = 'danger-btn';
    delBtn.textContent = '이 연결선 삭제';
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

  function updateNodeLabel(node) {
    const g = nodesLayer.querySelector(`.node[data-id="${node.id}"]`);
    if (g) {
      const t = g.querySelector('.node-label');
      if (t) t.textContent = node.label;
    }
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
      commit = (val) => { node.label = val; render(); pushHistory(); };
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
    const target = evt.target;
    const resizeHandle = target.closest && target.closest('[data-resize]');
    const nodeGroup = target.closest && target.closest('.node');
    const edgeGroup = target.closest && target.closest('.edge');
    const world = worldFromEvent(evt);

    if (['rect', 'circle', 'diamond'].includes(tool)) {
      addNode(tool, world.x, world.y);
      setTool('select');
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
    if (nodeGroup) {
      const node = state.nodes.find(n => n.id === nodeGroup.dataset.id);
      if (!node) return;
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
    }
  });

  function endDrag(evt) {
    if (!drag) return;
    const wasStructural = drag.type === 'move' || drag.type === 'resize';
    canvas.classList.remove('panning');
    try { canvas.releasePointerCapture(evt.pointerId); } catch (e) {}
    drag = null;
    if (wasStructural) pushHistory();
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
    canvas.classList.toggle('tool-add', ['rect', 'circle', 'diamond'].includes(name));
    const hints = {
      select: '요소를 클릭해 선택하거나 드래그해 이동하세요. 빈 곳을 드래그하면 화면이 이동합니다. 노드 선택 후 Insert 키로 동일한 노드를 추가·연결할 수 있습니다.',
      rect: '캔버스를 클릭해 사각형 노드를 추가하세요.',
      circle: '캔버스를 클릭해 원형 노드를 추가하세요.',
      diamond: '캔버스를 클릭해 마름모 노드를 추가하세요.',
      connect: '연결할 시작 노드를 클릭한 다음 도착 노드를 클릭하세요. (Esc로 취소)',
    };
    hintEl.textContent = hints[name] || hints.select;
    render();
  }

  document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => setTool(btn.dataset.tool));
  });

  document.getElementById('btnDelete').addEventListener('click', deleteSelection);
  document.getElementById('btnUndo').addEventListener('click', undo);
  document.getElementById('btnRedo').addEventListener('click', redo);
  document.getElementById('btnZoomIn').addEventListener('click', () => zoomBy(1.2));
  document.getElementById('btnZoomOut').addEventListener('click', () => zoomBy(1 / 1.2));
  document.getElementById('btnZoomReset').addEventListener('click', zoomToFit);
  document.getElementById('panelClose').addEventListener('click', clearSelection);

  function zoomBy(factor) {
    const rect = canvasWrap.getBoundingClientRect();
    const cx = rect.width / 2, cy = rect.height / 2;
    const worldX = (cx - view.x) / view.scale, worldY = (cy - view.y) / view.scale;
    view.scale = clamp(view.scale * factor, 0.15, 3);
    view.x = cx - worldX * view.scale;
    view.y = cy - worldY * view.scale;
    applyViewTransform();
  }

  mapTitleInput.addEventListener('input', () => { state.title = mapTitleInput.value; });
  mapTitleInput.addEventListener('change', () => pushHistory());

  document.getElementById('btnNew').addEventListener('click', () => {
    if (state.nodes.length === 0 && state.edges.length === 0) return;
    if (!confirm('현재 지도를 지우고 새로 시작할까요? 저장하지 않은 변경은 사라집니다.')) return;
    state = { title: '새 시스템 지도', nodes: [], edges: [] };
    mapTitleInput.value = state.title;
    clearSelection();
    render();
    zoomToFit();
    pushHistory();
  });

  // Export dropdown
  const exportMenu = document.getElementById('exportMenu');
  document.getElementById('btnExport').addEventListener('click', (e) => {
    e.stopPropagation();
    exportMenu.hidden = !exportMenu.hidden;
  });
  document.addEventListener('click', () => { exportMenu.hidden = true; });

  document.getElementById('btnExportJson').addEventListener('click', () => {
    downloadBlob(JSON.stringify(state, null, 2), `${safeName(state.title)}.json`, 'application/json');
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
        state = { title: data.title || '가져온 지도', nodes: data.nodes, edges: data.edges };
        mapTitleInput.value = state.title;
        clearSelection();
        render();
        zoomToFit();
        pushHistory();
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

  function downloadBlob(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
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
    const bg = cssVar('--bg') || '#ffffff';
    const textColor = cssVar('--text') || '#1c2128';
    const edgeColor = cssVar('--edge-color') || '#5b6472';
    setAttrs(clone, { width: w, height: h, viewBox: `${x} ${y} ${w} ${h}` });
    clone.querySelector('#viewport').removeAttribute('transform');
    clone.style.background = bg;
    // Inline a minimal stylesheet so the exported file renders standalone.
    const style = document.createElementNS(SVG_NS, 'style');
    style.textContent = `
      text { font-family: -apple-system, "Apple SD Gothic Neo", "Segoe UI", Roboto, sans-serif; }
      .node-label { fill: ${textColor}; font-size: 13px; text-anchor: middle; dominant-baseline: central; }
      .edge-line { stroke: ${edgeColor}; stroke-width: 2; fill: none; }
      .edge-label { fill: ${textColor}; font-size: 11.5px; text-anchor: middle; dominant-baseline: central; }
      .edge-label-bg { fill: ${bg}; opacity: 0.92; }
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
    const { src } = buildExportSvgString();
    downloadBlob('<?xml version="1.0" standalone="no"?>\r\n' + src, `${safeName(state.title)}.svg`, 'image/svg+xml');
  }

  function exportPNG() {
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
        const purl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = purl; a.download = `${safeName(state.title)}.png`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(purl), 2000);
      }, 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(url); alert('PNG로 내보내는 중 오류가 발생했습니다.'); };
    img.src = url;
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

    const map = { v: 'select', r: 'rect', o: 'circle', d: 'diamond', c: 'connect' };
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
    const hadAutosave = loadAutosave();
    if (!hadAutosave) state = starterTemplate();
    mapTitleInput.value = state.title;
    render();
    applyViewTransform();
    zoomToFit();
    history = [snapshot()];
    historyIndex = 0;
  }
  boot();

})();
