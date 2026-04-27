import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { DependencyAnalyzer } from '../analyzer/DependencyAnalyzer';
import { SymbolAnalyzer } from '../analyzer/SymbolAnalyzer';
import { GitAnalyzer } from '../analyzer/GitAnalyzer';
import { ClangdClient, DocumentSymbol as LspDocumentSymbol, Location as LspLocation, Position as LspPosition, CallHierarchyItem, TypeHierarchyItem } from '../analyzer/ClangdClient';
import { MacroExpander } from '../analyzer/MacroExpander';
import { BuildSubset } from '../analyzer/BuildSubset';

/** Lazy accessor for the shared ClangdClient singleton (or null if no workspace open). */
type ClangdProvider = () => ClangdClient | null;
/** Lazy accessor for the shared MacroExpander singleton (or null if no workspace open). */
type MacroExpanderProvider = () => MacroExpander | null;
/** Lazy accessor for the shared BuildSubset singleton (or null if no workspace open). */
type BuildSubsetProvider = () => BuildSubset | null;

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

function rel(analyzer: DependencyAnalyzer, absPath: string): string {
    return analyzer.toRelative(absPath);
}

function fileList(analyzer: DependencyAnalyzer, files: string[]): string {
    if (files.length === 0) { return '(none)'; }
    return files.map(f => `- \`${rel(analyzer, f)}\``).join('\n');
}

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: hivemind_getDependencies
// ─────────────────────────────────────────────────────────────────────────────

interface GetDepsInput { filePath: string; depth?: number; }

class GetDependenciesTool implements vscode.LanguageModelTool<GetDepsInput> {
    constructor(private readonly analyzer: DependencyAnalyzer) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetDepsInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { filePath, depth = 2 } = options.input;
        const resolved = this.analyzer.resolveFilePath(filePath);
        const deps = this.analyzer.getDependencies(filePath, depth);
        const resolvedDisplay = resolved ? rel(this.analyzer, resolved) : filePath;

        const parts: string[] = [];

        if (!resolved) {
            parts.push(
                `⚠️ File "${filePath}" was not found in the Hive Mind index.`,
                `The index contains ${this.analyzer.getNodeCount()} files.`,
                `Try using the full relative path from the workspace root.`
            );
        } else if (deps.length === 0) {
            parts.push(
                `**${resolvedDisplay}** has no resolved dependencies (depth=${depth}).`,
                `The file either has no imports, or its imports point to external packages not in the workspace.`
            );
        } else {
            parts.push(
                `**${resolvedDisplay}** depends on ${deps.length} file(s) (depth=${depth}):\n`,
                fileList(this.analyzer, deps)
            );
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(parts.join('\n')),
        ]);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: hivemind_getImpact
// ─────────────────────────────────────────────────────────────────────────────

interface GetImpactInput { filePath: string; }

class GetImpactTool implements vscode.LanguageModelTool<GetImpactInput> {
    constructor(private readonly analyzer: DependencyAnalyzer) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetImpactInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { filePath } = options.input;
        const resolved = this.analyzer.resolveFilePath(filePath);
        const impacted = this.analyzer.getImpact(filePath, 3);
        const resolvedDisplay = resolved ? rel(this.analyzer, resolved) : filePath;

        const parts: string[] = [];

        if (!resolved) {
            parts.push(
                `⚠️ File "${filePath}" was not found in the Hive Mind index.`,
                `The index contains ${this.analyzer.getNodeCount()} files.`,
                `Try using the full relative path from the workspace root.`
            );
        } else if (impacted.length === 0) {
            parts.push(
                `**${resolvedDisplay}** — no other files in the workspace depend on this file.`,
                `Changes here have no known downstream impact.`
            );
        } else {
            parts.push(
                `⚠️ Modifying **${resolvedDisplay}** may impact ${impacted.length} file(s):\n`,
                fileList(this.analyzer, impacted),
                `\nReview these files to ensure they remain consistent with your changes.`
            );
        }

        // Include related test files
        if (resolved) {
            const testFiles = this.analyzer.getTestFiles(resolved);
            if (testFiles.length > 0) {
                parts.push(`\n**Related test files** (re-run after changes):\n`);
                parts.push(fileList(this.analyzer, testFiles));
            }
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(parts.join('\n')),
        ]);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: hivemind_getRelatedFiles
// ─────────────────────────────────────────────────────────────────────────────

interface GetRelatedInput { filePath: string; }

class GetRelatedFilesTool implements vscode.LanguageModelTool<GetRelatedInput> {
    constructor(private readonly analyzer: DependencyAnalyzer) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetRelatedInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { filePath } = options.input;
        const resolved = this.analyzer.resolveFilePath(filePath);
        const { dependencies, dependents } = this.analyzer.getRelatedFiles(filePath);
        const resolvedDisplay = resolved ? rel(this.analyzer, resolved) : filePath;

        const parts: string[] = [];

        if (!resolved) {
            parts.push(
                `⚠️ File "${filePath}" was not found in the Hive Mind index.`,
                `The index contains ${this.analyzer.getNodeCount()} files.`
            );
        } else {
            const total = dependencies.length + dependents.length;
            parts.push(`**${resolvedDisplay}** has ${total} direct connection(s):\n`);
            parts.push(`**Imports (this file depends on):**`);
            parts.push(fileList(this.analyzer, dependencies));
            parts.push(`\n**Imported by (these files depend on this file):**`);
            parts.push(fileList(this.analyzer, dependents));
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(parts.join('\n')),
        ]);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: hivemind_getFullGraph
// ─────────────────────────────────────────────────────────────────────────────

interface GetFullGraphInput { maxNodes?: number; }

class GetFullGraphTool implements vscode.LanguageModelTool<GetFullGraphInput> {
    constructor(private readonly analyzer: DependencyAnalyzer) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetFullGraphInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const stats = this.analyzer.getStats();
        const maxNodes = options.input.maxNodes ?? 150;

        const lines: string[] = [
            `## Hive Mind — Workspace Dependency Graph\n`,
            `| Metric | Value |`,
            `|--------|-------|`,
            `| Files analyzed | ${stats.totalFiles} |`,
            `| Dependency edges | ${stats.totalEdges} |`,
            `| Circular dependencies | ${stats.circularDeps} |`,
            `| Orphan files (no connections) | ${stats.orphanFiles} |`,
            ``,
            `### Hub Files (most connected)\n`,
            `| File | Connections |`,
            `|------|------------|`,
            ...stats.hubFiles.map(h => `| \`${h.path}\` | ${h.connections} |`),
            ``,
            `### Language Breakdown\n`,
            `| Language | Files |`,
            `|----------|-------|`,
        ];

        for (const [lang, count] of Object.entries(stats.languages).sort((a, b) => b[1] - a[1])) {
            lines.push(`| ${lang} | ${count} |`);
        }

        if (stats.circularDeps > 0) {
            const cycles = this.analyzer.detectCycles();
            lines.push(`\n### Circular Dependencies (${cycles.length})\n`);
            for (let i = 0; i < Math.min(cycles.length, 10); i++) {
                lines.push(`${i + 1}. ${cycles[i].files.join(' → ')} → ↩`);
            }
            if (cycles.length > 10) {
                lines.push(`\n... and ${cycles.length - 10} more.`);
            }
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(lines.join('\n')),
        ]);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: hivemind_detectCycles
// ─────────────────────────────────────────────────────────────────────────────

class DetectCyclesTool implements vscode.LanguageModelTool<Record<string, never>> {
    constructor(private readonly analyzer: DependencyAnalyzer) {}

    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const cycles = this.analyzer.detectCycles();

        if (cycles.length === 0) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('No circular dependencies detected in the workspace.'),
            ]);
        }

        const lines = [
            `Found **${cycles.length}** circular dependency chain(s):\n`,
        ];
        for (let i = 0; i < cycles.length; i++) {
            lines.push(`${i + 1}. ${cycles[i].files.map(f => `\`${f}\``).join(' → ')} → ↩`);
        }
        lines.push(`\nCircular dependencies can cause issues with tree-shaking, incremental builds, and testability.`);
        lines.push(`Consider extracting shared code into a separate module to break these cycles.`);

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(lines.join('\n')),
        ]);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: hivemind_getTestFiles
// ─────────────────────────────────────────────────────────────────────────────

interface GetTestFilesInput { filePath: string; }

class GetTestFilesTool implements vscode.LanguageModelTool<GetTestFilesInput> {
    constructor(private readonly analyzer: DependencyAnalyzer) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetTestFilesInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { filePath } = options.input;
        const resolved = this.analyzer.resolveFilePath(filePath);
        const resolvedDisplay = resolved ? rel(this.analyzer, resolved) : filePath;

        if (!resolved) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `⚠️ File "${filePath}" was not found in the Hive Mind index.\n` +
                    `The index contains ${this.analyzer.getNodeCount()} files.`
                ),
            ]);
        }

        const testFiles = this.analyzer.getTestFiles(resolved);
        const sourceFile = this.analyzer.getSourceForTest(resolved);

        const parts: string[] = [];

        if (sourceFile) {
            parts.push(`**${resolvedDisplay}** is a test file for:\n`);
            parts.push(`- \`${rel(this.analyzer, sourceFile)}\`\n`);
        }

        if (testFiles.length > 0) {
            parts.push(`**Related test files for ${resolvedDisplay}:**\n`);
            parts.push(fileList(this.analyzer, testFiles));
        }

        if (!sourceFile && testFiles.length === 0) {
            parts.push(`No test file mappings found for **${resolvedDisplay}**.`);
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(parts.join('\n')),
        ]);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: hivemind_findSymbol
