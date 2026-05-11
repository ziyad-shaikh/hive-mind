import * as vscode from 'vscode';
import * as path from 'path';
import { DependencyAnalyzer } from '../analyzer/DependencyAnalyzer';
import { resolveModuleTriplet } from '../profiles';

// =============================================================================
// ModuleGraphPanel — module-level webview for repos with a Hive Mind profile.
// =============================================================================
//
// Aggregates the file-level dependency graph into module-level nodes + edges
// using the active profile's `modulePattern`. For Sage X3 specifically this
// produces a 25-node graph showing the runtime's true module structure: each
// known module becomes one bubble whose triplet (`<m>ext.h` / `<m>in.h` /
// `src/<m>*.cpp`) is reachable via click. Edges are aggregated #include
// relationships between modules; thickness encodes traffic. Build variants
// (sadora/sadpgs/sadoss) tint module nodes when any of their files are
// extraSources for that variant.
//
// This view is *the* X3-specific developer aid: a single picture of the
// runtime's module geometry that the file-level graph cannot show directly.
// =============================================================================

interface ModuleNode {
    name: string;
    triplet: { external: string; internal: string; implGlob: string };
    files: string[];          // absolute paths
    headerCount: number;
    implCount: number;
    locTotal: number;
    variants: string[];       // build variants this module is part of (e.g. ['sadora'])
}

interface ModuleEdge {
    from: string;
    to: string;
    weight: number;           // number of file-level include edges A → B
}

export class ModuleGraphPanel {
    public static currentPanel: ModuleGraphPanel | undefined;
    private static readonly viewType = 'hiveMindModuleGraph';

    private readonly panel: vscode.WebviewPanel;
    private readonly analyzer: DependencyAnalyzer;
    private disposables: vscode.Disposable[] = [];

    private constructor(panel: vscode.WebviewPanel, analyzer: DependencyAnalyzer) {
        this.panel = panel;
        this.analyzer = analyzer;
        this.update();

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        this.panel.webview.onDidReceiveMessage(
            (msg: { command: string; filePath?: string }) => {
                if (msg.command === 'openFile' && msg.filePath) {
                    vscode.window.showTextDocument(vscode.Uri.file(msg.filePath));
                }
                if (msg.command === 'refresh') {
                    this.update();
                }
            },
            null,
            this.disposables,
        );
    }

    static createOrShow(analyzer: DependencyAnalyzer): void {
        if (ModuleGraphPanel.currentPanel) {
            ModuleGraphPanel.currentPanel.panel.reveal(vscode.ViewColumn.Beside);
            ModuleGraphPanel.currentPanel.update();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            ModuleGraphPanel.viewType,
            'Hive Mind — Module Graph',
            vscode.ViewColumn.Beside,
            { enableScripts: true, retainContextWhenHidden: true },
        );

        ModuleGraphPanel.currentPanel = new ModuleGraphPanel(panel, analyzer);
    }

    static refresh(analyzer: DependencyAnalyzer): void {
        if (ModuleGraphPanel.currentPanel) {
            ModuleGraphPanel.currentPanel.update();
        }
    }

    private update(): void {
        this.panel.webview.html = this.getHtml();
    }

    private dispose(): void {
        ModuleGraphPanel.currentPanel = undefined;
        for (const d of this.disposables) { d.dispose(); }
        this.disposables = [];
    }

