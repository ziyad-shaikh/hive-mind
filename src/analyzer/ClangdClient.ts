import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';

// =============================================================================
// ClangdClient — minimal LSP client for clangd
// =============================================================================
//
// Purpose: provide AST-precise C/C++ analysis to Hive Mind tools by speaking
// LSP to a `clangd` child process. clangd already understands compile_commands.json,
// per-configuration #ifdef evaluation, virtual dispatch, templates, etc. — we just
// need to query it.
//
// Design constraints:
//   • Zero runtime dependencies (only `vscode`, Node `child_process`/`fs`/`path`).
//   • Lazy startup — clangd is only spawned on first request.
//   • Survive missing / broken clangd installs gracefully. All public methods
//     return `null` (or throw a typed error) when clangd is unavailable;
//     consumers must handle that.
//   • Single-shot per query — we do not maintain `textDocument/didOpen` state
//     for the entire workspace. Each query opens the relevant file, runs the
//     query, and closes it. This trades latency-per-query for memory simplicity.
//
// Non-goals (for this first cut):
//   • Workspace-wide indexing on our side. clangd does its own indexing.
//   • Wiring into any existing LM tool. That's a follow-up.
//   • Watching `compile_commands.json` for changes. Restart the extension.
//
// LSP framing reference: https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/

// -----------------------------------------------------------------------------
// Public types (a subset of LSP)
// -----------------------------------------------------------------------------

export interface Position { line: number; character: number; }
export interface Range { start: Position; end: Position; }
export interface Location { uri: string; range: Range; }
export interface DocumentSymbol {
    name: string;
    detail?: string;
    kind: number;
    range: Range;
    selectionRange: Range;
    children?: DocumentSymbol[];
}
export interface CallHierarchyItem {
    name: string;
    kind: number;
    detail?: string;
    uri: string;
    range: Range;
    selectionRange: Range;
    data?: unknown;
}
export interface TypeHierarchyItem extends CallHierarchyItem { /* same shape */ }
export interface Hover {
    contents: string | { kind: string; value: string } | Array<string | { kind: string; value: string }>;
    range?: Range;
}

export interface ClangdInfo {
    available: boolean;
    executable: string | null;
    version: string | null;
    reason?: string;
}

// -----------------------------------------------------------------------------
// JSON-RPC framing
// -----------------------------------------------------------------------------

interface JsonRpcRequest {
    jsonrpc: '2.0';
    id: number;
    method: string;
    params?: unknown;
}
interface JsonRpcNotification {
    jsonrpc: '2.0';
    method: string;
    params?: unknown;
}
interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: number;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

function encodeMessage(msg: object): Buffer {
    const json = JSON.stringify(msg);
    const body = Buffer.from(json, 'utf-8');
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
    return Buffer.concat([header, body]);
}

// -----------------------------------------------------------------------------
// Streaming LSP message parser
// -----------------------------------------------------------------------------
//
// LSP messages are framed by HTTP-style headers. The body is JSON. We accumulate
// bytes from clangd's stdout and emit complete messages as we get them.

class LspMessageParser {
    private buffer = Buffer.alloc(0);
    private contentLength = -1;

    /** Feed bytes; returns 0..N parsed JSON-RPC messages. */
    feed(chunk: Buffer): object[] {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const messages: object[] = [];

        while (true) {
            if (this.contentLength < 0) {
                const headerEnd = this.buffer.indexOf('\r\n\r\n');
                if (headerEnd < 0) { break; }  // need more data
                const headerStr = this.buffer.slice(0, headerEnd).toString('ascii');
                const match = /Content-Length:\s*(\d+)/i.exec(headerStr);
                if (!match) {
                    // Malformed; drop everything up to header end and recover.
                    this.buffer = this.buffer.slice(headerEnd + 4);
                    continue;
                }
                this.contentLength = parseInt(match[1], 10);
                this.buffer = this.buffer.slice(headerEnd + 4);
            }

            if (this.buffer.length < this.contentLength) { break; }  // need more bytes

            const body = this.buffer.slice(0, this.contentLength).toString('utf-8');
            this.buffer = this.buffer.slice(this.contentLength);
            this.contentLength = -1;

            try {
                messages.push(JSON.parse(body));
            } catch {
                // Skip malformed message; keep parsing.
            }
        }

        return messages;
    }
}