// ─────────────────────────────────────────────────────────────────────────────

interface FindSymbolInput { symbolName: string; }

class FindSymbolTool implements vscode.LanguageModelTool<FindSymbolInput> {
    constructor(
        private readonly analyzer: DependencyAnalyzer,
        private readonly symbolAnalyzer: SymbolAnalyzer
    ) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<FindSymbolInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { symbolName } = options.input;
        const results = this.symbolAnalyzer.findSymbol(symbolName);

        if (results.length === 0) {
            // Try indexing active file on demand
            const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
            if (activeFile) {
                await this.symbolAnalyzer.indexFile(activeFile);
                const retryResults = this.symbolAnalyzer.findSymbol(symbolName);
                if (retryResults.length > 0) {
                    return this.formatResults(symbolName, retryResults);
                }
            }

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `No symbol named "${symbolName}" found in the indexed files.\n` +
                    `${this.symbolAnalyzer.indexedCount} files have been symbol-indexed so far. ` +
                    `Symbols are indexed on demand — try opening the file first.`
                ),
            ]);
        }

        return this.formatResults(symbolName, results);
    }

    private formatResults(symbolName: string, results: { name: string; kind: number; filePath: string; range: { start: { line: number } } }[]): vscode.LanguageModelToolResult {
        const kindNames: Record<number, string> = {
            0: 'File', 1: 'Module', 2: 'Namespace', 3: 'Package',
            4: 'Class', 5: 'Method', 6: 'Property', 7: 'Field',
            8: 'Constructor', 9: 'Enum', 10: 'Interface', 11: 'Function',
            12: 'Variable', 13: 'Constant', 14: 'String', 15: 'Number',
            16: 'Boolean', 17: 'Array', 18: 'Object', 19: 'Key',
            20: 'Null', 21: 'EnumMember', 22: 'Struct', 23: 'Event',
            24: 'Operator', 25: 'TypeParameter',
        };

        const lines = [
            `Found **${results.length}** match(es) for "${symbolName}":\n`,
            `| Symbol | Kind | File | Line |`,
            `|--------|------|------|------|`,
        ];

        for (const r of results.slice(0, 30)) {
            const kind = kindNames[r.kind] ?? 'Unknown';
            const relPath = this.analyzer.toRelative(r.filePath);
            const line = r.range.start.line + 1;
            lines.push(`| \`${r.name}\` | ${kind} | \`${relPath}\` | ${line} |`);
        }

        if (results.length > 30) {
            lines.push(`\n... and ${results.length - 30} more.`);
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(lines.join('\n')),
        ]);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: hivemind_coChanged
// ─────────────────────────────────────────────────────────────────────────────

interface CoChangedInput { filePath: string; }

class CoChangedTool implements vscode.LanguageModelTool<CoChangedInput> {
    constructor(
        private readonly analyzer: DependencyAnalyzer,
        private readonly gitAnalyzer: GitAnalyzer
    ) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<CoChangedInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { filePath } = options.input;
        const resolved = this.analyzer.resolveFilePath(filePath);
        const resolvedDisplay = resolved ? rel(this.analyzer, resolved) : filePath;

        if (!resolved) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `⚠️ File "${filePath}" was not found in the Hive Mind index.`
                ),
            ]);
        }

        if (!this.gitAnalyzer.isAvailable) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `Git history analysis is not available. This workspace may not be a git repository, or git is not installed.`
                ),
            ]);
        }

        const coChanged = this.gitAnalyzer.getCoChangedFiles(resolved);

        if (coChanged.length === 0) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `No frequently co-changed files found for **${resolvedDisplay}** in recent git history.`
                ),
            ]);
        }

        const lines = [
            `**${resolvedDisplay}** frequently changes together with these files:\n`,
            `| File | Co-changes | Coupling |`,
            `|------|-----------|----------|`,
        ];

        for (const entry of coChanged) {
            const entryRel = this.analyzer.toRelative(entry.file);
            const pct = Math.round(entry.ratio * 100);
            lines.push(`| \`${entryRel}\` | ${entry.coChangeCount} | ${pct}% |`);
        }

        lines.push(`\nFiles with high coupling may need to be updated together, even without direct import relationships.`);

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(lines.join('\n')),
        ]);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: hivemind_getContext  — curated context bundle for a task
// ─────────────────────────────────────────────────────────────────────────────

interface GetContextInput {
    filePath: string;
    task?: string;
    includeContent?: boolean;
}

class GetContextTool implements vscode.LanguageModelTool<GetContextInput> {
    constructor(
        private readonly analyzer: DependencyAnalyzer,
        private readonly symbolAnalyzer: SymbolAnalyzer,
        private readonly gitAnalyzer: GitAnalyzer
    ) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetContextInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { filePath, task, includeContent } = options.input;
        const resolved = this.analyzer.resolveFilePath(filePath);

        if (!resolved) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `⚠️ File "${filePath}" was not found in the Hive Mind index.\n` +
                    `Index contains ${this.analyzer.getNodeCount()} files. Use a relative path from the workspace root.`
                ),
            ]);
        }

        const resolvedDisplay = rel(this.analyzer, resolved);
        const { dependencies, dependents } = this.analyzer.getRelatedFiles(resolved);
        const testFiles = this.analyzer.getTestFiles(resolved);
        const coChanged = this.gitAnalyzer.isAvailable
            ? this.gitAnalyzer.getCoChangedFiles(resolved)
            : [];

        // Symbol summary
        const symbols = await this.symbolAnalyzer.getFileSymbolsAsync(resolved);
        const exported = this.symbolAnalyzer.getExportedSymbols(resolved);

        const parts: string[] = [];

        // ── Header
        parts.push(`# Context Bundle: ${resolvedDisplay}\n`);
        if (task) { parts.push(`**Task:** ${task}\n`); }

        // ── File info
        const node = this.analyzer.resolveFilePath(resolved);
        parts.push(`## File Overview`);
        parts.push(`- **Path:** \`${resolvedDisplay}\``);
        parts.push(`- **Imports:** ${dependencies.length} file(s)`);
        parts.push(`- **Imported by:** ${dependents.length} file(s)`);
        parts.push(`- **Exported symbols:** ${exported.length}`);
        parts.push(`- **Test files:** ${testFiles.length}`);
        parts.push(``);

        // ── Exported symbols table
        if (exported.length > 0) {
            const kindNames: Record<number, string> = {
                4: 'Class', 5: 'Method', 9: 'Enum', 10: 'Interface',
                11: 'Function', 12: 'Variable', 13: 'Constant', 22: 'Struct',
                25: 'TypeParameter',
            };
            parts.push(`## Exported Symbols\n`);
            parts.push(`| Symbol | Kind | Line |`);
            parts.push(`|--------|------|------|`);
            for (const s of exported.slice(0, 40)) {
                const kind = kindNames[s.kind] ?? 'Other';
                parts.push(`| \`${s.name}\` | ${kind} | ${s.range.start.line + 1} |`);
            }
            parts.push(``);
        }

        // ── Direct dependencies
        if (dependencies.length > 0) {
            parts.push(`## This File Imports (${dependencies.length})\n`);
            for (const d of dependencies) {
                const r = rel(this.analyzer, d);
                const dExports = this.symbolAnalyzer.getExportedSymbols(d);
                if (dExports.length > 0) {
                    const names = dExports.slice(0, 6).map(s => s.name).join(', ');
                    const more = dExports.length > 6 ? ` +${dExports.length - 6} more` : '';
                    parts.push(`- \`${r}\` → exports: ${names}${more}`);
                } else {
                    parts.push(`- \`${r}\``);
                }
            }
            parts.push(``);
        }

        // ── Dependents (impacted files)
        if (dependents.length > 0) {
            parts.push(`## Files That Import This (${dependents.length})\n`);
            parts.push(dependents.map(d => `- \`${rel(this.analyzer, d)}\``).join('\n'));
            parts.push(``);
        }

        // ── Test files
        if (testFiles.length > 0) {
            parts.push(`## Test Files\n`);
            parts.push(testFiles.map(t => `- \`${rel(this.analyzer, t)}\``).join('\n'));
            parts.push(``);
        }

        // ── Co-changed files
        if (coChanged.length > 0) {
            parts.push(`## Historically Co-Changed (Git)\n`);
            parts.push(`| File | Co-changes | Coupling |`);
            parts.push(`|------|-----------|----------|`);
            for (const entry of coChanged.slice(0, 10)) {
                const entryRel = this.analyzer.toRelative(entry.file);
                const pct = Math.round(entry.ratio * 100);
                parts.push(`| \`${entryRel}\` | ${entry.coChangeCount} | ${pct}% |`);
            }
            parts.push(``);
        }

        // ── File content (opt-in, for small files)
        if (includeContent) {
            try {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved));
                const content = doc.getText();
                const lineCount = doc.lineCount;
                // Cap at 200 lines to avoid blowing context
                if (lineCount <= 200) {
                    parts.push(`## File Content (${lineCount} lines)\n`);
                    parts.push('```' + (doc.languageId || '') + '\n' + content + '\n```');
                } else {
                    parts.push(`## File Content (first 200 of ${lineCount} lines)\n`);
                    const truncated = content.split('\n').slice(0, 200).join('\n');
                    parts.push('```' + (doc.languageId || '') + '\n' + truncated + '\n```');
                    parts.push(`\n*Truncated — file has ${lineCount} lines total.*`);
                }
            } catch {
                parts.push(`\n*Could not read file content.*`);
            }
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(parts.join('\n')),
        ]);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: hivemind_planChange  — minimal file set for a task