    // ── Build module nodes + edges from the file-level graph ────────
    private buildData(): { nodes: ModuleNode[]; edges: ModuleEdge[]; profileName: string } | null {
        const profile = this.analyzer.getProfile();
        if (!profile) { return null; }

        const allFiles = this.analyzer.getAllFilePaths();
        const knownModules = profile.modulePattern.knownModules;

        // file → module reverse index. Use longest-match-first so 'apl' doesn't
        // shadow 'aplext' if a longer module name ever gets added.
        const sortedModules = [...knownModules].sort((a, b) => b.length - a.length);
        const fileToModule = new Map<string, string>();

        for (const f of allFiles) {
            const base = path.basename(f).toLowerCase();
            const ext = path.extname(base);
            const stem = base.slice(0, base.length - ext.length);
            for (const m of sortedModules) {
                if (stem === `${m}ext` || stem === `${m}in`) {
                    fileToModule.set(f, m);
                    break;
                }
                if (stem.startsWith(m)) {
                    const after = stem.slice(m.length);
                    if (after === '' || /^[0-9_]/.test(after) || /^[a-z]/.test(after)) {
                        // Only count source/inline files for the impl side
                        const isSrc = ext === '.cpp' || ext === '.cc' || ext === '.cxx' ||
                                      ext === '.c'   || ext === '.inl' || ext === '.ipp';
                        const isHdr = ext === '.h'   || ext === '.hpp' || ext === '.hxx';
                        if (isSrc || isHdr) {
                            fileToModule.set(f, m);
                        }
                        break;
                    }
                }
            }
        }

        // Build per-module nodes.
        const nodeMap = new Map<string, ModuleNode>();
        for (const m of knownModules) {
            nodeMap.set(m, {
                name: m,
                triplet: resolveModuleTriplet(profile, m),
                files: [],
                headerCount: 0,
                implCount: 0,
                locTotal: 0,
                variants: [],
            });
        }

        // Variant tags per file
        const fileToVariant = new Map<string, string>();
        for (const v of profile.buildVariants) {
            for (const src of v.extraSources) {
                const norm = src.replace(/\\/g, '/');
                // variant sources are workspace-relative; resolve to absolute via the index
                for (const f of allFiles) {
                    if (this.analyzer.toRelative(f).replace(/\\/g, '/') === norm) {
                        fileToVariant.set(f, v.name);
                    }
                }
            }
        }

        for (const [f, m] of fileToModule) {
            const node = nodeMap.get(m);
            if (!node) { continue; }
            node.files.push(f);
            const ext = path.extname(f).toLowerCase();
            if (ext === '.h' || ext === '.hpp' || ext === '.hxx') {
                node.headerCount++;
            } else {
                node.implCount++;
            }
            const v = fileToVariant.get(f);
            if (v && !node.variants.includes(v)) {
                node.variants.push(v);
            }
            // LOC — use the analyzer's cached graph node if available, else read on demand.
            // We avoid disk reads here; rely on file count as the size proxy.
        }

        // Aggregate file → file edges into module → module weights.
        const edgeMap = new Map<string, ModuleEdge>();
        for (const [src, srcMod] of fileToModule) {
            const { dependencies } = this.analyzer.getRelatedFiles(src);
            for (const dep of dependencies) {
                const dstMod = fileToModule.get(dep);
                if (!dstMod || dstMod === srcMod) { continue; }
                const key = `${srcMod}->${dstMod}`;
                const e = edgeMap.get(key);
                if (e) { e.weight++; } else { edgeMap.set(key, { from: srcMod, to: dstMod, weight: 1 }); }
            }
        }

        // Drop empty modules (no files in the index — happens if the profile
        // lists more modules than the workspace currently has).
        const nodes = [...nodeMap.values()].filter(n => n.files.length > 0);
        const edges = [...edgeMap.values()].filter(e =>
            nodes.some(n => n.name === e.from) && nodes.some(n => n.name === e.to)
        );

        return { nodes, edges, profileName: profile.displayName };
    }

