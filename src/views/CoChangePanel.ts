import * as vscode from 'vscode';
import { DependencyAnalyzer } from '../analyzer/DependencyAnalyzer';
import { GitAnalyzer, CoChangeEntry } from '../analyzer/GitAnalyzer';

/**
 * WebView panel showing a heat-map of co-changed files from git history.
 * Reveals hidden coupling that the import graph misses.
 */
export class CoChangePanel {
    public static currentPanel: CoChangePanel | undefined;
    private static readonly viewType = 'hiveMindCoChange';

    private readonly panel: vscode.WebviewPanel;
    private readonly analyzer: DependencyAnalyzer;
    private readonly gitAnalyzer: GitAnalyzer;
    private disposables: vscode.Disposable[] = [];
    private focusFile: string | undefined;

    private constructor(
        panel: vscode.WebviewPanel,
        analyzer: DependencyAnalyzer,
        gitAnalyzer: GitAnalyzer,
        focusFile: string | undefined,
    ) {
        this.panel = panel;
        this.analyzer = analyzer;
        this.gitAnalyzer = gitAnalyzer;
        this.focusFile = focusFile;

        this.update();

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        this.panel.webview.onDidReceiveMessage(
            (msg: { command: string; filePath?: string }) => {
                if (msg.command === 'openFile' && msg.filePath) {
                    vscode.window.showTextDocument(vscode.Uri.file(msg.filePath));
                }
                if (msg.command === 'focusFile' && msg.filePath) {
                    this.focusFile = msg.filePath;
                    this.update();
                }
                if (msg.command === 'refocusCurrent') {
                    const active = vscode.window.activeTextEditor?.document.uri.fsPath;
                    if (active) {
                        this.focusFile = active;
                        this.update();
                    }
                }
            },
            null,
            this.disposables,
        );
    }

    static createOrShow(
        analyzer: DependencyAnalyzer,
        gitAnalyzer: GitAnalyzer,
        focusFile?: string,
    ): void {
        const target = focusFile ?? vscode.window.activeTextEditor?.document.uri.fsPath;

        if (CoChangePanel.currentPanel) {
            CoChangePanel.currentPanel.focusFile = target;
            CoChangePanel.currentPanel.panel.reveal(vscode.ViewColumn.Beside);
            CoChangePanel.currentPanel.update();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            CoChangePanel.viewType,
            'Co-Change Heat Map',
            vscode.ViewColumn.Beside,
            { enableScripts: true, retainContextWhenHidden: true },
        );

        CoChangePanel.currentPanel = new CoChangePanel(panel, analyzer, gitAnalyzer, target);
    }

    static refresh(analyzer: DependencyAnalyzer, gitAnalyzer: GitAnalyzer): void {
        if (CoChangePanel.currentPanel) {
            CoChangePanel.currentPanel.update();
        }
    }

    private update(): void {
        this.panel.webview.html = this.getHtml();
    }

    private dispose(): void {
        CoChangePanel.currentPanel = undefined;
        for (const d of this.disposables) { d.dispose(); }
        this.disposables = [];
    }

    // ── Build data ──────────────────────────────────────────────────
    private getData(): { focusRel: string; entries: { rel: string; abs: string; count: number; ratio: number; isDependent: boolean; isDependency: boolean }[] } | null {
        if (!this.focusFile || !this.gitAnalyzer.isAvailable) { return null; }

        const resolved = this.analyzer.resolveFilePath(this.focusFile);
        if (!resolved) { return null; }

        const coChanged = this.gitAnalyzer.getCoChangedFiles(resolved);
        if (coChanged.length === 0) { return null; }

        const { dependencies, dependents } = this.analyzer.getRelatedFiles(resolved);
        const depSet = new Set(dependencies);
        const deptSet = new Set(dependents);

        const entries = coChanged.map(e => ({
            rel: this.analyzer.toRelative(e.file),
            abs: e.file,
            count: e.coChangeCount,
            ratio: e.ratio,
            isDependent: deptSet.has(e.file),
            isDependency: depSet.has(e.file),
        }));

        return { focusRel: this.analyzer.toRelative(resolved), entries };
    }

