import * as vscode from 'vscode';
import * as fs from 'fs';
import { DependencyAnalyzer } from '../analyzer/DependencyAnalyzer';
import { SymbolAnalyzer } from '../analyzer/SymbolAnalyzer';
import { GitAnalyzer } from '../analyzer/GitAnalyzer';

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
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerTools(
    context: vscode.ExtensionContext,
    analyzer: DependencyAnalyzer,
    symbolAnalyzer: SymbolAnalyzer,
    gitAnalyzer: GitAnalyzer
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
    );
}
