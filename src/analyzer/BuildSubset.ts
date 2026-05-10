import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import {
    detectCompiler,
    buildSyntaxOnlyArgs,
    profileFlagsFor,
    type CompilerInfo,
} from './CompilerDriver';
import type { ProjectProfile } from '../profiles';

// =============================================================================
// BuildSubset — "does it actually compile?" for the impacted slice of a change.
// =============================================================================
//
// The Hive Mind dependency graph already knows which translation units are
// reachable from a changed header (via `getImpact`). This module turns that
// list into a real syntax-check pass:
//
//   1. Take a seed file (the one being changed).
//   2. Walk the reverse-dependency graph to collect all .cpp/.cc/.cxx/.c TUs
//      that transitively include it.
//   3. For each TU, look up its build flags from compile_commands.json *or*
//      derive them from the active project profile (X3 has no compile DB).
//   4. Spawn the compiler with `/Zs` (cl.exe / clang-cl) or `-fsyntax-only`
//      (g++ / clang) so we get parse + semantic errors without codegen or
//      linking.
//   5. Aggregate diagnostics, return a concise pass/fail report.
//
// Why this beats invoking `ninja` directly:
//   • Doesn't require a configured build directory.
//   • Doesn't pollute build artefacts.
//   • Parallelism is trivially controllable (we drive the process pool).
//   • Works on any project that has compile_commands.json OR an active Hive
//     Mind profile (X3 falls in the latter bucket).
// =============================================================================

export interface BuildSubsetRequest {
    /** Absolute path to the seed file. The reverse-dep walk starts here. */
    seedFile: string;
    /** Hard cap on TUs to compile. Default 50. Anything above 200 is unwise. */
    maxTUs?: number;
    /** Reverse-dep graph walk depth. Default 8 (effectively unbounded for any sane graph). */
    depth?: number;
    /** Compiler timeout per TU in ms. Default 60s. */
    perFileTimeoutMs?: number;
    /** Total wallclock budget across all TUs in ms. Default 5 minutes. */
    totalBudgetMs?: number;
    /** Max parallel compiler processes. Default min(8, CPU count). */
    parallelism?: number;
    /** Optional explicit list of TUs to compile instead of walking the graph. */
    explicitTUs?: string[];
}

export interface TUResult {
    file: string;
    ok: boolean;
    durationMs: number;
    /** Trimmed compiler stderr (truncated to ~4KB per TU). */
    diagnostics: string;
    /** Compiler exit code (-1 if it never ran, e.g. timeout). */
    exitCode: number;
    /** True if we used compile_commands.json flags; false = profile/skipped. */
    usedCompileCommands: boolean;
    /** True if we used active project profile flags (compile_commands.json absent). */
    usedProfile?: boolean;
    skipReason?: string;
}

export interface BuildSubsetResult {
    seedFile: string;
    totalTUsConsidered: number;
    tusCompiled: number;
    tusPassed: number;
    tusFailed: number;
    tusSkipped: number;
    /** True if the cap (`maxTUs`) was hit. */
    truncated: boolean;
    durationMs: number;
    results: TUResult[];
    /** Files in the impact set that we couldn't compile-check. */
    skipped: Array<{ file: string; reason: string }>;
}

// -----------------------------------------------------------------------------
// Compile commands index (still used as the high-fidelity path when present)
// -----------------------------------------------------------------------------

interface CompileCommandEntry {
    directory: string;
    file: string;
    arguments?: string[];
    command?: string;
}

interface CompileCommandsIndex {
    byFile: Map<string, CompileCommandEntry>;
    sourcePath: string;
    mtimeMs: number;
}

function normalizeKey(p: string): string {
    return path.resolve(p).toLowerCase().replace(/\\/g, '/');
}

function splitCommand(cmd: string): string[] {
    const args: string[] = [];
    let current = '';
    let inQuote: string | null = null;
    for (const ch of cmd) {
        if (inQuote) {
            if (ch === inQuote) { inQuote = null; }
            else { current += ch; }
        } else if (ch === '"' || ch === "'") {
            inQuote = ch;
        } else if (ch === ' ' || ch === '\t') {
            if (current) { args.push(current); current = ''; }
        } else {
            current += ch;
        }
    }
    if (current) { args.push(current); }
    return args;
}

