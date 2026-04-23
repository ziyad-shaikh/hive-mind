import * as vscode from 'vscode';
import { DependencyAnalyzer } from '../analyzer/DependencyAnalyzer';

export class GraphPanel {
    public static currentPanel: GraphPanel | undefined;
    private static readonly viewType = 'hiveMindGraph';

    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private analyzer: DependencyAnalyzer;
    private focusFile: string | undefined;
    private depth: number;
    private updateTimer: ReturnType<typeof setTimeout> | undefined;
    private disposables: vscode.Disposable[] = [];

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        analyzer: DependencyAnalyzer,
        focusFile: string | undefined,
        depth = 1
    ) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.analyzer = analyzer;
        this.focusFile = focusFile;
        this.depth = depth;

        // Render once after a short delay so the webview is ready
        this.scheduleUpdate();

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        this.panel.webview.onDidReceiveMessage(
            (msg: { command: string; filePath?: string }) => {
                if (msg.command === 'openFile' && msg.filePath) {
                    vscode.window.showTextDocument(vscode.Uri.file(msg.filePath));
                }
                if (msg.command === 'focusNode' && msg.filePath) {
                    this.focusFile = msg.filePath;
                    this.depth = 1;
                    this.scheduleUpdate();
                }
                if (msg.command === 'refocusCurrent') {
                    const active = vscode.window.activeTextEditor?.document.uri.fsPath;
                    if (active) {
                        this.focusFile = active;
                        this.depth = 1;
                        this.scheduleUpdate();
                    }
                }
                if (msg.command === 'expandGraph') {
                    this.depth = Math.min(this.depth + 1, 3);
                    this.scheduleUpdate();
                }
                if (msg.command === 'collapseGraph') {
                    this.depth = Math.max(this.depth - 1, 1);
                    this.scheduleUpdate();
                }
            },
            null,
            this.disposables
        );
    }

    /** Debounce updates to avoid double-rendering on panel open / rapid actions */
    private scheduleUpdate(): void {
        if (this.updateTimer) { clearTimeout(this.updateTimer); }
        this.updateTimer = setTimeout(() => this.doUpdate(), 50);
    }

    static createOrShow(
        extensionUri: vscode.Uri,
        analyzer: DependencyAnalyzer,
        focusFile?: string
    ): void {
        // Always resolve to a concrete file — never show the full graph
        const target = focusFile
            ?? vscode.window.activeTextEditor?.document.uri.fsPath;

        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (GraphPanel.currentPanel) {
            GraphPanel.currentPanel.focusFile = target;
            GraphPanel.currentPanel.analyzer = analyzer;
            GraphPanel.currentPanel.depth = 1;
            GraphPanel.currentPanel.panel.reveal(column);
            GraphPanel.currentPanel.scheduleUpdate();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            GraphPanel.viewType,
            'Hive Mind — Code Graph',
            column ?? vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri],
            }
        );

        GraphPanel.currentPanel = new GraphPanel(panel, extensionUri, analyzer, target, 1);
    }

    static refresh(analyzer: DependencyAnalyzer): void {
        if (GraphPanel.currentPanel) {
            GraphPanel.currentPanel.analyzer = analyzer;
            GraphPanel.currentPanel.scheduleUpdate();
        }
    }

    private doUpdate(): void {
        if (!this.focusFile) {
            // No file to focus on — show a helpful empty state
            this.panel.title = 'Hive Mind — No File';
            this.panel.webview.html = this.getEmptyHtml();
            return;
        }
        const maxNodes = this.depth === 1 ? 25 : this.depth === 2 ? 50 : 80;
        const graph = this.analyzer.serialize(this.focusFile, maxNodes, this.depth);
        const fileName = this.focusFile.split(/[\\/]/).pop() ?? 'File';
        this.panel.title = `Hive Mind — ${fileName}`;
        this.panel.webview.html = this.getHtml(graph);
    }

    private dispose(): void {
        if (this.updateTimer) { clearTimeout(this.updateTimer); }
        GraphPanel.currentPanel = undefined;
        this.panel.dispose();
        for (const d of this.disposables) { d.dispose(); }
        this.disposables = [];
    }

    private getEmptyHtml(): string {
        return /* html */ `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  body { display:flex; align-items:center; justify-content:center; height:100vh;
         background:var(--vscode-editor-background,#1e1e2e);
         color:var(--vscode-editor-foreground,#cdd6f4);
         font-family:var(--vscode-font-family,'Segoe UI',sans-serif); }
  .msg { text-align:center; opacity:0.6; }
  .msg h2 { margin-bottom:8px; }
</style>
</head><body>
<div class="msg">
  <h2>No file selected</h2>
  <p>Open a source file and run <strong>Hive Mind: Graph Current File</strong> to see its dependencies.</p>
</div>
</body></html>`;
    }

    private getHtml(graph: ReturnType<DependencyAnalyzer['serialize']>): string {
        const graphJson = JSON.stringify(graph);
        const focusJson = JSON.stringify(this.focusFile ?? null);
        const depthVal = this.depth;

        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<title>Hive Mind</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--vscode-editor-background, #1e1e2e);
    color: var(--vscode-editor-foreground, #cdd6f4);
    font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
    overflow: hidden; height: 100vh; width: 100vw;
  }
  #toolbar {
    position: absolute; top: 12px; left: 50%; transform: translateX(-50%);
    display: flex; gap: 8px; z-index: 10;
    background: rgba(30,30,46,0.92); border: 1px solid rgba(255,255,255,0.08);
    border-radius: 8px; padding: 6px 12px; backdrop-filter: blur(8px); align-items: center;
  }
  #toolbar span { font-size: 11px; color: #a6adc8; line-height: 28px; }
  button {
    background: rgba(137,180,250,0.15); border: 1px solid rgba(137,180,250,0.25);
    color: #89b4fa; border-radius: 5px; padding: 4px 10px; font-size: 11px;
    cursor: pointer; transition: background 0.15s; white-space: nowrap;
  }
  button:hover { background: rgba(137,180,250,0.3); }
  #help {
    position: absolute; bottom: 12px; right: 12px; z-index: 10;
    background: rgba(30,30,46,0.92); border: 1px solid rgba(255,255,255,0.08);
    border-radius: 8px; padding: 8px 12px; backdrop-filter: blur(8px);
    font-size: 10px; color: #585b70; line-height: 1.6;
  }
  #canvas { display: block; }
