import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as crypto from 'crypto';

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
//   3. For each TU, look up its build flags from compile_commands.json.
//   4. Spawn the compiler with `-fsyntax-only` (clang/gcc) or `/Zs` (MSVC /
//      clang-cl) so we get parse + semantic errors without codegen or linking.
//   5. Aggregate diagnostics, return a concise pass/fail report.
//
// Why syntax-only:
//   • 5–20× faster than a real compile (no codegen, no LTO, no linking).
//   • Doesn't need build artefacts (no .obj path collisions, no PDB locking).
//   • Catches the failures that matter most for refactors: missing decls,
//     wrong types, broken includes, ambiguous overloads.
//   • Doesn't catch link errors or template instantiations that aren't used
//     locally — but `hivemind_callHierarchy` already covers most of that.
//
// Why this beats invoking `ninja` directly:
//   • Doesn't require a configured build directory.
//   • Doesn't pollute build artefacts.
//   • Parallelism is trivially controllable (we drive the process pool).
//   • Works on any project that has a compile_commands.json — even if
//     the user normally builds via msbuild/CMake/etc.
//
// Caveats:
//   • Files NOT in compile_commands.json get skipped (we report them).
//   • PCH-dependent headers may produce spurious errors (we strip /Yu).
//   • For very wide impact fans (one core header → 5000 TUs) the tool caps
//     the TU count and tells the agent so.
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
    /** True if we used compile_commands.json flags; false = skipped/no-flags. */
    usedCompileCommands: boolean;
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
    /** Files in the impact set that we couldn't compile-check (no compile_commands entry, etc.). */
    skipped: Array<{ file: string; reason: string }>;
}

