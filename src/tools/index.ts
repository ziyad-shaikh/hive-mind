import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { DependencyAnalyzer } from '../analyzer/DependencyAnalyzer';
import { SymbolAnalyzer } from '../analyzer/SymbolAnalyzer';
import { GitAnalyzer } from '../analyzer/GitAnalyzer';
import { MacroExpander } from '../analyzer/MacroExpander';
import { BuildSubset } from '../analyzer/BuildSubset';
import { GitHubClient } from '../analyzer/GitHubClient';
import { parseCppSync, isCppParserReady } from '../analyzer/CppTreeSitterParser';

/** Lazy accessor for the shared MacroExpander singleton (or null if no workspace open). */
type MacroExpanderProvider = () => MacroExpander | null;
/** Lazy accessor for the shared BuildSubset singleton (or null if no workspace open). */
type BuildSubsetProvider = () => BuildSubset | null;
/** Lazy accessor for the shared GitHubClient singleton (or null if no workspace open). */
type GitHubClientProvider = () => GitHubClient | null;

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

        // Build-variant filtering. If the seed file belongs to a profile build
        // variant (e.g. src/db/ora/oracli.cpp ∈ sadora), files from OTHER
        // variants are configurationally exclusive — they're never linked
        // together in any single binary. Demote them out of the modify/read
        // sets so the agent doesn't try to "consistently update both."
        const seedVariant = this.analyzer.getVariantOf(resolved);
        const conflictsWithSeedVariant = (file: string): boolean => {
            if (!seedVariant) { return false; }
            const v = this.analyzer.getVariantOf(file);
            return v !== null && v !== seedVariant;
        };

        // Sort by score descending
        const ranked = [...fileScores.entries()]
            .sort((a, b) => b[1].score - a[1].score);

        // Categorize
        const mustRead: string[] = [];
        const mustModify: string[] = [];
        const shouldVerify: string[] = [];
        const maybeAffected: string[] = [];
        const excludedVariantFiles: string[] = [];

        for (const [file, { score, reasons }] of ranked) {
            const r = rel(this.analyzer, file);
            if (file !== resolved && conflictsWithSeedVariant(file)) {
                excludedVariantFiles.push(r);
                continue;
            }
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

        if (excludedVariantFiles.length > 0 && seedVariant) {
            parts.push(`\n## ⚠ Excluded — wrong build variant (${excludedVariantFiles.length})\n`);
            parts.push(`These files share names/imports with the change set but belong to other build variants ` +
                       `(seed file is in **${seedVariant}**). They are *never* linked into the same binary as the seed and should NOT be edited as part of this change.\n`);
            for (const f of excludedVariantFiles.slice(0, 10)) {
                parts.push(`- \`${f}\``);
            }
            if (excludedVariantFiles.length > 10) {
                parts.push(`- ... and ${excludedVariantFiles.length - 10} more`);
            }
        }

        parts.push(`\n---`);
        const variantNote = seedVariant ? ` (variant: \`${seedVariant}\`)` : '';
        parts.push(`**Summary:** ${mustModify.length} to modify, ${mustRead.length} to read, ${shouldVerify.length} tests, ${maybeAffected.length} peripherally affected${variantNote}.`);

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

/**
 * If `stem` matches a known module's pattern — i.e. `<m>ext`, `<m>in`, or
 * `<m>WORD` where m is one of the listed modules — return m. Used by
 * getCppPair to expand a file to its full module triplet.
 */
function identifyModule(knownModules: string[], stem: string): string | null {
    const lower = stem.toLowerCase();
    // Prefer the longest match so 'apl' doesn't shadow 'aplext'.
    const sorted = [...knownModules].sort((a, b) => b.length - a.length);
    for (const m of sorted) {
        if (lower === m + 'ext' || lower === m + 'in') {
            return m;
        }
        if (lower.startsWith(m)) {
            const after = lower.slice(m.length);
            if (after === '' || /^[0-9_]/.test(after) || /^[a-z]/.test(after)) {
                return m;
            }
        }
    }
    return null;
}

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
        //   3. Profile-driven module triplet: if this file maps to a known
        //      module (e.g. divext.h → module 'div'), include divin.h + every
        //      src/div*.cpp as well. This is the X3 convention.
        //   4. Filter out the file itself
        const headers: string[] = [];
        const sources: string[] = [];
        const inlines: string[] = [];
        let moduleHint: string | null = null;

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

        // Profile-driven module-triplet expansion.
        const profile = this.analyzer.getProfile();
        const moduleSiblings = new Set<string>();
        if (profile) {
            const m = identifyModule(profile.modulePattern.knownModules, stem);
            if (m) {
                moduleHint = m;
                for (const f of allFiles) {
                    if (f === resolved) { continue; }
                    const fName = path.basename(f);
                    const fExt = path.extname(f).toLowerCase();
                    // <m>ext.h, <m>in.h, src/<m>WORD.cpp/.cc/.cxx/.c
                    if (fName.toLowerCase() === `${m}ext.h` || fName.toLowerCase() === `${m}in.h`) {
                        moduleSiblings.add(f);
                    } else if ((isCppSource(f) || isCppInline(f)) && fName.toLowerCase().startsWith(m)) {
                        // Distinguish e.g. 'div' from 'divx': require the next char
                        // to be a digit, an underscore, lower-case word boundary,
                        // or be exactly the dot separator.
                        const after = fName.slice(m.length, fName.length - fExt.length);
                        if (after === '' || /^[0-9_]/.test(after) || /^[a-z]/.test(after)) {
                            moduleSiblings.add(f);
                        }
                    }
                }
            }
        }

        const bucket = (f: string) => {
            if (isCppHeader(f)) { headers.push(f); }
            else if (isCppSource(f)) { sources.push(f); }
            else if (isCppInline(f)) { inlines.push(f); }
        };
        const seen = new Set<string>([resolved]);
        const dedup = (f: string) => {
            if (seen.has(f)) { return; }
            seen.add(f);
            bucket(f);
        };
        for (const f of sameDirSiblings) { dedup(f); }
        for (const f of otherDirMatches) { dedup(f); }
        for (const f of moduleSiblings)  { dedup(f); }

        const parts: string[] = [];
        parts.push(`# C/C++ Pair for \`${rel(this.analyzer, resolved)}\`\n`);
        if (moduleHint) {
            parts.push(`_Module: \`${moduleHint}\` — expanded via project profile (\`${moduleHint}ext.h\` / \`${moduleHint}in.h\` / \`src/${moduleHint}*.cpp\`)._\n`);
        }

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
// Tool: hivemind_findReferences  (tree-sitter scope resolver)
// ─────────────────────────────────────────────────────────────────────────────
//
// Returns every place a C/C++ symbol is referenced. Uses Hive Mind's own
// tree-sitter index built from the workspace, so we have no LSP dependency:
//   • The resolver tags each hit with a `confidence` (high/medium/low) based
//     on how unique the name is across the workspace.
//   • Comments, string literals, and preprocessor branches are stripped before
//     matching, so we don't get noise from `// foo()` or `"foo()"`.
//   • Declaration sites are flagged with `isDeclaration` so callers can show
//     them in a separate group.
//
// Caller passes `symbolName`. Position-only queries are not supported by the
// scope resolver (we don't keep token positions of every reference site).

interface FindReferencesInput {
    filePath: string;
    symbolName?: string;
    line?: number;        // accepted for backwards-compat; ignored by the resolver
    character?: number;   // accepted for backwards-compat; ignored
    includeDeclaration?: boolean;
    maxResults?: number;
}

class FindReferencesTool implements vscode.LanguageModelTool<FindReferencesInput> {
    constructor(private readonly analyzer: DependencyAnalyzer) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<FindReferencesInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { symbolName, includeDeclaration = true, maxResults = 100 } = options.input;
        if (!symbolName || !symbolName.trim()) {
            return text(
                `⚠️ \`hivemind_findReferences\` (tree-sitter mode) requires \`symbolName\`.`,
                `Position-only queries (\`line\`/\`character\`) are not supported in this build.`
            );
        }
        const resolver = this.analyzer.getScopeResolver();
        const refs = await resolver.findReferences({
            symbolName: symbolName.trim(),
            includeDeclaration,
            maxResults,
        });

        if (refs.length === 0) {
            return text(
                `# References to \`${symbolName}\``,
                ``,
                `_No references found in the workspace._`,
                ``,
                `Possible reasons:`,
                `- The symbol is unused, or only declared (not called) anywhere indexed.`,
                `- The file containing it is not in the Hive Mind index (check \`hiveMind.maxFiles\`).`,
                `- The name in your query has a typo or different casing.`
            );
        }

        // Group by file, preserving the resolver's confidence.
        const byFile = new Map<string, typeof refs>();
        for (const r of refs) {
            const list = byFile.get(r.file) ?? [];
            list.push(r);
            byFile.set(r.file, list);
        }

        const conf = refs[0]?.confidence ?? 'medium';
        const confNote =
            conf === 'high'   ? 'unique name across the workspace — high confidence' :
            conf === 'medium' ? 'name appears in 2-4 distinct declarations — verify scope' :
                                'name is overloaded/common — verify each result manually';

        const out: string[] = [];
        out.push(`# References to \`${symbolName}\``);
        out.push('');
        out.push(`Found **${refs.length}** reference(s) across **${byFile.size}** file(s) (tree-sitter + scope filter; ${confNote}).`);
        out.push('');

        const sortedFiles = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length);
        let shown = 0;
        let truncated = false;
        for (const [file, list] of sortedFiles) {
            if (shown >= maxResults) { truncated = true; break; }
            out.push(`## \`${rel(this.analyzer, file)}\` _(${list.length} ref${list.length === 1 ? '' : 's'})_`);
            out.push('');
            list.sort((a, b) => a.line - b.line || a.column - b.column);
            for (const r of list) {
                if (shown >= maxResults) { truncated = true; break; }
                const declMark = r.isDeclaration ? ' _(decl)_' : '';
                out.push(`- **L${r.line}:** \`${r.snippet.replace(/`/g, '\\`')}\`${declMark}`);
                shown++;
            }
            out.push('');
        }
        if (truncated) {
            out.push(`_${refs.length - shown} more reference(s) omitted (raise \`maxResults\`)._`);
        }
        if (conf !== 'high') {
            out.push(``);
            out.push(`> **Confidence: \`${conf}\`** — for AST-exact verification on a critical refactor, run \`hivemind_buildSubset\` after applying changes to confirm no override or call site was missed.`);
        }
        return text(...out);
    }
}

