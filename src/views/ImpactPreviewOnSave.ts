import * as vscode from 'vscode';
import { DependencyAnalyzer } from '../analyzer/DependencyAnalyzer';

/**
 * Shows a lightweight notification when a file is saved,
 * listing the downstream files affected by the change.
 */
export class ImpactPreviewOnSave implements vscode.Disposable {
    private disposable: vscode.Disposable;

    constructor(private readonly analyzer: DependencyAnalyzer) {
        this.disposable = vscode.workspace.onDidSaveTextDocument(doc => {
            this.onFileSaved(doc);
        });
    }

    private onFileSaved(doc: vscode.TextDocument): void {
        if (doc.uri.scheme !== 'file') { return; }

        const resolved = this.analyzer.resolveFilePath(doc.uri.fsPath);
        if (!resolved) { return; }

        const impacted = this.analyzer.getImpact(resolved, 2);
        if (impacted.length === 0) { return; }

        const relPaths = impacted.map(f => this.analyzer.toRelative(f));
        const topN = 5;
        const shown = relPaths.slice(0, topN);
        const remaining = relPaths.length - topN;

        const savedName = this.analyzer.toRelative(resolved);
        let message = `Hive Mind: Saving **${savedName}** impacts ${impacted.length} file(s): ${shown.join(', ')}`;
        if (remaining > 0) {
            message += ` and ${remaining} more`;
        }

        vscode.window.showInformationMessage(
            message,
            'Show All',
            'Dismiss',
        ).then(choice => {
            if (choice === 'Show All') {
                this.showFullImpact(savedName, relPaths);
            }
        });
    }

    private showFullImpact(savedFile: string, relPaths: string[]): void {
        this.analyzer.outputChannel.clear();
        this.analyzer.outputChannel.appendLine(`[Hive Mind] Impact of saving ${savedFile} — ${relPaths.length} file(s):\n`);
        for (const p of relPaths) {
            this.analyzer.outputChannel.appendLine(`  ${p}`);
        }
        this.analyzer.outputChannel.show();
    }

    dispose(): void {
        this.disposable.dispose();
    }
}
