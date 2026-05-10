import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as crypto from 'crypto';
import {
    detectCompiler,
    buildPreprocessArgs,
    profileFlagsFor,
    type CompilerInfo,
} from './CompilerDriver';
import type { ProjectProfile } from '../profiles';

// =============================================================================
// MacroExpander — runs `clang -E` to compute real preprocessor expansions
// =============================================================================
//
// Why this exists:
//   `hivemind_findMacro` shows the #define text. That doesn't tell the AI what
//   `FCIMPL3(MyMethod, x, y, z)` *actually* becomes at a specific call site,
//   because expansion depends on:
//     • What other macros are #defined in this TU (via -D flags)
//     • Which #ifdef branch is active (also driven by -D)
//     • Whether nested macros expand recursively
//
//   Only the preprocessor itself can answer this. We invoke `clang -E` with the
//   exact flags from compile_commands.json for the target TU.
//
// Implementation notes:
//   • clang outputs `# <line> "<file>" <flags>` line markers. We use these to
//     identify which preprocessor-output lines came from the original
//     (file, line) the user asked about.
//   • Result is cached by (file, mtime, flags-hash) — re-running clang is
//     expensive for large TUs (1–10 seconds is normal).
//   • If `clang` is missing or compile_commands.json doesn't list the file, we
//     fall back to a best-effort run with just the discovered -I paths.
//   • Uses `clang-cl` driver if invoked with MSVC-style flags (clang auto-
//     detects when arg[0] starts with `/` or `-` ambiguity arises). For most
//     real compile_commands.json entries we just pass the original args.
// =============================================================================

export interface ExpansionRequest {
    file: string;             // absolute path to the source file
    line: number;             // 1-indexed line in the original file
    contextLines?: number;    // include ±N lines around `line`. Default 0.
    timeoutMs?: number;       // default 30s
}

export interface ExpansionResult {
    ok: true;
    file: string;
    line: number;
    /** Preprocessor output corresponding to the requested line (and context). */
    expansion: string;
    /** Raw original source line(s) for reference. */
    originalSource: string;
    /** True if compile_commands.json listed this file; false = heuristic flags only. */
    usedCompileCommands: boolean;
    /** Truncated diagnostics from clang stderr (warnings, etc.). */
    diagnostics: string | null;
    /** Wall-clock time spent in clang. */
    durationMs: number;
}

export interface ExpansionFailure {
    ok: false;
    reason: string;
    detail?: string;
    /** Filled when clang ran but failed; contains exit code and stderr tail. */
    clangExitCode?: number;
    clangStderr?: string;
}

// -----------------------------------------------------------------------------
// CompileCommands loader
// -----------------------------------------------------------------------------

interface CompileCommandEntry {
    directory: string;
    file: string;
    arguments?: string[];
    command?: string;
}

interface CompileCommandsIndex {
    /** Lowercase normalized absolute path → entry */
    byFile: Map<string, CompileCommandEntry>;
    sourcePath: string;
    mtimeMs: number;
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

function normalizeKey(p: string): string {
    return path.resolve(p).toLowerCase().replace(/\\/g, '/');
}

// -----------------------------------------------------------------------------
// MacroExpander
// -----------------------------------------------------------------------------

export class MacroExpander {
    private compilerInfo: CompilerInfo | null = null;
    private compilerSearched = false;
    private cccIndex: CompileCommandsIndex | null = null;
    private cache = new Map<string, ExpansionResult>();
    private profile: ProjectProfile | null = null;

    constructor(
        private readonly workspaceRoot: string,
        private readonly logger: vscode.OutputChannel,
        private readonly fallbackIncludePaths: () => string[]
    ) {}

    /** Provide an active project profile so we can use its -D/-I set when
     *  compile_commands.json is missing (the typical X3 case). */
    setProfile(profile: ProjectProfile | null): void {
        this.profile = profile;
    }

    /**
     * Locate a usable C/C++ compiler. Tries cl.exe on Windows, g++ on Linux/Mac,
     * then falls back to clang. Cached after first successful lookup.
     *
     * Kept under the legacy name `locateClang()` for callers that don't care
     * about the kind. Returns the path or null.
     */
    locateClang(): string | null {
        const info = this.locateCompiler();
        return info?.exe ?? null;
    }