/** Helper to wrap text parts into a tool result. */
function text(...parts: string[]): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(parts.join('\n')),
    ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: hivemind_findOverrides  (tree-sitter scope resolver)
// ─────────────────────────────────────────────────────────────────────────────
//
// For a virtual method, returns every concrete override across the codebase.
// Closes the virtual-dispatch blind spot — without this, AI refactors of class
// hierarchies routinely miss override sites and silently break runtime behavior.
//
// Implemented against the tree-sitter scope resolver: we walk the inheritance
// closure built during indexing and look for matching method declarations on
// each derived class.

interface FindOverridesInput {
    filePath: string;
    symbolName?: string;
    line?: number;
    character?: number;
    maxResults?: number;
}

class FindOverridesTool implements vscode.LanguageModelTool<FindOverridesInput> {
    constructor(private readonly analyzer: DependencyAnalyzer) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<FindOverridesInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { symbolName, maxResults = 100 } = options.input;
        if (!symbolName || !symbolName.trim()) {
            return text(`⚠️ \`hivemind_findOverrides\` requires \`symbolName\` (the virtual method name).`);
        }
        const resolver = this.analyzer.getScopeResolver();
        const overrides = await resolver.findOverrides({ symbolName: symbolName.trim() });

        if (overrides.length === 0) {
            return text(
                `# Overrides of \`${symbolName}\``,
                ``,
                `_No overrides found._`,
                ``,
                `Possible reasons:`,
                `- The method is non-virtual (tree-sitter saw no \`virtual\` keyword in any base declaration).`,
                `- The base class has no derived classes in the indexed code.`,
                `- The method is declared in a header that isn't indexed.`
            );
        }

