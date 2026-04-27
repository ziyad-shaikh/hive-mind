import * as vscode from 'vscode';
import { DependencyAnalyzer } from './analyzer/DependencyAnalyzer';
import { SymbolAnalyzer } from './analyzer/SymbolAnalyzer';
import { GitAnalyzer } from './analyzer/GitAnalyzer';
import { ClangdClient } from './analyzer/ClangdClient';
import { MacroExpander } from './analyzer/MacroExpander';
import { BuildSubset } from './analyzer/BuildSubset';
import { GraphCache } from './analyzer/GraphCache';
import { GraphPanel } from './graph/GraphPanel';
import { registerTools } from './tools';
import { registerChatParticipant } from './chat/HiveMindParticipant';
import { scaffoldInstructions } from './scaffold';

let analyzer: DependencyAnalyzer;
let symbolAnalyzer: SymbolAnalyzer;
let gitAnalyzer: GitAnalyzer;
let clangdClient: ClangdClient | null = null;
let macroExpander: MacroExpander | null = null;
let buildSubset: BuildSubset | null = null;
let statusBarItem: vscode.StatusBarItem;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    analyzer = new DependencyAnalyzer();
    symbolAnalyzer = new SymbolAnalyzer();
    gitAnalyzer = new GitAnalyzer();

    // ── Disk-backed graph cache ─────────────────────────────────
    // Snapshots are persisted under the extension's globalStorage so that
    // re-opening a 100k-file workspace doesn't re-parse everything.
    const graphCache = new GraphCache(context.globalStorageUri, analyzer.outputChannel);
    analyzer.setCache(graphCache);

    // ── Status bar ──────────────────────────────────────────────────────
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    statusBarItem.command = 'hiveMind.showGraph';
    statusBarItem.text = '$(pulse) Hive Mind: Indexing...';
    statusBarItem.tooltip = 'Click to open the dependency graph';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // ── Initial analysis ────────────────────────────────────────────────
    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Hive Mind: Indexing workspace...' },
        async () => { await analyzer.analyze(); }
    );
    updateStatusBar();

    // ── Git co-change analysis (background) ─────────────────────────────
    try { gitAnalyzer.analyze(); } catch { /* git not available */ }

    // ── Background symbol indexing ──────────────────────────────────────
    const allFiles = analyzer.getIndexedFiles();
    if (allFiles.length <= 500) {
        // Small workspace: index all symbols in background
        const absFiles = analyzer.getAllFilePaths();
        symbolAnalyzer.indexFiles(absFiles).catch(() => {});
    }

    context.subscriptions.push(analyzer.outputChannel);

    // ── File watcher (debounced) ────────────────────────────────────────
    const watchGlob = '**/*.{ts,tsx,js,jsx,mjs,cjs,vue,svelte,py,cs,go,rs,cpp,c,h,hpp,hxx,java,kt,kts,php,rb,swift,css,scss,sass,less,styl}';
    const watcher = vscode.workspace.createFileSystemWatcher(watchGlob, false, false, false);
    watcher.onDidChange(uri => {
        analyzer.debouncedUpdateFile(uri.fsPath);
        symbolAnalyzer.invalidate(uri.fsPath);
        updateStatusBar();
    });
    watcher.onDidCreate(uri => {
        analyzer.debouncedUpdateFile(uri.fsPath);
        updateStatusBar();
    });
    watcher.onDidDelete(uri => {
        analyzer.removeFile(uri.fsPath);
        symbolAnalyzer.invalidate(uri.fsPath);
        updateStatusBar();
    });
    context.subscriptions.push(watcher);

    // ── Re-analyze when configuration changes ───────────────────────────
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('hiveMind')) {
                vscode.commands.executeCommand('hiveMind.analyzeWorkspace');
            }
        })
    );

    // ── Commands ────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('hiveMind.showGraph', () => {
            GraphPanel.createOrShow(context.extensionUri, analyzer);
        }),

        vscode.commands.registerCommand('hiveMind.showFileGraph', (resourceUri?: vscode.Uri) => {
            const targetFile = resourceUri?.fsPath
                ?? vscode.window.activeTextEditor?.document.uri.fsPath;
            GraphPanel.createOrShow(context.extensionUri, analyzer, targetFile);
        }),

        vscode.commands.registerCommand('hiveMind.analyzeWorkspace', async () => {
            statusBarItem.text = '$(sync~spin) Hive Mind: Re-indexing...';
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Hive Mind: Re-analyzing workspace...' },
                async () => { await analyzer.analyze(); }
            );
            symbolAnalyzer.clear();
            try { gitAnalyzer.analyze(); } catch { /* git not available */ }
            updateStatusBar();
            vscode.window.showInformationMessage(
                `Hive Mind: ${analyzer.getNodeCount()} files, ${analyzer.getEdgeCount()} relationships indexed.`
            );
            GraphPanel.refresh(analyzer);
        }),

        vscode.commands.registerCommand('hiveMind.showIndexedFiles', () => {
            const files = analyzer.getIndexedFiles();
            analyzer.outputChannel.clear();
            analyzer.outputChannel.appendLine(`[Hive Mind] ${files.length} indexed files:\n`);
            for (const f of files) { analyzer.outputChannel.appendLine('  ' + f); }
            analyzer.outputChannel.show();
        }),

        vscode.commands.registerCommand('hiveMind.showCycles', () => {
            const cycles = analyzer.detectCycles();
            analyzer.outputChannel.clear();
            if (cycles.length === 0) {
                analyzer.outputChannel.appendLine('[Hive Mind] No circular dependencies detected!');
            } else {
                analyzer.outputChannel.appendLine(`[Hive Mind] Found ${cycles.length} circular dependency chain(s):\n`);
                for (let i = 0; i < cycles.length; i++) {
                    analyzer.outputChannel.appendLine(`  Cycle ${i + 1}: ${cycles[i].files.join(' → ')} → (back to start)`);
                }
            }
            analyzer.outputChannel.show();
        }),

        vscode.commands.registerCommand('hiveMind.scaffoldInstructions', scaffoldInstructions),

        vscode.commands.registerCommand('hiveMind.invalidateCache', async () => {
            const roots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
            graphCache.invalidate(roots);
            vscode.window.showInformationMessage('Hive Mind: cache invalidated. Re-running analysis...');
            await vscode.commands.executeCommand('hiveMind.analyzeWorkspace');
        }),

        vscode.commands.registerCommand('hiveMind.checkClangd', async () => {
            const client = getClangdClient();
            analyzer.outputChannel.show();
            if (!client) {
                analyzer.outputChannel.appendLine('[Hive Mind] No workspace folder open — clangd cannot start.');
                return;
            }
            analyzer.outputChannel.appendLine('[Hive Mind] Probing clangd...');
            const info = await client.getInfo();
            if (info.available) {
                analyzer.outputChannel.appendLine(`[Hive Mind] clangd ready ✔  exe=${info.executable}  version=${info.version ?? 'unknown'}`);
                vscode.window.showInformationMessage(`clangd ready (version ${info.version ?? 'unknown'})`);
            } else {
                analyzer.outputChannel.appendLine(`[Hive Mind] clangd NOT available: ${info.reason}`);
                vscode.window.showWarningMessage(`Hive Mind: clangd not available — ${info.reason}`);
            }
        }),

        vscode.commands.registerCommand('hiveMind.showStats', () => {
            const stats = analyzer.getStats();
            analyzer.outputChannel.clear();
            analyzer.outputChannel.appendLine('[Hive Mind] Workspace Statistics\n');
            analyzer.outputChannel.appendLine(`  Total files: ${stats.totalFiles}`);
            analyzer.outputChannel.appendLine(`  Total edges: ${stats.totalEdges}`);
            analyzer.outputChannel.appendLine(`  Orphan files (no connections): ${stats.orphanFiles}`);
            analyzer.outputChannel.appendLine(`  Circular dependencies: ${stats.circularDeps}\n`);
            analyzer.outputChannel.appendLine('  Languages:');
            for (const [lang, count] of Object.entries(stats.languages).sort((a, b) => b[1] - a[1])) {
                analyzer.outputChannel.appendLine(`    ${lang}: ${count}`);
            }
            analyzer.outputChannel.appendLine('\n  Hub files (most connected):');
            for (const hub of stats.hubFiles) {
                analyzer.outputChannel.appendLine(`    ${hub.path} — ${hub.connections} connections`);
            }
            analyzer.outputChannel.show();
        })
    );

    // ── Register Copilot LM tools ───────────────────────────────────────
    registerTools(context, analyzer, symbolAnalyzer, gitAnalyzer, getClangdClient, getMacroExpander, getBuildSubset);

    // ── Register @hivemind chat participant ──────────────────────────────
    registerChatParticipant(context, analyzer, symbolAnalyzer, gitAnalyzer);

    // ── Index symbols for active editor on open ─────────────────────────
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor && editor.document.uri.scheme === 'file') {
                symbolAnalyzer.indexFile(editor.document.uri.fsPath).catch(() => {});
            }
        })
    );
    // Index currently active editor
    if (vscode.window.activeTextEditor?.document.uri.scheme === 'file') {
        symbolAnalyzer.indexFile(vscode.window.activeTextEditor.document.uri.fsPath).catch(() => {});
    }
}