// ─────────────────────────────────────────────────────────────────────────────

interface PlanChangeInput {
    filePath: string;
    description: string;
}

class PlanChangeTool implements vscode.LanguageModelTool<PlanChangeInput> {
    constructor(
        private readonly analyzer: DependencyAnalyzer,
        private readonly symbolAnalyzer: SymbolAnalyzer,
        private readonly gitAnalyzer: GitAnalyzer
    ) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<PlanChangeInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { filePath, description } = options.input;
        const resolved = this.analyzer.resolveFilePath(filePath);

        if (!resolved) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `⚠️ File "${filePath}" was not found in the Hive Mind index.\n` +
                    `Index contains ${this.analyzer.getNodeCount()} files.`
                ),
            ]);
        }

        const resolvedDisplay = rel(this.analyzer, resolved);
        const { dependencies, dependents } = this.analyzer.getRelatedFiles(resolved);

        // Gather all related data
        const testFiles = this.analyzer.getTestFiles(resolved);
        const coChanged = this.gitAnalyzer.isAvailable
            ? this.gitAnalyzer.getCoChangedFiles(resolved)
            : [];

        // Get transitive impact (depth 2 — what breaks)
        const impacted = this.analyzer.getImpact(resolved, 2);

        // Score every related file by relevance to this change
        const fileScores = new Map<string, { score: number; reasons: string[] }>();

        function addScore(file: string, points: number, reason: string) {
            const existing = fileScores.get(file) || { score: 0, reasons: [] };
            existing.score += points;
            existing.reasons.push(reason);
            fileScores.set(file, existing);
        }

        // The target file itself
        addScore(resolved, 100, 'target file');

        // Direct dependencies — likely need to read
        for (const d of dependencies) {
            addScore(d, 20, 'direct import');
        }

        // Direct dependents — may need updating
        for (const d of dependents) {
            addScore(d, 30, 'directly imports this file');
        }

        // Transitive impact (2-hop) — lower priority
        for (const d of impacted) {
            if (!dependents.includes(d)) {
                addScore(d, 10, 'transitive dependent');
            }
        }

        // Test files — need to update/verify
        for (const t of testFiles) {
            addScore(t, 25, 'test file');
        }

        // Co-changed — historically coupled
        for (const entry of coChanged) {
            const points = Math.min(15, Math.round(entry.ratio * 20));
            addScore(entry.file, points, `co-changed ${entry.coChangeCount}x (${Math.round(entry.ratio * 100)}%)`);
        }

        // Sort by score descending
        const ranked = [...fileScores.entries()]
            .sort((a, b) => b[1].score - a[1].score);

        // Categorize
        const mustRead: string[] = [];
        const mustModify: string[] = [];
        const shouldVerify: string[] = [];
        const maybeAffected: string[] = [];

        for (const [file, { score, reasons }] of ranked) {
            const r = rel(this.analyzer, file);
            if (file === resolved) {
                mustModify.push(r);
            } else if (reasons.includes('directly imports this file')) {
                mustModify.push(r);
            } else if (reasons.includes('test file')) {
                shouldVerify.push(r);
            } else if (score >= 20) {
                mustRead.push(r);
            } else {
                maybeAffected.push(r);
            }
        }

        const parts: string[] = [];
        parts.push(`# Change Plan: ${resolvedDisplay}\n`);
        parts.push(`**Task:** ${description}\n`);

        parts.push(`## 1. Files to Modify (${mustModify.length})\n`);
        parts.push(`These files will likely need code changes:\n`);
        for (const f of mustModify) {
            const entry = fileScores.get(this.analyzer.resolveFilePath(f) ?? f);
            const reasons = entry ? entry.reasons.join(', ') : '';
            parts.push(`- \`${f}\` — ${reasons}`);
        }

        parts.push(`\n## 2. Files to Read for Context (${mustRead.length})\n`);
        parts.push(`Understand these before making changes:\n`);
        for (const f of mustRead.slice(0, 15)) {
            const entry = fileScores.get(this.analyzer.resolveFilePath(f) ?? f);
            const reasons = entry ? entry.reasons.join(', ') : '';
            parts.push(`- \`${f}\` — ${reasons}`);
        }

        if (shouldVerify.length > 0) {
            parts.push(`\n## 3. Tests to Run/Update (${shouldVerify.length})\n`);
            for (const f of shouldVerify) {
                parts.push(`- \`${f}\``);
            }
        }

        if (maybeAffected.length > 0) {
            parts.push(`\n## 4. Possibly Affected (${maybeAffected.length})\n`);
            parts.push(`Lower confidence — check if the change scope is broad:\n`);
            for (const f of maybeAffected.slice(0, 10)) {
                parts.push(`- \`${f}\``);
            }
            if (maybeAffected.length > 10) {
                parts.push(`- ... and ${maybeAffected.length - 10} more`);
            }
        }

        parts.push(`\n---`);
        parts.push(`**Summary:** ${mustModify.length} to modify, ${mustRead.length} to read, ${shouldVerify.length} tests, ${maybeAffected.length} peripherally affected.`);

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(parts.join('\n')),
        ]);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: hivemind_search  — structural-aware text search
// ─────────────────────────────────────────────────────────────────────────────

interface SearchInput {
    query: string;
    isRegex?: boolean;
    caseSensitive?: boolean;
    maxResults?: number;
    contextFile?: string;
    includeSnippets?: boolean;
}

interface SearchHit {
    file: string;
    matchCount: number;
    structuralScore: number;
    totalScore: number;
    snippets: string[];
}

class SearchTool implements vscode.LanguageModelTool<SearchInput> {
    constructor(
        private readonly analyzer: DependencyAnalyzer,
        private readonly symbolAnalyzer: SymbolAnalyzer
    ) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<SearchInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const {
            query,
            isRegex = false,
            caseSensitive = false,
            maxResults = 30,
            contextFile,
            includeSnippets = true,
        } = options.input;

        if (!query || query.trim().length === 0) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('⚠️ Search query cannot be empty.'),
            ]);
        }

        // ── 1. Search all indexed files ─────────────────────────────────

        let regex: RegExp;
        try {
            const flags = caseSensitive ? 'g' : 'gi';
            regex = isRegex ? new RegExp(query, flags) : new RegExp(escapeRegex(query), flags);
        } catch {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`⚠️ Invalid regex pattern: "${query}"`),
            ]);
        }

        const allFiles = this.analyzer.getAllFilePaths();
        const fileMatches = new Map<string, { count: number; snippets: string[] }>();

        for (const filePath of allFiles) {
            let content: string;
            try {
                content = fs.readFileSync(filePath, 'utf-8');
            } catch {
                continue;
            }

            const lines = content.split('\n');
            let count = 0;
            const snippets: string[] = [];

            for (let i = 0; i < lines.length; i++) {
                // Reset regex lastIndex for each line
                regex.lastIndex = 0;
                const matches = lines[i].match(regex);
                if (matches) {
                    count += matches.length;
                    if (includeSnippets && snippets.length < 3) {
                        const trimmed = lines[i].trim();
                        if (trimmed.length > 0 && trimmed.length <= 200) {
                            snippets.push(`L${i + 1}: ${trimmed}`);
                        }
                    }
                }
            }

            if (count > 0) {
                fileMatches.set(filePath, { count, snippets });
            }
        }

        if (fileMatches.size === 0) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `No results found for "${query}" across ${allFiles.length} indexed files.`
                ),
            ]);
        }

        // ── 2. Compute structural proximity scores ──────────────────────

        // Build the set of matched files for cross-reference
        const matchedFiles = new Set(fileMatches.keys());

        // Resolve contextFile for proximity boosting
        const contextResolved = contextFile
            ? this.analyzer.resolveFilePath(contextFile)
            : null;

        // Get the structural neighborhood of contextFile
        const contextNeighbors = new Set<string>();
        if (contextResolved) {
            const { dependencies, dependents } = this.analyzer.getRelatedFiles(contextResolved);
            for (const d of dependencies) { contextNeighbors.add(d); }
            for (const d of dependents) { contextNeighbors.add(d); }
            contextNeighbors.add(contextResolved);
        }

        // Score each file
        const hits: SearchHit[] = [];

        for (const [file, { count, snippets }] of fileMatches) {
            let structuralScore = 0;

            // Boost files whose graph neighbors also have matches (cluster signal)
            const { dependencies, dependents } = this.analyzer.getRelatedFiles(file);
            const neighbors = [...dependencies, ...dependents];
            let neighborsWithMatches = 0;
            for (const n of neighbors) {
                if (matchedFiles.has(n)) { neighborsWithMatches++; }
            }
            // Each matching neighbor adds 2 points (max 10)
            structuralScore += Math.min(10, neighborsWithMatches * 2);

            // Boost if in the contextFile's structural neighborhood
            if (contextNeighbors.has(file)) {
                structuralScore += 15;
            }

            // Boost if it's a hub file (many connections = likely important)
            const connectionCount = neighbors.length;
            if (connectionCount >= 10) { structuralScore += 3; }
            else if (connectionCount >= 5) { structuralScore += 1; }

            // Boost if there are symbol name matches (e.g. query matches an exported symbol)
            const exported = this.symbolAnalyzer.getExportedSymbols(file);
            const queryLower = query.toLowerCase();
            const symbolMatch = exported.some(s => s.name.toLowerCase().includes(queryLower));
            if (symbolMatch) { structuralScore += 8; }

            const totalScore = count + structuralScore;

            hits.push({
                file,
                matchCount: count,
                structuralScore,
                totalScore,
                snippets,
            });
        }

        // Sort by total score descending, then by match count
        hits.sort((a, b) => b.totalScore - a.totalScore || b.matchCount - a.matchCount);

        // ── 3. Format output ────────────────────────────────────────────

        const capped = hits.slice(0, maxResults);
        const parts: string[] = [];

        parts.push(`# Search: "${query}"\n`);
        parts.push(`Found matches in **${fileMatches.size}** file(s)${fileMatches.size > maxResults ? ` (showing top ${maxResults})` : ''}.\n`);

        if (contextResolved) {
            parts.push(`*Structurally boosted around* \`${rel(this.analyzer, contextResolved)}\`\n`);
        }

        parts.push(`| # | File | Matches | Structural | Score |`);
        parts.push(`|---|------|---------|------------|-------|`);

        for (let i = 0; i < capped.length; i++) {
            const h = capped[i];
            const r = rel(this.analyzer, h.file);
            const structLabel = h.structuralScore > 0 ? `+${h.structuralScore}` : '—';
            parts.push(`| ${i + 1} | \`${r}\` | ${h.matchCount} | ${structLabel} | ${h.totalScore} |`);
        }

        // Snippets for top results
        if (includeSnippets) {
            const snippetCount = Math.min(10, capped.length);
            parts.push(`\n## Top Matches\n`);

            for (let i = 0; i < snippetCount; i++) {
                const h = capped[i];
                if (h.snippets.length === 0) { continue; }
                const r = rel(this.analyzer, h.file);
                parts.push(`### \`${r}\``);
                parts.push('```');
                for (const s of h.snippets) {
                    parts.push(s);
                }
                parts.push('```\n');
            }
        }

        if (fileMatches.size > maxResults) {
            parts.push(`\n*${fileMatches.size - maxResults} more file(s) not shown. Narrow your query or increase maxResults.*`);
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(parts.join('\n')),
        ]);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: hivemind_getCppPair