        const sliced = overrides.slice(0, maxResults);
        const byClass = new Map<string, typeof sliced>();
        for (const o of sliced) {
            const list = byClass.get(o.className) ?? [];
            list.push(o);
            byClass.set(o.className, list);
        }

        const out: string[] = [];
        out.push(`# Overrides of \`${symbolName}\``);
        out.push('');
        out.push(`Found **${overrides.length}** implementation(s) across **${byClass.size}** derived class(es) (tree-sitter + inheritance closure).`);
        out.push('');

        const confidenceCounts = { high: 0, medium: 0, low: 0 } as Record<string, number>;
        for (const o of sliced) { confidenceCounts[o.confidence]++; }
        out.push(`Confidence breakdown: **${confidenceCounts.high}** high · **${confidenceCounts.medium}** medium · **${confidenceCounts.low}** low.`);
        out.push('');

        for (const [cls, list] of byClass) {
            out.push(`## \`${cls}\``);
            for (const o of list) {
                out.push(`- **L${o.line}** in \`${rel(this.analyzer, o.file)}\` — confidence \`${o.confidence}\` (${o.confidenceReason})${o.paramCount !== null ? `, ${o.paramCount} param(s)` : ''}`);
            }
            out.push('');
        }

        if (overrides.length > maxResults) {
            out.push(`_${overrides.length - maxResults} more override(s) omitted (raise \`maxResults\` to see them)._`);
        }
        out.push(`**Refactor rule:** every \`high\`-confidence override above must be updated in lockstep when you change the base method's signature or contract. \`medium\`/\`low\` results should be sanity-checked manually before relying on the list.`);
        return text(...out);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: hivemind_callHierarchy  (tree-sitter scope resolver)
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
    constructor(private readonly analyzer: DependencyAnalyzer) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<CallHierarchyInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { symbolName } = options.input;
        const direction = options.input.direction ?? 'both';
        const depth = Math.min(2, Math.max(1, options.input.depth ?? 1));
        const maxPerLevel = options.input.maxPerLevel ?? 25;
        if (!symbolName || !symbolName.trim()) {
            return text(`⚠️ \`hivemind_callHierarchy\` requires \`symbolName\` (the function name).`);
        }
        const resolver = this.analyzer.getScopeResolver();
        const result = await resolver.callHierarchy({
            symbolName: symbolName.trim(),
            direction,
            depth,
            maxPerLevel,
        });

        const out: string[] = [];
        out.push(`# Call Hierarchy: \`${symbolName}\``);
        out.push('');
        out.push(`Source: tree-sitter scope resolver (depth=${depth}, max-per-level=${maxPerLevel})`);
        out.push('');

        const renderNode = (node: any, indent: string): void => {
            const loc = node.file
                ? `\`${rel(this.analyzer, node.file)}:${node.line ?? '?'}\``
                : '_(unresolved — likely external/stdlib)_';
            out.push(`${indent}- \`${node.qualifiedName}\` — ${loc} — confidence \`${node.confidence}\``);
            if (node.children && node.children.length > 0) {
                for (const child of node.children) {
                    renderNode(child, indent + '    ');
                }
            }
        };

        if (direction === 'incoming' || direction === 'both') {
            out.push(`## Incoming (callers)`);
            if (result.incoming.length === 0) {
                out.push(`- _(no callers found in indexed code)_`);
            } else {
                for (const node of result.incoming) { renderNode(node, ''); }
            }
            out.push('');
        }
        if (direction === 'outgoing' || direction === 'both') {
            out.push(`## Outgoing (callees)`);
            if (result.outgoing.length === 0) {
                out.push(`- _(no outgoing calls extracted — function may be empty or not parsed)_`);
            } else {
                for (const node of result.outgoing) { renderNode(node, ''); }
            }
            out.push('');
        }

        out.push(`**Note:** \`low\` confidence callees are typically calls into stdlib / system headers / unindexed templates — they didn't match any decl in the workspace.`);
        return text(...out);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: hivemind_typeHierarchy  (tree-sitter scope resolver)
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
    constructor(private readonly analyzer: DependencyAnalyzer) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<TypeHierarchyInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { symbolName } = options.input;
        const direction = options.input.direction ?? 'both';
        const depth = Math.min(3, Math.max(1, options.input.depth ?? 2));
        const maxPerLevel = options.input.maxPerLevel ?? 25;
        if (!symbolName || !symbolName.trim()) {
            return text(`⚠️ \`hivemind_typeHierarchy\` requires \`symbolName\` (the class / struct name).`);
        }
        const resolver = this.analyzer.getScopeResolver();
        const result = await resolver.typeHierarchy({
            className: symbolName.trim(),
            direction,
            depth,
            maxPerLevel,
        });

        const out: string[] = [];
        out.push(`# Type Hierarchy: \`${symbolName}\``);
        out.push('');
        out.push(`Source: tree-sitter scope resolver (depth=${depth}, max-per-level=${maxPerLevel})`);
        out.push('');

        const renderNode = (node: any, indent: string): void => {
            const loc = node.file
                ? `\`${rel(this.analyzer, node.file)}:${node.line ?? '?'}\``
                : '_(unresolved)_';
            out.push(`${indent}- \`${node.className}\` — ${loc} — confidence \`${node.confidence}\``);
            if (node.children && node.children.length > 0) {
                for (const child of node.children) {
                    renderNode(child, indent + '    ');
                }
            }
        };

