import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import {
    detectCompiler,
    profileFlagsFor,
    type CompilerInfo,
} from './CompilerDriver';
import type { ProjectProfile } from '../profiles';

// =============================================================================
// SanitizerRunner — AddressSanitizer / UndefinedBehaviorSanitizer builds
// =============================================================================
//
// Orchestrates targeted ASan builds:
//   1. Takes a seed file or explicit TU list.
//   2. Compiles with sanitizer flags (full compile, not syntax-only).
//   3. Optionally links and runs a test binary to capture runtime reports.
//   4. Parses sanitizer output into structured diagnostics.
//
// The extension does NOT bundle ASan. It relies on the compiler's built-in
// support: MSVC `/fsanitize=address`, GCC/Clang `-fsanitize=address`.
// =============================================================================

export type SanitizerKind = 'address' | 'undefined' | 'address,undefined';

export interface SanitizerRequest {
    /** Absolute path(s) to compile with sanitizer flags. */
    files: string[];
    /** Which sanitizers to enable. Default: 'address'. */
    sanitizers?: SanitizerKind;
    /** If provided, link these TUs into an executable and run this command. */
    runCommand?: string;
    /** Working directory for the run command. Defaults to workspace root. */
    runCwd?: string;
    /** Environment variables to set during the run (merged with process.env). */
    runEnv?: Record<string, string>;
    /** Timeout per file compile in ms. Default 120s. */
    perFileTimeoutMs?: number;
    /** Timeout for the run phase in ms. Default 60s. */
    runTimeoutMs?: number;
    /** Max parallel compiles. Default min(4, CPU count). */
    parallelism?: number;
}

export interface SanitizerCompileResult {
    file: string;
    ok: boolean;
    durationMs: number;
    diagnostics: string;
    exitCode: number;
}

export interface SanitizerIssue {
    /** e.g. 'heap-buffer-overflow', 'use-after-free', 'stack-buffer-overflow', 'memory-leak' */
    type: string;
    /** File where the error was detected. */
    file: string;
    /** Line number (0 if unknown). */
    line: number;
    /** Column (0 if unknown). */
    column: number;
    /** Function name if available. */
    function?: string;
    /** Summary line from ASan. */
    summary: string;
    /** Full stack trace text. */
    stackTrace: string;
}

export interface SanitizerRunResult {
    command: string;
    exitCode: number;
    durationMs: number;
    /** Raw sanitizer output (stderr). */
    rawOutput: string;
    /** Parsed issues from sanitizer reports. */
    issues: SanitizerIssue[];
}

export interface SanitizerResult {
    compiler: string;
    sanitizers: SanitizerKind;
    compileResults: SanitizerCompileResult[];
    compilePassed: number;
    compileFailed: number;
    /** Only present if runCommand was provided and compile succeeded. */
    runResult?: SanitizerRunResult;
    durationMs: number;
    error?: string;
}

// -----------------------------------------------------------------------------
// Compile commands parsing (shared with BuildSubset pattern)
// -----------------------------------------------------------------------------

interface CompileCommandEntry {
    directory: string;
    file: string;
    arguments?: string[];
    command?: string;
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
// SanitizerRunner
// -----------------------------------------------------------------------------

export class SanitizerRunner {
    private compilerInfo: CompilerInfo | null = null;
    private compilerSearched = false;
    private cccByFile: Map<string, CompileCommandEntry> | null = null;
    private profile: ProjectProfile | null = null;

    constructor(
        private readonly workspaceRoot: string,
        private readonly logger: vscode.OutputChannel
    ) {}

    setProfile(profile: ProjectProfile | null): void {
        this.profile = profile;
    }

    private locateCompiler(): CompilerInfo | null {
        if (this.compilerSearched) { return this.compilerInfo; }
        this.compilerSearched = true;
        const info = detectCompiler(this.logger);
        if (info) {
            this.logger.appendLine(`[sanitizer] Using ${info.kind} (${info.exe}) — ${info.note}`);
        }
        this.compilerInfo = info;
        return info;
    }

