import * as vscode from 'vscode';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SymbolInfo {
    name: string;
    kind: vscode.SymbolKind;
    filePath: string;
    range: vscode.Range;
    detail: string;
    children: SymbolInfo[];
}

// ---------------------------------------------------------------------------
// SymbolAnalyzer — extracts symbols via VS Code's DocumentSymbolProvider
// ---------------------------------------------------------------------------

export class SymbolAnalyzer {
    /** file path → symbols (cached) */
    private cache = new Map<string, { symbols: SymbolInfo[]; version: number }>();

    /** symbol name (lowercase) → file paths where it's defined */
    private nameIndex = new Map<string, Set<string>>();

    private workspaceRoots: string[];

    constructor() {
        this.workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /**
     * Index symbols for a single file. Uses VS Code's built-in DocumentSymbolProvider.
     * Returns empty array for files with no language support.
     */
    async indexFile(filePath: string): Promise<SymbolInfo[]> {
        const uri = vscode.Uri.file(filePath);

        try {
            const rawSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                uri
            );

            if (!rawSymbols || rawSymbols.length === 0) {
                this.cache.set(filePath, { symbols: [], version: Date.now() });
                return [];
            }

            const symbols = this.flattenSymbols(rawSymbols, filePath);

            // Update caches
            this.cache.set(filePath, { symbols, version: Date.now() });

            // Remove old name index entries for this file
            for (const [name, files] of this.nameIndex) {
                files.delete(filePath);
                if (files.size === 0) { this.nameIndex.delete(name); }
            }

            // Add new name index entries
            for (const sym of symbols) {
                const key = sym.name.toLowerCase();
                if (!this.nameIndex.has(key)) { this.nameIndex.set(key, new Set()); }
                this.nameIndex.get(key)!.add(filePath);
            }

            return symbols;
        } catch {
            // Language server not available for this file type
            return [];
        }
    }

    /**
     * Index all files in the graph (background, lazy).
     * Indexes in batches to avoid blocking the extension host.
     */
    async indexFiles(filePaths: string[]): Promise<void> {
        const BATCH_SIZE = 20;
        for (let i = 0; i < filePaths.length; i += BATCH_SIZE) {
            const batch = filePaths.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(f => this.indexFile(f)));
        }
    }

    /**
     * Find all locations of a symbol by name (case-insensitive).
     */
    findSymbol(name: string): SymbolInfo[] {
        const key = name.toLowerCase();
        const results: SymbolInfo[] = [];

        // First check the name index for exact matches
        const files = this.nameIndex.get(key);
        if (files) {
            for (const filePath of files) {
                const cached = this.cache.get(filePath);
                if (cached) {
                    for (const sym of cached.symbols) {
                        if (sym.name.toLowerCase() === key) {
                            results.push(sym);
                        }
                    }
                }
            }
        }

        // Also check for partial matches if no exact matches
        if (results.length === 0) {
            for (const [indexKey, files] of this.nameIndex) {
                if (indexKey.includes(key)) {
                    for (const filePath of files) {
                        const cached = this.cache.get(filePath);
                        if (cached) {
                            for (const sym of cached.symbols) {
                                if (sym.name.toLowerCase().includes(key)) {
                                    results.push(sym);
                                }
                            }
                        }
                    }
                }
            }
        }

        return results;
    }

    /**
     * Get all symbols for a specific file. Indexes on demand if not cached.
     */
    getFileSymbols(filePath: string): SymbolInfo[] {
        const cached = this.cache.get(filePath);
        if (cached) { return cached.symbols; }
        return [];
    }

    /**
     * Get all symbols for a specific file, indexing if needed.
     */
    async getFileSymbolsAsync(filePath: string): Promise<SymbolInfo[]> {
        const cached = this.cache.get(filePath);
        if (cached) { return cached.symbols; }
        return this.indexFile(filePath);
    }

    /**
     * Get top-level exported symbols (classes, functions, interfaces, types, enums).
     */
    getExportedSymbols(filePath: string): SymbolInfo[] {
        const all = this.getFileSymbols(filePath);
        const exportKinds = new Set([
            vscode.SymbolKind.Class,
            vscode.SymbolKind.Function,
            vscode.SymbolKind.Interface,
            vscode.SymbolKind.Enum,
            vscode.SymbolKind.Module,
            vscode.SymbolKind.Variable,
            vscode.SymbolKind.Constant,
            vscode.SymbolKind.TypeParameter,
        ]);
        // Return only top-level symbols of export-worthy kinds
        return all.filter(s => exportKinds.has(s.kind) && s.children.length === 0 || s.detail === '');
    }

    /**
     * Invalidate cache for a file (call on file change).
     */
    invalidate(filePath: string): void {
        this.cache.delete(filePath);
        for (const [name, files] of this.nameIndex) {
            files.delete(filePath);
            if (files.size === 0) { this.nameIndex.delete(name); }
        }
    }

    /**
     * Clear all caches.
     */
    clear(): void {
        this.cache.clear();
        this.nameIndex.clear();
    }

    /**
     * Number of indexed files.
     */
    get indexedCount(): number {
        return this.cache.size;
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    private flattenSymbols(
        symbols: vscode.DocumentSymbol[],
        filePath: string,
        parent?: SymbolInfo
    ): SymbolInfo[] {
        const result: SymbolInfo[] = [];

        for (const sym of symbols) {
            const info: SymbolInfo = {
                name: sym.name,
                kind: sym.kind,
                filePath,
                range: sym.selectionRange,
                detail: sym.detail,
                children: [],
            };

            if (sym.children && sym.children.length > 0) {
                info.children = this.flattenSymbols(sym.children, filePath, info);
            }

            result.push(info);
            // Also include children in the flat list
            result.push(...info.children);
        }

        return result;
    }

    toRelative(absPath: string): string {
        for (const root of this.workspaceRoots) {
            if (absPath.startsWith(root)) {
                return path.relative(root, absPath).replace(/\\/g, '/');
            }
        }
        return absPath;
    }
}
