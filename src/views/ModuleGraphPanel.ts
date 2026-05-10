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
    #container { display: flex; height: calc(100vh - 50px); }
    #canvas-wrap { flex: 1; position: relative; }
    #graph { width: 100%; height: 100%; cursor: grab; }
    #graph:active { cursor: grabbing; }
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
    .legend { position: absolute; bottom: 8px; left: 8px; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 6px 10px; font-size: 0.78em; color: var(--vscode-descriptionForeground); pointer-events: none; }
    .legend-row { display: flex; align-items: center; gap: 4px; }
    .legend-dot { width: 10px; height: 10px; border-radius: 50%; }
    button { padding: 4px 12px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; cursor: pointer; font-size: 0.85em; }
    button:hover { background: var(--vscode-button-hoverBackground); }
</style>
</head>
<body>
<div id="header">
    <div>
        <h2 id="title">Module Graph</h2>
        <div class="subtitle" id="subtitle"></div>
    </div>
    <button onclick="vscode.postMessage({command:'refresh'})">Refresh</button>
</div>
<div id="container">
    <div id="canvas-wrap">
        <svg id="graph"></svg>
        <div class="legend">
            <div class="legend-row"><div class="legend-dot" style="background:#4b8bbe"></div>module · size = file count</div>
            <div class="legend-row"><div class="legend-dot" style="background:#c97a3a"></div>variant-tagged module</div>
            <div class="legend-row">edge thickness = #include count</div>
        </div>
    </div>
    <div id="sidebar">
        <div class="empty-state">Click a module to inspect its triplet and files.</div>
    </div>
</div>
<script>
const vscode = acquireVsCodeApi();
const data = ${payloadJson};

document.getElementById('title').textContent = 'Module Graph — ' + data.profileName;
document.getElementById('subtitle').textContent =
    data.nodes.length + ' module(s) · ' + data.edges.length + ' inter-module edge(s)';

// ── force-directed layout (small N — Verlet-style, no external deps) ─────
const svg = document.getElementById('graph');
const w = svg.clientWidth, h = svg.clientHeight;

// Nodes get random initial positions clustered near center.
const nodes = data.nodes.map((n, i) => ({
    id: n.name,
    data: n,
    x: w / 2 + Math.cos((i / data.nodes.length) * 2 * Math.PI) * Math.min(w, h) * 0.32,
    y: h / 2 + Math.sin((i / data.nodes.length) * 2 * Math.PI) * Math.min(w, h) * 0.32,
    vx: 0, vy: 0,
    r: 14 + Math.sqrt(n.fileCount) * 4,
}));
const idx = new Map(nodes.map(n => [n.id, n]));
const links = data.edges.map(e => ({ source: idx.get(e.from), target: idx.get(e.to), weight: e.weight }))
                        .filter(l => l.source && l.target);

const REPULSION = 8000;     // pairwise repulsion
const SPRING_LEN = 110;     // ideal edge length
const SPRING_K = 0.04;      // edge attraction
const DAMPING = 0.85;
const CENTER_PULL = 0.005;

function step() {
    // Repulsion
    for (const a of nodes) {
        for (const b of nodes) {
            if (a === b) continue;
            const dx = a.x - b.x, dy = a.y - b.y;
            const d2 = dx*dx + dy*dy + 1;
            const f = REPULSION / d2;
            a.vx += dx * f / Math.sqrt(d2);
            a.vy += dy * f / Math.sqrt(d2);
        }
    }
    // Springs
    for (const l of links) {
        const dx = l.target.x - l.source.x, dy = l.target.y - l.source.y;
        const d = Math.sqrt(dx*dx + dy*dy) + 0.01;
        const force = SPRING_K * (d - SPRING_LEN) * Math.log(1 + l.weight);
        l.source.vx += (dx / d) * force;
        l.source.vy += (dy / d) * force;
        l.target.vx -= (dx / d) * force;
        l.target.vy -= (dy / d) * force;
    }
    // Center pull
    for (const n of nodes) {
        n.vx += (w/2 - n.x) * CENTER_PULL;
        n.vy += (h/2 - n.y) * CENTER_PULL;
    }
    // Integrate
    for (const n of nodes) {
        n.vx *= DAMPING; n.vy *= DAMPING;
        n.x += n.vx; n.y += n.vy;
        // Bound
        n.x = Math.max(n.r + 10, Math.min(w - n.r - 10, n.x));
        n.y = Math.max(n.r + 10, Math.min(h - n.r - 10, n.y));
    }
}