// ─────────────────────────────────────────────────────────────────────────────
//
// Given a C/C++ file (.h, .hpp, .cpp, .cc, etc.), returns the matching
// declaration / definition / inline files. Critical for refactoring: editing
// foo.cpp without touching foo.h is one of the most common AI mistakes.

interface GetCppPairInput { filePath: string; }

const CPP_HEADER_EXTS = new Set(['.h', '.hh', '.hpp', '.hxx', '.h++', '.cuh']);
const CPP_SOURCE_EXTS = new Set(['.c', '.cc', '.cpp', '.cxx', '.c++', '.cu', '.m', '.mm']);
const CPP_INLINE_EXTS = new Set(['.inl', '.ipp', '.tpp', '.tcc']);

function isCppHeader(p: string): boolean { return CPP_HEADER_EXTS.has(path.extname(p).toLowerCase()); }
function isCppSource(p: string): boolean { return CPP_SOURCE_EXTS.has(path.extname(p).toLowerCase()); }
function isCppInline(p: string): boolean { return CPP_INLINE_EXTS.has(path.extname(p).toLowerCase()); }

class GetCppPairTool implements vscode.LanguageModelTool<GetCppPairInput> {
    constructor(private readonly analyzer: DependencyAnalyzer) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetCppPairInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { filePath } = options.input;
        const resolved = this.analyzer.resolveFilePath(filePath);
        if (!resolved) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`⚠️ File "${filePath}" not found in the Hive Mind index.`),
            ]);
        }

        const ext = path.extname(resolved).toLowerCase();
        if (!isCppHeader(resolved) && !isCppSource(resolved) && !isCppInline(resolved)) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `⚠️ \`${rel(this.analyzer, resolved)}\` is not a C/C++ file (extension: \`${ext}\`).\n` +
                    `This tool only works for .h/.hpp/.cpp/.cc/.inl/etc.`
                ),
            ]);
        }

        const dir = path.dirname(resolved);
        const stem = path.basename(resolved, ext);
        const allFiles = this.analyzer.getAllFilePaths();

        // Strategy:
        //   1. Same-stem siblings in the same directory (highest confidence)
        //   2. Same-stem files anywhere in the workspace (basename match)
        //   3. Filter out the file itself
        const headers: string[] = [];
        const sources: string[] = [];
        const inlines: string[] = [];

        const sameDirSiblings: string[] = [];
        const otherDirMatches: string[] = [];

        for (const f of allFiles) {
            if (f === resolved) { continue; }
            const fStem = path.basename(f, path.extname(f));
            if (fStem !== stem) { continue; }
            if (path.dirname(f) === dir) {
                sameDirSiblings.push(f);
            } else if (isCppHeader(f) || isCppSource(f) || isCppInline(f)) {
                otherDirMatches.push(f);
            }
        }

        const bucket = (f: string) => {
            if (isCppHeader(f)) { headers.push(f); }
            else if (isCppSource(f)) { sources.push(f); }
            else if (isCppInline(f)) { inlines.push(f); }
        };
        for (const f of sameDirSiblings) { bucket(f); }
        for (const f of otherDirMatches) { bucket(f); }

        const parts: string[] = [];
        parts.push(`# C/C++ Pair for \`${rel(this.analyzer, resolved)}\`\n`);

        const renderList = (label: string, files: string[]) => {
            if (files.length === 0) {
                parts.push(`**${label}:** (none found)\n`);
                return;
            }
            parts.push(`**${label}** (${files.length}):`);
            for (const f of files) {
                const sameDir = path.dirname(f) === dir ? ' _(same dir)_' : '';
                parts.push(`- \`${rel(this.analyzer, f)}\`${sameDir}`);
            }
            parts.push('');
        };

        renderList('Headers', headers);
        renderList('Sources', sources);
        renderList('Inline / template impl', inlines);

        if (headers.length === 0 && sources.length === 0 && inlines.length === 0) {
            parts.push(
                `\n_No matching pair found by basename._\n` +
                `This may be a header-only file, a generated file, or use a non-standard naming convention. ` +
                `Try \`hivemind_getRelatedFiles\` or \`hivemind_findSymbol\` instead.`
            );
        } else {
            parts.push(
                `\n**Refactoring rule:** When changing a public function signature in any of the above files, ` +
                `update *all* declaration/definition pairs together to keep the build passing.`
            );
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(parts.join('\n')),
        ]);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: hivemind_findMacro
// ─────────────────────────────────────────────────────────────────────────────
//
// Lazy index of `#define` macros across all C/C++ files. AI agents struggle
// with macro-heavy code (FCIMPL, BEGIN_PINVOKE, etc.) because grep returns
// usages mixed with definitions. This tool returns ONLY the definitions.

interface FindMacroInput { name: string; exact?: boolean; maxResults?: number; }

interface MacroDef {
    file: string;
    line: number;
    name: string;
    params: string | null;       // null = object-like, "()" or "(a, b)" = function-like
    body: string;                 // first line of body, truncated
    multiLine: boolean;           // continued with backslash
}

let MACRO_INDEX: MacroDef[] | null = null;
let MACRO_INDEX_BUILT_FOR: string | null = null;  // cache key

function buildMacroIndex(analyzer: DependencyAnalyzer): MacroDef[] {
    const allFiles = analyzer.getAllFilePaths();
    const cacheKey = `${allFiles.length}:${analyzer.getNodeCount()}`;

    if (MACRO_INDEX && MACRO_INDEX_BUILT_FOR === cacheKey) { return MACRO_INDEX; }

    const cppFiles = allFiles.filter(f => isCppHeader(f) || isCppSource(f) || isCppInline(f));
    const defines: MacroDef[] = [];

    // Match: optional whitespace, #define, NAME, optional (params), body
    const defineRe = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_][A-Za-z0-9_]*)(\([^)]*\))?[ \t]*(.*)$/;

    for (const file of cppFiles) {
        let content: string;
        try {
            content = fs.readFileSync(file, 'utf-8');
        } catch {
            continue;
        }
        // Skip files larger than 2MB — usually generated / amalgamated
        if (content.length > 2 * 1024 * 1024) { continue; }

        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            const m = defineRe.exec(lines[i]);
            if (!m) { continue; }
            const [, name, params, rawBody] = m;
            const body = (rawBody ?? '').trim();
            const multiLine = body.endsWith('\\');
            defines.push({
                file,
                line: i + 1,
                name,
                params: params ?? null,
                body: multiLine ? body.slice(0, -1).trim() : body,
                multiLine,
            });
        }
    }

    MACRO_INDEX = defines;
    MACRO_INDEX_BUILT_FOR = cacheKey;
    return defines;
}

