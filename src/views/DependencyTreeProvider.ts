import * as vscode from 'vscode';
import * as path from 'path';
import { DependencyAnalyzer } from '../analyzer/DependencyAnalyzer';

// ── Tree item types ────────────────────────────────────────────────────
type RootSection = 'dependencies' | 'dependents' | 'hubs' | 'orphans' | 'cycles';

interface SectionItem { kind: 'section'; section: RootSection; label: string; count: number }
interface FileItem   { kind: 'file';    absPath: string; relPath: string; extra?: string }
interface CycleItem  { kind: 'cycle';   index: number; files: string[] }

type TreeItem = SectionItem | FileItem | CycleItem;

// ── Language → icon mapping (ThemeIcon ids) ────────────────────────────
const langIcon: Record<string, string> = {
    typescript: 'symbol-method', javascript: 'symbol-method',
    c: 'symbol-field', cpp: 'symbol-field', 'c/c++ header': 'symbol-interface',
    python: 'symbol-variable', go: 'symbol-constant', rust: 'symbol-struct',
    java: 'symbol-class', csharp: 'symbol-class', ruby: 'symbol-color',
    php: 'symbol-event', swift: 'symbol-enum', css: 'symbol-color',
};

// ────────────────────────────────────────────────────────────────────────
export class DependencyTreeProvider implements vscode.TreeDataProvider<TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private activeFile: string | undefined;

    constructor(private readonly analyzer: DependencyAnalyzer) {}

    /** Call when the focused editor changes. */
    setActiveFile(absPath: string | undefined): void {
        this.activeFile = absPath;
        this._onDidChangeTreeData.fire(undefined);
    }

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    // ── TreeDataProvider ─────────────────────────────────────────────
    getTreeItem(el: TreeItem): vscode.TreeItem {
        switch (el.kind) {
            case 'section': {
                const item = new vscode.TreeItem(
                    `${el.label} (${el.count})`,
                    el.count > 0
                        ? vscode.TreeItemCollapsibleState.Collapsed
                        : vscode.TreeItemCollapsibleState.None,
                );
                item.iconPath = sectionIcon(el.section);
                item.contextValue = 'section';
                return item;
            }
            case 'file': {
                const item = new vscode.TreeItem(el.relPath, vscode.TreeItemCollapsibleState.None);
                item.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(el.absPath)] };
                item.tooltip = el.absPath;
                item.description = el.extra;
                item.iconPath = fileThemeIcon(el.relPath);
                item.contextValue = 'file';
                return item;
            }
            case 'cycle': {
                const item = new vscode.TreeItem(
                    `Cycle ${el.index + 1}`,
                    vscode.TreeItemCollapsibleState.Collapsed,
                );
                item.description = `${el.files.length} files`;
                item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
                item.contextValue = 'cycle';
                return item;
            }
        }
    }

    getChildren(element?: TreeItem): TreeItem[] {
        if (!element) {
            return this.getRootSections();
        }
        if (element.kind === 'section') {
            return this.getSectionChildren(element.section);
        }
        if (element.kind === 'cycle') {
            return element.files.map(f => ({
                kind: 'file' as const,
                absPath: this.analyzer.resolveFilePath(f) ?? f,
                relPath: f,
            }));
        }
        return [];
    }

    // ── Root sections ────────────────────────────────────────────────
    private getRootSections(): SectionItem[] {
        const stats = this.analyzer.getStats();
        const related = this.activeFile
            ? this.analyzer.getRelatedFiles(this.activeFile)
            : { dependencies: [], dependents: [] };

        return [
            { kind: 'section', section: 'dependencies', label: 'Dependencies', count: related.dependencies.length },
            { kind: 'section', section: 'dependents', label: 'Dependents', count: related.dependents.length },
            { kind: 'section', section: 'hubs', label: 'Hub Files', count: stats.hubFiles.length },
            { kind: 'section', section: 'orphans', label: 'Orphan Files', count: stats.orphanFiles },
            { kind: 'section', section: 'cycles', label: 'Circular Dependencies', count: stats.circularDeps },
        ];
    }

    private getSectionChildren(section: RootSection): TreeItem[] {
        switch (section) {
            case 'dependencies': {
                if (!this.activeFile) { return []; }
                const { dependencies } = this.analyzer.getRelatedFiles(this.activeFile);
                return dependencies.map(d => toFileItem(this.analyzer, d));
            }
            case 'dependents': {
                if (!this.activeFile) { return []; }
                const { dependents } = this.analyzer.getRelatedFiles(this.activeFile);
                return dependents.map(d => toFileItem(this.analyzer, d));
            }
            case 'hubs': {
                const stats = this.analyzer.getStats();
                return stats.hubFiles.map(h => ({
                    kind: 'file' as const,
                    absPath: this.analyzer.resolveFilePath(h.path) ?? h.path,
                    relPath: h.path,
                    extra: `${h.connections} connections`,
                }));
            }
            case 'orphans': {
                return this.getOrphanFiles();
            }
            case 'cycles': {
                const cycles = this.analyzer.detectCycles();
                return cycles.map((c, i) => ({
                    kind: 'cycle' as const,
                    index: i,
                    files: c.files,
                }));
            }
        }
    }

    private getOrphanFiles(): FileItem[] {
        const allFiles = this.analyzer.getAllFilePaths();
        const orphans: FileItem[] = [];
        for (const abs of allFiles) {
            const { dependencies, dependents } = this.analyzer.getRelatedFiles(abs);
            if (dependencies.length === 0 && dependents.length === 0) {
                orphans.push({
                    kind: 'file',
                    absPath: abs,
                    relPath: this.analyzer.toRelative(abs),
                });
            }
        }
        return orphans;
    }
}

// ── Helpers ────────────────────────────────────────────────────────────
function toFileItem(analyzer: DependencyAnalyzer, absPath: string): FileItem {
    return {
        kind: 'file',
        absPath,
        relPath: analyzer.toRelative(absPath),
    };
}

function sectionIcon(section: RootSection): vscode.ThemeIcon {
    switch (section) {
        case 'dependencies': return new vscode.ThemeIcon('references');
        case 'dependents':   return new vscode.ThemeIcon('callstack-view-session');
        case 'hubs':         return new vscode.ThemeIcon('flame');
        case 'orphans':      return new vscode.ThemeIcon('debug-disconnect');
        case 'cycles':       return new vscode.ThemeIcon('sync');
    }
}

function fileThemeIcon(relPath: string): vscode.ThemeIcon {
    const ext = path.extname(relPath).toLowerCase().replace('.', '');
    const map: Record<string, string> = {
        ts: 'symbol-method', tsx: 'symbol-method', js: 'symbol-method', jsx: 'symbol-method',
        c: 'symbol-field', cpp: 'symbol-field', cc: 'symbol-field', cxx: 'symbol-field',
        h: 'symbol-interface', hpp: 'symbol-interface', hxx: 'symbol-interface',
        py: 'symbol-variable', go: 'symbol-constant', rs: 'symbol-struct',
        java: 'symbol-class', kt: 'symbol-class', cs: 'symbol-class',
        rb: 'symbol-color', php: 'symbol-event', swift: 'symbol-enum',
        css: 'symbol-color', scss: 'symbol-color', vue: 'symbol-method', svelte: 'symbol-method',
    };
    return new vscode.ThemeIcon(map[ext] ?? 'file');
}