// -----------------------------------------------------------------------------
// BuildSubset
// -----------------------------------------------------------------------------

export interface ReverseDepProvider {
    /** Return the set of TUs that transitively depend on `seedFile`. */
    getImpact(seedFile: string, depth: number): string[];
    /** Resolve any user input path to an absolute indexed path, or null. */
    resolveFilePath(input: string): string | null | undefined;
}

export class BuildSubset {
    private compilerInfo: CompilerInfo | null = null;
    private compilerSearched = false;
    private cccIndex: CompileCommandsIndex | null = null;
    private profile: ProjectProfile | null = null;

    constructor(
        private readonly workspaceRoot: string,
        private readonly logger: vscode.OutputChannel,
        private readonly deps: ReverseDepProvider
    ) {}

    /** Provide an active project profile so we can syntax-check files that have
     *  no compile_commands.json entry. */
    setProfile(profile: ProjectProfile | null): void {
        this.profile = profile;
    }

    /**
     * Locate a usable C/C++ compiler. Tries cl.exe on Windows, g++ on
     * Linux/Mac, then falls back to clang. Cached after first lookup.
     */
    private locateCompiler(): CompilerInfo | null {
        if (this.compilerSearched) { return this.compilerInfo; }
        this.compilerSearched = true;
        const info = detectCompiler(this.logger);
        if (info) {
            this.logger.appendLine(`[buildSubset] Using ${info.kind} (${info.exe}) — ${info.note}`);
        }
        this.compilerInfo = info;
        return info;
    }

    private loadCompileCommands(): CompileCommandsIndex | null {
        const candidates = ['compile_commands.json',
                            'build/compile_commands.json',
                            'out/compile_commands.json',
                            'cmake-build-debug/compile_commands.json',
                            'cmake-build-release/compile_commands.json'];
        for (const rel of candidates) {
            const full = path.join(this.workspaceRoot, rel);
            if (!fs.existsSync(full)) { continue; }
            const stat = fs.statSync(full);
            if (this.cccIndex && this.cccIndex.sourcePath === full && this.cccIndex.mtimeMs === stat.mtimeMs) {
                return this.cccIndex;
            }
            try {
                const raw = fs.readFileSync(full, 'utf-8');
                const entries: CompileCommandEntry[] = JSON.parse(raw);
                const byFile = new Map<string, CompileCommandEntry>();
                for (const e of entries) {
                    if (!e.file || !e.directory) { continue; }
                    const abs = path.isAbsolute(e.file) ? e.file : path.resolve(e.directory, e.file);
                    byFile.set(normalizeKey(abs), e);
                }
                this.cccIndex = { byFile, sourcePath: full, mtimeMs: stat.mtimeMs };
                return this.cccIndex;
            } catch { /* ignore */ }
        }
        return null;
    }

    /**
     * Convert a compile_commands.json entry into a syntax-only argument list
     * appropriate for the active compiler. Strips output paths, codegen flags,
     * PCH usage, etc.
     */
    private syntaxOnlyFromEntry(entry: CompileCommandEntry, sourceFile: string, info: CompilerInfo): string[] {
        const original = entry.arguments && entry.arguments.length > 0
            ? entry.arguments
            : (entry.command ? splitCommand(entry.command) : []);
        const sourceNorm = normalizeKey(sourceFile);
        const skipPair = new Set(['-o', '-MF', '-MT', '-MQ', '-MD', '-MMD',
                                  '-include-pch', '-Fo', '-Fd', '-Fp', '-MP']);
        const out: string[] = [];
        let started = false;
        for (let i = 0; i < original.length; i++) {
            const a = original[i];
            if (!started) {
                started = true;
                if (/clang(\+\+|-cl)?(\.exe)?$/i.test(a) || /cl\.exe$/i.test(a) ||
                    /gcc(\.exe)?$/i.test(a) || /g\+\+(\.exe)?$/i.test(a) || /cc(\.exe)?$/i.test(a)) {
                    continue;
                }
            }
            if (normalizeKey(a) === sourceNorm) { continue; }
            if (skipPair.has(a)) { i++; continue; }
            if (/^\/F[opd]/i.test(a) || /^-Fo/i.test(a) || /^-Fd/i.test(a)) {
                if (a.length === 3) { i++; }
                continue;
            }
            if (a === '-c' || a === '/c') { continue; }
            if (/^-O[0-3sz]?$/.test(a)) { continue; }
            if (/^\/O/i.test(a)) { continue; }
            if (/^\/Z/i.test(a)) { continue; }
            if (/^\/Y[cu]/i.test(a)) { continue; }
            if (/^\/M[DTLP]/i.test(a)) { continue; }
            if (/^\/EH/i.test(a) || /^\/GR/i.test(a) || /^\/GS/i.test(a)) { continue; }
            if (/^\/[Ww]\d?$/i.test(a)) { continue; }
            if (/^\/showIncludes/i.test(a)) { continue; }
            out.push(a);
        }

        if (info.kind === 'cl') {
            out.unshift('/Zs', '/nologo', '/EHsc');
        } else {
            out.unshift('-fsyntax-only', '-w');
        }
        out.push(sourceFile);
        return out;
    }