// -----------------------------------------------------------------------------
// Compile commands index (shared shape with MacroExpander; we keep our own copy
// to avoid coupling the two modules).
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
    private clangPath: string | null = null;
    private clangClPath: string | null = null;
    private clangSearched = false;
    private cccIndex: CompileCommandsIndex | null = null;

    constructor(
        private readonly workspaceRoot: string,
        private readonly logger: vscode.OutputChannel,
        private readonly deps: ReverseDepProvider
    ) {}

    /**
     * Locate clang and clang-cl. We want both because compile_commands.json
     * entries are usually of one flavour or the other, and mixing the wrong
     * driver with the wrong flags fails immediately.
     */
    private locateCompilers(): { clang: string | null; clangCl: string | null } {
        if (this.clangSearched) {
            return { clang: this.clangPath, clangCl: this.clangClPath };
        }
        this.clangSearched = true;

        const cfg = vscode.workspace.getConfiguration('hivemind');
        const cfgUpper = vscode.workspace.getConfiguration('hiveMind');
        const configuredClang = cfg.get<string>('clangPath') || cfgUpper.get<string>('clangPath');

        const isFile = (p: string) => {
            try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; }
        };

        // For clang: same logic as MacroExpander. We look at the configured path,
        // vscode-clangd's install tree, PATH, and known fixed install dirs.
        if (configuredClang && isFile(configuredClang)) {
            this.clangPath = configuredClang;
        } else {
            this.clangPath = this.findCompilerInTree('clang');
        }

        // For clang-cl: try the same install tree (it's usually next to clang).
        this.clangClPath = this.findCompilerInTree('clang-cl');

        if (this.clangPath) { this.logger.appendLine(`[buildSubset] Found clang: ${this.clangPath}`); }
        if (this.clangClPath) { this.logger.appendLine(`[buildSubset] Found clang-cl: ${this.clangClPath}`); }

        return { clang: this.clangPath, clangCl: this.clangClPath };
    }

    private findCompilerInTree(toolName: string): string | null {
        const exe = process.platform === 'win32' ? `${toolName}.exe` : toolName;
        const isFile = (p: string) => {
            try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; }
        };

        const candidates: string[] = [];

        // 1. vscode-clangd globalStorage install tree
        const globalStorage = this.guessGlobalStorage('llvm-vs-code-extensions.vscode-clangd');
        if (globalStorage) {
            try {
                const installDir = path.join(globalStorage, 'install');
                if (fs.existsSync(installDir)) {
                    for (const v of fs.readdirSync(installDir, { withFileTypes: true })) {
                        if (!v.isDirectory()) { continue; }
                        const direct = path.join(installDir, v.name, 'bin', exe);
                        candidates.push(direct);
                        // Also nested (clangd_<version>/bin/exe layout)
                        try {
                            for (const n of fs.readdirSync(path.join(installDir, v.name), { withFileTypes: true })) {
                                if (n.isDirectory()) {
                                    candidates.push(path.join(installDir, v.name, n.name, 'bin', exe));
                                }
                            }
                        } catch { /* ignore */ }
                    }
                }
            } catch { /* ignore */ }
        }

        // 2. PATH
        const pathSep = process.platform === 'win32' ? ';' : ':';
        for (const dir of (process.env.PATH ?? '').split(pathSep)) {
            if (!dir) { continue; }
            candidates.push(path.join(dir.replace(/^"|"$/g, ''), exe));
        }

        // 3. Common LLVM install paths
        if (process.platform === 'win32') {
            candidates.push(`C:\\Program Files\\LLVM\\bin\\${exe}`);
            candidates.push(`C:\\Program Files (x86)\\LLVM\\bin\\${exe}`);
            if (process.env.LOCALAPPDATA) {
                candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'LLVM', 'bin', exe));
            }
        } else if (process.platform === 'darwin') {
            candidates.push('/usr/local/opt/llvm/bin/' + exe);
            candidates.push('/opt/homebrew/opt/llvm/bin/' + exe);
        } else {
            candidates.push('/usr/bin/' + exe);
            candidates.push('/usr/local/bin/' + exe);
        }

        for (const c of candidates) {
            if (isFile(c)) { return c; }
        }
        return null;
    }

    private guessGlobalStorage(extensionId: string): string | null {
        const candidates: string[] = [];
        if (process.platform === 'win32') {
            const appData = process.env.APPDATA;
            if (appData) {
                candidates.push(path.join(appData, 'Code', 'User', 'globalStorage', extensionId));
                candidates.push(path.join(appData, 'Code - Insiders', 'User', 'globalStorage', extensionId));
            }
        } else if (process.platform === 'darwin') {
            const home = process.env.HOME;
            if (home) {
                candidates.push(path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', extensionId));
            }
        } else {
            const home = process.env.HOME;
            if (home) { candidates.push(path.join(home, '.config', 'Code', 'User', 'globalStorage', extensionId)); }
        }
        for (const c of candidates) { if (fs.existsSync(c)) { return c; } }
        return null;
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
     * Strip the original args down to something safe for `-fsyntax-only` /
     * `/Zs`. We keep:  -I/-isystem, -D, -U, -std=, -W*, -f*, -m*, --target,
     * --sysroot, -include, -include-pch (best-effort).
     * We drop:  the compiler path, output paths, the source file (we re-add
     * it), `-c`, codegen flags, /MD /MT /Z* /Fo /Fd /Fp etc.
     */
    private buildSyntaxOnlyArgs(entry: CompileCommandEntry, sourceFile: string, isClangCl: boolean): string[] {
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
                // Drop the leading compiler binary
                if (/clang(\+\+|-cl)?(\.exe)?$/i.test(a) || /cl\.exe$/i.test(a) ||
                    /gcc(\.exe)?$/i.test(a) || /g\+\+(\.exe)?$/i.test(a) || /cc(\.exe)?$/i.test(a)) {
                    continue;
                }
            }
            if (normalizeKey(a) === sourceNorm) { continue; }
            if (skipPair.has(a)) { i++; continue; }
            // MSVC-style /Fo, /Fd, /Fp with attached value
            if (/^\/F[opd]/i.test(a) || /^-Fo/i.test(a) || /^-Fd/i.test(a)) {
                if (a.length === 3) { i++; }
                continue;
            }
            if (a === '-c' || a === '/c') { continue; }
            if (/^-O[0-3sz]?$/.test(a)) { continue; }
            if (/^\/O/i.test(a)) { continue; }
            if (/^\/Z/i.test(a)) { continue; }              // /Zi /Z7 /ZI etc.
            if (/^\/Y[cu]/i.test(a)) { continue; }          // /Yc /Yu — PCH
            if (/^\/M[DTLP]/i.test(a)) { continue; }        // /MD /MT /MP
            if (/^\/EH/i.test(a) || /^\/GR/i.test(a) || /^\/GS/i.test(a)) { continue; }
            if (/^\/[Ww]\d?$/i.test(a)) { continue; }       // /W3 /Wall — keep diagnostics manageable
            // Drop /showIncludes, /diagnostics:column etc. (noise)
            if (/^\/showIncludes/i.test(a)) { continue; }
            out.push(a);
        }

        // Append our syntax-only switch + source file.
        if (isClangCl) {
            out.push('/Zs');         // syntax-only for clang-cl / MSVC
            out.push(sourceFile);
        } else {
            out.push('-fsyntax-only');
            out.push('-w');          // suppress warnings, only show errors
            out.push(sourceFile);
        }
        return out;
    }

    /** Detect whether the entry was originally driven by clang-cl/MSVC. */
    private isClangClStyle(entry: CompileCommandEntry): boolean {
        const args = entry.arguments && entry.arguments.length > 0
            ? entry.arguments
            : (entry.command ? splitCommand(entry.command) : []);
        if (args.length === 0) { return false; }
        const head = args[0].toLowerCase();
        if (head.endsWith('clang-cl.exe') || head.endsWith('clang-cl') || head.endsWith('cl.exe')) { return true; }
        // Heuristic: any /Fo /MD /Yc etc.
        return args.some(a => /^\/(Fo|Fd|Fp|MD|MT|Z[i7I]|Y[cu]|EH|W\d|GS|GR|O[12dxs])/i.test(a));
    }

    /** Decide which TUs (.cpp/.cc/.cxx/.c) are impacted by a change to `seed`. */
    private collectImpactedTUs(seed: string, depth: number): string[] {
        const impacted = new Set<string>(this.deps.getImpact(seed, depth));
        // The seed itself is impacted if it's a TU.
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
        file: string, entry: CompileCommandEntry,
        clang: string | null, clangCl: string | null,
        timeoutMs: number
    ): Promise<TUResult> {
        const start = Date.now();
        const isClangCl = this.isClangClStyle(entry);
        const compiler = isClangCl ? (clangCl ?? clang) : (clang ?? clangCl);
        if (!compiler) {
            return {
                file, ok: false, durationMs: 0, diagnostics: '',
                exitCode: -1, usedCompileCommands: true,
                skipReason: 'No suitable compiler found (need clang or clang-cl).',
            };
        }
        const args = this.buildSyntaxOnlyArgs(entry, file, isClangCl && compiler === clangCl);
        return await new Promise<TUResult>((resolve) => {
            let settled = false;
            const proc = cp.spawn(compiler, args, {
                cwd: entry.directory,
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
                    exitCode: -1, usedCompileCommands: true,
                });
            }, timeoutMs);
            proc.stderr.on('data', d => { stderr += d.toString(); if (stderr.length > 8192) { stderr = stderr.slice(-8192); } });
            proc.stdout.on('data', d => { stdout += d.toString(); if (stdout.length > 4096) { stdout = stdout.slice(-4096); } });
            proc.on('error', err => {
                if (settled) { return; } settled = true; clearTimeout(timer);
                resolve({
                    file, ok: false, durationMs: Date.now() - start,
                    diagnostics: 'spawn error: ' + err.message, exitCode: -1, usedCompileCommands: true,
                });
            });
            proc.on('close', code => {
                if (settled) { return; } settled = true; clearTimeout(timer);
                // clang-cl writes errors to stdout with /Zs; normal clang to stderr. Combine.
                const diag = trimDiagnostics(stderr || stdout);
                resolve({
                    file, ok: code === 0, durationMs: Date.now() - start,
                    diagnostics: diag, exitCode: code ?? -1, usedCompileCommands: true,
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

        const ccc = this.loadCompileCommands();
        if (!ccc) {
            return {
                seedFile, totalTUsConsidered: 0, tusCompiled: 0, tusPassed: 0, tusFailed: 0, tusSkipped: 0,
                truncated: false, durationMs: Date.now() - start, results: [],
                skipped: [{ file: seedFile, reason: 'No compile_commands.json found in workspace.' }],
            };
        }

        const { clang, clangCl } = this.locateCompilers();
        if (!clang && !clangCl) {
            return {
                seedFile, totalTUsConsidered: 0, tusCompiled: 0, tusPassed: 0, tusFailed: 0, tusSkipped: 0,
                truncated: false, durationMs: Date.now() - start, results: [],
                skipped: [{ file: seedFile, reason: 'No clang/clang-cl found. Install LLVM or set hivemind.clangPath.' }],
            };
        }

        // Decide the candidate TU list.
        const candidates = req.explicitTUs && req.explicitTUs.length > 0
            ? req.explicitTUs.map(p => path.resolve(p))
            : this.collectImpactedTUs(seedFile, depth);

        const allTUs = [...new Set(candidates)];
        const skipped: BuildSubsetResult['skipped'] = [];
        const compileTargets: Array<{ file: string; entry: CompileCommandEntry }> = [];
        for (const tu of allTUs) {
            const entry = ccc.byFile.get(normalizeKey(tu));
            if (!entry) {
                skipped.push({ file: tu, reason: 'No compile_commands.json entry.' });
                continue;
            }
            compileTargets.push({ file: tu, entry });
        }

        const truncated = compileTargets.length > maxTUs;
        if (truncated) {
            // Prefer keeping the seed file at the front
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
                    const r = await this.compileOne(file, entry, clang, clangCl, perFileTimeoutMs);
                    results.push(r);
                }
            })());
        }
        await Promise.all(workers);

        // Anything we didn't get to (budget exceeded) → skipped
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
