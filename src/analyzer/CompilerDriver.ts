/**
 * Compiler-driver detection + flag generation. Replaces the hard dependency on
 * clang in MacroExpander and BuildSubset. Resolves the compiler in this priority
 * order:
 *
 *   1. User config: `hivemind.clangPath` (legacy override, still honoured)
 *   2. Platform-native: `cl.exe` on Windows, `g++` on Linux/Darwin
 *   3. clang fallback: from PATH, vscode-clangd extension, or LLVM install dirs
 *
 * The platform-native preference lines up with the runtime's actual build
 * toolchain (X3 builds with MSVC on Windows, g++ on Linux). Using the same
 * compiler the project itself uses gives strictly better fidelity than using
 * clang in mixed mode.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as vscode from 'vscode';
import type { ProjectProfile } from '../profiles';
import { resolveConfiguration, pickAutoConfiguration } from '../profiles';

export type CompilerKind = 'cl' | 'clang' | 'gcc';

export interface CompilerInfo {
    /** Absolute path to the executable. */
    exe: string;
    /** Driver flavour — used to pick flag syntax. */
    kind: CompilerKind;
    /** Free-form note for diagnostics. */
    note: string;
}

/**
 * Detect a usable C/C++ compiler. Preference order:
 *   1. User-configured `hivemind.clangPath` (any flavour — we sniff it)
 *   2. Platform-native (cl.exe on Windows, g++ on Linux/Darwin)
 *   3. clang from PATH / vscode-clangd / common LLVM install paths
 */
export function detectCompiler(logger?: vscode.OutputChannel): CompilerInfo | null {
    const tried: string[] = [];
    const isFile = (p: string): boolean => {
        try {
            return fs.existsSync(p) && fs.statSync(p).isFile();
        } catch {
            return false;
        }
    };

    // 1. User override
    const cfg = vscode.workspace.getConfiguration('hivemind');
    const cfgUpper = vscode.workspace.getConfiguration('hiveMind');
    const configured = cfg.get<string>('clangPath') || cfgUpper.get<string>('clangPath');
    if (configured) {
        tried.push(configured);
        if (isFile(configured)) {
            return { exe: configured, kind: kindOf(configured), note: 'configured via hivemind.clangPath' };
        }
    }

    // 2. Platform native
    if (process.platform === 'win32') {
        // Try `cl.exe` from PATH (typically populated by VsDevCmd.bat / Developer PowerShell).
        const cl = findOnPath('cl.exe');
        tried.push(cl ?? 'cl.exe (not on PATH)');
        if (cl && isFile(cl)) {
            return { exe: cl, kind: 'cl', note: 'cl.exe from PATH' };
        }
        // Common Visual Studio install locations.
        const vsRoots = [
            'C:\\Program Files\\Microsoft Visual Studio\\2022',
            'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022',
            'C:\\Program Files\\Microsoft Visual Studio\\2019',
            'C:\\Program Files (x86)\\Microsoft Visual Studio\\2019',
        ];
        for (const root of vsRoots) {
            const found = scanForCl(root);
            if (found) {
                tried.push(found);
                if (isFile(found)) {
                    return { exe: found, kind: 'cl', note: `cl.exe from ${root}` };
                }
            }
        }
    } else {
        // Try g++ first (matches the makefile), then clang++.
        for (const name of ['g++', 'clang++', 'gcc', 'clang']) {
            const found = findOnPath(name);
            tried.push(found ?? `${name} (not on PATH)`);
            if (found && isFile(found)) {
                return { exe: found, kind: name.startsWith('clang') ? 'clang' : 'gcc', note: `${name} from PATH` };
            }
        }
    }

    // 3. Clang fallback — vscode-clangd extension globalStorage, LLVM common dirs
    const clangCandidates = clangSearchPaths();
    for (const c of clangCandidates) {
        tried.push(c);
        if (isFile(c)) {
            return { exe: c, kind: 'clang', note: `clang from ${c}` };
        }
    }

    if (logger) {
        logger.appendLine('[CompilerDriver] No compiler found. Tried:');
        for (const t of tried) {
            logger.appendLine(`[CompilerDriver]   • ${t}`);
        }
    }
    return null;
}

function kindOf(exe: string): CompilerKind {
    const base = path.basename(exe).toLowerCase();
    if (base === 'cl.exe' || base === 'cl') {
        return 'cl';
    }
    if (base.startsWith('clang')) {
        return 'clang';
    }
    return 'gcc';
}

function findOnPath(name: string): string | null {
    const sep = process.platform === 'win32' ? ';' : ':';
    const dirs = (process.env.PATH ?? '').split(sep);
    for (const dir of dirs) {
        const trimmed = dir.replace(/^"|"$/g, '');
        if (!trimmed) {
            continue;
        }
        const candidate = path.join(trimmed, name);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return candidate;
        }
    }
    return null;
}