    locateCompiler(): CompilerInfo | null {
        if (this.compilerSearched) { return this.compilerInfo; }
        this.compilerSearched = true;
        const info = detectCompiler(this.logger);
        if (info) {
            this.logger.appendLine(`[macroExpand] Using ${info.kind} (${info.exe}) — ${info.note}`);
        }
        this.compilerInfo = info;
        return info;
    }

    /** Lazy load of compile_commands.json. Returns null if not found / malformed. */
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
                this.logger.appendLine(`[macroExpand] Loaded ${byFile.size} entries from ${rel}`);
                return this.cccIndex;
            } catch (e) {
                this.logger.appendLine(`[macroExpand] Failed to parse ${rel}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        return null;
    }

    /**
     * Build the compiler argument list for a given file. Three priorities:
     *   1. compile_commands.json entry (most precise; reuse project's exact flags)
     *   2. Active project profile (e.g. X3) — defines + include roots
     *   3. fallbackIncludePaths heuristic (backward-compat last resort)
     */
    private buildArgsFor(file: string, info: CompilerInfo): { args: string[]; usedCompileCommands: boolean; usedProfile: boolean } | null {
        const ccc = this.loadCompileCommands();
        const entry = ccc?.byFile.get(normalizeKey(file));
        if (entry) {
            const original = entry.arguments && entry.arguments.length > 0
                ? entry.arguments
                : (entry.command ? splitCommand(entry.command) : []);
            const cleaned = this.sanitizeArgs(original, file);
            // Preserve the legacy clang invocation when the entry came from a real
            // compile DB. cl.exe-mode reuse is risky because flag formats differ.
            const args = info.kind === 'cl'
                ? ['/E', '/P', '/nologo', '/EHsc', ...cleaned, file]
                : ['-E', '-w', ...cleaned, file];
            return { args, usedCompileCommands: true, usedProfile: false };
        }

        // Profile-driven path (the X3 runtime has no compile_commands.json).
        if (this.profile) {
            const extras = profileFlagsFor(this.profile, this.workspaceRoot);
            const args = buildPreprocessArgs(info, file, extras);
            return { args, usedCompileCommands: false, usedProfile: true };
        }

        // Heuristic last resort.
        const extras = {
            defines: {} as Record<string, string>,
            includeRoots: this.fallbackIncludePaths(),
            workspaceRoot: '',  // include paths from fallbackIncludePaths are already absolute
        };
        const args = buildPreprocessArgs(info, file, extras);
        return { args, usedCompileCommands: false, usedProfile: false };
    }

    /**
     * Strip args that don't apply to a preprocessor-only run from a different working directory:
     *   - The compiler path itself (first arg, if it ends in cl.exe / clang / gcc / etc.)
     *   - Output flags (-o X, -MF X, -MT X, -MQ X, -Fo, /Fo, /Fd, /Fp, /MP, etc.)
     *   - The source file path (last positional)
     *   - PCH-related flags (we won't replicate the PCH state)
     *   - Code-generation flags that don't affect preprocessing (-c, /c, /Z*, /O*, /GS, /GR, /EH*, etc.)
     */
    private sanitizeArgs(args: string[], sourceFile: string): string[] {
        const out: string[] = [];
        const sourceNorm = normalizeKey(sourceFile);
        const skipNext = new Set(['-o', '-MF', '-MT', '-MQ', '-MD', '-MMD', '-include-pch', '-Fo', '-Fd', '-Fp']);
        // Drop first arg (compiler path)
        let started = false;
        for (let i = 0; i < args.length; i++) {
            const a = args[i];
            if (!started) {
                started = true;
                // Skip the compiler binary itself
                if (/clang(\+\+)?(\.exe)?$/i.test(a) || /cl\.exe$/i.test(a) || /gcc(\.exe)?$/i.test(a) || /g\+\+(\.exe)?$/i.test(a) || /cc(\.exe)?$/i.test(a)) {
                    continue;
                }
            }
            // Source file (positional, matches the entry's file)
            if (normalizeKey(a) === sourceNorm) { continue; }
            // Skip flag + value pairs
            if (skipNext.has(a)) { i++; continue; }
            // MSVC-style /Fo X, /Fd X
            if (/^\/F[op]/i.test(a) || /^-Fo/i.test(a) || /^-Fd/i.test(a)) {
                if (a.length === 3) { i++; }  // value in next arg
                continue;
            }
            // Drop output / build-only flags
            if (a === '-c' || a === '/c') { continue; }
            // Drop optimization + codegen — they don't affect preprocessor output but can slow things or fail
            if (/^-O[0-3sz]?$/.test(a)) { continue; }
            if (/^\/O/i.test(a)) { continue; }
            // Drop /Z* debug-info flags (MSVC)
            if (/^\/Z/i.test(a)) { continue; }
            // PCH flags (MSVC /Yc /Yu /Fp)
            if (/^\/Y[cu]/i.test(a)) { continue; }
            // Drop /MD /MT etc. — they're CRT linkage, irrelevant for preprocessor
            if (/^\/M[DTLP]/i.test(a)) { continue; }
            // Drop /EH* /GR /GS — codegen
            if (/^\/EH/i.test(a) || /^\/GR/i.test(a) || /^\/GS/i.test(a)) { continue; }
            out.push(a);
        }
        return out;
    }

    /** Hash of the args list to use as a cache key alongside file mtime. */
    private hashArgs(args: string[]): string {
        return crypto.createHash('sha1').update(args.join('\u0000')).digest('hex').slice(0, 12);
    }

    /**
     * Run the preprocessor and extract output corresponding to (file, line ± context).
     */
    async expandLine(req: ExpansionRequest): Promise<ExpansionResult | ExpansionFailure> {
        const file = path.resolve(req.file);
        if (!fs.existsSync(file)) {
            return { ok: false, reason: `File does not exist: ${file}` };
        }
        const ext = path.extname(file).toLowerCase();
        const isHeader = ['.h', '.hh', '.hpp', '.hxx', '.h++', '.cuh'].includes(ext);
        if (isHeader) {
            return {
                ok: false,
                reason: 'Cannot expand macros in a header file directly.',
                detail:
                    `Headers don't have their own translation unit. To see how a macro expands when this header is included, ` +
                    `call \`hivemind_macroExpand\` on a .cpp/.cc/.cxx that #includes this header.`,
            };
        }