    /** Decide which TUs (.cpp/.cc/.cxx/.c) are impacted by a change to `seed`. */
    private collectImpactedTUs(seed: string, depth: number): string[] {
        const impacted = new Set<string>(this.deps.getImpact(seed, depth));
        impacted.add(seed);
        const tuExts = new Set(['.cpp', '.cc', '.cxx', '.c', '.c++']);
        const tus: string[] = [];
        for (const f of impacted) {
            if (tuExts.has(path.extname(f).toLowerCase())) {
                tus.push(f);
            }
        }
        return tus;
    }

    /** Run a single TU compile and return its result. */
    private async compileOne(
        file: string,
        info: CompilerInfo,
        entry: CompileCommandEntry | null,
        timeoutMs: number
    ): Promise<TUResult> {
        const start = Date.now();
        let args: string[];
        let cwd: string;
        let usedCompileCommands: boolean;
        let usedProfile: boolean;

        if (entry) {
            args = this.syntaxOnlyFromEntry(entry, file, info);
            cwd = entry.directory;
            usedCompileCommands = true;
            usedProfile = false;
        } else if (this.profile) {
            const extras = profileFlagsFor(this.profile, this.workspaceRoot);
            args = buildSyntaxOnlyArgs(info, file, extras);
            cwd = this.workspaceRoot;
            usedCompileCommands = false;
            usedProfile = true;
        } else {
            return {
                file, ok: false, durationMs: 0, diagnostics: '',
                exitCode: -1, usedCompileCommands: false,
                skipReason: 'No compile_commands.json entry and no active project profile.',
            };
        }

        return await new Promise<TUResult>((resolve) => {
            let settled = false;
            const proc = cp.spawn(info.exe, args, {
                cwd,
                windowsHide: true,
            });
            let stderr = '';
            let stdout = '';
            const timer = setTimeout(() => {
                if (settled) { return; }
                settled = true;
                try { proc.kill('SIGKILL'); } catch { /* ignore */ }
                resolve({
                    file, ok: false, durationMs: Date.now() - start,
                    diagnostics: '(timed out after ' + timeoutMs + 'ms)',
                    exitCode: -1, usedCompileCommands, usedProfile,
                });
            }, timeoutMs);
            proc.stderr.on('data', d => { stderr += d.toString(); if (stderr.length > 8192) { stderr = stderr.slice(-8192); } });
            proc.stdout.on('data', d => { stdout += d.toString(); if (stdout.length > 4096) { stdout = stdout.slice(-4096); } });
            proc.on('error', err => {
                if (settled) { return; } settled = true; clearTimeout(timer);
                resolve({
                    file, ok: false, durationMs: Date.now() - start,
                    diagnostics: 'spawn error: ' + err.message, exitCode: -1,
                    usedCompileCommands, usedProfile,
                });
            });
            proc.on('close', code => {
                if (settled) { return; } settled = true; clearTimeout(timer);
                // cl.exe writes errors to stdout; gcc/clang to stderr. Combine.
                const diag = trimDiagnostics(stderr || stdout);
                resolve({
                    file, ok: code === 0, durationMs: Date.now() - start,
                    diagnostics: diag, exitCode: code ?? -1,
                    usedCompileCommands, usedProfile,
                });
            });
        });
    }