function scanForCl(root: string): string | null {
    if (!fs.existsSync(root)) {
        return null;
    }
    try {
        const editions = fs.readdirSync(root);
        for (const edition of editions) {
            // VS install structure: <Edition>/VC/Tools/MSVC/<version>/bin/Hostx64/x64/cl.exe
            const tools = path.join(root, edition, 'VC', 'Tools', 'MSVC');
            if (!fs.existsSync(tools)) {
                continue;
            }
            const versions = fs.readdirSync(tools).sort().reverse(); // newest first
            for (const v of versions) {
                const exe = path.join(tools, v, 'bin', 'Hostx64', 'x64', 'cl.exe');
                if (fs.existsSync(exe)) {
                    return exe;
                }
            }
        }
    } catch {
        // ignore — directory walking errors are acceptable here
    }
    return null;
}

function clangSearchPaths(): string[] {
    const out: string[] = [];
    const exeName = process.platform === 'win32' ? 'clang.exe' : 'clang';
    const fromPath = findOnPath(exeName);
    if (fromPath) {
        out.push(fromPath);
    }
    if (process.platform === 'win32') {
        out.push(
            'C:\\Program Files\\LLVM\\bin\\clang.exe',
            'C:\\Program Files (x86)\\LLVM\\bin\\clang.exe',
            path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'LLVM', 'bin', 'clang.exe'),
        );
    } else if (process.platform === 'darwin') {
        out.push('/usr/local/opt/llvm/bin/clang', '/opt/homebrew/opt/llvm/bin/clang', '/usr/local/bin/clang');
    } else {
        out.push('/usr/bin/clang', '/usr/local/bin/clang');
    }
    return out;
}

// ---------------------------------------------------------------------------

/**
 * Build preprocessor arguments (the `-E` / `/E` family) appropriate to the
 * compiler kind, given a profile-derived define + include set.
 */
export function buildPreprocessArgs(
    info: CompilerInfo,
    sourceFile: string,
    extras: { defines: Record<string, string>; includeRoots: string[]; workspaceRoot: string }
): string[] {
    const args: string[] = [];
    if (info.kind === 'cl') {
        args.push('/E', '/P', '/nologo', '/EHsc');
        for (const [k, v] of Object.entries(extras.defines)) {
            args.push(`/D${k}=${v}`);
        }
        for (const inc of extras.includeRoots) {
            args.push(`/I${path.join(extras.workspaceRoot, inc)}`);
        }
    } else {
        args.push('-E', '-P', '-w');
        for (const [k, v] of Object.entries(extras.defines)) {
            args.push(`-D${k}=${v}`);
        }
        for (const inc of extras.includeRoots) {
            args.push('-I', path.join(extras.workspaceRoot, inc));
        }
        const ext = path.extname(sourceFile).toLowerCase();
        if (['.cpp', '.cxx', '.cc'].includes(ext)) {
            args.push('-x', 'c++', '-std=c++17');
        } else if (ext === '.c') {
            args.push('-x', 'c', '-std=c11');
        }
    }
    args.push(sourceFile);
    return args;
}

/**
 * Build syntax-only check arguments (`-fsyntax-only` / `/Zs`) appropriate to
 * the compiler kind.
 */
export function buildSyntaxOnlyArgs(
    info: CompilerInfo,
    sourceFile: string,
    extras: { defines: Record<string, string>; includeRoots: string[]; workspaceRoot: string }
): string[] {
    const args: string[] = [];
    if (info.kind === 'cl') {
        args.push('/Zs', '/nologo', '/EHsc');
        for (const [k, v] of Object.entries(extras.defines)) {
            args.push(`/D${k}=${v}`);
        }
        for (const inc of extras.includeRoots) {
            args.push(`/I${path.join(extras.workspaceRoot, inc)}`);
        }
    } else {
        args.push('-fsyntax-only');
        for (const [k, v] of Object.entries(extras.defines)) {
            args.push(`-D${k}=${v}`);
        }
        for (const inc of extras.includeRoots) {
            args.push('-I', path.join(extras.workspaceRoot, inc));
        }
        const ext = path.extname(sourceFile).toLowerCase();
        if (['.cpp', '.cxx', '.cc'].includes(ext)) {
            args.push('-x', 'c++', '-std=c++17');
        } else if (ext === '.c') {
            args.push('-x', 'c', '-std=c11');
        }
    }
    args.push(sourceFile);
    return args;
}

/**
 * Resolve profile-derived defines + include roots for the active configuration.
 * Returns empty extras if no profile is active (caller falls back to legacy
 * heuristics).
 */
export function profileFlagsFor(
    profile: ProjectProfile | null,
    workspaceRoot: string
): { defines: Record<string, string>; includeRoots: string[]; workspaceRoot: string } {
    if (!profile) {
        return { defines: {}, includeRoots: [], workspaceRoot };
    }
    const cfgName = pickAutoConfiguration(profile);
    const resolved = resolveConfiguration(profile, cfgName);
    return {
        defines: resolved.defines,
        includeRoots: resolved.includeRoots,
        workspaceRoot,
    };
}

export function probeCompilerVersion(info: CompilerInfo): string {
    try {
        const r = cp.spawnSync(info.exe, info.kind === 'cl' ? [] : ['--version'], {
            encoding: 'utf-8',
            timeout: 5000,
        });
        const text = ((r.stdout || '') + (r.stderr || '')).split(/\r?\n/)[0] ?? '';
        return text.trim() || 'unknown';
    } catch {
        return 'unknown';
    }
}