    private loadCompileCommands(): Map<string, CompileCommandEntry> | null {
        if (this.cccByFile) { return this.cccByFile; }
        const candidates = [
            'compile_commands.json',
            'build/compile_commands.json',
            'out/compile_commands.json',
            'cmake-build-debug/compile_commands.json',
        ];
        for (const rel of candidates) {
            const full = path.join(this.workspaceRoot, rel);
            if (!fs.existsSync(full)) { continue; }
            try {
                const raw = fs.readFileSync(full, 'utf-8');
                const entries: CompileCommandEntry[] = JSON.parse(raw);
                const byFile = new Map<string, CompileCommandEntry>();
                for (const e of entries) {
                    if (!e.file || !e.directory) { continue; }
                    const abs = path.isAbsolute(e.file) ? e.file : path.resolve(e.directory, e.file);
                    byFile.set(normalizeKey(abs), e);
                }
                this.cccByFile = byFile;
                return byFile;
            } catch { /* ignore */ }
        }
        return null;
    }

    /**
     * Build sanitizer compile arguments from a compile_commands.json entry.
     * Preserves includes/defines but replaces optimization and output flags.
     */
    private sanitizerArgsFromEntry(
        entry: CompileCommandEntry,
        sourceFile: string,
        info: CompilerInfo,
        sanitizers: SanitizerKind
    ): { args: string[]; cwd: string } {
        const original = entry.arguments && entry.arguments.length > 0
            ? entry.arguments
            : (entry.command ? splitCommand(entry.command) : []);

        const sourceNorm = normalizeKey(sourceFile);
        // Flags to skip (output paths, PCH, optimization)
        const skipPair = new Set(['-o', '-MF', '-MT', '-MQ', '-MD', '-MMD',
                                  '-include-pch', '-Fo', '-Fd', '-Fp']);
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
            // Keep -c for compile-only
            if (/^-O[0-3sz]?$/.test(a)) { continue; }
            if (/^\/O/i.test(a)) { continue; }
            if (/^\/Z[is7]/i.test(a)) { continue; }
            if (/^\/Y[cu]/i.test(a)) { continue; }
            out.push(a);
        }

        // Add sanitizer flags
        if (info.kind === 'cl') {
            out.unshift('/c', '/nologo', '/EHsc', '/Zi', '/fsanitize=address');
        } else {
            const sanFlag = `-fsanitize=${sanitizers}`;
            out.unshift('-c', sanFlag, '-fno-omit-frame-pointer', '-g', '-O1');
        }
        out.push(sourceFile);

        return { args: out, cwd: entry.directory };
    }

    /**
     * Build sanitizer compile arguments from profile flags (no compile_commands.json).
     */
    private sanitizerArgsFromProfile(
        sourceFile: string,
        info: CompilerInfo,
        sanitizers: SanitizerKind
    ): { args: string[]; cwd: string } {
        const extras = profileFlagsFor(this.profile, this.workspaceRoot);
        const args: string[] = [];

        if (info.kind === 'cl') {
            args.push('/c', '/nologo', '/EHsc', '/Zi', '/fsanitize=address');
            for (const [k, v] of Object.entries(extras.defines)) {
                args.push(`/D${k}=${v}`);
            }
            for (const inc of extras.includeRoots) {
                args.push(`/I${path.join(this.workspaceRoot, inc)}`);
            }
        } else {
            const sanFlag = `-fsanitize=${sanitizers}`;
            args.push('-c', sanFlag, '-fno-omit-frame-pointer', '-g', '-O1');
            for (const [k, v] of Object.entries(extras.defines)) {
                args.push(`-D${k}=${v}`);
            }
            for (const inc of extras.includeRoots) {
                args.push('-I', path.join(this.workspaceRoot, inc));
            }
            const ext = path.extname(sourceFile).toLowerCase();
            if (['.cpp', '.cxx', '.cc', '.c++'].includes(ext)) {
                args.push('-x', 'c++', '-std=c++17');
            } else if (ext === '.c') {
                args.push('-x', 'c', '-std=c11');
            }
        }
        args.push(sourceFile);
        return { args, cwd: this.workspaceRoot };
    }