// -----------------------------------------------------------------------------
// ClangdClient
// -----------------------------------------------------------------------------

export class ClangdClient {
    private proc: cp.ChildProcessWithoutNullStreams | null = null;
    private parser = new LspMessageParser();
    private nextRequestId = 1;
    private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    private initializing: Promise<boolean> | null = null;
    private initialized = false;
    private openDocs = new Set<string>();
    private info: ClangdInfo = { available: false, executable: null, version: null };
    private disposed = false;

    constructor(
        private readonly workspaceRoot: string,
        private readonly logger: vscode.OutputChannel
    ) {}

    /** Returns clangd availability and version (initializes lazily on first call). */
    async getInfo(): Promise<ClangdInfo> {
        await this.ensureInitialized();
        return this.info;
    }

    /** Force initialization; returns true if clangd is ready. */
    async ensureInitialized(): Promise<boolean> {
        if (this.initialized) { return true; }
        if (this.disposed) { return false; }
        if (this.initializing) { return this.initializing; }
        this.initializing = this.doInit();
        return this.initializing;
    }

    private async doInit(): Promise<boolean> {
        const exe = await this.locateClangd();
        if (!exe) {
            this.info = {
                available: false,
                executable: null,
                version: null,
                reason: 'clangd executable not found. Install LLVM/clangd or the "llvm-vs-code-extensions.vscode-clangd" extension.',
            };
            this.logger.appendLine(`[clangd] ${this.info.reason}`);
            return false;
        }

        // Probe version cheaply before spawning the long-lived process.
        let version: string | null = null;
        try {
            const out = cp.execFileSync(exe, ['--version'], { encoding: 'utf-8', timeout: 5000 });
            const m = /clangd version\s+([^\s]+)/i.exec(out);
            version = m ? m[1] : out.split('\n')[0]?.trim() ?? null;
        } catch (e) {
            this.logger.appendLine(`[clangd] --version probe failed: ${e instanceof Error ? e.message : String(e)}`);
        }

        try {
            this.proc = cp.spawn(exe, [
                '--background-index',
                '--clang-tidy=false',
                '--header-insertion=never',
                '--limit-results=200',
                '--log=error',
            ], { cwd: this.workspaceRoot, stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (e) {
            this.info = {
                available: false,
                executable: exe,
                version,
                reason: `Failed to spawn clangd: ${e instanceof Error ? e.message : String(e)}`,
            };
            this.logger.appendLine(`[clangd] spawn failed: ${this.info.reason}`);
            return false;
        }

        this.proc.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
        this.proc.stderr.on('data', (chunk: Buffer) => {
            this.logger.appendLine(`[clangd:stderr] ${chunk.toString('utf-8').trimEnd()}`);
        });
        this.proc.on('exit', (code, signal) => {
            this.logger.appendLine(`[clangd] exited (code=${code}, signal=${signal})`);
            this.proc = null;
            this.initialized = false;
            // Reject any in-flight requests
            for (const { reject } of this.pending.values()) {
                reject(new Error('clangd exited unexpectedly'));
            }
            this.pending.clear();
        });
        this.proc.on('error', (e) => {
            this.logger.appendLine(`[clangd] process error: ${e.message}`);
        });

        try {
            const initResult = await this.request<{ serverInfo?: { name?: string; version?: string } }>('initialize', {
                processId: process.pid,
                clientInfo: { name: 'hive-mind', version: '0.x' },
                rootUri: 'file://' + this.toForwardSlash(this.workspaceRoot),
                capabilities: {
                    textDocument: {
                        synchronization: { dynamicRegistration: false, didSave: false, willSave: false },
                        definition: { dynamicRegistration: false, linkSupport: false },
                        references: { dynamicRegistration: false },
                        implementation: { dynamicRegistration: false, linkSupport: false },
                        documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
                        callHierarchy: { dynamicRegistration: false },
                        typeHierarchy: { dynamicRegistration: false },
                        hover: { dynamicRegistration: false, contentFormat: ['plaintext', 'markdown'] },
                    },
                    workspace: {},
                },
                workspaceFolders: [{ uri: 'file://' + this.toForwardSlash(this.workspaceRoot), name: path.basename(this.workspaceRoot) }],
            });

            this.notify('initialized', {});
            const serverVersion = initResult?.serverInfo?.version ?? version;
            this.info = { available: true, executable: exe, version: serverVersion };
            this.initialized = true;
            this.logger.appendLine(`[clangd] ready (${exe}, version=${serverVersion ?? 'unknown'})`);
            return true;
        } catch (e) {
            this.info = {
                available: false,
                executable: exe,
                version,
                reason: `LSP initialize failed: ${e instanceof Error ? e.message : String(e)}`,
            };
            this.logger.appendLine(`[clangd] ${this.info.reason}`);
            this.kill();
            return false;
        }
    }

    /** Look for clangd on PATH or in known install locations. */
    private async locateClangd(): Promise<string | null> {
        const exeName = process.platform === 'win32' ? 'clangd.exe' : 'clangd';
        const tried: string[] = [];
        const isFile = (p: string) => {
            try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; }
        };
        const tryPath = (p: string | undefined | null): string | null => {
            if (!p) { return null; }
            tried.push(p);
            if (isFile(p)) { return p; }
            // If a bare name was given, leave PATH resolution to step 5.
            return null;
        };

        // 1. Hive Mind's own override (support both casings — old & new)
        const hmCfg = vscode.workspace.getConfiguration('hivemind');
        const hmCfgUpper = vscode.workspace.getConfiguration('hiveMind');
        const configured = hmCfg.get<string>('clangdPath') || hmCfgUpper.get<string>('clangdPath');
        const c1 = tryPath(configured);
        if (c1) { return c1; }

        // 2. vscode-clangd's own setting `clangd.path` (most users have this set automatically)
        const clangdCfg = vscode.workspace.getConfiguration('clangd');
        const clangdPathSetting = clangdCfg.get<string>('path');
        if (clangdPathSetting && clangdPathSetting !== 'clangd') {
            // Absolute path → check directly
            if (path.isAbsolute(clangdPathSetting)) {
                const c2 = tryPath(clangdPathSetting);
                if (c2) { return c2; }
            }
            // Bare name → resolve via PATH (handled in step 5 with `where`/`which`)
        }

        // 3. vscode-clangd's auto-downloaded binary lives in globalStorage, NOT extensionPath.
        const ext = vscode.extensions.getExtension('llvm-vs-code-extensions.vscode-clangd');
        if (ext) {
            // Search both globalStorage variants and extensionPath as a fallback.
            const candidates = [
                this.findInClangdInstallTree(this.guessGlobalStorage('llvm-vs-code-extensions.vscode-clangd')),
                this.findInClangdInstallTree(ext.extensionPath),
            ];
            for (const c of candidates) {
                tried.push(c ?? '(globalStorage search returned no candidate)');
                if (c && isFile(c)) { return c; }
            }
        }

        // 4. PATH lookup — including version-suffixed names (clangd-18, clangd-17, ...)
        const pathSep = process.platform === 'win32' ? ';' : ':';
        const pathDirs = (process.env.PATH ?? '').split(pathSep);
        const exeNames = process.platform === 'win32'
            ? [exeName]
            : ['clangd', 'clangd-19', 'clangd-18', 'clangd-17', 'clangd-16', 'clangd-15', 'clangd-14'];
        for (const dir of pathDirs) {
            if (!dir) { continue; }
            for (const name of exeNames) {
                const candidate = path.join(dir.replace(/^"|"$/g, ''), name);
                tried.push(candidate);
                if (isFile(candidate)) { return candidate; }
            }
        }

        // 5. Fall back to OS shell resolution — handles cases where PATH was set after VS Code launched
        //    or where the binary is exposed via a shim that doesn't show up as a file in step 4.
        try {
            const cmd = process.platform === 'win32' ? 'where' : 'which';
            const out = cp.execFileSync(cmd, ['clangd'], { encoding: 'utf-8', timeout: 3000 });
            const firstLine = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
            if (firstLine && isFile(firstLine)) {
                return firstLine;
            }
            tried.push(`${cmd} clangd → ${firstLine ?? '(empty)'}`);
        } catch (e) {
            tried.push(`shell-resolve clangd failed: ${e instanceof Error ? e.message : String(e)}`);
        }

        // 6. Common LLVM install locations on Windows / macOS / Linux
        const fixedCandidates: string[] = [];
        if (process.platform === 'win32') {
            fixedCandidates.push(
                'C:\\Program Files\\LLVM\\bin\\clangd.exe',
                'C:\\Program Files (x86)\\LLVM\\bin\\clangd.exe',
                path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'LLVM', 'bin', 'clangd.exe'),
                path.join(process.env.ProgramW6432 ?? '', 'LLVM', 'bin', 'clangd.exe'),
            );
        } else if (process.platform === 'darwin') {
            fixedCandidates.push(
                '/usr/local/opt/llvm/bin/clangd',
                '/opt/homebrew/opt/llvm/bin/clangd',
                '/usr/local/bin/clangd',
                '/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clangd',
            );
        } else {
            fixedCandidates.push('/usr/bin/clangd', '/usr/local/bin/clangd');
        }
        for (const c of fixedCandidates) {
            tried.push(c);
            if (isFile(c)) { return c; }
        }

        // Diagnostic dump — write the search trail so users can see why detection failed.
        this.logger.appendLine('[clangd] Search trail (set "hivemind.clangdPath" to override):');
        for (const t of tried) {
            this.logger.appendLine(`[clangd]   • ${t}`);
        }
        return null;
    }

    /** vscode-clangd auto-downloads to `<globalStorage>/install/<version>/clangd_<version>/bin/clangd`. */
    private findInClangdInstallTree(rootDir: string | null): string | null {
        const exeName = process.platform === 'win32' ? 'clangd.exe' : 'clangd';
        if (!rootDir) { return null; }
        try {
            const installDir = path.join(rootDir, 'install');
            if (!fs.existsSync(installDir)) { return null; }
            // Walk: install/<version>/clangd_<version>/bin/clangd
            const versions = fs.readdirSync(installDir, { withFileTypes: true });
            for (const v of versions) {
                if (!v.isDirectory()) { continue; }
                const versionDir = path.join(installDir, v.name);
                // Try direct bin/ first (older layout)
                const direct = path.join(versionDir, 'bin', exeName);
                if (fs.existsSync(direct)) { return direct; }
                // Then nested clangd_<version>/bin (current vscode-clangd layout)
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

    /**
     * Best-effort guess at vscode-clangd's globalStorage directory.
     * VS Code stores per-extension state at:
     *   <userDataDir>/User/globalStorage/<publisher.name>/
     */
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
                candidates.push(path.join(home, 'Library', 'Application Support', 'Code - Insiders', 'User', 'globalStorage', extensionId));
            }
        } else {
            const home = process.env.HOME;
            if (home) {
                candidates.push(path.join(home, '.config', 'Code', 'User', 'globalStorage', extensionId));
                candidates.push(path.join(home, '.config', 'Code - Insiders', 'User', 'globalStorage', extensionId));
            }
        }
        for (const c of candidates) {
            if (fs.existsSync(c)) { return c; }
        }
        return null;
    }

    // -------------------------------------------------------------------------
    // Public LSP queries
    // -------------------------------------------------------------------------

    async definition(file: string, pos: Position): Promise<Location[]> {
        if (!await this.ensureInitialized()) { return []; }
        await this.openDocument(file);
        const result = await this.request<Location | Location[] | null>('textDocument/definition', {
            textDocument: { uri: this.fileToUri(file) },
            position: pos,
        });
        return this.normalizeLocations(result);
    }

    async references(file: string, pos: Position, includeDeclaration = true): Promise<Location[]> {
        if (!await this.ensureInitialized()) { return []; }
        await this.openDocument(file);
        const result = await this.request<Location[] | null>('textDocument/references', {
            textDocument: { uri: this.fileToUri(file) },
            position: pos,
            context: { includeDeclaration },
        });
        return Array.isArray(result) ? result : [];
    }

    async implementations(file: string, pos: Position): Promise<Location[]> {
        if (!await this.ensureInitialized()) { return []; }
        await this.openDocument(file);
        const result = await this.request<Location | Location[] | null>('textDocument/implementation', {
            textDocument: { uri: this.fileToUri(file) },
            position: pos,
        });
        return this.normalizeLocations(result);
    }

    async documentSymbols(file: string): Promise<DocumentSymbol[]> {
        if (!await this.ensureInitialized()) { return []; }
        await this.openDocument(file);
        const result = await this.request<DocumentSymbol[] | null>('textDocument/documentSymbol', {
            textDocument: { uri: this.fileToUri(file) },
        });
        return Array.isArray(result) ? result : [];
    }

    async hover(file: string, pos: Position): Promise<Hover | null> {
        if (!await this.ensureInitialized()) { return null; }
        await this.openDocument(file);
        return this.request<Hover | null>('textDocument/hover', {
            textDocument: { uri: this.fileToUri(file) },
            position: pos,
        });
    }

    async prepareCallHierarchy(file: string, pos: Position): Promise<CallHierarchyItem[]> {
        if (!await this.ensureInitialized()) { return []; }
        await this.openDocument(file);
        const result = await this.request<CallHierarchyItem[] | null>('textDocument/prepareCallHierarchy', {
            textDocument: { uri: this.fileToUri(file) },
            position: pos,
        });
        return Array.isArray(result) ? result : [];
    }

    async incomingCalls(item: CallHierarchyItem): Promise<{ from: CallHierarchyItem; fromRanges: Range[] }[]> {
        if (!await this.ensureInitialized()) { return []; }
        const result = await this.request<{ from: CallHierarchyItem; fromRanges: Range[] }[] | null>(
            'callHierarchy/incomingCalls', { item }
        );
        return Array.isArray(result) ? result : [];
    }

    async outgoingCalls(item: CallHierarchyItem): Promise<{ to: CallHierarchyItem; fromRanges: Range[] }[]> {
        if (!await this.ensureInitialized()) { return []; }
        const result = await this.request<{ to: CallHierarchyItem; fromRanges: Range[] }[] | null>(
            'callHierarchy/outgoingCalls', { item }
        );
        return Array.isArray(result) ? result : [];
    }

    async prepareTypeHierarchy(file: string, pos: Position): Promise<TypeHierarchyItem[]> {
        if (!await this.ensureInitialized()) { return []; }
        await this.openDocument(file);
        const result = await this.request<TypeHierarchyItem[] | null>('textDocument/prepareTypeHierarchy', {
            textDocument: { uri: this.fileToUri(file) },
            position: pos,
        });
        return Array.isArray(result) ? result : [];
    }

    async supertypes(item: TypeHierarchyItem): Promise<TypeHierarchyItem[]> {
        if (!await this.ensureInitialized()) { return []; }
        const result = await this.request<TypeHierarchyItem[] | null>('typeHierarchy/supertypes', { item });
        return Array.isArray(result) ? result : [];
    }

    async subtypes(item: TypeHierarchyItem): Promise<TypeHierarchyItem[]> {
        if (!await this.ensureInitialized()) { return []; }
        const result = await this.request<TypeHierarchyItem[] | null>('typeHierarchy/subtypes', { item });
        return Array.isArray(result) ? result : [];
    }

    /** Shut down clangd cleanly. */
    async dispose(): Promise<void> {
        this.disposed = true;
        if (!this.proc || !this.initialized) {
            this.kill();
            return;
        }
        try {
            await this.request('shutdown', null, 2000);
            this.notify('exit', null);
        } catch { /* ignore */ }
        this.kill();
    }

    private kill(): void {
        if (this.proc) {
            try { this.proc.kill(); } catch { /* ignore */ }
            this.proc = null;
        }
        this.initialized = false;
        this.openDocs.clear();
    }

    // -------------------------------------------------------------------------
    // JSON-RPC plumbing
    // -------------------------------------------------------------------------

    private onStdout(chunk: Buffer): void {
        const messages = this.parser.feed(chunk);
        for (const msg of messages) {
            this.handleMessage(msg as JsonRpcResponse | JsonRpcNotification);
        }
    }

    private handleMessage(msg: JsonRpcResponse | JsonRpcNotification): void {
        // Responses always have an `id` (number); notifications never do.
        if ('id' in msg && typeof (msg as JsonRpcResponse).id === 'number') {
            const response = msg as JsonRpcResponse;
            const pending = this.pending.get(response.id);
            if (!pending) { return; }
            this.pending.delete(response.id);
            if (response.error) {
                pending.reject(new Error(`clangd error ${response.error.code}: ${response.error.message}`));
            } else {
                pending.resolve(response.result);
            }
            return;
        }
        // Notifications from server (window/logMessage, textDocument/publishDiagnostics, etc.)
        // are ignored for now — diagnostics aren't surfaced through our tools yet.
    }

    private request<T>(method: string, params: unknown, timeoutMs = 10000): Promise<T> {
        if (!this.proc) { return Promise.reject(new Error('clangd not running')); }
        const id = this.nextRequestId++;
        const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params: params ?? undefined };
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`clangd request timed out: ${method}`));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: (v) => { clearTimeout(timer); resolve(v as T); },
                reject:  (e) => { clearTimeout(timer); reject(e); },
            });
            try {
                this.proc!.stdin.write(encodeMessage(req));
            } catch (e) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(e instanceof Error ? e : new Error(String(e)));
            }
        });
    }

    private notify(method: string, params: unknown): void {
        if (!this.proc) { return; }
        const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params: params ?? undefined };
        try { this.proc.stdin.write(encodeMessage(msg)); } catch { /* ignore */ }
    }

    // -------------------------------------------------------------------------
    // textDocument lifecycle (lazy open)
    // -------------------------------------------------------------------------

    private async openDocument(file: string): Promise<void> {
        const uri = this.fileToUri(file);
        if (this.openDocs.has(uri)) { return; }
        let content: string;
        try {
            content = fs.readFileSync(file, 'utf-8');
        } catch {
            return;
        }
        this.notify('textDocument/didOpen', {
            textDocument: {
                uri,
                languageId: this.languageIdFromExt(file),
                version: 1,
                text: content,
            },
        });
        this.openDocs.add(uri);
    }

    private languageIdFromExt(file: string): string {
        const ext = path.extname(file).toLowerCase();
        if (['.c', '.h'].includes(ext)) { return 'c'; }
        if (['.cu', '.cuh'].includes(ext)) { return 'cuda-cpp'; }
        if (['.m'].includes(ext)) { return 'objective-c'; }
        if (['.mm'].includes(ext)) { return 'objective-cpp'; }
        return 'cpp';
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private fileToUri(file: string): string {
        return 'file://' + this.toForwardSlash(file);
    }

    /** Convert a Windows absolute path to a file:// URI body. */
    private toForwardSlash(p: string): string {
        const fwd = p.replace(/\\/g, '/');
        // file:///C:/Users/... — absolute Windows paths need a leading slash.
        return process.platform === 'win32' && /^[a-zA-Z]:\//.test(fwd) ? '/' + fwd : fwd;
    }

    private normalizeLocations(result: Location | Location[] | null | undefined): Location[] {
        if (!result) { return []; }
        return Array.isArray(result) ? result : [result];
    }
}