        if (direction === 'supertypes' || direction === 'both') {
            out.push(`## Supertypes (bases)`);
            if (result.supertypes.length === 0) {
                out.push(`- _(no supertypes — class either has no \`: public X\` clause or its bases aren't indexed)_`);
            } else {
                for (const node of result.supertypes) { renderNode(node, ''); }
            }
            out.push('');
        }
        if (direction === 'subtypes' || direction === 'both') {
            out.push(`## Subtypes (derived classes)`);
            if (result.subtypes.length === 0) {
                out.push(`- _(no subtypes found in indexed code)_`);
            } else {
                for (const node of result.subtypes) { renderNode(node, ''); }
            }
            out.push('');
        }
        out.push(`**Refactor rule:** Changing a base class affects every subtype above. When adding/removing/altering virtual methods, call \`hivemind_findOverrides\` on each affected method to find the concrete implementations.`);
        return text(...out);
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
// Tool: hivemind_getWarnings  — C++ diagnostics from the VS Code Problems panel
// ─────────────────────────────────────────────────────────────────────────────

interface GetWarningsInput {
    filePath?: string;
    severity?: 'error' | 'warning' | 'information' | 'hint' | 'all';
    source?: string;
    maxResults?: number;
}

class GetWarningsTool implements vscode.LanguageModelTool<GetWarningsInput> {
    constructor(private readonly analyzer: DependencyAnalyzer) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetWarningsInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { filePath, severity = 'warning', source, maxResults = 100 } = options.input;

        const severityMap: Record<string, vscode.DiagnosticSeverity> = {
            'error': vscode.DiagnosticSeverity.Error,
            'warning': vscode.DiagnosticSeverity.Warning,
            'information': vscode.DiagnosticSeverity.Information,
            'hint': vscode.DiagnosticSeverity.Hint,
        };

        // Determine which URIs to include
        let targetUris: Set<string> | null = null;
        if (filePath) {
            const resolved = this.analyzer.resolveFilePath(filePath);
            if (!resolved) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`⚠️ File "${filePath}" not found in the Hive Mind index.`),
                ]);
            }
            const { dependents } = this.analyzer.getRelatedFiles(resolved);
            targetUris = new Set([resolved, ...dependents].map(f => vscode.Uri.file(f).toString()));
        }

        interface DiagEntry {
            file: string; line: number; col: number;
            message: string; source: string; code: string;
            severity: vscode.DiagnosticSeverity;
        }

        const entries: DiagEntry[] = [];
        for (const [uri, diags] of vscode.languages.getDiagnostics()) {
            if (targetUris && !targetUris.has(uri.toString())) { continue; }
            const fsPath = uri.fsPath;
            if (!fsPath) { continue; }

            for (const d of diags) {
                if (severity !== 'all') {
                    const wanted = severityMap[severity];
                    if (wanted === undefined || d.severity > wanted) { continue; }
                }
                if (source && d.source && !d.source.toLowerCase().includes(source.toLowerCase())) { continue; }

                entries.push({
                    file: this.analyzer.toRelative(fsPath) ?? fsPath,
                    line: d.range.start.line + 1,
                    col: d.range.start.character + 1,
                    message: d.message,
                    source: d.source ?? '',
                    code: typeof d.code === 'object' ? String((d.code as { value: unknown }).value) : String(d.code ?? ''),
                    severity: d.severity,
                });
            }
        }

        entries.sort((a, b) => a.severity - b.severity || a.file.localeCompare(b.file) || a.line - b.line);

        if (entries.length === 0) {
            const scopeNote = filePath ? ` for \`${filePath}\` and its dependents` : '';
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`No ${severity === 'all' ? '' : severity + ' '}diagnostics found${scopeNote}.`),
            ]);
        }

        const severityLabel = (s: vscode.DiagnosticSeverity) => ['Error', 'Warning', 'Info', 'Hint'][s] ?? 'Unknown';
        const shown = entries.slice(0, maxResults);

        const sourceCounts = new Map<string, number>();
        for (const e of entries) {
            const k = e.source || 'unknown';
            sourceCounts.set(k, (sourceCounts.get(k) ?? 0) + 1);
        }

        const lines: string[] = [];
        const scopeNote = filePath ? ` (scoped to \`${filePath}\` + dependents)` : ' (workspace-wide)';
        lines.push(`# C++ Diagnostics — ${entries.length} result(s)${scopeNote}\n`);

        if (sourceCounts.size > 1) {
            lines.push(`## Summary by Source\n`);
            lines.push(`| Source | Count |`);
            lines.push(`|--------|-------|`);
            for (const [src, count] of [...sourceCounts.entries()].sort((a, b) => b[1] - a[1])) {
                lines.push(`| ${src || '(unknown)'} | ${count} |`);
            }
            lines.push('');
        }

        lines.push(`## Diagnostics\n`);
        lines.push(`| Severity | File | Line | Code | Message | Source |`);
        lines.push(`|----------|------|------|------|---------|--------|`);
        for (const e of shown) {
            const msg = e.message.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 120);
            lines.push(`| ${severityLabel(e.severity)} | \`${e.file}\` | ${e.line} | ${e.code} | ${msg} | ${e.source} |`);
        }
        if (entries.length > maxResults) {
            lines.push(`\n_Showing ${maxResults} of ${entries.length} results. Use \`filePath\` to scope or increase \`maxResults\`._`);
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(lines.join('\n')),
        ]);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: hivemind_getCodeQLAlerts  — parse SARIF output from CodeQL / static analysis
// ─────────────────────────────────────────────────────────────────────────────

interface GetCodeQLAlertsInput {
    sarifPath?: string;
    ruleId?: string;
    filePath?: string;
    severity?: string;
    maxResults?: number;
    source?: 'local' | 'github' | 'both';
}

