import * as vscode from 'vscode';
import { DependencyAnalyzer } from '../analyzer/DependencyAnalyzer';

/**
 * Decorates files in the Explorer with badges:
 *  - Hub files (top 10 by connections) → 🔥 badge with connection count
 *  - Cycle participants → ⚠ badge
 *  - Orphan files (no connections) → ○ badge
 */
export class HiveMindFileDecorationProvider implements vscode.FileDecorationProvider {
    private _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
    readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

    private hubSet = new Map<string, number>();   // absPath → connection count
    private cycleSet = new Set<string>();          // absPath

    constructor(private readonly analyzer: DependencyAnalyzer) {
        this.recompute();
    }

    /** Recompute hub/cycle sets after re-index. */
    recompute(): void {
        const stats = this.analyzer.getStats();

        this.hubSet.clear();
        for (const hub of stats.hubFiles) {
            const abs = this.analyzer.resolveFilePath(hub.path);
            if (abs) { this.hubSet.set(abs, hub.connections); }
        }

        this.cycleSet.clear();
        const cycles = this.analyzer.detectCycles();
        for (const cycle of cycles) {
            for (const file of cycle.files) {
                const abs = this.analyzer.resolveFilePath(file);
                if (abs) { this.cycleSet.add(abs); }
            }
        }

        this._onDidChangeFileDecorations.fire(undefined);
    }

    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        if (uri.scheme !== 'file') { return undefined; }
        const abs = uri.fsPath;

        // Hub files get highest priority
        const connections = this.hubSet.get(abs);
        if (connections !== undefined) {
            return {
                badge: '🔥',
                tooltip: `Hub file — ${connections} connections`,
                color: new vscode.ThemeColor('charts.orange'),
            };
        }

        // Cycle participants
        if (this.cycleSet.has(abs)) {
            return {
                badge: '⚠',
                tooltip: 'Part of a circular dependency',
                color: new vscode.ThemeColor('editorWarning.foreground'),
            };
        }

        return undefined;
    }
}