    private getHtml(): string {
        const data = this.buildData();
        if (!data) {
            return `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:24px;">
                <h2>Module Graph</h2>
                <p style="color:var(--vscode-descriptionForeground)">
                    No active Hive Mind project profile is detected for this workspace, so there's no module pattern to aggregate by.
                </p>
                <p style="color:var(--vscode-descriptionForeground)">
                    Module graphs are built from a profile's <code>modulePattern.knownModules</code>. The Sage X3 runtime profile activates
                    automatically when the workspace contains <code>include/adx_include.h</code>.
                </p>
            </body></html>`;
        }

        if (data.nodes.length === 0) {
            return `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:24px;">
                <h2>Module Graph — ${this.escapeHtml(data.profileName)}</h2>
                <p style="color:var(--vscode-descriptionForeground)">
                    The active profile lists known modules, but none of them have files in the current Hive Mind index.
                    Try <strong>Hive Mind: Re-analyze Workspace</strong> first.
                </p>
            </body></html>`;
        }

        // Pre-compute display info on the extension side; the webview just renders.
        const payload = {
            profileName: data.profileName,
            nodes: data.nodes.map(n => ({
                name: n.name,
                files: n.files.map(f => ({ abs: f, rel: this.analyzer.toRelative(f) })),
                triplet: n.triplet,
                headerCount: n.headerCount,
                implCount: n.implCount,
                fileCount: n.files.length,
                variants: n.variants,
            })),
            edges: data.edges,
        };

        const json = JSON.stringify(payload).replace(/</g, '\\u003c');
        return this.renderShell(json);
    }

    private renderShell(payloadJson: string): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 0; margin: 0; overflow: hidden; }
    #header { padding: 10px 16px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    #header h2 { margin: 0; font-size: 1.05em; }
    #header .subtitle { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
    #header .controls { display: flex; gap: 8px; align-items: center; }
    #header label { font-size: 0.82em; color: var(--vscode-descriptionForeground); display: flex; gap: 4px; align-items: center; }
    #container { display: flex; height: calc(100vh - 50px); }
    #canvas-wrap { flex: 1; position: relative; }
    #graph { width: 100%; height: 100%; display: block; }
    #sidebar { width: 320px; border-left: 1px solid var(--vscode-panel-border); padding: 12px 14px; overflow-y: auto; background: var(--vscode-sideBar-background); }
    #sidebar h3 { margin: 0 0 6px 0; font-size: 1em; }
    #sidebar .meta { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-bottom: 12px; }
    #sidebar h4 { margin: 14px 0 4px 0; font-size: 0.9em; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.05em; }
    #sidebar ul { list-style: none; padding: 0; margin: 0; font-size: 0.85em; }
    #sidebar li { padding: 3px 6px; border-radius: 3px; cursor: pointer; word-break: break-all; }
    #sidebar li:hover { background: var(--vscode-list-hoverBackground); }
    #sidebar li.empty { color: var(--vscode-descriptionForeground); cursor: default; font-style: italic; }
    #sidebar .triplet-row { display: flex; gap: 6px; align-items: center; padding: 3px 0; font-size: 0.85em; }
    #sidebar .triplet-label { color: var(--vscode-descriptionForeground); width: 70px; flex-shrink: 0; }
    #sidebar .triplet-value { font-family: var(--vscode-editor-font-family); word-break: break-all; }
    #sidebar .variant-pill { display: inline-block; padding: 1px 8px; border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 0.8em; margin-right: 4px; }
    .empty-state { padding: 20px; color: var(--vscode-descriptionForeground); text-align: center; font-size: 0.9em; }
    .legend { position: absolute; bottom: 8px; left: 8px; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 6px 10px; font-size: 0.78em; color: var(--vscode-descriptionForeground); pointer-events: none; line-height: 1.45; }
    .legend-row { display: flex; align-items: center; gap: 6px; }
    .legend-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
    .legend-bar { width: 14px; height: 3px; border-radius: 2px; flex-shrink: 0; }
    select, button { padding: 4px 10px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; cursor: pointer; font-size: 0.85em; }
    select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .node-label { font-size: 12px; font-weight: 600; user-select: none; cursor: pointer; }
    .node-label.dim { opacity: 0.25; }
</style>
</head>
<body>
<div id="header">
    <div>
        <h2 id="title">Module Graph</h2>
        <div class="subtitle" id="subtitle"></div>
    </div>
    <div class="controls">
        <label>Sort
            <select id="sort">
                <option value="alpha">alphabetical</option>
                <option value="degree">by coupling</option>
                <option value="files">by file count</option>
            </select>
        </label>
        <button onclick="vscode.postMessage({command:'refresh'})">Refresh</button>
    </div>