// Run a fixed number of warmup iterations before first paint so the layout
// settles instead of animating chaotically.
for (let i = 0; i < 250; i++) { step(); }

// ── render ────────────────────────────────────────────────────────────
const NS = 'http://www.w3.org/2000/svg';
function el(tag, attrs) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
}

const linkGroup = el('g', { id: 'links' });
const nodeGroup = el('g', { id: 'nodes' });
svg.appendChild(linkGroup);
svg.appendChild(nodeGroup);

const linkEls = links.map(l => {
    const path = el('line', {
        x1: l.source.x, y1: l.source.y, x2: l.target.x, y2: l.target.y,
        stroke: 'var(--vscode-charts-blue, #4b8bbe)',
        'stroke-opacity': 0.35,
        'stroke-width': Math.min(6, 1 + Math.log(1 + l.weight) * 1.2),
    });
    linkGroup.appendChild(path);
    return { el: path, link: l };
});

const nodeEls = nodes.map(n => {
    const g = el('g', { class: 'node', transform: 'translate(' + n.x + ',' + n.y + ')', style: 'cursor:pointer' });
    const fill = n.data.variants.length > 0 ? '#c97a3a' : '#4b8bbe';
    const circle = el('circle', { r: n.r, fill, 'fill-opacity': 0.85, stroke: 'var(--vscode-foreground)', 'stroke-opacity': 0.4, 'stroke-width': 1 });
    const text = el('text', {
        'text-anchor': 'middle', 'dominant-baseline': 'central',
        'font-size': '11', 'font-weight': '600',
        fill: 'var(--vscode-editor-background)',
        'pointer-events': 'none',
    });
    text.textContent = n.id;
    g.appendChild(circle); g.appendChild(text);
    g.addEventListener('click', () => selectNode(n.data));
    nodeGroup.appendChild(g);
    return { el: g, node: n, circle };
});

// Continue running the simulation lightly so newly-clicked nodes settle without jolt.
function animate() {
    step();
    for (const ne of nodeEls) {
        ne.el.setAttribute('transform', 'translate(' + ne.node.x + ',' + ne.node.y + ')');
    }
    for (const le of linkEls) {
        le.el.setAttribute('x1', le.link.source.x); le.el.setAttribute('y1', le.link.source.y);
        le.el.setAttribute('x2', le.link.target.x); le.el.setAttribute('y2', le.link.target.y);
    }
}
let frame = 0, raf = null;
function pump() {
    if (frame++ < 200) { animate(); raf = requestAnimationFrame(pump); }
    else { raf = null; }
}
pump();

// Drag support
let drag = null;
svg.addEventListener('mousedown', (ev) => {
    const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
    const ctm = svg.getScreenCTM().inverse();
    const p = pt.matrixTransform(ctm);
    let hit = null;
    for (const ne of nodeEls) {
        const dx = ne.node.x - p.x, dy = ne.node.y - p.y;
        if (dx*dx + dy*dy < ne.node.r * ne.node.r) { hit = ne; break; }
    }
    if (hit) drag = { node: hit.node, dx: hit.node.x - p.x, dy: hit.node.y - p.y };
});
svg.addEventListener('mousemove', (ev) => {
    if (!drag) return;
    const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM().inverse());
    drag.node.x = p.x + drag.dx; drag.node.y = p.y + drag.dy;
    drag.node.vx = 0; drag.node.vy = 0;
    if (!raf) { frame = 0; pump(); }
});
window.addEventListener('mouseup', () => { drag = null; });

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
