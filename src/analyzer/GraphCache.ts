import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// =============================================================================
// GraphCache — disk-persisted dependency graph snapshot.
// =============================================================================
//
// Purpose:
//   Cold-start indexing on a 100k-file C/C++ repo takes 30–120 seconds. Most of
//   that work is wasted re-parsing files that haven't changed since the last
//   session. This module persists the graph to disk and lets `analyze()` skip
//   the parse step for files whose mtime/size match the cached entry.
//
// Snapshot shape (on disk, JSON):
//   • schemaVersion       — bumped any time we change semantics. Old snapshots
//                            with a different version are silently discarded.
//   • contextHash         — fingerprint of inputs that change parsing globally
//                            (compile_commands.json, tsconfig, parser version,
//                            -D flags universe, etc.). Changing this
//                            invalidates EVERY cached entry, not just one.
//   • workspaceRoots      — list of absolute paths the snapshot was built for.
//                            Mismatched roots invalidate the snapshot.
//   • files               — array of { path, mtimeMs, size, deps[] }. The
//                            `deps` array holds absolute dependency paths
//                            exactly as the live graph stores them.
//   • headerIndex         — flattened Map<string, string[]> snapshot. We could
//                            rebuild it from the file list, but persisting it
//                            saves 1-2s on huge repos.
//
// Validity rules at load time:
//   1. Schema version matches.
//   2. Workspace roots match (any change → full reindex).
//   3. contextHash matches.
//   4. Per-file: mtime + size match. If either differs, that file gets
//      re-parsed. Files in the cache that no longer exist are dropped.
//
// Storage location:
//   `{globalStorageUri}/graph-cache/<workspace-fingerprint>.json`
//
//   Using `globalStorageUri` (extension-scoped) instead of `.vscode/` keeps
//   user repos clean. The workspace fingerprint is a hash of the sorted root
//   paths so multiple workspaces don't collide.
//
// Atomic write strategy:
//   Write to `<file>.tmp` then rename. JSON files this size (10–50MB on huge
//   repos) take a noticeable fraction of a second to fsync; we don't want a
//   crashed VS Code to leave a corrupted snapshot.
// =============================================================================

const SCHEMA_VERSION = 3;

export interface CachedFile {
    /** Absolute path on disk. */
    path: string;
    /** Last-modified time (ms since epoch). */
    mtimeMs: number;
    /** File size in bytes. */
    size: number;
    /** Absolute paths of dependencies, exactly as resolved at parse time. */
    deps: string[];
    /** Source language token (matches the live graph's `language` field). */
    language: string;
}

export interface CachedSnapshot {
    schemaVersion: number;
    contextHash: string;
    workspaceRoots: string[];
    files: CachedFile[];
    /** Header index for C/C++. Map serialised as plain object. */
    headerIndex: Record<string, string[]>;
    /** When the snapshot was written. Informational only. */
    savedAt: number;
}

/**
 * Inputs that affect how files get parsed/resolved at the project level. A
 * change to any of these means every cached entry is potentially stale.
 */
export interface CacheContextInputs {
    /** Absolute path to the active compile_commands.json (or null). */
    compileCommandsPath: string | null;
    /** Absolute path to the active tsconfig.json (or null). */
    tsconfigPath: string | null;
    /** A version string from the analyzer (parser semantics). Bump on logic changes. */
    parserVersion: string;
    /** The user-provided ignored directories. Affects which files we visit. */
    ignoredDirs: string[];
    /** Whether `#ifdef` branch stripping is on (config). */
    respectIfdef: boolean;
}

// -----------------------------------------------------------------------------
// Hashing helpers
// -----------------------------------------------------------------------------

/** SHA-1 of a string. We don't need cryptographic strength; speed + brevity matter. */
function sha1(input: string): string {
    return crypto.createHash('sha1').update(input).digest('hex');
}

/** Hash the full contents of a file, or return a sentinel if it doesn't exist. */
function fileContentHash(p: string | null): string {
    if (!p) { return 'none'; }
    try {
        const buf = fs.readFileSync(p);
        return crypto.createHash('sha1').update(buf).digest('hex');
    } catch {
        return 'unreadable';
    }
}

/** Stable hash of the inputs that drive parsing. */
export function computeContextHash(inputs: CacheContextInputs): string {
    const parts: string[] = [
        'parser=' + inputs.parserVersion,
        'cc=' + fileContentHash(inputs.compileCommandsPath),
        'ts=' + fileContentHash(inputs.tsconfigPath),
        'ignored=' + [...inputs.ignoredDirs].sort().join(','),
        'ifdef=' + (inputs.respectIfdef ? '1' : '0'),
    ];
    return sha1(parts.join('|'));
}