class FindMacroTool implements vscode.LanguageModelTool<FindMacroInput> {
    constructor(private readonly analyzer: DependencyAnalyzer) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<FindMacroInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { name, exact = true, maxResults = 25 } = options.input;
        if (!name || !name.trim()) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`⚠️ \`name\` is required.`),
            ]);
        }

        const index = buildMacroIndex(this.analyzer);
        const needle = name.trim();
        const matches = exact
            ? index.filter(d => d.name === needle)
            : index.filter(d => d.name.toLowerCase().includes(needle.toLowerCase()));

        const parts: string[] = [];
        parts.push(`# Macro Definitions: \`${needle}\`${exact ? '' : ' _(substring)_'}\n`);
        parts.push(`Searched **${index.length}** \`#define\` directives across the workspace.\n`);

        if (matches.length === 0) {
            parts.push(`No matching \`#define\` found.`);
            if (exact) {
                parts.push(`Try again with \`exact: false\` to do a substring search.`);
            }
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(parts.join('\n')),
            ]);
        }

        const capped = matches.slice(0, maxResults);
        parts.push(`Found **${matches.length}** definition(s)${matches.length > maxResults ? ` (showing top ${maxResults})` : ''}:\n`);

        for (const d of capped) {
            const kind = d.params === null ? 'object' : 'function';
            const sig = d.params === null ? d.name : `${d.name}${d.params}`;
            const cont = d.multiLine ? ' _(multi-line — body truncated)_' : '';
            const bodyPreview = d.body.length > 160 ? d.body.slice(0, 160) + '…' : d.body;
            parts.push(`### \`${sig}\` _(${kind}-like)_`);
            parts.push(`- **File:** \`${rel(this.analyzer, d.file)}:${d.line}\``);
            if (bodyPreview) {
                parts.push(`- **Body:** \`${bodyPreview}\`${cont}`);
            } else {
                parts.push(`- **Body:** _(empty — flag macro)_`);
            }
            parts.push('');
        }

        if (matches.length > maxResults) {
            parts.push(`_${matches.length - maxResults} more definition(s) omitted._`);
        }

        if (matches.length > 1) {
            parts.push(
                `\n**Note:** Multiple definitions usually indicate platform-specific or feature-gated variants ` +
                `(\`#ifdef PLATFORM_X\`). Read the surrounding \`#if\`/\`#ifdef\` context before assuming which one is active.`
            );
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(parts.join('\n')),
        ]);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: hivemind_findReferences  (clangd-backed, AST-precise)
// ─────────────────────────────────────────────────────────────────────────────
//
// Returns every place a C/C++ symbol is *actually* referenced — not text-grep
// hits. Resolves through clang's AST so it understands:
//   • Overload resolution  (foo(int) vs foo(double))
//   • Namespaces           (ns::foo vs ::foo)
//   • Method dispatch      (Bar::foo() vs Baz::foo())
//   • #ifdef configurations (only the active variant)
//   • Templates            (instantiations of T::foo)
//
// This is the single largest C++ refactor-safety improvement in Hive Mind.
//
// Two invocation styles:
//   1. Symbol-by-name:    { filePath, symbolName } — uses clangd documentSymbols
//                         to locate the definition's selection range, then queries
//                         references at that position.
//   2. Position-explicit: { filePath, line, character } — caller already knows
//                         the cursor position (e.g. from getContext output).
//
// If clangd is unavailable, returns a clear, actionable error that tells the
// AI agent how to fix it (and to fall back to hivemind_findSymbol).

interface FindReferencesInput {
    filePath: string;
    symbolName?: string;
    line?: number;        // 1-indexed (human convention) — converted to 0-indexed for LSP
    character?: number;   // 0-indexed (LSP convention)
    includeDeclaration?: boolean;
    maxResults?: number;
}

class FindReferencesTool implements vscode.LanguageModelTool<FindReferencesInput> {
    constructor(
        private readonly analyzer: DependencyAnalyzer,
        private readonly clangd: ClangdProvider
    ) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<FindReferencesInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { includeDeclaration = true, maxResults = 100 } = options.input;

        const clientOrErr = await ensureClangdReady(this.clangd, 'hivemind_findReferences');
        if (isToolResult(clientOrErr)) { return clientOrErr; }
        const client = clientOrErr;

        const sym = await resolveSymbolPosition(this.analyzer, client, options.input);
        if (isToolResult(sym)) { return sym; }

        let locations: LspLocation[] = [];
        try {
            locations = await client.references(sym.file, sym.position, includeDeclaration);
        } catch (e) {
            return text(
                `⚠️ clangd \`textDocument/references\` failed: ${e instanceof Error ? e.message : String(e)}`,
                ``,
                `This usually means the file is not in clangd's compilation database (\`compile_commands.json\`). ` +
                `clangd can still answer some queries via heuristics, but precision suffers.`
            );
        }

        return text(
            ...this.formatResults(sym.name, sym.file, sym.position, locations, maxResults, includeDeclaration)
        );
    }

    /** Format reference results as Markdown grouped by file. */
    private formatResults(
        symbolName: string | null,
        queriedFile: string,
        position: LspPosition,
        locations: LspLocation[],
        maxResults: number,
        includeDeclaration: boolean
    ): string[] {
        const queriedRel = rel(this.analyzer, queriedFile);
        const symLabel = symbolName ? `\`${symbolName}\`` : `cursor at ${queriedRel}:${position.line + 1}:${position.character}`;

        if (locations.length === 0) {
            return [
                `# References to ${symLabel}`,
                ``,
                `_clangd returned **0** references._`,
                ``,
                `Possible reasons:`,
                `- The symbol is unused.`,
                `- The cursor was on whitespace or punctuation, not an identifier (try a different position).`,
                `- The file is not in \`compile_commands.json\` and clangd's heuristic mode could not resolve it.`,
            ];
        }

        // Group by file
        const byFile = new Map<string, LspLocation[]>();
        for (const loc of locations) {
            const localPath = uriToPath(loc.uri);
            if (!byFile.has(localPath)) { byFile.set(localPath, []); }
            byFile.get(localPath)!.push(loc);
        }

        // Sort: file with declaration first (matches queried file), then by reference count desc
        const fileEntries = [...byFile.entries()].sort((a, b) => {
            const aIsQueried = path.normalize(a[0]).toLowerCase() === path.normalize(queriedFile).toLowerCase();
            const bIsQueried = path.normalize(b[0]).toLowerCase() === path.normalize(queriedFile).toLowerCase();
            if (aIsQueried && !bIsQueried) { return -1; }
            if (bIsQueried && !aIsQueried) { return 1; }
            return b[1].length - a[1].length;
        });

        const totalFiles = fileEntries.length;
        const totalRefs = locations.length;
        const out: string[] = [];
        out.push(`# References to ${symLabel}`);
        out.push('');
        out.push(`Found **${totalRefs}** reference(s) across **${totalFiles}** file(s) (clangd, AST-precise${includeDeclaration ? ', incl. declaration' : ''}).`);
        out.push('');

        let shown = 0;
        let truncated = false;
        for (const [file, locs] of fileEntries) {
            if (shown >= maxResults) { truncated = true; break; }
            const relPath = rel(this.analyzer, file);
            out.push(`## \`${relPath}\` _(${locs.length} ref${locs.length === 1 ? '' : 's'})_`);
            out.push('');
            const lines = readFileLinesSafe(file);
            // Sort references within a file by line
            locs.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
            for (const loc of locs) {
                if (shown >= maxResults) { truncated = true; break; }
                const lineNum = loc.range.start.line + 1;   // back to 1-indexed for display
                const lineText = lines[loc.range.start.line]?.trim() ?? '(line not readable)';
                const truncLine = lineText.length > 200 ? lineText.slice(0, 200) + '…' : lineText;
                out.push(`- **L${lineNum}:** \`${truncLine.replace(/`/g, '\\`')}\``);
                shown++;
            }
            out.push('');
        }

        if (truncated) {
            out.push(`_${totalRefs - shown} more reference(s) omitted (raise \`maxResults\` to see them)._`);
        }
        return out;
    }
}

/** Convert an `lsp:LocationUri` (file:// URI) back to an absolute filesystem path. */
function uriToPath(uri: string): string {
    if (!uri.startsWith('file://')) { return uri; }
    let p = decodeURIComponent(uri.slice('file://'.length));
    // On Windows, file:///C:/foo → /C:/foo → strip leading slash
    if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(p)) {
        p = p.slice(1);
    }
    return path.normalize(p);
}

/** Read a file into lines for snippet display; returns [] on failure. */
function readFileLinesSafe(file: string): string[] {
    try {
        if (!fs.existsSync(file)) { return []; }
        const stat = fs.statSync(file);
        // Skip giant files (>5MB) — generated/amalgamated; snippets aren't worth the cost
        if (stat.size > 5 * 1024 * 1024) { return []; }
        return fs.readFileSync(file, 'utf-8').split(/\r?\n/);
    } catch {
        return [];
    }
}

/** Helper to wrap text parts into a tool result. */
function text(...parts: string[]): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(parts.join('\n')),
    ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers for clangd-backed tools
// ─────────────────────────────────────────────────────────────────────────────

interface SymbolPositionInput {
    filePath: string;
    symbolName?: string;
    line?: number;
    character?: number;
}

/** Result of resolving a symbol name / cursor to a clangd-ready position. */
interface ResolvedSymbol {
    file: string;                 // absolute path
    position: LspPosition;        // 0-indexed line + character
    name: string | null;          // resolved symbol name (matched in documentSymbols), or null if position-only
}

/**
 * Resolve { filePath, symbolName? | line+character? } into an absolute file path
 * and an LSP cursor position. Returns either a resolved symbol or an error
 * tool-result that should be returned directly to the caller.
 */