    /** Compile a single file with sanitizer flags. */
    private async compileOne(
        file: string,
        info: CompilerInfo,
        sanitizers: SanitizerKind,
        timeoutMs: number
    ): Promise<SanitizerCompileResult> {
        const start = Date.now();
        const ccc = this.loadCompileCommands();
        const entry = ccc?.get(normalizeKey(file)) ?? null;

        let args: string[];
        let cwd: string;

        if (entry) {
            const r = this.sanitizerArgsFromEntry(entry, file, info, sanitizers);
            args = r.args;
            cwd = r.cwd;
        } else if (this.profile) {
            const r = this.sanitizerArgsFromProfile(file, info, sanitizers);
            args = r.args;
            cwd = r.cwd;
        } else {
            return {
                file, ok: false, durationMs: 0, diagnostics: 'No compile flags available.',
                exitCode: -1,
            };
        }

        return await new Promise<SanitizerCompileResult>((resolve) => {
            let settled = false;
            const proc = cp.spawn(info.exe, args, { cwd, windowsHide: true });
            let stderr = '';
            let stdout = '';
            const timer = setTimeout(() => {
                if (settled) { return; }
                settled = true;
                try { proc.kill('SIGKILL'); } catch { /* ignore */ }
                resolve({
                    file, ok: false, durationMs: Date.now() - start,
                    diagnostics: `(timed out after ${timeoutMs}ms)`, exitCode: -1,
                });
            }, timeoutMs);

            proc.stderr.on('data', d => { stderr += d.toString(); if (stderr.length > 16384) { stderr = stderr.slice(-16384); } });
            proc.stdout.on('data', d => { stdout += d.toString(); if (stdout.length > 8192) { stdout = stdout.slice(-8192); } });
            proc.on('error', err => {
                if (settled) { return; } settled = true; clearTimeout(timer);
                resolve({
                    file, ok: false, durationMs: Date.now() - start,
                    diagnostics: 'spawn error: ' + err.message, exitCode: -1,
                });
            });
            proc.on('close', code => {
                if (settled) { return; } settled = true; clearTimeout(timer);
                const diag = (stderr || stdout).trim();
                resolve({
                    file, ok: code === 0, durationMs: Date.now() - start,
                    diagnostics: diag.length > 4096 ? diag.slice(-4096) : diag,
                    exitCode: code ?? -1,
                });
            });
        });
    }

    /** Run a sanitized binary and capture ASan output. */
    private async runSanitized(
        command: string,
        cwd: string,
        env: Record<string, string>,
        timeoutMs: number
    ): Promise<SanitizerRunResult> {
        const start = Date.now();
        // Set ASan options for maximum reporting
        const asanOpts = [
            'detect_leaks=1',
            'print_stats=1',
            'halt_on_error=0',
            'detect_stack_use_after_return=1',
        ].join(':');

        const runEnv = {
            ...process.env,
            ...env,
            ASAN_OPTIONS: env.ASAN_OPTIONS || asanOpts,
            UBSAN_OPTIONS: env.UBSAN_OPTIONS || 'print_stacktrace=1:halt_on_error=0',
        };

        // Parse the command into executable + args
        const parts = splitCommand(command);
        const exe = parts[0];
        const args = parts.slice(1);

        return await new Promise<SanitizerRunResult>((resolve) => {
            let settled = false;
            const proc = cp.spawn(exe, args, {
                cwd,
                env: runEnv,
                windowsHide: true,
            });
            let stderr = '';
            let stdout = '';

            const timer = setTimeout(() => {
                if (settled) { return; }
                settled = true;
                try { proc.kill('SIGKILL'); } catch { /* ignore */ }
                resolve({
                    command, exitCode: -1, durationMs: Date.now() - start,
                    rawOutput: stderr || stdout,
                    issues: parseAsanOutput(stderr || stdout),
                });
            }, timeoutMs);

            proc.stderr.on('data', d => { stderr += d.toString(); if (stderr.length > 65536) { stderr = stderr.slice(-65536); } });
            proc.stdout.on('data', d => { stdout += d.toString(); if (stdout.length > 65536) { stdout = stdout.slice(-65536); } });
            proc.on('error', err => {
                if (settled) { return; } settled = true; clearTimeout(timer);
                resolve({
                    command, exitCode: -1, durationMs: Date.now() - start,
                    rawOutput: 'spawn error: ' + err.message, issues: [],
                });
            });
            proc.on('close', code => {
                if (settled) { return; } settled = true; clearTimeout(timer);
                const output = stderr || stdout;
                resolve({
                    command, exitCode: code ?? -1, durationMs: Date.now() - start,
                    rawOutput: output.length > 32768 ? output.slice(-32768) : output,
                    issues: parseAsanOutput(output),
                });
            });
        });
    }