/** Stable hash of the workspace root list. */
function fingerprintRoots(roots: string[]): string {
    return sha1([...roots].sort().join('\u0000')).slice(0, 16);
}

// -----------------------------------------------------------------------------
// GraphCache
// -----------------------------------------------------------------------------

export class GraphCache {
    /** Directory where snapshots are stored (created on first save). */
    private readonly cacheDir: string;

    constructor(globalStorageUri: vscode.Uri, private readonly logger: vscode.OutputChannel) {
        this.cacheDir = path.join(globalStorageUri.fsPath, 'graph-cache');
    }

    private snapshotPath(roots: string[]): string {
        return path.join(this.cacheDir, fingerprintRoots(roots) + '.json');
    }

    /**
     * Load the snapshot for the given roots, validating it against expected
     * inputs. Returns null on any miss/mismatch — callers should treat that as
     * "do a full reindex".
     */
    load(roots: string[], expectedContextHash: string): CachedSnapshot | null {
        const file = this.snapshotPath(roots);
        if (!fs.existsSync(file)) { return null; }
        let parsed: CachedSnapshot;
        try {
            const raw = fs.readFileSync(file, 'utf-8');
            parsed = JSON.parse(raw);
        } catch (e) {
            this.logger.appendLine('[graphCache] Failed to read snapshot: ' + (e instanceof Error ? e.message : String(e)));
            return null;
        }
        if (parsed.schemaVersion !== SCHEMA_VERSION) {
            this.logger.appendLine(`[graphCache] Schema mismatch (got ${parsed.schemaVersion}, want ${SCHEMA_VERSION}). Discarding.`);
            return null;
        }
        if (parsed.contextHash !== expectedContextHash) {
            this.logger.appendLine('[graphCache] Context hash changed (compile_commands/tsconfig/parser/etc.). Discarding.');
            return null;
        }
        const expectedRoots = [...roots].sort().join('\u0000');
        const cachedRoots = [...parsed.workspaceRoots].sort().join('\u0000');
        if (expectedRoots !== cachedRoots) {
            this.logger.appendLine('[graphCache] Workspace roots changed. Discarding.');
            return null;
        }
        return parsed;
    }

    /**
     * Atomically write a snapshot to disk. Creates the cache directory if
     * needed. Errors are logged but never thrown.
     */
    save(snapshot: CachedSnapshot): void {
        try {
            fs.mkdirSync(this.cacheDir, { recursive: true });
            const file = this.snapshotPath(snapshot.workspaceRoots);
            const tmp = file + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(snapshot));
            fs.renameSync(tmp, file);
            this.logger.appendLine(`[graphCache] Saved snapshot: ${snapshot.files.length} files → ${file}`);
        } catch (e) {
            this.logger.appendLine('[graphCache] Save failed: ' + (e instanceof Error ? e.message : String(e)));
        }
    }

    /** Delete the snapshot for the given roots. */
    invalidate(roots: string[]): void {
        try {
            const file = this.snapshotPath(roots);
            if (fs.existsSync(file)) { fs.unlinkSync(file); }
            this.logger.appendLine('[graphCache] Invalidated cache for current workspace.');
        } catch (e) {
            this.logger.appendLine('[graphCache] Invalidate failed: ' + (e instanceof Error ? e.message : String(e)));
        }
    }
}

// -----------------------------------------------------------------------------
// Index helpers — turn a CachedSnapshot into fast-lookup structures.
// -----------------------------------------------------------------------------

/**
 * Build a quick `path → CachedFile` lookup. Used during incremental analyze()
 * to ask "do I have this file cached, and is it still fresh?" in O(1).
 */
export function indexCachedFiles(snapshot: CachedSnapshot): Map<string, CachedFile> {
    const m = new Map<string, CachedFile>();
    for (const f of snapshot.files) { m.set(f.path, f); }
    return m;
}

/** Reverse of `indexCachedFiles` — build the on-disk Map<string, string[]> for the snapshot. */
export function headerIndexToObject(headerIndex: Map<string, string[]>): Record<string, string[]> {
    const obj: Record<string, string[]> = {};
    for (const [k, v] of headerIndex) { obj[k] = v; }
    return obj;
}

export function objectToHeaderIndex(obj: Record<string, string[]>): Map<string, string[]> {
    const m = new Map<string, string[]>();
    for (const [k, v] of Object.entries(obj)) { m.set(k, v); }
    return m;
}