async function resolveSymbolPosition(
    analyzer: DependencyAnalyzer,
    client: ClangdClient,
    input: SymbolPositionInput
): Promise<ResolvedSymbol | vscode.LanguageModelToolResult> {
    const resolved = analyzer.resolveFilePath(input.filePath);
    if (!resolved) {
        return text(
            `⚠️ File "${input.filePath}" not found in the Hive Mind index.`,
            `The index contains ${analyzer.getNodeCount()} files. Use a workspace-relative path.`
        );
    }

    if (typeof input.line === 'number' && typeof input.character === 'number') {
        return {
            file: resolved,
            position: { line: Math.max(0, input.line - 1), character: Math.max(0, input.character) },
            name: input.symbolName?.trim() || null,
        };
    }

    if (input.symbolName && input.symbolName.trim()) {
        const located = await locateSymbolInFile(client, resolved, input.symbolName.trim());
        if (!located) {
            return text(
                `⚠️ Could not locate symbol \`${input.symbolName}\` in \`${analyzer.toRelative(resolved)}\`.`,
                ``,
                `clangd's document symbols for this file did not contain a top-level (or nested) symbol named "${input.symbolName}".`,
                `Try one of:`,
                `- Pass an explicit \`line\` (1-indexed) and \`character\` (0-indexed) of the symbol's cursor position.`,
                `- Use \`hivemind_findSymbol\` to locate the file that *defines* the symbol, then call this tool against that file.`,
            );
        }
        return { file: resolved, position: located.selectionRange.start, name: located.name };
    }

    return text(`⚠️ Provide either \`symbolName\` (most common) or both \`line\` and \`character\`.`);
}

/** Recursively walk documentSymbols looking for an exact-name match (handles `Foo::bar` by tail). */
async function locateSymbolInFile(
    client: ClangdClient,
    file: string,
    name: string
): Promise<LspDocumentSymbol | null> {
    let symbols: LspDocumentSymbol[] = [];
    try { symbols = await client.documentSymbols(file); } catch { return null; }
    const target = name.trim();
    const tail = target.includes('::') ? target.split('::').pop()!.trim() : target;
    const stack = [...symbols];
    while (stack.length > 0) {
        const sym = stack.pop()!;
        if (sym.name === target || sym.name === tail) { return sym; }
        if (sym.children) { stack.push(...sym.children); }
    }
    return null;
}

/** Ensure clangd is available; returns a tool-result error if not. */
async function ensureClangdReady(
    clangdProvider: ClangdProvider,
    toolName: string
): Promise<ClangdClient | vscode.LanguageModelToolResult> {
    const client = clangdProvider();
    if (!client) {
        return text(`⚠️ \`${toolName}\` requires a workspace folder. None is open.`);
    }
    const info = await client.getInfo();
    if (!info.available) {
        return text(
            `⚠️ clangd is not available, so \`${toolName}\` cannot run.`,
            `**Reason:** ${info.reason ?? 'unknown'}`,
            ``,
            `**Fix:** install LLVM/clangd or the "llvm-vs-code-extensions.vscode-clangd" extension, then run \`Hive Mind: Check clangd Status\`.`
        );
    }
    return client;
}

function isToolResult(x: unknown): x is vscode.LanguageModelToolResult {
    return x instanceof vscode.LanguageModelToolResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: hivemind_findOverrides  (clangd-backed)
// ─────────────────────────────────────────────────────────────────────────────
//
// For a virtual method, returns every concrete override across the codebase.
// Closes the virtual-dispatch blind spot — without this, AI refactors of class
// hierarchies routinely miss override sites and silently break runtime behavior.
//
// Implemented via LSP `textDocument/implementation`. clangd handles the AST
// resolution; we just navigate to the declaration and ask.

interface FindOverridesInput {
    filePath: string;
    symbolName?: string;
    line?: number;
    character?: number;
    maxResults?: number;
}

class FindOverridesTool implements vscode.LanguageModelTool<FindOverridesInput> {
    constructor(
        private readonly analyzer: DependencyAnalyzer,
        private readonly clangd: ClangdProvider
    ) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<FindOverridesInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { maxResults = 100 } = options.input;
        const clientOrErr = await ensureClangdReady(this.clangd, 'hivemind_findOverrides');
        if (isToolResult(clientOrErr)) { return clientOrErr; }
        const client = clientOrErr;

        const sym = await resolveSymbolPosition(this.analyzer, client, options.input);
        if (isToolResult(sym)) { return sym; }

        let impls: LspLocation[] = [];
        try {
            impls = await client.implementations(sym.file, sym.position);
        } catch (e) {
            return text(
                `⚠️ clangd \`textDocument/implementation\` failed: ${e instanceof Error ? e.message : String(e)}`,
                ``,
                `If the file is not in \`compile_commands.json\`, clangd cannot resolve overrides reliably.`
            );
        }

        const symLabel = sym.name ? `\`${sym.name}\`` : `cursor at ${this.analyzer.toRelative(sym.file)}:${sym.position.line + 1}:${sym.position.character}`;
        if (impls.length === 0) {
            return text(
                `# Overrides of ${symLabel}`,
                ``,
                `_clangd returned **0** implementations._`,
                ``,
                `Possible reasons:`,
                `- The method is non-virtual.`,
                `- It has no overrides yet.`,
                `- The cursor is on a non-method symbol — try positioning on the method name itself.`,
                `- The TU is not in \`compile_commands.json\`.`
            );
        }

        const out: string[] = [];
        out.push(`# Overrides of ${symLabel}`);
        out.push('');
        out.push(`Found **${impls.length}** implementation(s) (clangd, AST-precise):`);
        out.push('');

        // Group by file
        const byFile = new Map<string, LspLocation[]>();
        for (const loc of impls) {
            const local = uriToPath(loc.uri);
            if (!byFile.has(local)) { byFile.set(local, []); }
            byFile.get(local)!.push(loc);
        }
        const sortedFiles = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length);

        let shown = 0;
        for (const [file, locs] of sortedFiles) {
            if (shown >= maxResults) { break; }
            const lines = readFileLinesSafe(file);
            const relPath = rel(this.analyzer, file);
            out.push(`## \`${relPath}\``);
            locs.sort((a, b) => a.range.start.line - b.range.start.line);
            for (const loc of locs) {
                if (shown >= maxResults) { break; }
                const ln = loc.range.start.line + 1;
                const lineText = lines[loc.range.start.line]?.trim() ?? '(line not readable)';
                const trunc = lineText.length > 200 ? lineText.slice(0, 200) + '…' : lineText;
                out.push(`- **L${ln}:** \`${trunc.replace(/`/g, '\\`')}\``);
                shown++;
            }
            out.push('');
        }

        if (impls.length > shown) {
            out.push(`_${impls.length - shown} more override(s) omitted (raise \`maxResults\` to see them)._`);
        }
        out.push(`\n**Refactor rule:** When changing the signature or contract of a virtual method, ` +
                 `every override above must be updated in lockstep. Skipping any one breaks Liskov substitution.`);

        return text(...out);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: hivemind_callHierarchy  (clangd-backed)
// ─────────────────────────────────────────────────────────────────────────────
//
// Returns the call graph around a function — who calls it (incoming), what it
// calls (outgoing), or both. Supports a `depth` parameter (1 or 2) so an AI
// can trace 2 levels deep in a single tool call instead of N round-trips.
//
// Use cases:
//   • "Who calls this function?" before changing its signature
//   • "What does this function call?" to understand its dependencies
//   • Bug tracing: walk outgoing calls from an entry point

interface CallHierarchyInput {
    filePath: string;
    symbolName?: string;
    line?: number;
    character?: number;
    direction?: 'incoming' | 'outgoing' | 'both';
    depth?: number;       // 1 or 2 — caps at 2 to keep output manageable
    maxPerLevel?: number; // cap children at each level
}

class CallHierarchyTool implements vscode.LanguageModelTool<CallHierarchyInput> {
    constructor(
        private readonly analyzer: DependencyAnalyzer,
        private readonly clangd: ClangdProvider
    ) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<CallHierarchyInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const direction = options.input.direction ?? 'both';
        const depth = Math.min(2, Math.max(1, options.input.depth ?? 1));
        const maxPerLevel = options.input.maxPerLevel ?? 25;

        const clientOrErr = await ensureClangdReady(this.clangd, 'hivemind_callHierarchy');
        if (isToolResult(clientOrErr)) { return clientOrErr; }
        const client = clientOrErr;

        const sym = await resolveSymbolPosition(this.analyzer, client, options.input);
        if (isToolResult(sym)) { return sym; }

        // Step 1: prepare hierarchy at the cursor
        let prepared: CallHierarchyItem[] = [];
        try {
            prepared = await client.prepareCallHierarchy(sym.file, sym.position);
        } catch (e) {
            return text(`⚠️ clangd \`prepareCallHierarchy\` failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (prepared.length === 0) {
            return text(
                `# Call Hierarchy: ${sym.name ?? this.analyzer.toRelative(sym.file)}`,
                ``,
                `_clangd could not anchor a call hierarchy at this position._`,
                ``,
                `Position the cursor on a function name (declaration or call site). Free functions, methods, and lambdas with names all work; lambda *call sites* without a name don't.`
            );
        }

        const root = prepared[0];
        const rootLabel = `\`${root.detail ? root.detail + ' ' : ''}${root.name}\``;

        const out: string[] = [];
        out.push(`# Call Hierarchy: ${rootLabel}`);
        out.push('');
        out.push(`Defined at \`${rel(this.analyzer, uriToPath(root.uri))}:${root.range.start.line + 1}\``);
        out.push('');

        if (direction === 'incoming' || direction === 'both') {
            out.push(`## Incoming (callers)`);
            await this.renderIncoming(client, root, depth, maxPerLevel, out, '');
            out.push('');
        }

        if (direction === 'outgoing' || direction === 'both') {
            out.push(`## Outgoing (callees)`);
            await this.renderOutgoing(client, root, depth, maxPerLevel, out, '');
            out.push('');
        }