</div>
<div id="container">
    <div id="canvas-wrap">
        <svg id="graph"></svg>
        <div class="legend">
            <div class="legend-row"><div class="legend-dot" style="background:#4b8bbe"></div>module · size = file count</div>
            <div class="legend-row"><div class="legend-dot" style="background:#c97a3a"></div>variant-tagged module</div>
            <div class="legend-row"><div class="legend-bar" style="background:#4b8bbe"></div>edge thickness = #include count</div>
            <div class="legend-row"><div class="legend-bar" style="background:#c97a3a"></div>on hover: outgoing edges</div>
            <div class="legend-row"><div class="legend-bar" style="background:#5fb04c"></div>on hover: incoming edges</div>
        </div>
    </div>
    <div id="sidebar">
        <div class="empty-state">Click a module to inspect its triplet and files.<br>Hover to highlight neighbours.</div>
    </div>
</div>
<script>
const vscode = acquireVsCodeApi();
const data = ${payloadJson};

document.getElementById('title').textContent = 'Module Graph — ' + data.profileName;
document.getElementById('subtitle').textContent =
    data.nodes.length + ' module(s) · ' + data.edges.length + ' inter-module edge(s)';

// ── Radial chord-diagram layout (deterministic, no physics) ──────────
const svg = document.getElementById('graph');
const NS = 'http://www.w3.org/2000/svg';
function el(tag, attrs) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, String(attrs[k]));
    return e;
}

// Pre-compute per-node degree (in+out) once for sorting and node sizing.
const degree = new Map();
for (const n of data.nodes) degree.set(n.name, 0);
for (const e of data.edges) {
    degree.set(e.from, (degree.get(e.from) || 0) + 1);
    degree.set(e.to, (degree.get(e.to) || 0) + 1);
}

const SORTERS = {
    alpha: (a, b) => a.name.localeCompare(b.name),
    degree: (a, b) => (degree.get(b.name) - degree.get(a.name)) || a.name.localeCompare(b.name),
    files: (a, b) => (b.fileCount - a.fileCount) || a.name.localeCompare(b.name),
};

let nodeMeta = [];
let linkMeta = [];
let bidirSet = new Set();

const edgeKey = (a, b) => a < b ? a + '|' + b : b + '|' + a;

function buildModel(sortKey) {
    const sorted = [...data.nodes].sort(SORTERS[sortKey] || SORTERS.alpha);
    const N = sorted.length;
    nodeMeta = sorted.map((n, i) => ({
        id: n.name,
        data: n,
        angle: (i / N) * 2 * Math.PI - Math.PI / 2,  // start at 12 o'clock
        r: 7 + Math.sqrt(n.fileCount) * 2.4,
        x: 0, y: 0,
    }));
    const idx = new Map(nodeMeta.map(n => [n.id, n]));
    linkMeta = data.edges
        .map(e => ({ source: idx.get(e.from), target: idx.get(e.to), weight: e.weight }))
        .filter(l => l.source && l.target);

    bidirSet = new Set();
    const seen = new Set();
    for (const l of linkMeta) {
        const fwd = l.source.id + '|' + l.target.id;
        const rev = l.target.id + '|' + l.source.id;
        if (seen.has(rev)) bidirSet.add(edgeKey(l.source.id, l.target.id));
        seen.add(fwd);
    }
}

// SVG group containers
const linkGroup = el('g', { id: 'links' });
const nodeGroup = el('g', { id: 'nodes' });
const labelGroup = el('g', { id: 'labels' });
svg.appendChild(linkGroup);
svg.appendChild(nodeGroup);
svg.appendChild(labelGroup);

let linkEls = [];
let nodeEls = [];