        const compiler = this.locateCompiler();
        if (!compiler) {
            return {
                ok: false,
                reason: 'No C/C++ compiler found.',
                detail:
                    'Hive Mind looks for `cl.exe` (Windows), `g++` (Linux/Mac), and `clang` as a fallback. ' +
                    'Install one, or set `hivemind.clangPath` to a specific compiler executable. ' +
                    'On Windows, run a "Developer Command Prompt for VS 2022" so cl.exe is on PATH.',
            };
        }

        const built = this.buildArgsFor(file, compiler);
        if (!built) {
            return { ok: false, reason: 'Could not build compiler arguments for this file.' };
        }

        const stat = fs.statSync(file);
        const cacheKey = `${normalizeKey(file)}:${stat.mtimeMs}:${this.hashArgs(built.args)}`;
        const usedCompileCommands = built.usedCompileCommands;
        const timeoutMs = req.timeoutMs ?? 30_000;
        const contextLines = Math.max(0, req.contextLines ?? 0);

        let preprocessed: string;
        let diagnostics: string | null = null;
        let durationMs: number;

        // Cache hit: full preprocessor output is what we store. Per-line slicing is cheap.
        const cachedFull = this.fullCache.get(cacheKey);
        const cachedMeta = this.cache.get(cacheKey);
        if (cachedFull !== undefined && cachedMeta) {
            preprocessed = cachedFull;
            diagnostics = cachedMeta.diagnostics;
            durationMs = cachedMeta.durationMs;
        } else {
            const start = Date.now();
            const cwd = (this.loadCompileCommands()?.byFile.get(normalizeKey(file))?.directory) ?? this.workspaceRoot;
            try {
                const result = cp.spawnSync(compiler.exe, built.args, {
                    cwd,
                    encoding: 'utf-8',
                    timeout: timeoutMs,
                    maxBuffer: 64 * 1024 * 1024,  // 64MB
                });
                durationMs = Date.now() - start;
                if (result.error) {
                    return {
                        ok: false,
                        reason: `Failed to invoke ${compiler.kind}: ${result.error.message}`,
                    };
                }
                if (result.status !== 0) {
                    const stderr = (result.stderr || '').toString().split(/\r?\n/).slice(-25).join('\n');
                    return {
                        ok: false,
                        reason: `${compiler.kind} exited with code ${result.status}.`,
                        detail: usedCompileCommands
                            ? 'The compile_commands.json entry may use flags this compiler doesn\'t accept. ' +
                              'You can edit the entry, set `hivemind.clangPath` to a different compiler, or expand a different TU.'
                            : built.usedProfile
                                ? 'Compiled with X3 profile flags. If the failure is about missing system headers, the profile\'s include set may need updating.'
                                : 'No compile_commands.json entry was found for this file. Activate a project profile or provide compile_commands.json for accurate results.',
                        clangExitCode: result.status ?? undefined,
                        clangStderr: stderr,
                    };
                }
                preprocessed = result.stdout;
                diagnostics = (result.stderr || '').trim() || null;
                if (diagnostics && diagnostics.length > 4000) {
                    diagnostics = diagnostics.slice(0, 4000) + '\n…(truncated)';
                }
            } catch (e) {
                return {
                    ok: false,
                    reason: `Exception running ${compiler.kind}: ${e instanceof Error ? e.message : String(e)}`,
                };
            }
        }