    /**
     * Main entry: compile files with sanitizer flags and optionally run.
     */
    async run(req: SanitizerRequest): Promise<SanitizerResult> {
        const start = Date.now();
        const sanitizers = req.sanitizers ?? 'address';
        const perFileTimeoutMs = req.perFileTimeoutMs ?? 120_000;
        const runTimeoutMs = req.runTimeoutMs ?? 60_000;
        const parallelism = Math.max(1, Math.min(8, req.parallelism ?? Math.min(4, require('os').cpus()?.length ?? 4)));

        const compiler = this.locateCompiler();
        if (!compiler) {
            return {
                compiler: 'none', sanitizers, compileResults: [],
                compilePassed: 0, compileFailed: 0, durationMs: Date.now() - start,
                error: 'No C/C++ compiler found. ASan requires MSVC (cl.exe ≥ VS2019), g++ ≥ 4.8, or clang ≥ 3.1.',
            };
        }

        // MSVC only supports address sanitizer (not undefined)
        const effectiveSanitizers: SanitizerKind = compiler.kind === 'cl'
            ? 'address'
            : sanitizers;

        if (compiler.kind === 'cl' && sanitizers !== 'address') {
            this.logger.appendLine('[sanitizer] MSVC only supports /fsanitize=address. Ignoring "undefined".');
        }

        const ccc = this.loadCompileCommands();
        if (!ccc && !this.profile) {
            return {
                compiler: `${compiler.kind} (${compiler.exe})`, sanitizers: effectiveSanitizers,
                compileResults: [], compilePassed: 0, compileFailed: 0,
                durationMs: Date.now() - start,
                error: 'No compile_commands.json and no active project profile. Cannot determine compile flags.',
            };
        }

        this.logger.appendLine(`[sanitizer] Compiling ${req.files.length} file(s) with -fsanitize=${effectiveSanitizers}`);

        // Parallel compilation
        const results: SanitizerCompileResult[] = [];
        const queue = [...req.files];
        let active = 0;
        let idx = 0;

        await new Promise<void>((resolve) => {
            const next = () => {
                while (active < parallelism && idx < queue.length) {
                    const file = queue[idx++];
                    active++;
                    this.compileOne(file, compiler, effectiveSanitizers, perFileTimeoutMs).then(r => {
                        results.push(r);
                        active--;
                        if (idx >= queue.length && active === 0) {
                            resolve();
                        } else {
                            next();
                        }
                    });
                }
                if (queue.length === 0) { resolve(); }
            };
            next();
        });

        const passed = results.filter(r => r.ok).length;
        const failed = results.filter(r => !r.ok).length;

        const result: SanitizerResult = {
            compiler: `${compiler.kind} (${compiler.exe})`,
            sanitizers: effectiveSanitizers,
            compileResults: results,
            compilePassed: passed,
            compileFailed: failed,
            durationMs: Date.now() - start,
        };

        // Run phase (only if all compiles passed and a run command was given)
        if (req.runCommand && failed === 0) {
            const cwd = req.runCwd || this.workspaceRoot;
            const env = req.runEnv || {};
            this.logger.appendLine(`[sanitizer] Running: ${req.runCommand}`);
            result.runResult = await this.runSanitized(req.runCommand, cwd, env, runTimeoutMs);
            this.logger.appendLine(`[sanitizer] Run exited with code ${result.runResult.exitCode}, found ${result.runResult.issues.length} issue(s)`);
        } else if (req.runCommand && failed > 0) {
            this.logger.appendLine(`[sanitizer] Skipping run phase — ${failed} compile failure(s).`);
        }

        result.durationMs = Date.now() - start;
        return result;
    }
}

