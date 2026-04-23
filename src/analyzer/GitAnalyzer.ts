import * as path from 'path';
import { execSync } from 'child_process';
import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CoChangeEntry {
    file: string;       // absolute path
    coChangeCount: number;
    ratio: number;      // 0-1, proportion of commits containing both files
}

// ---------------------------------------------------------------------------
// GitAnalyzer — finds files that frequently change together in git history
// ---------------------------------------------------------------------------

export class GitAnalyzer {
    /** file path → co-changed files */
    private coChangeCache = new Map<string, CoChangeEntry[]>();
    private cacheTimestamp = 0;
    private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

    /** commit → set of files changed in that commit */
    private commitMap: Map<number, Set<string>> | null = null;

    /** file → set of commit indices */
    private fileCommits: Map<string, Set<number>> | null = null;

    private workspaceRoot: string | undefined;

    constructor() {
        this.workspaceRoot = (vscode.workspace.workspaceFolders ?? [])[0]?.uri.fsPath;
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /**
     * Parse git log and build co-change index.
     * @param maxCommits Maximum number of commits to analyze (default: 500)
     */
    analyze(maxCommits = 500): void {
        if (!this.workspaceRoot) { return; }
        if (!this.isGitRepo()) { return; }

        try {
            const output = execSync(
                `git log --name-only --pretty=format:"---COMMIT---" -n ${maxCommits} --diff-filter=ACMR`,
                {
                    cwd: this.workspaceRoot,
                    encoding: 'utf-8',
                    maxBuffer: 10 * 1024 * 1024, // 10MB
                    timeout: 30000,
                }
            );

            this.parseGitLog(output);
            this.cacheTimestamp = Date.now();
            this.coChangeCache.clear();
        } catch {
            // git not available or not a git repo — silently ignore
            this.commitMap = null;
            this.fileCommits = null;
        }
    }

    /**
     * Get files that frequently change together with the given file.
     * Returns sorted by co-change count descending.
     */
    getCoChangedFiles(filePath: string): CoChangeEntry[] {
        if (!this.workspaceRoot || !this.fileCommits) { return []; }

        // Normalize path to relative
        const rel = this.toRelative(filePath);
        if (!rel) { return []; }

        // Check cache
        if (this.isCacheValid()) {
            const cached = this.coChangeCache.get(rel);
            if (cached) { return cached; }
        }

        const myCommits = this.fileCommits.get(rel);
        if (!myCommits || myCommits.size === 0) { return []; }

        // Count co-occurrences
        const counts = new Map<string, number>();
        for (const commitIdx of myCommits) {
            const filesInCommit = this.commitMap!.get(commitIdx);
            if (!filesInCommit) { continue; }
            for (const otherFile of filesInCommit) {
                if (otherFile === rel) { continue; }
                counts.set(otherFile, (counts.get(otherFile) ?? 0) + 1);
            }
        }

        // Filter: at least 3 co-changes and >= 30% ratio
        const results: CoChangeEntry[] = [];
        for (const [otherRel, count] of counts) {
            if (count < 3) { continue; }
            const otherCommits = this.fileCommits.get(otherRel);
            if (!otherCommits) { continue; }
            const ratio = count / Math.min(myCommits.size, otherCommits.size);
            if (ratio < 0.3) { continue; }

            const absPath = path.join(this.workspaceRoot!, otherRel);
            results.push({ file: absPath, coChangeCount: count, ratio });
        }

        results.sort((a, b) => b.coChangeCount - a.coChangeCount);
        const top = results.slice(0, 20);

        this.coChangeCache.set(rel, top);
        return top;
    }

    /**
     * Clear all caches.
     */
    clear(): void {
        this.coChangeCache.clear();
        this.commitMap = null;
        this.fileCommits = null;
        this.cacheTimestamp = 0;
    }

    /**
     * Whether git history data is available.
     */
    get isAvailable(): boolean {
        return this.fileCommits !== null && this.fileCommits.size > 0;
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    private isGitRepo(): boolean {
        if (!this.workspaceRoot) { return false; }
        try {
            execSync('git rev-parse --is-inside-work-tree', {
                cwd: this.workspaceRoot,
                encoding: 'utf-8',
                timeout: 5000,
            });
            return true;
        } catch {
            return false;
        }
    }

    private parseGitLog(output: string): void {
        this.commitMap = new Map();
        this.fileCommits = new Map();

        const commits = output.split('---COMMIT---');
        let commitIdx = 0;

        for (const block of commits) {
            const lines = block.trim().split('\n').filter(l => l.trim().length > 0);
            if (lines.length === 0) { continue; }

            const files = new Set<string>();
            for (const line of lines) {
                const trimmed = line.trim();
                // Skip empty lines and lines that look like commit metadata
                if (!trimmed || trimmed.startsWith('commit ') || trimmed.startsWith('Author:') ||
                    trimmed.startsWith('Date:') || trimmed.startsWith('Merge:')) {
                    continue;
                }
                // Normalize path separators
                const normalized = trimmed.replace(/\\/g, '/');
                files.add(normalized);
            }

            if (files.size > 0 && files.size <= 50) {
                // Skip very large commits (likely merges/refactors, not meaningful coupling)
                this.commitMap.set(commitIdx, files);
                for (const file of files) {
                    if (!this.fileCommits.has(file)) { this.fileCommits.set(file, new Set()); }
                    this.fileCommits.get(file)!.add(commitIdx);
                }
                commitIdx++;
            }
        }
    }

    private isCacheValid(): boolean {
        return Date.now() - this.cacheTimestamp < this.CACHE_TTL_MS;
    }

    private toRelative(filePath: string): string | undefined {
        if (!this.workspaceRoot) { return undefined; }
        if (path.isAbsolute(filePath)) {
            if (filePath.startsWith(this.workspaceRoot)) {
                return path.relative(this.workspaceRoot, filePath).replace(/\\/g, '/');
            }
            return undefined;
        }
        return filePath.replace(/\\/g, '/');
    }
}