    /**
     * Compute and run the syntax-check pass for the impact set of `seedFile`.
     */
    async run(req: BuildSubsetRequest): Promise<BuildSubsetResult> {
        const start = Date.now();
        const seedFile = path.resolve(req.seedFile);
        const maxTUs = Math.max(1, Math.min(500, req.maxTUs ?? 50));
        const depth = Math.max(1, Math.min(20, req.depth ?? 8));
        const perFileTimeoutMs = Math.max(1000, req.perFileTimeoutMs ?? 60_000);
        const totalBudgetMs = Math.max(perFileTimeoutMs, req.totalBudgetMs ?? 5 * 60_000);
        const parallelism = Math.max(1, Math.min(16, req.parallelism ?? Math.min(8, require('os').cpus()?.length ?? 4)));

        const compiler = this.locateCompiler();
        if (!compiler) {
            return {
                seedFile, totalTUsConsidered: 0, tusCompiled: 0, tusPassed: 0, tusFailed: 0, tusSkipped: 0,
                truncated: false, durationMs: Date.now() - start, results: [],
                skipped: [{ file: seedFile, reason: 'No C/C++ compiler found. Install MSVC (cl.exe), g++, or clang, or set hivemind.clangPath.' }],
            };
        }

        const ccc = this.loadCompileCommands();
        const hasProfile = !!this.profile;
        if (!ccc && !hasProfile) {
            return {
                seedFile, totalTUsConsidered: 0, tusCompiled: 0, tusPassed: 0, tusFailed: 0, tusSkipped: 0,
                truncated: false, durationMs: Date.now() - start, results: [],
                skipped: [{ file: seedFile, reason: 'No compile_commands.json found and no active Hive Mind project profile.' }],
            };
        }

        // Decide the candidate TU list.
        const candidates = req.explicitTUs && req.explicitTUs.length > 0
            ? req.explicitTUs.map(p => path.resolve(p))
            : this.collectImpactedTUs(seedFile, depth);

        const allTUs = [...new Set(candidates)];
        const skipped: BuildSubsetResult['skipped'] = [];
        const compileTargets: Array<{ file: string; entry: CompileCommandEntry | null }> = [];
        for (const tu of allTUs) {
            const entry = ccc?.byFile.get(normalizeKey(tu)) ?? null;
            if (!entry && !hasProfile) {
                skipped.push({ file: tu, reason: 'No compile_commands.json entry and no profile fallback.' });
                continue;
            }
            compileTargets.push({ file: tu, entry });
        }

        const truncated = compileTargets.length > maxTUs;
        if (truncated) {
            compileTargets.sort((a, b) => {
                if (a.file === seedFile) { return -1; }
                if (b.file === seedFile) { return 1; }
                return 0;
            });
            const dropped = compileTargets.splice(maxTUs);
            for (const d of dropped) {
                skipped.push({ file: d.file, reason: 'Capped by maxTUs (' + maxTUs + ').' });
            }
        }

        // Bounded-parallelism worker pool.
        const results: TUResult[] = [];
        const deadline = start + totalBudgetMs;
        let cursor = 0;
        const workers: Promise<void>[] = [];
        for (let w = 0; w < parallelism; w++) {
            workers.push((async () => {
                while (true) {
                    if (Date.now() > deadline) { return; }
                    const idx = cursor++;
                    if (idx >= compileTargets.length) { return; }
                    const { file, entry } = compileTargets[idx];
                    const r = await this.compileOne(file, compiler, entry, perFileTimeoutMs);
                    results.push(r);
                }
            })());
        }
        await Promise.all(workers);

        for (let i = cursor; i < compileTargets.length; i++) {
            skipped.push({ file: compileTargets[i].file, reason: 'Total time budget exhausted.' });
        }

        const tusPassed = results.filter(r => r.ok).length;
        const tusFailed = results.filter(r => !r.ok).length;
        return {
            seedFile,
            totalTUsConsidered: allTUs.length,
            tusCompiled: results.length,
            tusPassed,
            tusFailed,
            tusSkipped: skipped.length,
            truncated,
            durationMs: Date.now() - start,
            results,
            skipped,
        };
    }
}

function trimDiagnostics(s: string): string {
    if (!s) { return ''; }
    const trimmed = s.trim();
    if (trimmed.length <= 4000) { return trimmed; }
    return trimmed.slice(0, 4000) + '\n…(truncated)';
}