        return text(...out);
    }

    private async renderIncoming(
        client: ClangdClient,
        item: CallHierarchyItem,
        depth: number,
        cap: number,
        out: string[],
        indent: string
    ): Promise<void> {
        const calls = await client.incomingCalls(item).catch(() => []);
        if (calls.length === 0) {
            out.push(`${indent}- _(no callers found)_`);
            return;
        }
        const capped = calls.slice(0, cap);
        for (const c of capped) {
            const f = uriToPath(c.from.uri);
            const ln = c.from.selectionRange.start.line + 1;
            out.push(`${indent}- \`${c.from.name}\` — \`${rel(this.analyzer, f)}:${ln}\` _(${c.fromRanges.length} call site${c.fromRanges.length === 1 ? '' : 's'})_`);
            if (depth > 1) {
                await this.renderIncoming(client, c.from, depth - 1, cap, out, indent + '    ');
            }
        }
        if (calls.length > cap) {
            out.push(`${indent}- _… ${calls.length - cap} more caller(s) not shown_`);
        }
    }

    private async renderOutgoing(
        client: ClangdClient,
        item: CallHierarchyItem,
        depth: number,
        cap: number,
        out: string[],
        indent: string
    ): Promise<void> {
        const calls = await client.outgoingCalls(item).catch(() => []);
        if (calls.length === 0) {
            out.push(`${indent}- _(no outgoing calls found)_`);
            return;
        }
        const capped = calls.slice(0, cap);
        for (const c of capped) {
            const f = uriToPath(c.to.uri);
            const ln = c.to.selectionRange.start.line + 1;
            out.push(`${indent}- \`${c.to.name}\` — \`${rel(this.analyzer, f)}:${ln}\``);
            if (depth > 1) {
                await this.renderOutgoing(client, c.to, depth - 1, cap, out, indent + '    ');
            }
        }
        if (calls.length > cap) {
            out.push(`${indent}- _… ${calls.length - cap} more callee(s) not shown_`);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: hivemind_typeHierarchy  (clangd-backed)
// ─────────────────────────────────────────────────────────────────────────────
//
// Returns supertypes and/or subtypes of a class. Critical for refactoring
// class hierarchies — tells the AI every class affected when modifying a
// base class or interface.

interface TypeHierarchyInput {
    filePath: string;
    symbolName?: string;
    line?: number;
    character?: number;
    direction?: 'supertypes' | 'subtypes' | 'both';
    depth?: number;
    maxPerLevel?: number;
}

class TypeHierarchyTool implements vscode.LanguageModelTool<TypeHierarchyInput> {
    constructor(
        private readonly analyzer: DependencyAnalyzer,
        private readonly clangd: ClangdProvider
    ) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<TypeHierarchyInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const direction = options.input.direction ?? 'both';
        const depth = Math.min(3, Math.max(1, options.input.depth ?? 2));
        const maxPerLevel = options.input.maxPerLevel ?? 25;

        const clientOrErr = await ensureClangdReady(this.clangd, 'hivemind_typeHierarchy');
        if (isToolResult(clientOrErr)) { return clientOrErr; }
        const client = clientOrErr;

        const sym = await resolveSymbolPosition(this.analyzer, client, options.input);
        if (isToolResult(sym)) { return sym; }

        let prepared: TypeHierarchyItem[] = [];
        try {
            prepared = await client.prepareTypeHierarchy(sym.file, sym.position);
        } catch (e) {
            return text(`⚠️ clangd \`prepareTypeHierarchy\` failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (prepared.length === 0) {
            return text(
                `# Type Hierarchy: ${sym.name ?? this.analyzer.toRelative(sym.file)}`,
                ``,
                `_clangd could not anchor a type hierarchy at this position._`,
                ``,
                `Position the cursor on a class, struct, or interface name.`
            );
        }

        const root = prepared[0];
        const rootLabel = `\`${root.name}\``;

        const out: string[] = [];
        out.push(`# Type Hierarchy: ${rootLabel}`);
        out.push('');
        out.push(`Defined at \`${rel(this.analyzer, uriToPath(root.uri))}:${root.range.start.line + 1}\``);
        out.push('');

        if (direction === 'supertypes' || direction === 'both') {
            out.push(`## Supertypes (parents — bases this type derives from)`);
            await this.renderSupertypes(client, root, depth, maxPerLevel, out, '');
            out.push('');
        }

        if (direction === 'subtypes' || direction === 'both') {
            out.push(`## Subtypes (children — types that derive from this)`);
            await this.renderSubtypes(client, root, depth, maxPerLevel, out, '');
            out.push('');
        }

        out.push(
            `**Refactor rule:** Changing a base class affects every subtype above. ` +
            `When adding/removing/altering virtual methods, also call \`hivemind_findOverrides\` on each affected method to find the concrete implementations.`
        );

        return text(...out);
    }

    private async renderSupertypes(
        client: ClangdClient,
        item: TypeHierarchyItem,
        depth: number,
        cap: number,
        out: string[],
        indent: string
    ): Promise<void> {
        const supers = await client.supertypes(item).catch(() => []);
        if (supers.length === 0) {
            out.push(`${indent}- _(no supertypes)_`);
            return;
        }
        const capped = supers.slice(0, cap);
        for (const s of capped) {
            const f = uriToPath(s.uri);
            const ln = s.range.start.line + 1;
            out.push(`${indent}- \`${s.name}\` — \`${rel(this.analyzer, f)}:${ln}\``);
            if (depth > 1) {
                await this.renderSupertypes(client, s, depth - 1, cap, out, indent + '    ');
            }
        }
        if (supers.length > cap) {
            out.push(`${indent}- _… ${supers.length - cap} more supertype(s) not shown_`);
        }
    }

    private async renderSubtypes(
        client: ClangdClient,
        item: TypeHierarchyItem,
        depth: number,
        cap: number,
        out: string[],
        indent: string
    ): Promise<void> {
        const subs = await client.subtypes(item).catch(() => []);
        if (subs.length === 0) {
            out.push(`${indent}- _(no subtypes)_`);
            return;
        }
        const capped = subs.slice(0, cap);
        for (const s of capped) {
            const f = uriToPath(s.uri);
            const ln = s.range.start.line + 1;
            out.push(`${indent}- \`${s.name}\` — \`${rel(this.analyzer, f)}:${ln}\``);
            if (depth > 1) {
                await this.renderSubtypes(client, s, depth - 1, cap, out, indent + '    ');
            }
        }
        if (subs.length > cap) {
            out.push(`${indent}- _… ${subs.length - cap} more subtype(s) not shown_`);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: hivemind_macroExpand  (clang preprocessor)
// ─────────────────────────────────────────────────────────────────────────────
//
// Runs `clang -E` with the file's compile_commands.json flags, then returns
// the preprocessor expansion of a specific source line. This is the only way
// to know what `FCIMPL3(MyMethod, ...)` *actually* becomes at a real call site —
// `findMacro` shows the #define text, but real expansions depend on:
//   • Other macros currently #defined  (-D flags + earlier #defines in the TU)
//   • Which #ifdef branch is active
//   • Recursive macro expansion
//
// Inputs: filePath (must be a .cpp/.cc — NOT a header), line (1-indexed),
// optional contextLines.

interface MacroExpandInput {
    filePath: string;
    line: number;
    contextLines?: number;
    timeoutMs?: number;
}

class MacroExpandTool implements vscode.LanguageModelTool<MacroExpandInput> {
    constructor(
        private readonly analyzer: DependencyAnalyzer,
        private readonly expander: MacroExpanderProvider
    ) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<MacroExpandInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { filePath, line, contextLines = 0, timeoutMs } = options.input;
        if (typeof line !== 'number' || line < 1) {
            return text(`⚠️ \`line\` must be a positive 1-indexed line number.`);
        }

        const expander = this.expander();
        if (!expander) {
            return text(`⚠️ \`hivemind_macroExpand\` requires a workspace folder. None is open.`);
        }

        const resolved = this.analyzer.resolveFilePath(filePath);
        if (!resolved) {
            return text(
                `⚠️ File "${filePath}" not found in the Hive Mind index.`,
                `The index contains ${this.analyzer.getNodeCount()} files. Use a workspace-relative path.`
            );
        }

        const result = await expander.expandLine({
            file: resolved,
            line,
            contextLines: Math.min(20, Math.max(0, contextLines)),
            timeoutMs,
        });

        if (!result.ok) {
            const parts: string[] = [
                `# Macro Expansion — Failed`,
                ``,
                `**File:** \`${rel(this.analyzer, resolved)}\`  **Line:** ${line}`,
                ``,
                `**Reason:** ${result.reason}`,
            ];
            if (result.detail) { parts.push('', result.detail); }
            if (result.clangExitCode !== undefined) {
                parts.push('', `**clang exit code:** ${result.clangExitCode}`);
                if (result.clangStderr) {
                    parts.push('', '```', result.clangStderr, '```');
                }
            }
            return text(...parts);
        }

        const out: string[] = [];
        out.push(`# Macro Expansion: \`${rel(this.analyzer, resolved)}:${line}\``);
        out.push('');
        out.push(`**Mode:** ${result.usedCompileCommands ? 'compile_commands.json (full project flags)' : 'fallback (workspace include paths only — accuracy reduced)'}  ` +
                 `· **clang time:** ${result.durationMs}ms`);
        out.push('');

        if (result.originalSource.trim()) {
            out.push(`## Original Source`);
            out.push('```cpp');
            out.push(result.originalSource);
            out.push('```');
            out.push('');
        }

        if (result.expansion.trim()) {
            out.push(`## Preprocessed`);
            out.push('```cpp');
            // Trim very long expansions so the AI doesn't choke on giant macro outputs.
            const expansion = result.expansion.length > 8000
                ? result.expansion.slice(0, 8000) + '\n// …(truncated, use a smaller contextLines)'
                : result.expansion;
            out.push(expansion);
            out.push('```');
        } else {
            out.push(`## Preprocessed`);
            out.push('_The preprocessor produced no output for this line._');
            out.push('');
            out.push('Possible reasons:');
            out.push('- The line is inside an inactive `#ifdef` branch for this build configuration.');
            out.push('- The line is whitespace, a comment, or a `#include` directive (which expands elsewhere).');
            out.push('- clang\'s line markers don\'t match the requested line — try `contextLines: 5`.');
        }

        if (result.diagnostics) {
            out.push('');
            out.push(`<details><summary>clang diagnostics</summary>`);
            out.push('');
            out.push('```');
            out.push(result.diagnostics);
            out.push('```');
            out.push('</details>');
        }

        return text(...out);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: hivemind_buildSubset  (syntax-only compile of the impacted slice)
// ─────────────────────────────────────────────────────────────────────────────
//
// Given a seed file (typically the file the agent just edited), walk the
// reverse-dependency graph to find every TU that #includes it transitively,
// then run `clang -fsyntax-only` (or clang-cl `/Zs`) on each one with that
// TU's exact compile_commands.json flags.
//
// This is the cheapest "did I just break the build?" signal available without
// a full project rebuild. Pairs with `hivemind_planChange` (find what's at
// risk) and `hivemind_callHierarchy` (find what calls into the changed code).
//
// Inputs: filePath (seed), maxTUs?, depth?, perFileTimeoutMs?, totalBudgetMs?,
// parallelism?, explicitTUs?

interface BuildSubsetInput {
    filePath: string;
    maxTUs?: number;
    depth?: number;
    perFileTimeoutMs?: number;
    totalBudgetMs?: number;
    parallelism?: number;
    explicitTUs?: string[];
}

class BuildSubsetTool implements vscode.LanguageModelTool<BuildSubsetInput> {
    constructor(
        private readonly analyzer: DependencyAnalyzer,
        private readonly buildSubset: BuildSubsetProvider
    ) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<BuildSubsetInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { filePath, maxTUs, depth, perFileTimeoutMs, totalBudgetMs, parallelism, explicitTUs } = options.input;

        const builder = this.buildSubset();
        if (!builder) {
            return text(`⚠️ \`hivemind_buildSubset\` requires a workspace folder. None is open.`);
        }

        const resolved = this.analyzer.resolveFilePath(filePath);
        if (!resolved) {
            return text(
                `⚠️ File "${filePath}" not found in the Hive Mind index.`,
                `The index contains ${this.analyzer.getNodeCount()} files. Use a workspace-relative path.`
            );
        }

        // Resolve any explicit TU paths up front so the user can pass relative names.
        const resolvedExplicit = explicitTUs?.map(p => this.analyzer.resolveFilePath(p)).filter((p): p is string => !!p);

        if (token.isCancellationRequested) {
            return text('⚠️ Cancelled before compile started.');
        }

        const result = await builder.run({
            seedFile: resolved,
            maxTUs,
            depth,
            perFileTimeoutMs,
            totalBudgetMs,
            parallelism,
            explicitTUs: resolvedExplicit,
        });

        // Format the report.
        const out: string[] = [];
        out.push(`# Build Subset Check: \`${rel(this.analyzer, resolved)}\``);
        out.push('');
        const headline = result.tusFailed === 0
            ? (result.tusCompiled === 0
                ? `⚠️ **No TUs compiled** — ${result.skipped.length} skipped.`
                : `✅ **${result.tusPassed}/${result.tusCompiled} TUs passed** syntax check.`)
            : `❌ **${result.tusFailed} of ${result.tusCompiled} TUs failed** syntax check.`;
        out.push(headline);
        out.push('');

        out.push(`**Impact set considered:** ${result.totalTUsConsidered} TU(s)  ` +
                 `· **Compiled:** ${result.tusCompiled}  ` +
                 `· **Passed:** ${result.tusPassed}  ` +
                 `· **Failed:** ${result.tusFailed}  ` +
                 `· **Skipped:** ${result.tusSkipped}  ` +
                 (result.truncated ? `· ⚠️ **Truncated to maxTUs**  ` : '') +
                 `· **Wall:** ${(result.durationMs / 1000).toFixed(1)}s`);
        out.push('');

        if (result.tusFailed > 0) {
            out.push('## Failures');
            const failed = result.results.filter(r => !r.ok).slice(0, 20);
            for (const r of failed) {
                out.push(`### \`${rel(this.analyzer, r.file)}\`  · exit ${r.exitCode}  · ${r.durationMs}ms`);
                out.push('```');
                out.push(r.diagnostics || '(no diagnostics)');
                out.push('```');
                out.push('');
            }
            const failedCount = result.results.filter(r => !r.ok).length;
            if (failedCount > 20) {
                out.push(`_…and ${failedCount - 20} more failed TU(s) omitted._`);
                out.push('');
            }
        }

        if (result.tusPassed > 0 && result.tusFailed === 0) {
            out.push('## Passing TUs');
            const passed = result.results.filter(r => r.ok).slice(0, 25);
            for (const r of passed) {
                out.push(`- \`${rel(this.analyzer, r.file)}\` (${r.durationMs}ms)`);
            }
            const passingCount = result.results.filter(r => r.ok).length;
            if (passingCount > 25) {
                out.push(`- _…and ${passingCount - 25} more._`);
            }
            out.push('');
        }

        if (result.skipped.length > 0) {
            out.push('## Skipped');
            const reasons = new Map<string, number>();
            for (const s of result.skipped) {
                reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
            }
            for (const [reason, count] of reasons) {
                out.push(`- ${reason} — **${count}** file(s)`);
            }
            // Show a few examples
            const sample = result.skipped.slice(0, 8);
            if (sample.length > 0) {
                out.push('');
                out.push('<details><summary>Sample skipped files</summary>');
                out.push('');
                for (const s of sample) {
                    out.push(`- \`${rel(this.analyzer, s.file)}\` — ${s.reason}`);
                }
                out.push('</details>');
            }
            out.push('');
        }

        if (result.tusCompiled === 0 && result.skipped.some(s => /no compile_commands\.json/i.test(s.reason))) {
            out.push('---');
            out.push('**No `compile_commands.json` found.** Generate one with CMake (`-DCMAKE_EXPORT_COMPILE_COMMANDS=ON`) ' +
                    'or `compdb`/`bear` for Make/Ninja, then re-run.');
        }

        return text(...out);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerTools(
    context: vscode.ExtensionContext,
    analyzer: DependencyAnalyzer,
    symbolAnalyzer: SymbolAnalyzer,
    gitAnalyzer: GitAnalyzer,
    clangdProvider: ClangdProvider,
    macroExpanderProvider: MacroExpanderProvider,
    buildSubsetProvider: BuildSubsetProvider
): void {
    context.subscriptions.push(
        vscode.lm.registerTool('hivemind_getDependencies', new GetDependenciesTool(analyzer)),
        vscode.lm.registerTool('hivemind_getImpact',       new GetImpactTool(analyzer)),
        vscode.lm.registerTool('hivemind_getRelatedFiles', new GetRelatedFilesTool(analyzer)),
        vscode.lm.registerTool('hivemind_getFullGraph',    new GetFullGraphTool(analyzer)),
        vscode.lm.registerTool('hivemind_detectCycles',    new DetectCyclesTool(analyzer)),
        vscode.lm.registerTool('hivemind_getTestFiles',    new GetTestFilesTool(analyzer)),
        vscode.lm.registerTool('hivemind_findSymbol',      new FindSymbolTool(analyzer, symbolAnalyzer)),
        vscode.lm.registerTool('hivemind_coChanged',       new CoChangedTool(analyzer, gitAnalyzer)),
        vscode.lm.registerTool('hivemind_getContext',      new GetContextTool(analyzer, symbolAnalyzer, gitAnalyzer)),
        vscode.lm.registerTool('hivemind_planChange',      new PlanChangeTool(analyzer, symbolAnalyzer, gitAnalyzer)),
        vscode.lm.registerTool('hivemind_search',          new SearchTool(analyzer, symbolAnalyzer)),
        vscode.lm.registerTool('hivemind_getCppPair',      new GetCppPairTool(analyzer)),
        vscode.lm.registerTool('hivemind_findMacro',       new FindMacroTool(analyzer)),
        vscode.lm.registerTool('hivemind_findReferences',  new FindReferencesTool(analyzer, clangdProvider)),
        vscode.lm.registerTool('hivemind_findOverrides',   new FindOverridesTool(analyzer, clangdProvider)),
        vscode.lm.registerTool('hivemind_callHierarchy',   new CallHierarchyTool(analyzer, clangdProvider)),
        vscode.lm.registerTool('hivemind_typeHierarchy',   new TypeHierarchyTool(analyzer, clangdProvider)),
        vscode.lm.registerTool('hivemind_macroExpand',     new MacroExpandTool(analyzer, macroExpanderProvider)),
        vscode.lm.registerTool('hivemind_buildSubset',     new BuildSubsetTool(analyzer, buildSubsetProvider)),
    );
}