    // ── HTML ────────────────────────────────────────────────────────
    private getHtml(): string {
        const data = this.getData();

        const noDataHtml = `
            <body style="font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:24px;">
                <h2>Co-Change Heat Map</h2>
                <p style="color:var(--vscode-descriptionForeground)">
                    ${!this.gitAnalyzer.isAvailable
                        ? 'Git history not available. Run <code>Hive Mind: Re-analyze Workspace</code> to index git data.'
                        : this.focusFile
                            ? 'No co-change data for the current file. It may not have enough commit history.'
                            : 'Open a file to see which other files change together with it in git history.'
                    }
                </p>
                <button onclick="vscode.postMessage({command:'refocusCurrent'})"
                        style="margin-top:12px;padding:6px 14px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:4px;cursor:pointer;">
                    Refocus on Current File
                </button>
            </body>`;

        if (!data) {
            return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"></head>${noDataHtml}</html>`;
        }

        const maxCount = Math.max(...data.entries.map(e => e.count), 1);

        const rows = data.entries.map(e => {
            const pct = Math.round((e.count / maxCount) * 100);
            const hue = Math.round((1 - e.ratio) * 120); // 0=red (high coupling), 120=green (low)
            const tags: string[] = [];
            if (e.isDependency) { tags.push('<span class="tag dep">dependency</span>'); }
            if (e.isDependent) { tags.push('<span class="tag dept">dependent</span>'); }
            if (!e.isDependency && !e.isDependent) { tags.push('<span class="tag hidden">hidden coupling</span>'); }

            return `
                <tr class="row" onclick="vscode.postMessage({command:'openFile',filePath:'${this.escapeJs(e.abs)}'})"
                    title="Click to open · ${e.count} co-changes · ratio ${(e.ratio * 100).toFixed(0)}%">
                    <td class="file">${this.escapeHtml(e.rel)}</td>
                    <td class="tags">${tags.join(' ')}</td>
                    <td class="bar-cell">
                        <div class="bar" style="width:${pct}%;background:hsl(${hue},70%,45%);"></div>
                    </td>
                    <td class="count">${e.count}</td>
                    <td class="ratio">${(e.ratio * 100).toFixed(0)}%</td>
                </tr>`;
        }).join('\n');

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; margin: 0; }
    h2 { margin: 0 0 4px 0; font-size: 1.15em; }
    .subtitle { color: var(--vscode-descriptionForeground); margin-bottom: 14px; font-size: 0.9em; }
    .toolbar { display: flex; gap: 8px; margin-bottom: 14px; }
    .toolbar button { padding: 4px 12px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; cursor: pointer; font-size: 0.85em; }
    .toolbar button:hover { background: var(--vscode-button-hoverBackground); }
    table { width: 100%; border-collapse: collapse; font-size: 0.87em; }
    th { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); font-weight: 500; }
    .row { cursor: pointer; }
    .row:hover { background: var(--vscode-list-hoverBackground); }
    td { padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
    .file { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 300px; }
    .bar-cell { width: 30%; }
    .bar { height: 14px; border-radius: 3px; min-width: 4px; }
    .count, .ratio { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .tag { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 0.8em; margin-right: 4px; }
    .tag.dep { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    .tag.dept { background: #2d5a2d; color: #b5e8b5; }
    .tag.hidden { background: #7a3c1a; color: #f5c89a; }
    .legend { display: flex; gap: 16px; margin-top: 14px; font-size: 0.82em; color: var(--vscode-descriptionForeground); }
    .legend-item { display: flex; align-items: center; gap: 4px; }
    .legend-swatch { width: 12px; height: 12px; border-radius: 2px; }
</style>
</head>
<body>
    <h2>Co-Change Heat Map</h2>
    <p class="subtitle">Files that change together with <strong>${this.escapeHtml(data.focusRel)}</strong> in git history</p>
    <div class="toolbar">
        <button onclick="vscode.postMessage({command:'refocusCurrent'})">Refocus on Current File</button>
    </div>
    <table>
        <tr>
            <th>File</th>
            <th>Relation</th>
            <th>Co-changes</th>
            <th>#</th>
            <th>Ratio</th>
        </tr>
        ${rows}
    </table>
    <div class="legend">
        <div class="legend-item"><div class="legend-swatch" style="background:hsl(0,70%,45%)"></div> High coupling</div>
        <div class="legend-item"><div class="legend-swatch" style="background:hsl(60,70%,45%)"></div> Medium</div>
        <div class="legend-item"><div class="legend-swatch" style="background:hsl(120,70%,45%)"></div> Low coupling</div>
        <div class="legend-item"><span class="tag hidden">hidden coupling</span> Not in import graph</div>
    </div>
    <script>const vscode = acquireVsCodeApi();</script>
</body>
</html>`;
    }

    private escapeHtml(s: string): string {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    private escapeJs(s: string): string {
        return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    }
}