</style>
</head>
<body>
<div id="toolbar">
  <button id="btn-collapse" title="Reduce depth">&#x2212;</button>
  <span id="depth-info"></span>
  <button id="btn-expand" title="Expand depth">+</button>
  <button id="btn-fit">Fit All</button>
  <button id="btn-refocus">Re-focus Active File</button>
  <span id="stats"></span>
</div>
<div id="help">
  Scroll: zoom · Drag: pan · Double-click: open file<br>
  Right-click: re-center on file
</div>
<canvas id="canvas"></canvas>

<script>
(function() {
  const vscode = acquireVsCodeApi();
  const GRAPH  = ${graphJson};
  const FOCUS  = ${focusJson};
  const DEPTH  = ${depthVal};
  const N      = GRAPH.nodes.length;

  // ── language colours ─────────────────────────────────────────────
  const LC = {
    typescript:'#3b8fe8',javascript:'#f7df1e',vue:'#42b883',svelte:'#ff3e00',
    python:'#3572a5',csharp:'#178600',go:'#00add8',rust:'#dea584',
    cpp:'#f34b7d',c:'#555555',java:'#b07219',kotlin:'#A97BFF',
    php:'#4F5D95',ruby:'#CC342D',swift:'#F05138',css:'#563d7c',
    scss:'#c6538c',sass:'#c6538c',less:'#1d365d',stylus:'#ff6347',
    unknown:'#89b4fa',
  };
  function langColor(l) { return LC[l] || LC.unknown; }

  // ── canvas ──────────────────────────────────────────────────────
  const canvas = document.getElementById('canvas');
  const ctx    = canvas.getContext('2d');
  let W, H;
  function resize() { W = canvas.width = innerWidth; H = canvas.height = innerHeight; }
  resize(); addEventListener('resize', () => { resize(); render(); });

  // ══════════════════════════════════════════════════════════════════
  //  STATIC HIERARCHICAL LAYOUT (schema-diagram style)
  // ══════════════════════════════════════════════════════════════════

  // Build lookup
  const nodeById = {};
  GRAPH.nodes.forEach(n => { nodeById[n.id] = n; });

  // Build directed adjacency: source imports target
  const imports  = {};   // id → Set<id>  (files this file imports)
  const importedBy = {}; // id → Set<id>  (files that import this file)
  GRAPH.nodes.forEach(n => { imports[n.id] = new Set(); importedBy[n.id] = new Set(); });
  GRAPH.edges.forEach(e => {
    if (imports[e.source]) imports[e.source].add(e.target);
    if (importedBy[e.target]) importedBy[e.target].add(e.source);
  });

  // ── Assign layers via BFS from focus file ──────────────────────
  // Layer 0 = focus file
  // Layer +1,+2 = files the focus imports (dependencies)
  // Layer -1,-2 = files that import the focus (dependents/importers)
  const layerOf = {};
  if (FOCUS && nodeById[FOCUS]) {
    layerOf[FOCUS] = 0;
    // BFS downward (dependencies)
    let frontier = [FOCUS];
    for (let d = 1; frontier.length > 0 && d <= DEPTH; d++) {
      const next = [];
      for (const id of frontier) {
        for (const dep of imports[id] || []) {
          if (layerOf[dep] === undefined) { layerOf[dep] = d; next.push(dep); }
        }
      }
      frontier = next;
    }
    // BFS upward (dependents)
    frontier = [FOCUS];
    for (let d = 1; frontier.length > 0 && d <= DEPTH; d++) {
      const next = [];
      for (const id of frontier) {
        for (const imp of importedBy[id] || []) {
          if (layerOf[imp] === undefined) { layerOf[imp] = -d; next.push(imp); }
        }
      }
      frontier = next;
    }
    // Anything remaining (connected but not via directed path) → put at layer 0
    GRAPH.nodes.forEach(n => { if (layerOf[n.id] === undefined) layerOf[n.id] = 0; });
  } else {
    // No focus — flat single layer
    GRAPH.nodes.forEach(n => { layerOf[n.id] = 0; });
  }

  // ── Box dimensions ─────────────────────────────────────────────
  const BOX_H      = 32;
  const BOX_PAD_X  = 14;
  const BOX_RADIUS = 6;
  const LAYER_GAP  = 90;
  const ROW_GAP    = 12;   // vertical gap between wrapped sub-rows
  const COL_GAP    = 20;
  const ACCENT_W   = 4;
  const MAX_ROW_W  = 900;  // max px width before wrapping to next sub-row

  ctx.font = '12px monospace';
  function textW(t) { return ctx.measureText(t).width; }

  // Build box objects
  const boxes = GRAPH.nodes.map(n => {
    const label = n.label;
    const w = textW(label) + BOX_PAD_X * 2 + ACCENT_W + 8;
    return {
      id: n.id, label, path: n.relativePath, lang: n.language,
      conns: n.connectionCount,
      color: langColor(n.language),
      isFocus: n.id === FOCUS,
      layer: layerOf[n.id] || 0,
      w: Math.max(w, 90), h: BOX_H,
      x: 0, y: 0,  // will be set below
    };
  });
  const boxById = {};
  boxes.forEach(b => { boxById[b.id] = b; });

  // ── Position boxes in layers ───────────────────────────────────
  // Group by layer
  const layers = {};
  boxes.forEach(b => {
    if (!layers[b.layer]) layers[b.layer] = [];
    layers[b.layer].push(b);
  });
  const layerKeys = Object.keys(layers).map(Number).sort((a, b) => a - b);

  // Sort within each layer: focus-adjacent first, then alphabetical
  const focusAdj = new Set();
  if (FOCUS) {
    (imports[FOCUS] || new Set()).forEach(id => focusAdj.add(id));
    (importedBy[FOCUS] || new Set()).forEach(id => focusAdj.add(id));
  }
  for (const k of layerKeys) {
    layers[k].sort((a, b) => {
      const aAdj = focusAdj.has(a.id) ? 0 : 1;
      const bAdj = focusAdj.has(b.id) ? 0 : 1;
      if (aAdj !== bAdj) return aAdj - bAdj;
      return a.label.localeCompare(b.label);
    });
  }

  // Compute positions: wrap long layers into multiple sub-rows
  // First pass: figure out cumulative Y offset per layer (layers can be multi-row)
  const layerY = {};     // layer key → starting Y
  const layerHeight = {};// layer key → total height (including sub-rows)
  let cumulativeY = 0;

  for (const lk of layerKeys) {
    const row = layers[lk];
    // Split into sub-rows that fit within MAX_ROW_W
    const subRows = [[]];
    let curW = 0;
    for (const b of row) {
      if (subRows[subRows.length - 1].length > 0 && curW + COL_GAP + b.w > MAX_ROW_W) {
        subRows.push([]);
        curW = 0;
      }
      subRows[subRows.length - 1].push(b);
      curW += (curW > 0 ? COL_GAP : 0) + b.w;
    }

    layerY[lk] = cumulativeY;
    const totalH = subRows.length * BOX_H + (subRows.length - 1) * ROW_GAP;
    layerHeight[lk] = totalH;

    // Position each box
    for (let ri = 0; ri < subRows.length; ri++) {
      const sr = subRows[ri];
      const totalW = sr.reduce((s, b) => s + b.w, 0) + (sr.length - 1) * COL_GAP;
      let x = -totalW / 2;
      const y = cumulativeY + ri * (BOX_H + ROW_GAP);
      for (const b of sr) {
        b.x = x;
        b.y = y;
        x += b.w + COL_GAP;
      }
    }

    cumulativeY += totalH + LAYER_GAP;
  }

  // ── Build edge data ────────────────────────────────────────────
  const edges = GRAPH.edges.map(e => ({
    src: boxById[e.source], tgt: boxById[e.target],
  })).filter(e => e.src && e.tgt);

  // ── Transform (pan/zoom) ───────────────────────────────────────
  const transform = { x: W / 2, y: H / 2, scale: 1 };

  function screenToWorld(sx, sy) {
    return { x: (sx - transform.x) / transform.scale, y: (sy - transform.y) / transform.scale };
  }

  function fitAll() {
    if (boxes.length === 0) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const b of boxes) {
      if (b.x < minX) minX = b.x;
      if (b.x + b.w > maxX) maxX = b.x + b.w;
      if (b.y < minY) minY = b.y;
      if (b.y + b.h > maxY) maxY = b.y + b.h;
    }
    const pad = 60;
    const gw = maxX - minX + pad * 2, gh = maxY - minY + pad * 2;
    const scale = Math.min(W / gw, H / gh, 1.5);
    transform.scale = scale;
    transform.x = W / 2 - ((minX + maxX) / 2) * scale;
    transform.y = H / 2 - ((minY + maxY) / 2) * scale;
  }
  fitAll();

  // ── Hit testing ────────────────────────────────────────────────
  let hovering = null;

  function boxAt(sx, sy) {
    const w = screenToWorld(sx, sy);
    for (let i = boxes.length - 1; i >= 0; i--) {
      const b = boxes[i];
      if (w.x >= b.x && w.x <= b.x + b.w && w.y >= b.y && w.y <= b.y + b.h) return b;
    }
    return null;
  }

  // ── Drawing helpers ────────────────────────────────────────────
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  function rgba(hex, a) {
    const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), bl = parseInt(hex.slice(5,7),16);
    return 'rgba('+r+','+g+','+bl+','+a+')';
  }

  // ── Render ─────────────────────────────────────────────────────
  function render() {
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.scale, transform.scale);
    const sc = transform.scale;

    // ── Layer labels (background) ────────────────────────────
    ctx.font = '10px sans-serif';
    ctx.textBaseline = 'middle';
    for (const lk of layerKeys) {
      const row = layers[lk];
      if (row.length === 0) continue;
      const y = layerY[lk];
      const h = layerHeight[lk];
      let label = '';
      if (lk < 0) label = 'Imported by  \\u2191';
      else if (lk > 0) label = 'Imports  \\u2193';
      else label = FOCUS ? '\\u25C6 Current file' : 'Files';
      // Draw faint layer band
      const allMinX = Math.min(...row.map(b => b.x)) - 20;
      const allMaxX = Math.max(...row.map(b => b.x + b.w)) + 20;
      ctx.fillStyle = lk === 0 ? 'rgba(137,180,250,0.04)' : 'rgba(255,255,255,0.015)';
      ctx.fillRect(allMinX, y - 6, allMaxX - allMinX, h + 12);
      ctx.fillStyle = 'rgba(166,173,200,0.35)';
      ctx.fillText(label, allMinX + 4, y - 14);
    }

    // ── Edges (curved connectors) ────────────────────────────
    for (const e of edges) {
      const s = e.src, t = e.tgt;
      const isHL = hovering && (hovering === s || hovering === t);

      // Source port: bottom center, target port: top center
      const sx = s.x + s.w / 2, sy = s.y + s.h;
      const tx = t.x + t.w / 2, ty = t.y;

      // If target is above source, flip ports
      let x0 = sx, y0 = sy, x1 = tx, y1 = ty;
      if (ty < sy) {
        x0 = sx; y0 = s.y;
        x1 = tx; y1 = t.y + t.h;
      }

      const midY = (y0 + y1) / 2;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.bezierCurveTo(x0, midY, x1, midY, x1, y1);

      ctx.strokeStyle = isHL ? 'rgba(137,180,250,0.7)' : 'rgba(108,112,134,0.2)';
      ctx.lineWidth = isHL ? 1.8 / sc : 1 / sc;
      ctx.stroke();

      // Arrowhead at target
      const arrowLen = 6 / sc;
      const angle = Math.atan2(y1 - midY, x1 - x1) || (y1 > y0 ? Math.PI/2 : -Math.PI/2);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - arrowLen * Math.cos(angle - 0.4), y1 - arrowLen * Math.sin(angle - 0.4));
      ctx.lineTo(x1 - arrowLen * Math.cos(angle + 0.4), y1 - arrowLen * Math.sin(angle + 0.4));
      ctx.closePath();
      ctx.fillStyle = isHL ? 'rgba(137,180,250,0.7)' : 'rgba(108,112,134,0.25)';
      ctx.fill();
    }

    // ── Boxes ────────────────────────────────────────────────
    ctx.textBaseline = 'middle';
    const fontSize = 12 / sc;
    ctx.font = fontSize + 'px monospace';

    for (const b of boxes) {
      const isHov = hovering === b;
      const isAdj = hovering && (
        imports[hovering.id]?.has(b.id) || importedBy[hovering.id]?.has(b.id) ||
        imports[b.id]?.has(hovering.id) || importedBy[b.id]?.has(hovering.id)
      );
      const dim = hovering && !isHov && !isAdj;
      const alpha = dim ? 0.3 : 1;

      // Box background
      roundRect(b.x, b.y, b.w, b.h, BOX_RADIUS / sc);
      if (b.isFocus) {
        ctx.fillStyle = rgba('#313244', alpha);
        ctx.fill();
        ctx.strokeStyle = rgba('#89b4fa', alpha * 0.8);
        ctx.lineWidth = 1.5 / sc;
        ctx.stroke();
      } else {
        ctx.fillStyle = rgba('#1e1e2e', alpha * 0.95);
        ctx.fill();
        ctx.strokeStyle = rgba('#45475a', alpha * 0.6);
        ctx.lineWidth = 1 / sc;
        ctx.stroke();
      }

      // Hover ring
      if (isHov) {
        ctx.strokeStyle = rgba('#89b4fa', 0.6);
        ctx.lineWidth = 1.5 / sc;
        ctx.stroke();
      }

      // Language accent bar (left edge)
      const accentW = ACCENT_W / sc;
      const inset = BOX_RADIUS / sc;
      ctx.fillStyle = rgba(b.color, alpha);
      ctx.beginPath();
      ctx.moveTo(b.x + inset, b.y);
      ctx.lineTo(b.x + inset + accentW, b.y);
      ctx.lineTo(b.x + inset + accentW, b.y + b.h);
      ctx.lineTo(b.x + inset, b.y + b.h);
      ctx.arcTo(b.x, b.y + b.h, b.x, b.y + b.h - inset, inset);
      ctx.lineTo(b.x, b.y + inset);
      ctx.arcTo(b.x, b.y, b.x + inset, b.y, inset);
      ctx.closePath();
      ctx.fill();

      // File icon dot
      const dotX = b.x + ACCENT_W / sc + inset + 8 / sc;
      const dotY = b.y + b.h / 2;
      const dotR = 3 / sc;
      ctx.beginPath();
      ctx.arc(dotX, dotY, dotR, 0, Math.PI * 2);
      ctx.fillStyle = rgba(b.color, alpha);
      ctx.fill();

      // Label
      ctx.fillStyle = rgba(b.isFocus ? '#cdd6f4' : '#bac2de', alpha);
      ctx.font = (b.isFocus ? 'bold ' : '') + fontSize + 'px monospace';
      ctx.fillText(b.label, dotX + 8 / sc, dotY);

      // Connection count badge (right side)
      if (b.conns > 0) {
        const badge = '' + b.conns;
        const bw = textW(badge) + 8 / sc;
        const bx = b.x + b.w - bw - 6 / sc;
        const by = b.y + (b.h - 16 / sc) / 2;
        ctx.fillStyle = rgba('#313244', alpha * 0.8);
        roundRect(bx, by, bw, 16 / sc, 3 / sc);
        ctx.fill();
        ctx.fillStyle = rgba('#6c7086', alpha);
        ctx.font = (10 / sc) + 'px monospace';
        ctx.fillText(badge, bx + 4 / sc, by + 8 / sc);
        ctx.font = fontSize + 'px monospace';
      }
    }

    ctx.restore();
  }

  render();
  document.getElementById('stats').textContent = N + ' files \\u00b7 ' + GRAPH.edges.length + ' edges';

  // ── Interaction ────────────────────────────────────────────────
  let isPanning = false, panStart = { x:0, y:0, tx:0, ty:0 };

  canvas.addEventListener('mousemove', e => {
    if (isPanning) {
      transform.x = panStart.tx + (e.clientX - panStart.x);
      transform.y = panStart.ty + (e.clientY - panStart.y);
      render(); return;
    }
    const b = boxAt(e.clientX, e.clientY);
    if (b !== hovering) { hovering = b; render(); }
    canvas.style.cursor = b ? 'pointer' : 'grab';
  });
  canvas.addEventListener('mousedown', e => {
    isPanning = true; canvas.style.cursor = 'grabbing';
    panStart = { x: e.clientX, y: e.clientY, tx: transform.x, ty: transform.y };
  });
  addEventListener('mouseup', () => { isPanning = false; canvas.style.cursor = hovering ? 'pointer' : 'grab'; });
  canvas.addEventListener('dblclick', e => {
    const b = boxAt(e.clientX, e.clientY);
    if (b) vscode.postMessage({ command: 'openFile', filePath: b.id });
  });
  canvas.addEventListener('contextmenu', e => {
    e.preventDefault();
    const b = boxAt(e.clientX, e.clientY);
    if (b) vscode.postMessage({ command: 'focusNode', filePath: b.id });
  });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const f = e.deltaY < 0 ? 1.12 : 0.89;
    const ns = Math.max(0.1, Math.min(6, transform.scale * f));
    const r = ns / transform.scale;
    transform.x = e.clientX - (e.clientX - transform.x) * r;
    transform.y = e.clientY - (e.clientY - transform.y) * r;
    transform.scale = ns;
    render();
  }, { passive: false });

  // ── Toolbar ────────────────────────────────────────────────────
  document.getElementById('btn-fit').addEventListener('click', () => { fitAll(); render(); });
  const btnExpand = document.getElementById('btn-expand');
  if (DEPTH >= 3) btnExpand.style.opacity = '0.3';
  btnExpand.addEventListener('click', () => { if (DEPTH < 3) vscode.postMessage({ command: 'expandGraph' }); });
  const btnCollapse = document.getElementById('btn-collapse');
  if (DEPTH <= 1) btnCollapse.style.opacity = '0.3';
  btnCollapse.addEventListener('click', () => { if (DEPTH > 1) vscode.postMessage({ command: 'collapseGraph' }); });
  document.getElementById('depth-info').textContent = ({1:'Direct',2:'2-hop',3:'3-hop'})[DEPTH] || (DEPTH+'-hop');
  document.getElementById('btn-refocus').addEventListener('click', () => { vscode.postMessage({ command: 'refocusCurrent' }); });

  // ── Touch ──────────────────────────────────────────────────────
  let lastTouchDist = 0;
  canvas.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      lastTouchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    }
  });
  canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    if (e.touches.length === 2) {
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      const f = d / (lastTouchDist || d); lastTouchDist = d;
      const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const ns = Math.max(0.1, Math.min(6, transform.scale * f));
      const r = ns / transform.scale;
      transform.x = mx - (mx - transform.x) * r;
      transform.y = my - (my - transform.y) * r;
      transform.scale = ns;
      render();
    }
  }, { passive: false });
})();
</script>
</body>
</html>`;
    }
}