// Minimal SARIF type subset
interface SarifArtifactLocation { uri?: string; uriBaseId?: string; }
interface SarifPhysicalLocation {
    artifactLocation?: SarifArtifactLocation;
    region?: { startLine?: number; startColumn?: number; };
}
interface SarifLocation { physicalLocation?: SarifPhysicalLocation; }
interface SarifMessage { text?: string; markdown?: string; }
interface SarifResult {
    ruleId?: string;
    message?: SarifMessage;
    locations?: SarifLocation[];
    level?: string;
}
interface SarifRule {
    id?: string;
    name?: string;
    shortDescription?: SarifMessage;
}
interface SarifRun {
    tool?: { driver?: { name?: string; rules?: SarifRule[]; }; };
    results?: SarifResult[];
}
interface SarifDocument { runs?: SarifRun[]; }

class GetCodeQLAlertsTool implements vscode.LanguageModelTool<GetCodeQLAlertsInput> {
    constructor(private readonly analyzer: DependencyAnalyzer, private readonly ghProvider: GitHubClientProvider) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetCodeQLAlertsInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { sarifPath, ruleId, filePath, severity, maxResults = 50, source = 'both' } = options.input;
        const roots = this.analyzer.getWorkspaceRoots();
        const workspaceRoot = roots[0];
        if (!workspaceRoot) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('⚠️ No workspace root found.'),
            ]);
        }

        interface AlertEntry {
            tool: string; ruleId: string; ruleName: string;
            level: string; file: string; line: number; message: string;
            origin: 'local' | 'github';
        }

        const alerts: AlertEntry[] = [];

        // ── Local SARIF scan ────────────────────────────────────────────
        if (source === 'local' || source === 'both') {
            let sarifFiles: string[];
            if (sarifPath) {
                const abs = path.isAbsolute(sarifPath) ? sarifPath : path.join(workspaceRoot, sarifPath);
                if (fs.existsSync(abs)) { sarifFiles = [abs]; }
                else { sarifFiles = []; }
            } else {
                sarifFiles = this.findSarifFiles(workspaceRoot);
            }

            const ruleMap = new Map<string, SarifRule>();
            for (const sf of sarifFiles) {
                let doc: SarifDocument;
                try { doc = JSON.parse(fs.readFileSync(sf, 'utf8')) as SarifDocument; }
                catch { continue; }

                for (const run of doc.runs ?? []) {
                    const toolName = run.tool?.driver?.name ?? 'Unknown';
                    for (const rule of run.tool?.driver?.rules ?? []) {
                        if (rule.id) { ruleMap.set(rule.id, rule); }
                    }
                    for (const result of run.results ?? []) {
                        const rid = result.ruleId ?? '';
                        const rule = ruleMap.get(rid);
                        const ruleName = rule?.name ?? rule?.shortDescription?.text ?? '';
                        const level = result.level ?? 'warning';

                        if (ruleId && !rid.toLowerCase().includes(ruleId.toLowerCase())) { continue; }
                        if (severity && !level.toLowerCase().includes(severity.toLowerCase())) { continue; }

                        const loc = result.locations?.[0];
                        const rawUri = loc?.physicalLocation?.artifactLocation?.uri ?? '';
                        const fileRel = this.resolveArtifactUri(rawUri, workspaceRoot);

                        if (filePath) {
                            const resolved = this.analyzer.resolveFilePath(filePath);
                            const targetRel = resolved ? this.analyzer.toRelative(resolved) : filePath;
                            if (targetRel && !fileRel.includes(targetRel) && !targetRel.includes(fileRel)) { continue; }
                        }

                        const line = loc?.physicalLocation?.region?.startLine ?? 0;
                        const msg = (result.message?.text ?? result.message?.markdown ?? '')
                            .replace(/\n/g, ' ').slice(0, 200);

                        alerts.push({ tool: toolName, ruleId: rid, ruleName, level, file: fileRel, line, message: msg, origin: 'local' });
                    }
                }
            }
        }

        // ── GitHub API scan ─────────────────────────────────────────────
        if (source === 'github' || source === 'both') {
            const gh = this.ghProvider();
            if (gh && gh.isAvailable()) {
                const result = await gh.getCodeScanningAlerts({ severity });
                if (!result.error) {
                    for (const alert of result.alerts) {
                        const rid = alert.rule.id ?? '';
                        if (ruleId && !rid.toLowerCase().includes(ruleId.toLowerCase())) { continue; }

                        const alertFile = alert.most_recent_instance.location?.path ?? '';
                        if (filePath) {
                            const resolved = this.analyzer.resolveFilePath(filePath);
                            const targetRel = resolved ? this.analyzer.toRelative(resolved) : filePath;
                            if (targetRel && !alertFile.includes(targetRel) && !targetRel.includes(alertFile)) { continue; }
                        }

                        alerts.push({
                            tool: alert.tool.name ?? 'CodeQL',
                            ruleId: rid,
                            ruleName: alert.rule.description ?? '',
                            level: alert.rule.severity ?? 'warning',
                            file: alertFile,
                            line: alert.most_recent_instance.location?.start_line ?? 0,
                            message: (alert.most_recent_instance.message?.text ?? '').replace(/\n/g, ' ').slice(0, 200),
                            origin: 'github',
                        });
                    }
                } else if (source === 'github') {
                    // Only show error if user explicitly asked for GitHub
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(`⚠️ ${result.error}`),
                    ]);
                }
            } else if (source === 'github') {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        '⚠️ GitHub integration unavailable. Ensure the workspace has a git remote pointing to github.com and you are signed in via VS Code\'s GitHub account.'
                    ),
                ]);
            }
        }

        if (alerts.length === 0) {
            const filterNote = [
                ruleId ? `ruleId="${ruleId}"` : '',
                filePath ? `file="${filePath}"` : '',
                severity ? `level="${severity}"` : '',
            ].filter(Boolean).join(', ');
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `No CodeQL/SARIF alerts found${filterNote ? ` matching: ${filterNote}` : ''}.`
                ),
            ]);
        }

        const levelOrder: Record<string, number> = { error: 0, warning: 1, note: 2, none: 3 };
        alerts.sort((a, b) =>
            (levelOrder[a.level] ?? 1) - (levelOrder[b.level] ?? 1) ||
            a.file.localeCompare(b.file) ||
            a.line - b.line
        );

        const ruleCounts = new Map<string, number>();
        for (const a of alerts) { ruleCounts.set(a.ruleId || 'unknown', (ruleCounts.get(a.ruleId || 'unknown') ?? 0) + 1); }

        const shown = alerts.slice(0, maxResults);
        const lines: string[] = [];
        const localCount = alerts.filter(a => a.origin === 'local').length;
        const ghCount = alerts.filter(a => a.origin === 'github').length;
        const sourceNote = localCount && ghCount
            ? ` (${localCount} local SARIF, ${ghCount} GitHub API)`
            : ghCount ? ' (GitHub API)' : ' (local SARIF)';
        lines.push(`# CodeQL / Static Analysis Alerts — ${alerts.length} total${sourceNote}\n`);

        lines.push(`## Top Rules\n`);
        lines.push(`| Rule | Count |`);
        lines.push(`|------|-------|`);
        for (const [rule, count] of [...ruleCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
            lines.push(`| \`${rule}\` | ${count} |`);
        }
        lines.push('');

        lines.push(`## Alerts\n`);
        lines.push(`| Level | Rule | File | Line | Source | Message |`);
        lines.push(`|-------|------|------|------|--------|---------|`);
        for (const a of shown) {
            const msg = a.message.replace(/\|/g, '\\|').slice(0, 100);
            lines.push(`| ${a.level} | \`${a.ruleId}\` | \`${a.file}\` | ${a.line} | ${a.origin} | ${msg} |`);
        }
        if (alerts.length > maxResults) {
            lines.push(`\n_Showing ${maxResults} of ${alerts.length} alerts. Filter with \`ruleId\`, \`filePath\`, or \`severity\`._`);
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(lines.join('\n')),
        ]);
    }

    private findSarifFiles(workspaceRoot: string): string[] {
        const found: string[] = [];
        const searchDirs = [
            workspaceRoot,
            path.join(workspaceRoot, '.github'),
            path.join(workspaceRoot, '.github', 'codeql-results'),
            path.join(workspaceRoot, 'results'),
            path.join(workspaceRoot, 'build'),
            path.join(workspaceRoot, 'out'),
        ];
        for (const dir of searchDirs) {
            if (!fs.existsSync(dir)) { continue; }
            let entries: fs.Dirent[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
            for (const entry of entries) {
                if (entry.isFile() && entry.name.endsWith('.sarif')) {
                    found.push(path.join(dir, entry.name));
                } else if (entry.isDirectory() && dir === workspaceRoot &&
                           !entry.name.startsWith('.') && entry.name !== 'node_modules') {
                    // One extra level from root only
                    try {
                        for (const sub of fs.readdirSync(path.join(dir, entry.name), { withFileTypes: true })) {
                            if (sub.isFile() && sub.name.endsWith('.sarif')) {
                                found.push(path.join(dir, entry.name, sub.name));
                            }
                        }
                    } catch { /* skip */ }
                }
            }
        }
        return [...new Set(found)];
    }

    private resolveArtifactUri(uri: string, workspaceRoot: string): string {
        let resolved = uri;
        if (resolved.startsWith('file:///')) { resolved = resolved.slice(8); }
        else if (resolved.startsWith('file://')) { resolved = resolved.slice(7); }
        // Normalise separators for display
        const normalised = resolved.replace(/\//g, '/');
        const abs = path.isAbsolute(normalised)
            ? normalised
            : path.join(workspaceRoot, normalised);
        if (fs.existsSync(abs)) {
            return path.relative(workspaceRoot, abs).replace(/\\/g, '/');
        }
        return normalised;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: hivemind_getCIWarnings  — GitHub Actions build warnings/errors
// ─────────────────────────────────────────────────────────────────────────────

interface GetCIWarningsInput {
    workflowFileName?: string;
    branch?: string;
    filePath?: string;
    level?: 'failure' | 'warning' | 'notice' | 'all';
    maxResults?: number;
}

class GetCIWarningsTool implements vscode.LanguageModelTool<GetCIWarningsInput> {
    constructor(private readonly analyzer: DependencyAnalyzer, private readonly ghProvider: GitHubClientProvider) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetCIWarningsInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { workflowFileName, branch, filePath, level = 'all', maxResults = 100 } = options.input;

        const gh = this.ghProvider();
        if (!gh || !gh.isAvailable()) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    '⚠️ GitHub integration unavailable. Ensure the workspace has a git remote pointing to github.com and you are signed in via VS Code\'s GitHub account (Accounts menu in the sidebar).'
                ),
            ]);
        }

        const result = await gh.getCIWarnings({ workflowFileName, branch });

        if (result.error) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`⚠️ ${result.error}`),
            ]);
        }

        if (!result.run) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    'No completed workflow runs found.' +
                    (workflowFileName ? ` Checked workflow: \`${workflowFileName}\`.` : ' Checked all workflows.') +
                    (branch ? ` Branch: \`${branch}\`.` : '')
                ),
            ]);
        }

        let annotations = result.annotations;

        // Filter by level
        if (level !== 'all') {
            annotations = annotations.filter(a => a.annotation_level === level);
        }

        // Filter by file path
        if (filePath) {
            const resolved = this.analyzer.resolveFilePath(filePath);
            const targetRel = resolved ? this.analyzer.toRelative(resolved) : filePath;
            annotations = annotations.filter(a => {
                if (!targetRel) { return true; }
                return a.path.includes(targetRel) || targetRel.includes(a.path);
            });
        }

        if (annotations.length === 0) {
            const filterNote = [
                level !== 'all' ? `level="${level}"` : '',
                filePath ? `file="${filePath}"` : '',
            ].filter(Boolean).join(', ');
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `No build annotations found in the latest CI run${filterNote ? ` matching: ${filterNote}` : ''}.\n\n` +
                    `**Run:** ${result.run.name} (${result.run.conclusion ?? result.run.status})\n` +
                    `**Branch:** ${result.run.head_branch}\n` +
                    `**URL:** ${result.run.html_url}`
                ),
            ]);
        }

        // Sort: failures first, then warnings, then notices
        const levelOrder: Record<string, number> = { failure: 0, warning: 1, notice: 2 };
        annotations.sort((a, b) =>
            (levelOrder[a.annotation_level] ?? 1) - (levelOrder[b.annotation_level] ?? 1) ||
            a.path.localeCompare(b.path) ||
            a.start_line - b.start_line
        );

        const shown = annotations.slice(0, maxResults);

        // Summary counts
        const counts = { failure: 0, warning: 0, notice: 0 };
        for (const a of annotations) {
            if (a.annotation_level in counts) { counts[a.annotation_level as keyof typeof counts]++; }
        }

        const lines: string[] = [];
        lines.push(`# CI Build Annotations — ${annotations.length} total\n`);
        lines.push(`**Workflow:** ${result.run.name}`);
        lines.push(`**Branch:** ${result.run.head_branch}`);
        lines.push(`**Status:** ${result.run.conclusion ?? result.run.status}`);
        lines.push(`**URL:** ${result.run.html_url}\n`);

        if (counts.failure || counts.warning || counts.notice) {
            lines.push(`**Summary:** ${counts.failure} errors, ${counts.warning} warnings, ${counts.notice} notices\n`);
        }

        // Check runs overview
        if (result.checkRuns.length > 0) {
            lines.push(`## Check Runs\n`);
            lines.push(`| Name | Status | Conclusion | Annotations |`);
            lines.push(`|------|--------|------------|-------------|`);
            for (const cr of result.checkRuns.slice(0, 20)) {
                lines.push(`| ${cr.name} | ${cr.status} | ${cr.conclusion ?? '-'} | ${cr.output.annotations_count} |`);
            }
            lines.push('');
        }

        lines.push(`## Annotations\n`);
        lines.push(`| Level | File | Line | Title | Message |`);
        lines.push(`|-------|------|------|-------|---------|`);
        for (const a of shown) {
            const msg = (a.message ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 120);
            const title = (a.title ?? '').replace(/\|/g, '\\|').slice(0, 50);
            lines.push(`| ${a.annotation_level} | \`${a.path}\` | ${a.start_line} | ${title} | ${msg} |`);
        }
        if (annotations.length > maxResults) {
            lines.push(`\n_Showing ${maxResults} of ${annotations.length} annotations. Filter with \`filePath\` or \`level\`._`);
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(lines.join('\n')),
        ]);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: hivemind_unusedIncludes  — detect likely-unused #include directives
