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
  const NODE_DEFAULT_SIZES = { rect: [150, 90], circle: [110, 110], diamond: [140, 100] };
  const NODE_DEFAULT_LABELS = { rect: '시스템', circle: '사용자', diamond: '분기', text: '텍스트', loop: 'R1' };
  const LOOP_ICON = { R: '↻', B: '↺' };

  // 텍스트·루프 노드는 배경 도형이 없어 글자 크기에 딱 맞게 자동으로 커진다.
  const measureCtx = document.createElement('canvas').getContext('2d');
  function loopDisplayText(label, loopType) { return `${LOOP_ICON[loopType] || LOOP_ICON.R} ${label || ''}`; }
  function measureNodeSize(shape, label, loopType) {
    const isLoop = shape === 'loop';
    const fontSize = isLoop ? 15 : 13;
    const fontWeight = isLoop ? 700 : 400;
    measureCtx.font = `${fontWeight} ${fontSize}px ${FONT_STACK}`;
    const display = isLoop ? loopDisplayText(label, loopType) : (label || '');
    const textW = measureCtx.measureText(display || ' ').width;
    const w = Math.max(30, Math.ceil(textW) + 20);
    const h = Math.ceil(fontSize * 1.5) + 16;
    return { w, h };
  }

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
    const label = NODE_DEFAULT_LABELS[shape] || '노드';
    const isTextLike = shape === 'text' || shape === 'loop';
    let w, h, fill, stroke;
    const node = { id: uid(), shape, label };
    if (isTextLike) {
      if (shape === 'loop') node.loopType = 'R';
      node.textColor = cssVar('--text') || '#1c2128';
      ({ w, h } = measureNodeSize(shape, label, node.loopType));
      fill = 'transparent';
      stroke = node.textColor;
    } else {
      [w, h] = NODE_DEFAULT_SIZES[shape] || [150, 90];
      fill = cssVar('--node-fill') || '#eef2ff';
      stroke = cssVar('--node-stroke') || '#4f6df5';
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
      bend: 0, delay: false, polarity: '',
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
      bend: 0, delay: false, polarity: '',
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
    // 프레젠테이션 속성(fill=)은 스타일시트의 .node-label 규칙보다 우선순위가
    // 낮아 덮어써진다 — 인라인 style로 지정해야 커스텀 글자색이 실제로 적용됨.
    if (isTextLike) text.style.fill = node.textColor || cssVar('--text') || '#1c2128';
    text.textContent = nodeDisplayText(node);
    g.appendChild(text);
    if (selection.type === 'node' && selection.id === node.id) {
      g.classList.add('selected');
      if (isTextLike) {
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

  function buildEdgeEl(edge) {
    const from = state.nodes.find(n => n.id === edge.from);
    const to = state.nodes.find(n => n.id === edge.to);
    const g = svgEl('g', { class: 'edge', 'data-id': edge.id });
    if (!from || !to) return g;
    const { p1, p2, ctrl, ux, uy, px, py } = edgeAnchorPoints(edge, from, to);
    const d = `M${p1.x},${p1.y} Q${ctrl.x},${ctrl.y} ${p2.x},${p2.y}`;

    const hit = svgEl('path', { d, class: 'edge-hit' });
    const line = svgEl('path', { d, class: 'edge-line' });
    if (edge.dashed) line.setAttribute('stroke-dasharray', '7 5');
    if (edge.arrowEnd) line.setAttribute('marker-end', 'url(#arrowHead)');
    if (edge.arrowStart) line.setAttribute('marker-start', 'url(#arrowHead)');
    g.appendChild(hit);
    g.appendChild(line);

    // 인과 지도 표기: 지연 표시(‖, 곡선 중앙을 가로지르는 두 짧은 선)
    if (edge.delay) {
      const mid = bezierPoint(p1, ctrl, p2, 0.5);
      const tickLen = 9, gap = 4;
      for (const off of [-gap, gap]) {
        const bx = mid.x + ux * off, by = mid.y + uy * off;
        g.appendChild(svgEl('line', {
          x1: bx - px * tickLen / 2, y1: by - py * tickLen / 2,
          x2: bx + px * tickLen / 2, y2: by + py * tickLen / 2,
          class: 'edge-delay-mark',
        }));
      }
    }

    // 극성 표시(+/-): 화살촉 쪽에 가깝게, 선 옆으로 살짝 띄워서 표시
    if (edge.polarity) {
      const q = bezierPoint(p1, ctrl, p2, 0.78);
      const label = svgEl('text', { x: q.x + px * 11, y: q.y + py * 11, class: 'edge-polarity' });
      label.textContent = edge.polarity;
      g.appendChild(label);
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
    if (selection.type === 'edge' && selection.id === edge.id) {
      g.classList.add('selected');
      if (tool === 'select') {
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
      const size = measureNodeSize(newShape, node.label, node.loopType);
      node.w = size.w; node.h = size.h;
    } else {
      const [w, h] = NODE_DEFAULT_SIZES[newShape] || [150, 90];
      node.w = w; node.h = h;
      // fill/stroke는 텍스트 노드였을 때 "글자색" 용도로 쓰였을 수 있으므로
      // (값이 있어도) 도형으로 바뀌는 경우엔 항상 기본 배색으로 되돌린다.
      if (wasTextLike || !node.fill || node.fill === 'transparent') node.fill = cssVar('--node-fill') || '#eef2ff';
      if (wasTextLike || !node.stroke) node.stroke = cssVar('--node-stroke') || '#4f6df5';
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
      [['rect', '사각형'], ['circle', '원'], ['diamond', '마름모'], ['text', '텍스트'], ['loop', '루프 라벨 (R/B)']].forEach(([v, l]) => {
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

    if (isTextLike) {
      panelBody.appendChild(field('글자 색', () => {
        const input = document.createElement('input');
        input.type = 'color'; input.value = toHex(node.textColor || cssVar('--text') || '#1c2128');
        input.addEventListener('input', () => { node.textColor = input.value; patchNodeVisual(node); });
        input.addEventListener('change', () => pushHistory());
        return input;
      }));
    } else {
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
      const { w, h } = measureNodeSize(node.shape, node.label, node.loopType);
      node.w = w; node.h = h;
      node.x = c.x - w / 2; node.y = c.y - h / 2;
    }
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
        if (isTextLikeShape(node.shape)) text.style.fill = node.textColor || cssVar('--text') || '#1c2128';
      }
      const box = g.querySelector('.text-select-box');
      if (box) setAttrs(box, { x: -4, y: -4, width: node.w + 8, height: node.h + 8 });
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
    const bendHandle = target.closest && target.closest('[data-bend]');
    const nodeGroup = target.closest && target.closest('.node');
    const edgeGroup = target.closest && target.closest('.edge');
    const world = worldFromEvent(evt);

    if (['rect', 'circle', 'diamond', 'text', 'loop'].includes(tool)) {
      const placedShape = tool;
      const created = addNode(placedShape, world.x, world.y);
      setTool('select');
      // 텍스트·루프 노드는 놓자마자 라벨을 입력하도록 바로 편집 모드로 진입.
      if (placedShape === 'text' || placedShape === 'loop') startInlineEdit('node', created.id);
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
    } else if (drag.type === 'bend') {
      const edge = state.edges.find(e => e.id === drag.id);
      if (!edge) return;
      const world = worldFromEvent(evt);
      const relX = world.x - drag.mid.x, relY = world.y - drag.mid.y;
      edge.bend = relX * drag.perp.x + relY * drag.perp.y;
      const el = edgesLayer.querySelector(`.edge[data-id="${edge.id}"]`);
      if (el) el.replaceWith(buildEdgeEl(edge));
    }
  });

  function endDrag(evt) {
    if (!drag) return;
    const wasStructural = drag.type === 'move' || drag.type === 'resize' || drag.type === 'bend';
    const wasBend = drag.type === 'bend';
    canvas.classList.remove('panning');
    try { canvas.releasePointerCapture(evt.pointerId); } catch (e) {}
    drag = null;
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
    canvas.classList.toggle('tool-add', ['rect', 'circle', 'diamond', 'text', 'loop'].includes(name));
    const hints = {
      select: '요소를 클릭해 선택하거나 드래그해 이동하세요. 빈 곳을 드래그하면 화면이 이동합니다. 방향키로 요소 사이를 이동하고, Insert 키로 동일한 노드를 추가·연결할 수 있습니다.',
      rect: '캔버스를 클릭해 사각형 노드를 추가하세요.',
      circle: '캔버스를 클릭해 원형 노드를 추가하세요.',
      diamond: '캔버스를 클릭해 마름모 노드를 추가하세요.',
      text: '캔버스를 클릭해 테두리 없는 텍스트 노드를 추가하세요. 인과 지도의 변수명 표기에 적합합니다.',
      loop: '캔버스를 클릭해 루프 라벨(R11, B7 등)을 추가하세요. 속성 패널에서 강화(R)/균형(B)을 선택할 수 있습니다.',
      connect: '연결할 시작 노드를 클릭한 다음 도착 노드를 클릭하세요. 선택 후 가운데 손잡이를 드래그하면 곡선으로 휘어집니다. (Esc로 취소)',
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
    clone.querySelectorAll('[data-bend]').forEach(el => el.remove());
    clone.querySelectorAll('.text-select-box').forEach(el => el.remove());
    // 클릭 판정용 투명 히트 영역들 — 정적 내보내기에는 필요 없고, 남겨두면
    // 스타일시트 없이 브라우저 기본값(fill:black)으로 그려져 시커멓게 보인다.
    clone.querySelectorAll('.edge-hit, .node-hit').forEach(el => el.remove());
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
      .node-label.loop-label { font-size: 15px; font-weight: 700; }
      .edge-line { stroke: ${edgeColor}; stroke-width: 2; fill: none; }
      .edge-label { fill: ${textColor}; font-size: 11.5px; text-anchor: middle; dominant-baseline: central; }
      .edge-label-bg { fill: ${bg}; opacity: 0.92; }
      .edge-delay-mark { stroke: ${edgeColor}; stroke-width: 2; }
      .edge-polarity { fill: ${edgeColor}; font-size: 13px; font-weight: 700; text-anchor: middle; dominant-baseline: central; }
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

    const arrowDirs = { ArrowRight: 'right', ArrowLeft: 'left', ArrowDown: 'down', ArrowUp: 'up' };
    if (arrowDirs[evt.key] && state.nodes.length > 0) {
      evt.preventDefault();
      moveSelectionByArrow(arrowDirs[evt.key]);
      return;
    }

    const map = { v: 'select', r: 'rect', o: 'circle', d: 'diamond', t: 'text', l: 'loop', c: 'connect' };
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