function buildElements() {
    // Clear previous
    while (linkGroup.firstChild) linkGroup.removeChild(linkGroup.firstChild);
    while (nodeGroup.firstChild) nodeGroup.removeChild(nodeGroup.firstChild);
    while (labelGroup.firstChild) labelGroup.removeChild(labelGroup.firstChild);

    linkEls = linkMeta.map(l => {
        const path = el('path', {
            fill: 'none',
            stroke: 'var(--vscode-charts-blue, #4b8bbe)',
            'stroke-opacity': '0.20',
            'stroke-width': Math.min(5, 1 + Math.log(1 + l.weight) * 1.0),
            'stroke-linecap': 'round',
        });
        linkGroup.appendChild(path);
        return { el: path, link: l };
    });

    nodeEls = nodeMeta.map(n => {
        const g = el('g', { class: 'node', style: 'cursor:pointer' });
        const fill = n.data.variants.length > 0 ? '#c97a3a' : '#4b8bbe';
        const circle = el('circle', {
            r: n.r, fill, 'fill-opacity': '0.92',
            stroke: 'var(--vscode-foreground)', 'stroke-opacity': '0.35', 'stroke-width': '1.4',
        });
        g.appendChild(circle);
        g.addEventListener('mouseenter', () => highlightNode(n.id));
        g.addEventListener('mouseleave', clearHighlight);
        g.addEventListener('click', () => selectNode(n.data));
        nodeGroup.appendChild(g);

        const text = el('text', {
            class: 'node-label',
            fill: 'var(--vscode-foreground)',
        });
        text.textContent = n.id;
        text.addEventListener('mouseenter', () => highlightNode(n.id));
        text.addEventListener('mouseleave', clearHighlight);
        text.addEventListener('click', () => selectNode(n.data));
        labelGroup.appendChild(text);

        return { node: n, g, circle, textEl: text };
    });
}

let cx = 0, cy = 0, R = 0;

function pathFor(l) {
    const sx = l.source.x, sy = l.source.y;
    const tx = l.target.x, ty = l.target.y;
    const midX = (sx + tx) / 2, midY = (sy + ty) / 2;
    // Pull control point ~65% of the way from chord midpoint toward the circle centre.
    // The result is a soft inward arc, dense at the centre, that doesn't actually pass
    // through (0,0) — so it stays visible behind the central whitespace.
    let ctrlX = midX + (cx - midX) * 0.65;
    let ctrlY = midY + (cy - midY) * 0.65;
    // For pairs of edges (A→B and B→A), nudge control points perpendicular to the
    // chord so the two arcs are visually distinct rather than overlapping.
    if (bidirSet.has(edgeKey(l.source.id, l.target.id))) {
        const dirSign = l.source.id < l.target.id ? 1 : -1;
        const dx = tx - sx, dy = ty - sy;
        const len = Math.sqrt(dx*dx + dy*dy) || 1;
        const off = Math.min(28, R * 0.12);
        ctrlX += (-dy / len) * off * dirSign;
        ctrlY += ( dx / len) * off * dirSign;
    }
    return 'M ' + sx + ' ' + sy + ' Q ' + ctrlX + ' ' + ctrlY + ' ' + tx + ' ' + ty;
}

function layout() {
    const w = svg.clientWidth, h = svg.clientHeight;
    if (w === 0 || h === 0) { return false; }
    cx = w / 2; cy = h / 2;
    // Reserve outer margin for labels (~100px should fit the longest module name).
    R = Math.max(60, Math.min(cx, cy) - 100);

    for (const ne of nodeEls) {
        const a = ne.node.angle;
        ne.node.x = cx + R * Math.cos(a);
        ne.node.y = cy + R * Math.sin(a);
        ne.g.setAttribute('transform', 'translate(' + ne.node.x + ',' + ne.node.y + ')');

        const labelDist = R + ne.node.r + 10;
        const lx = cx + labelDist * Math.cos(a);
        const ly = cy + labelDist * Math.sin(a);
        ne.textEl.setAttribute('x', lx);
        ne.textEl.setAttribute('y', ly);
        const cosA = Math.cos(a);
        const anchor = Math.abs(cosA) < 0.15 ? 'middle' : (cosA > 0 ? 'start' : 'end');
        ne.textEl.setAttribute('text-anchor', anchor);
        ne.textEl.setAttribute('dominant-baseline', 'central');
    }
    for (const le of linkEls) {
        le.el.setAttribute('d', pathFor(le.link));
    }
    return true;
}