// =============================================================================
// ASan output parser
// =============================================================================

/**
 * Parse ASan/UBSan stderr output into structured issues.
 * Handles the standard LLVM/GCC ASan report format:
 *   ==PID==ERROR: AddressSanitizer: <type> on address ...
 *   ...stack frames...
 *   SUMMARY: AddressSanitizer: <type> <file>:<line>:<col> in <function>
 */
export function parseAsanOutput(output: string): SanitizerIssue[] {
    const issues: SanitizerIssue[] = [];
    const lines = output.split(/\r?\n/);

    // Pattern: SUMMARY line from ASan/UBSan
    // SUMMARY: AddressSanitizer: heap-buffer-overflow /path/to/file.cpp:42:5 in func
    const summaryRe = /SUMMARY:\s*\w+Sanitizer:\s*(\S+)\s+([^\s:]+):(\d+):?(\d+)?\s*(?:in\s+(.+))?/;

    // Pattern: ERROR line that starts a report
    // ==12345==ERROR: AddressSanitizer: heap-buffer-overflow on address ...
    const errorRe = /==\d+==ERROR:\s*\w+Sanitizer:\s*(.+?)(?:\s+on\s+address|\s+\()/;

    // Pattern: leak summary
    // Direct leak of N byte(s) in M object(s) allocated from:
    const leakRe = /^(Direct|Indirect) leak of (\d+) byte/;

    let currentStackTrace = '';
    let inReport = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Detect start of a new report
        if (errorRe.test(line) || leakRe.test(line)) {
            inReport = true;
            currentStackTrace = '';
        }

        if (inReport) {
            currentStackTrace += line + '\n';
        }

        // SUMMARY line closes a report and gives us the structured data
        const summaryMatch = line.match(summaryRe);
        if (summaryMatch) {
            issues.push({
                type: summaryMatch[1],
                file: summaryMatch[2],
                line: parseInt(summaryMatch[3], 10) || 0,
                column: parseInt(summaryMatch[4] || '0', 10),
                function: summaryMatch[5]?.trim(),
                summary: line.trim(),
                stackTrace: currentStackTrace.trim(),
            });
            inReport = false;
            currentStackTrace = '';
        }
    }

    // If we had reports without SUMMARY lines (e.g. leak reports), try to extract from stack frames
    if (issues.length === 0 && output.includes('Sanitizer')) {
        // Fallback: look for frame references
        const frameRe = /#\d+\s+\S+\s+in\s+(\S+)\s+([^\s:]+):(\d+)/g;
        let match: RegExpExecArray | null;
        const seen = new Set<string>();
        while ((match = frameRe.exec(output)) !== null) {
            const key = `${match[2]}:${match[3]}`;
            if (seen.has(key)) { continue; }
            seen.add(key);
            issues.push({
                type: 'sanitizer-error',
                file: match[2],
                line: parseInt(match[3], 10),
                column: 0,
                function: match[1],
                summary: `Sanitizer error in ${match[1]} at ${match[2]}:${match[3]}`,
                stackTrace: output.slice(Math.max(0, match.index - 200), match.index + 500).trim(),
            });
            if (issues.length >= 20) { break; }
        }
    }

    return issues;
}