// ─────────────────────────────────────────────────────────────────────────────

interface UnusedIncludesInput {
    filePath: string;
    confidence?: 'high' | 'all';
}

class UnusedIncludesTool implements vscode.LanguageModelTool<UnusedIncludesInput> {
    constructor(private readonly analyzer: DependencyAnalyzer) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<UnusedIncludesInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { filePath, confidence = 'all' } = options.input;
        const resolved = this.analyzer.resolveFilePath(filePath);
        if (!resolved) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`⚠️ File "${filePath}" not found in the Hive Mind index.`),
            ]);
        }

        const ext = path.extname(resolved).toLowerCase();
        if (!['.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx', '.inl', '.ipp', '.tpp'].includes(ext)) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`⚠️ This tool only works on C/C++ files. "${filePath}" is a ${ext} file.`),
            ]);
        }

        if (!isCppParserReady()) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('⚠️ Tree-sitter C++ parser is not available. Cannot analyze includes.'),
            ]);
        }

        // Read and parse the source file
        let sourceText: string;
        try {
            sourceText = fs.readFileSync(resolved, 'utf8');
        } catch {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`⚠️ Could not read file "${filePath}".`),
            ]);
        }

        // Extract all identifiers used in the source file (rough but effective)
        const usedIdentifiers = this.extractIdentifiers(sourceText);

        // Get the file's direct dependencies from the graph
        const node = this.analyzer.getGraphNode(resolved);
        if (!node) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`⚠️ File "${filePath}" is not in the dependency graph.`),
            ]);
        }

        // Extract #include lines with line numbers for reporting
        const includeLines = this.extractIncludeLines(sourceText);

        interface IncludeAnalysis {
            includeLine: string;
            lineNumber: number;
            resolvedPath: string | null;
            headerSymbols: string[];
            usedSymbols: string[];
            verdict: 'unused' | 'likely-unused' | 'used';
        }

        const results: IncludeAnalysis[] = [];

        for (const inc of includeLines) {
            // Find which resolved dependency this include maps to
            const matchedDep = this.findResolvedDep(inc.path, resolved, node.dependencies);

            if (!matchedDep) {
                // Include not resolved — could be external SDK header
                results.push({
                    includeLine: inc.raw,
                    lineNumber: inc.line,
                    resolvedPath: null,
                    headerSymbols: [],
                    usedSymbols: [],
                    verdict: 'likely-unused',
                });
                continue;
            }

            // Parse the header to get its exported symbols
            let headerText: string;
            try {
                headerText = fs.readFileSync(matchedDep, 'utf8');
            } catch {
                continue;
            }

            const headerParsed = parseCppSync(headerText);
            const headerSymbolNames = headerParsed.symbols.map(s => s.name);

            // Also extract macro definitions from the header
            const macroNames = this.extractMacroNames(headerText);
            const allHeaderSymbols = [...new Set([...headerSymbolNames, ...macroNames])];

            // Check which header symbols are referenced in the source
            const usedFromHeader = allHeaderSymbols.filter(sym => usedIdentifiers.has(sym));

            let verdict: 'unused' | 'likely-unused' | 'used';
            if (usedFromHeader.length > 0) {
                verdict = 'used';
            } else if (allHeaderSymbols.length === 0) {
                // Header declares no symbols we can detect — might be a config/pragma header
                verdict = 'likely-unused';
            } else {
                verdict = 'unused';
            }

            results.push({
                includeLine: inc.raw,
                lineNumber: inc.line,
                resolvedPath: matchedDep,
                headerSymbols: allHeaderSymbols.slice(0, 20),
                usedSymbols: usedFromHeader.slice(0, 10),
                verdict,
            });
        }

        // Filter by confidence
        const unused = results.filter(r =>
            confidence === 'high' ? r.verdict === 'unused' : r.verdict !== 'used'
        );

        if (unused.length === 0) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `All ${results.length} #include directives in \`${rel(this.analyzer, resolved)}\` appear to be in use.`
                ),
            ]);
        }

        const lines: string[] = [];
        lines.push(`# Unused Includes — \`${rel(this.analyzer, resolved)}\`\n`);
        lines.push(`Found **${unused.length}** potentially unused include(s) out of ${results.length} total.\n`);

        lines.push(`| Line | Include | Status | Header Exports (sample) |`);
        lines.push(`|------|---------|--------|-------------------------|`);

        for (const r of unused) {
            const headerRel = r.resolvedPath ? `\`${rel(this.analyzer, r.resolvedPath)}\`` : '(unresolved)';
            const exports = r.headerSymbols.length > 0
                ? r.headerSymbols.slice(0, 5).join(', ') + (r.headerSymbols.length > 5 ? '...' : '')
                : '(none detected)';
            lines.push(`| ${r.lineNumber} | ${r.includeLine} | **${r.verdict}** | ${exports} |`);
        }

        lines.push(`\n## Recommended Actions\n`);
        lines.push(`- **unused**: No symbols from this header are referenced. Safe to remove (verify with \`hivemind_buildSubset\`).`);
        lines.push(`- **likely-unused**: Unresolved or no detectable exports. May be a system header, config, or pragma-only header — review manually.\n`);
        lines.push(`> ⚠️ This analysis is heuristic. Macros that generate code, template metaprogramming, and ADL can create invisible dependencies. Always validate removals with \`hivemind_buildSubset\`.`);

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(lines.join('\n')),
        ]);
    }

    /** Extract all C/C++ identifiers from source text (fast regex scan). */
    private extractIdentifiers(source: string): Set<string> {
        const ids = new Set<string>();
        // Strip comments and string literals to avoid false positives
        const stripped = source
            .replace(/\/\/[^\n]*/g, '')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/"(?:[^"\\]|\\.)*"/g, '')
            .replace(/'(?:[^'\\]|\\.)*'/g, '');
        // Extract identifiers (C/C++ identifier rules)
        const re = /\b([A-Za-z_]\w*)\b/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(stripped)) !== null) {
            ids.add(m[1]);
        }
        return ids;
    }

    /** Extract #include lines with line numbers and paths. */
    private extractIncludeLines(source: string): { raw: string; path: string; line: number }[] {
        const results: { raw: string; path: string; line: number }[] = [];
        const lines = source.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(/^\s*#\s*include\s*[<"]([^>"]+)[>"]/);
            if (m) {
                results.push({ raw: lines[i].trim(), path: m[1], line: i + 1 });
            }
        }
        return results;
    }

    /** Extract #define macro names from header source. */
    private extractMacroNames(source: string): string[] {
        const names: string[] = [];
        const re = /^\s*#\s*define\s+([A-Za-z_]\w*)/gm;
        let m: RegExpExecArray | null;
        while ((m = re.exec(source)) !== null) {
            names.push(m[1]);
        }
        return names;
    }

    /** Find which resolved dependency corresponds to an include path. */
    private findResolvedDep(includePath: string, fromFile: string, deps: Set<string>): string | null {
        const includeNorm = includePath.replace(/\\/g, '/').toLowerCase();
        const baseName = path.basename(includePath).toLowerCase();

        for (const dep of deps) {
            const depNorm = dep.replace(/\\/g, '/').toLowerCase();
            // Exact suffix match (e.g., "net/socket.h" matches ".../net/socket.h")
            if (depNorm.endsWith('/' + includeNorm) || depNorm.endsWith('\\' + includeNorm)) {
                return dep;
            }
            // Basename match
            if (path.basename(dep).toLowerCase() === baseName) {
                return dep;
            }
        }
        return null;
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
    macroExpanderProvider: MacroExpanderProvider,
    buildSubsetProvider: BuildSubsetProvider,
    gitHubClientProvider: GitHubClientProvider
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
        vscode.lm.registerTool('hivemind_findReferences',  new FindReferencesTool(analyzer)),
        vscode.lm.registerTool('hivemind_findOverrides',   new FindOverridesTool(analyzer)),
        vscode.lm.registerTool('hivemind_callHierarchy',   new CallHierarchyTool(analyzer)),
        vscode.lm.registerTool('hivemind_typeHierarchy',   new TypeHierarchyTool(analyzer)),
        vscode.lm.registerTool('hivemind_macroExpand',     new MacroExpandTool(analyzer, macroExpanderProvider)),
        vscode.lm.registerTool('hivemind_buildSubset',     new BuildSubsetTool(analyzer, buildSubsetProvider)),
        vscode.lm.registerTool('hivemind_getWarnings',     new GetWarningsTool(analyzer)),
        vscode.lm.registerTool('hivemind_getCodeQLAlerts', new GetCodeQLAlertsTool(analyzer, gitHubClientProvider)),
        vscode.lm.registerTool('hivemind_getCIWarnings',   new GetCIWarningsTool(analyzer, gitHubClientProvider)),
        vscode.lm.registerTool('hivemind_unusedIncludes',  new UnusedIncludesTool(analyzer)),
    );
}