function rebuild(sortKey) {
    buildModel(sortKey);
    buildElements();
    if (!layout()) {
        requestAnimationFrame(() => layout());
    }
}

rebuild('alpha');

document.getElementById('sort').addEventListener('change', (ev) => {
    rebuild(ev.target.value);
});

let resizeTimer;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(layout, 80);
});

// ── highlight on hover ───────────────────────────────────────────────
function highlightNode(id) {
    const neighbours = new Set();
    for (const l of linkMeta) {
        if (l.source.id === id) neighbours.add(l.target.id);
        if (l.target.id === id) neighbours.add(l.source.id);
    }
    for (const le of linkEls) {
        const isOut = le.link.source.id === id;
        const isIn = le.link.target.id === id;
        if (isOut) {
            le.el.setAttribute('stroke', '#c97a3a');
            le.el.setAttribute('stroke-opacity', '0.9');
        } else if (isIn) {
            le.el.setAttribute('stroke', '#5fb04c');
            le.el.setAttribute('stroke-opacity', '0.9');
        } else {
            le.el.setAttribute('stroke-opacity', '0.04');
        }
    }
    for (const ne of nodeEls) {
        const isSelf = ne.node.id === id;
        const isNeighbour = neighbours.has(ne.node.id);
        ne.circle.setAttribute('fill-opacity', (isSelf || isNeighbour) ? '1.0' : '0.22');
        if (isSelf || isNeighbour) {
            ne.textEl.classList.remove('dim');
        } else {
            ne.textEl.classList.add('dim');
        }
    }
}
function clearHighlight() {
    for (const le of linkEls) {
        le.el.setAttribute('stroke', 'var(--vscode-charts-blue, #4b8bbe)');
        le.el.setAttribute('stroke-opacity', '0.20');
    }
    for (const ne of nodeEls) {
        ne.circle.setAttribute('fill-opacity', '0.92');
        ne.textEl.classList.remove('dim');
    }
}

// ── sidebar ───────────────────────────────────────────────────────────
function selectNode(d) {
    const sb = document.getElementById('sidebar');
    const variantPills = d.variants.map(v => '<span class="variant-pill">' + esc(v) + '</span>').join('');
    const filesByExt = new Map();
    for (const f of d.files) {
        const ext = (f.rel.match(/\\.[^.]+$/) || ['?'])[0];
        if (!filesByExt.has(ext)) filesByExt.set(ext, []);
        filesByExt.get(ext).push(f);
    }
    const fileSections = [...filesByExt.entries()].sort((a, b) => b[1].length - a[1].length).map(([ext, list]) => {
        const items = list.map(f =>
            '<li onclick="openFile(\\'' + escAttr(f.abs) + '\\')">' + esc(f.rel) + '</li>'
        ).join('');
        return '<h4>' + esc(ext) + ' (' + list.length + ')</h4><ul>' + items + '</ul>';
    }).join('');
    sb.innerHTML =
        '<h3>' + esc(d.name) + '</h3>' +
        '<div class="meta">' + d.fileCount + ' file(s) · ' + d.headerCount + ' header(s) · ' + d.implCount + ' impl(s)' +
        (variantPills ? '<div style="margin-top:4px">' + variantPills + '</div>' : '') +
        '</div>' +
        '<h4>Triplet pattern</h4>' +
        '<div class="triplet-row"><div class="triplet-label">external</div><div class="triplet-value">' + esc(d.triplet.external) + '</div></div>' +
        '<div class="triplet-row"><div class="triplet-label">internal</div><div class="triplet-value">' + esc(d.triplet.internal) + '</div></div>' +
        '<div class="triplet-row"><div class="triplet-label">impl glob</div><div class="triplet-value">' + esc(d.triplet.implGlob) + '</div></div>' +
        fileSections;
}
function openFile(p) { vscode.postMessage({ command: 'openFile', filePath: p }); }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escAttr(s) { return String(s).replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'"); }
</script>
</body>
</html>`;
    }

    private escapeHtml(s: string): string {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
}
