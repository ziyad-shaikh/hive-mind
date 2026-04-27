import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as crypto from 'crypto';

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
    private clangPath: string | null = null;
    private clangSearched = false;
    private cccIndex: CompileCommandsIndex | null = null;
    private cache = new Map<string, ExpansionResult>();

    constructor(
        private readonly workspaceRoot: string,
        private readonly logger: vscode.OutputChannel,
        private readonly fallbackIncludePaths: () => string[]
    ) {}

    /** Locate a clang binary (separate from clangd, but often in the same install). */
    locateClang(): string | null {
        if (this.clangSearched) { return this.clangPath; }
        this.clangSearched = true;

        const exeName = process.platform === 'win32' ? 'clang.exe' : 'clang';
        const tried: string[] = [];
        const isFile = (p: string) => {
            try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; }
        };

        // 1. User override
        const cfg = vscode.workspace.getConfiguration('hivemind');
        const cfgUpper = vscode.workspace.getConfiguration('hiveMind');
        const configured = cfg.get<string>('clangPath') || cfgUpper.get<string>('clangPath');
        if (configured) {
            tried.push(configured);
            if (isFile(configured)) { this.clangPath = configured; return configured; }
        }

        // 2. Look next to the auto-detected clangd (vscode-clangd's globalStorage install)
        const ext = vscode.extensions.getExtension('llvm-vs-code-extensions.vscode-clangd');
        if (ext) {
            const globalStorage = this.guessGlobalStorage('llvm-vs-code-extensions.vscode-clangd');
            for (const root of [globalStorage, ext.extensionPath]) {
                const c = this.findInClangInstallTree(root);
                if (c) { tried.push(c); if (isFile(c)) { this.clangPath = c; return c; } }
            }
        }

        // 3. PATH
        const pathSep = process.platform === 'win32' ? ';' : ':';
        const pathDirs = (process.env.PATH ?? '').split(pathSep);
        const exeNames = process.platform === 'win32'
            ? [exeName]
            : ['clang', 'clang-19', 'clang-18', 'clang-17', 'clang-16'];
        for (const dir of pathDirs) {
            if (!dir) { continue; }
            for (const name of exeNames) {
                const candidate = path.join(dir.replace(/^"|"$/g, ''), name);
                tried.push(candidate);
                if (isFile(candidate)) { this.clangPath = candidate; return candidate; }
            }
        }

        // 4. Common install locations
        const fixed: string[] = [];
        if (process.platform === 'win32') {
            fixed.push(
                'C:\\Program Files\\LLVM\\bin\\clang.exe',
                'C:\\Program Files (x86)\\LLVM\\bin\\clang.exe',
                path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'LLVM', 'bin', 'clang.exe'),
            );
        } else if (process.platform === 'darwin') {
            fixed.push(
                '/usr/local/opt/llvm/bin/clang',
                '/opt/homebrew/opt/llvm/bin/clang',
                '/usr/local/bin/clang',
            );
        } else {
            fixed.push('/usr/bin/clang', '/usr/local/bin/clang');
        }
        for (const c of fixed) {
            tried.push(c);
            if (isFile(c)) { this.clangPath = c; return c; }
        }

        this.logger.appendLine('[macroExpand] clang executable not found. Search trail:');
        for (const t of tried) { this.logger.appendLine(`[macroExpand]   • ${t}`); }
        return null;
    }

    private findInClangInstallTree(rootDir: string | null): string | null {
        const exeName = process.platform === 'win32' ? 'clang.exe' : 'clang';
        if (!rootDir) { return null; }
        try {
            const installDir = path.join(rootDir, 'install');
            if (!fs.existsSync(installDir)) { return null; }
            const versions = fs.readdirSync(installDir, { withFileTypes: true });
            for (const v of versions) {
                if (!v.isDirectory()) { continue; }
                const versionDir = path.join(installDir, v.name);
                const direct = path.join(versionDir, 'bin', exeName);
                if (fs.existsSync(direct)) { return direct; }
                const nested = fs.readdirSync(versionDir, { withFileTypes: true });
                for (const n of nested) {
                    if (!n.isDirectory()) { continue; }
                    const candidate = path.join(versionDir, n.name, 'bin', exeName);
                    if (fs.existsSync(candidate)) { return candidate; }
                }
            }
        } catch { /* ignore */ }
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
            if (home) {
                candidates.push(path.join(home, '.config', 'Code', 'User', 'globalStorage', extensionId));
            }
        }
        for (const c of candidates) {
            if (fs.existsSync(c)) { return c; }
        }
        return null;
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
     * Build the clang argument list for a given file.
     * Returns null if no commands are available AND fallback fails to produce useful args.
     */
    private buildArgsFor(file: string): { args: string[]; usedCompileCommands: boolean } | null {
        const ccc = this.loadCompileCommands();
        const entry = ccc?.byFile.get(normalizeKey(file));
        if (entry) {
            // Reuse the project's exact flags. Strip -o/-c/output/source path; we'll add preprocessor flags.
            const original = entry.arguments && entry.arguments.length > 0
                ? entry.arguments
                : (entry.command ? splitCommand(entry.command) : []);
            const cleaned = this.sanitizeArgs(original, file);
            // Preprocess only, suppress warnings, keep `# <line> "<file>"` markers (we need them).
            const args = ['-E', '-w', ...cleaned, file];
            return { args, usedCompileCommands: true };
        }

        // Fallback: no compile_commands entry. Use discovered -I paths only.
        const args: string[] = ['-E', '-w'];
        for (const inc of this.fallbackIncludePaths()) {
            args.push('-I', inc);
        }
        // Best-guess language standard for headers/cpp
        const ext = path.extname(file).toLowerCase();
        if (['.cpp', '.cxx', '.cc', '.c++', '.hpp', '.hxx', '.h++'].includes(ext)) {
            args.push('-x', 'c++', '-std=c++17');
        } else if (['.c', '.h'].includes(ext)) {
            args.push('-x', 'c', '-std=c11');
        }
        args.push(file);
        return { args, usedCompileCommands: false };
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

        const clang = this.locateClang();
        if (!clang) {
            return {
                ok: false,
                reason: 'clang executable not found.',
                detail:
                    'Install LLVM or set `hivemind.clangPath` to the absolute path of clang.exe. ' +
                    'The clangd extension does not always bundle clang itself.',
            };
        }

        const built = this.buildArgsFor(file);
        if (!built) {
            return { ok: false, reason: 'Could not build clang arguments for this file.' };
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
                const result = cp.spawnSync(clang, built.args, {
                    cwd,
                    encoding: 'utf-8',
                    timeout: timeoutMs,
                    maxBuffer: 64 * 1024 * 1024,  // 64MB
                });
                durationMs = Date.now() - start;
                if (result.error) {
                    return {
                        ok: false,
                        reason: `Failed to invoke clang: ${result.error.message}`,
                    };
                }
                if (result.status !== 0) {
                    const stderr = (result.stderr || '').toString().split(/\r?\n/).slice(-25).join('\n');
                    return {
                        ok: false,
                        reason: `clang exited with code ${result.status}.`,
                        detail: usedCompileCommands
                            ? 'The compile_commands.json entry may use flags clang doesn\'t accept (often MSVC-only). ' +
                              'You can edit the entry, set `hivemind.clangPath` to clang-cl, or expand a different TU.'
                            : 'No compile_commands.json entry was found for this file. Provide one for accurate results.',
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
                    reason: `Exception running clang: ${e instanceof Error ? e.message : String(e)}`,
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