        // Extract the preprocessor lines that came from (file, line ± context)
        const sliceLines = this.extractRangeFromPreprocessed(preprocessed, file, req.line, contextLines);
        const originalSource = this.readSourceContext(file, req.line, contextLines);

        // Cache: store full output AND a slim ExpansionResult
        this.fullCache.set(cacheKey, preprocessed);
        if (this.fullCache.size > 50) {
            const firstKey = this.fullCache.keys().next().value;
            if (firstKey) { this.fullCache.delete(firstKey); }
        }

        const expansion = sliceLines.length > 0
            ? sliceLines.join('\n')
            : '';

        const finalResult: ExpansionResult = {
            ok: true,
            file,
            line: req.line,
            expansion,
            originalSource,
            usedCompileCommands,
            diagnostics,
            durationMs,
        };
        this.cache.set(cacheKey, finalResult);
        if (this.cache.size > 100) {
            const firstKey = this.cache.keys().next().value;
            if (firstKey) { this.cache.delete(firstKey); }
        }
        return finalResult;
    }

    private fullCache = new Map<string, string>();

    /**
     * Walk the preprocessor output for `# <line> "<file>" [flags]` markers and
     * gather the lines that originated from the requested (file, line ± context).
     *
     * clang emits markers in the GNU format: `# 123 "/abs/path/foo.cpp" 1`
     * The flag digit semantics (1 = entered file, 2 = returned, 3 = system, 4 = extern C)
     * don't affect us — we just track the current source file and current source line.
     */
    private extractRangeFromPreprocessed(
        preprocessed: string,
        targetFile: string,
        targetLine: number,
        contextLines: number
    ): string[] {
        const targetNorm = normalizeKey(targetFile);
        const lines = preprocessed.split(/\r?\n/);
        const markerRe = /^#\s+(\d+)\s+"((?:[^"\\]|\\.)+)"/;
        const out: string[] = [];

        let curFile: string | null = null;
        let curLine = 0;
        const wantMin = targetLine - contextLines;
        const wantMax = targetLine + contextLines;

        for (const ln of lines) {
            const m = markerRe.exec(ln);
            if (m) {
                curLine = parseInt(m[1], 10);
                curFile = normalizeKey(m[2].replace(/\\\\/g, '\\').replace(/\\"/g, '"'));
                continue;
            }
            if (curFile === targetNorm && curLine >= wantMin && curLine <= wantMax) {
                out.push(ln);
            }
            curLine++;
        }
        return out;
    }

    private readSourceContext(file: string, line: number, contextLines: number): string {
        try {
            const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/);
            const start = Math.max(0, line - 1 - contextLines);
            const end = Math.min(lines.length, line + contextLines);
            return lines.slice(start, end).join('\n');
        } catch {
            return '';
        }
    }
}