function updateStatusBar(): void {
    const files = analyzer.getNodeCount();
    const edges = analyzer.getEdgeCount();
    statusBarItem.text = `$(pulse) Hive Mind: ${files} files · ${edges} edges`;
}

export function deactivate(): void {
    if (clangdClient) {
        clangdClient.dispose().catch(() => { /* ignore */ });
        clangdClient = null;
    }
    // remaining cleanup handled by context.subscriptions
}

/**
 * Lazily construct the ClangdClient against the first workspace folder.
 * Returns null if no workspace is open.
 */
function getClangdClient(): ClangdClient | null {
    if (clangdClient) { return clangdClient; }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { return null; }
    clangdClient = new ClangdClient(folder.uri.fsPath, analyzer.outputChannel);
    return clangdClient;
}

/** Lazily construct the MacroExpander against the first workspace folder. */
function getMacroExpander(): MacroExpander | null {
    if (macroExpander) { return macroExpander; }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { return null; }
    macroExpander = new MacroExpander(
        folder.uri.fsPath,
        analyzer.outputChannel,
        () => analyzer.getIncludePaths()
    );
    return macroExpander;
}

/** Lazily construct the BuildSubset compile-checker against the first workspace folder. */
function getBuildSubset(): BuildSubset | null {
    if (buildSubset) { return buildSubset; }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { return null; }
    buildSubset = new BuildSubset(folder.uri.fsPath, analyzer.outputChannel, {
        getImpact: (seed, depth) => analyzer.getImpact(seed, depth),
        resolveFilePath: (input) => analyzer.resolveFilePath(input),
    });
    return buildSubset;
}

export { getClangdClient, getMacroExpander, getBuildSubset };
