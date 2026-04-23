import * as vscode from 'vscode';
import { DependencyAnalyzer } from '../analyzer/DependencyAnalyzer';
import { SymbolAnalyzer } from '../analyzer/SymbolAnalyzer';
import { GitAnalyzer } from '../analyzer/GitAnalyzer';

interface HiveMindChatResult extends vscode.ChatResult {
    metadata?: { command?: string };
}

export function registerChatParticipant(
    context: vscode.ExtensionContext,
    analyzer: DependencyAnalyzer,
    symbolAnalyzer: SymbolAnalyzer,
    gitAnalyzer: GitAnalyzer
): void {
    const handler: vscode.ChatRequestHandler = async (
        request: vscode.ChatRequest,
        chatContext: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<HiveMindChatResult> => {
        // Determine target file(s) from references or active editor
        const targetFiles = resolveTargetFiles(request, analyzer);

        if (request.command === 'impact') {
            return await handleImpact(targetFiles, request, stream, token, analyzer, gitAnalyzer);
        }
        if (request.command === 'deps') {
            return await handleDeps(targetFiles, request, stream, token, analyzer);
        }
        if (request.command === 'cycles') {
            return await handleCycles(request, stream, token, analyzer);
        }

        // Default: auto-context mode — gather context and augment prompt
        return await handleFreeform(targetFiles, request, chatContext, stream, token, analyzer, symbolAnalyzer, gitAnalyzer);
    };

    const participant = vscode.chat.createChatParticipant('hivemind.hivemind', handler);
    participant.iconPath = new vscode.ThemeIcon('pulse');

    participant.followupProvider = {
        provideFollowups(result: HiveMindChatResult, _context: vscode.ChatContext, _token: vscode.CancellationToken) {
            const followups: vscode.ChatFollowup[] = [];
            if (result.metadata?.command !== 'impact') {
                followups.push({ prompt: 'What files would be affected if I change this file?', command: 'impact' });
            }
            if (result.metadata?.command !== 'deps') {
                followups.push({ prompt: 'Show me what this file depends on', command: 'deps' });
            }
            if (result.metadata?.command !== 'cycles') {
                followups.push({ prompt: 'Are there any circular dependencies?', command: 'cycles' });
            }
            return followups;
        }
    };

    context.subscriptions.push(participant);
}

// ---------------------------------------------------------------------------
// Resolve target files from request references or active editor
// ---------------------------------------------------------------------------

function resolveTargetFiles(request: vscode.ChatRequest, analyzer: DependencyAnalyzer): string[] {
    const files: string[] = [];

    // Check #file references in the prompt
    for (const ref of request.references) {
        if (ref.value instanceof vscode.Uri) {
            const resolved = analyzer.resolveFilePath(ref.value.fsPath);
            if (resolved) { files.push(resolved); }
        } else if (ref.value && typeof ref.value === 'object' && 'uri' in ref.value) {
            const loc = ref.value as vscode.Location;
            const resolved = analyzer.resolveFilePath(loc.uri.fsPath);
            if (resolved) { files.push(resolved); }
        }
    }

    // Fall back to active editor
    if (files.length === 0) {
        const activeUri = vscode.window.activeTextEditor?.document.uri;
        if (activeUri && activeUri.scheme === 'file') {
            const resolved = analyzer.resolveFilePath(activeUri.fsPath);
            if (resolved) { files.push(resolved); }
        }
    }

    return [...new Set(files)];
}

// ---------------------------------------------------------------------------
// /impact command
// ---------------------------------------------------------------------------

async function handleImpact(
    targetFiles: string[],
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    analyzer: DependencyAnalyzer,
    gitAnalyzer: GitAnalyzer
): Promise<HiveMindChatResult> {
    if (targetFiles.length === 0) {
        stream.markdown('No file in focus. Open a file or reference one with `#file` to analyze its impact.');
        return { metadata: { command: 'impact' } };
    }

    for (const file of targetFiles) {
        if (token.isCancellationRequested) { break; }
        const rel = analyzer.toRelative(file);
        stream.progress(`Analyzing impact of ${rel}...`);

        const impacted = analyzer.getImpact(file, 3);
        const testFiles = analyzer.getTestFiles(file);
        const coChanged = gitAnalyzer.getCoChangedFiles(file);

        stream.markdown(`## Impact Analysis: \`${rel}\`\n\n`);

        if (impacted.length === 0 && testFiles.length === 0 && coChanged.length === 0) {
            stream.markdown('No downstream impact detected. This file is not imported by other files in the workspace.\n');
        } else {
            if (impacted.length > 0) {
                stream.markdown(`### Downstream Dependencies (${impacted.length} files)\n`);
                stream.markdown('These files import this file directly or transitively and may need updates:\n\n');
                for (const f of impacted) {
                    stream.reference(vscode.Uri.file(f));
                    stream.markdown(`- \`${analyzer.toRelative(f)}\`\n`);
                }
                stream.markdown('\n');
            }

            if (testFiles.length > 0) {
                stream.markdown(`### Related Test Files (${testFiles.length})\n`);
                stream.markdown('These tests should be re-run after changes:\n\n');
                for (const f of testFiles) {
                    stream.reference(vscode.Uri.file(f));
                    stream.markdown(`- \`${analyzer.toRelative(f)}\`\n`);
                }
                stream.markdown('\n');
            }

            if (coChanged.length > 0) {
                stream.markdown(`### Historically Co-Changed Files\n`);
                stream.markdown('These files frequently change together in git history:\n\n');
                for (const entry of coChanged.slice(0, 10)) {
                    stream.markdown(`- \`${analyzer.toRelative(entry.file)}\` (${entry.coChangeCount} co-changes, ${Math.round(entry.ratio * 100)}% coupling)\n`);
                }
                stream.markdown('\n');
            }
        }
    }

    return { metadata: { command: 'impact' } };
}

// ---------------------------------------------------------------------------
// /deps command
// ---------------------------------------------------------------------------

async function handleDeps(
    targetFiles: string[],
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    analyzer: DependencyAnalyzer
): Promise<HiveMindChatResult> {
    if (targetFiles.length === 0) {
        stream.markdown('No file in focus. Open a file or reference one with `#file` to show its dependencies.');
        return { metadata: { command: 'deps' } };
    }

    for (const file of targetFiles) {
        if (token.isCancellationRequested) { break; }
        const rel = analyzer.toRelative(file);
        stream.progress(`Resolving dependencies of ${rel}...`);

        const deps = analyzer.getDependencies(file, 2);
        const { dependents } = analyzer.getRelatedFiles(file);

        stream.markdown(`## Dependencies: \`${rel}\`\n\n`);

        if (deps.length > 0) {
            stream.markdown(`### This file imports (${deps.length})\n`);
            for (const f of deps) {
                stream.reference(vscode.Uri.file(f));
                stream.markdown(`- \`${analyzer.toRelative(f)}\`\n`);
            }
            stream.markdown('\n');
        } else {
            stream.markdown('This file has no resolved workspace dependencies.\n\n');
        }

        if (dependents.length > 0) {
            stream.markdown(`### Imported by (${dependents.length})\n`);
            for (const f of dependents) {
                stream.reference(vscode.Uri.file(f));
                stream.markdown(`- \`${analyzer.toRelative(f)}\`\n`);
            }
            stream.markdown('\n');
        } else {
            stream.markdown('No other files in the workspace import this file.\n\n');
        }
    }

    return { metadata: { command: 'deps' } };
}

// ---------------------------------------------------------------------------
// /cycles command
// ---------------------------------------------------------------------------

async function handleCycles(
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    analyzer: DependencyAnalyzer
): Promise<HiveMindChatResult> {
    stream.progress('Detecting circular dependencies...');
    const cycles = analyzer.detectCycles();

    if (cycles.length === 0) {
        stream.markdown('No circular dependencies detected in the workspace.\n');
    } else {
        stream.markdown(`## Circular Dependencies (${cycles.length} found)\n\n`);
        for (let i = 0; i < cycles.length; i++) {
            if (token.isCancellationRequested) { break; }
            stream.markdown(`${i + 1}. ${cycles[i].files.map(f => `\`${f}\``).join(' → ')} → ↩\n`);
        }
        stream.markdown('\nCircular dependencies can cause issues with tree-shaking, incremental builds, and testability. ');
        stream.markdown('Consider extracting shared code into a separate module to break these cycles.\n');
    }

    return { metadata: { command: 'cycles' } };
}

// ---------------------------------------------------------------------------
// Freeform (no command) — auto-context + LLM
// ---------------------------------------------------------------------------

async function handleFreeform(
    targetFiles: string[],
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    analyzer: DependencyAnalyzer,
    symbolAnalyzer: SymbolAnalyzer,
    gitAnalyzer: GitAnalyzer
): Promise<HiveMindChatResult> {
    stream.progress('Gathering dependency context...');

    // Build context preamble
    const contextParts: string[] = [];

    // Workspace overview
    const stats = analyzer.getStats();
    contextParts.push(
        `## Workspace Overview`,
        `- ${stats.totalFiles} files indexed, ${stats.totalEdges} dependency edges`,
        `- ${stats.circularDeps} circular dependencies`,
        `- Languages: ${Object.entries(stats.languages).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([l, c]) => `${l} (${c})`).join(', ')}`,
        ``
    );

    // Per-file context
    for (const file of targetFiles.slice(0, 3)) {
        const rel = analyzer.toRelative(file);
        const deps = analyzer.getDependencies(file, 2);
        const impacted = analyzer.getImpact(file, 2);
        const testFiles = analyzer.getTestFiles(file);
        const coChanged = gitAnalyzer.getCoChangedFiles(file);
        const symbols = symbolAnalyzer.getFileSymbols(file);

        contextParts.push(`## File: ${rel}`);

        if (deps.length > 0) {
            contextParts.push(`**Imports:** ${deps.map(f => analyzer.toRelative(f)).join(', ')}`);
        }
        if (impacted.length > 0) {
            contextParts.push(`**Imported by:** ${impacted.map(f => analyzer.toRelative(f)).join(', ')}`);
        }
        if (testFiles.length > 0) {
            contextParts.push(`**Test files:** ${testFiles.map(f => analyzer.toRelative(f)).join(', ')}`);
        }
        if (coChanged.length > 0) {
            contextParts.push(`**Historically co-changed with:** ${coChanged.slice(0, 5).map(e => analyzer.toRelative(e.file)).join(', ')}`);
        }
        if (symbols.length > 0) {
            const topSymbols = symbols.slice(0, 20).map(s => `${s.name} (${vscode.SymbolKind[s.kind]})`).join(', ');
            contextParts.push(`**Symbols:** ${topSymbols}`);
        }
        contextParts.push('');
    }

    // Send augmented prompt to LLM
    const contextBlock = contextParts.join('\n');
    const messages: vscode.LanguageModelChatMessage[] = [
        vscode.LanguageModelChatMessage.User(
            `You are Hive Mind, an expert code dependency analysis assistant. You help developers understand how their codebase is connected and what the impact of changes will be.\n\n` +
            `Here is the dependency context for the user's current workspace:\n\n${contextBlock}\n\n` +
            `Answer the user's question using this context. Reference specific files and relationships when relevant. Be concise and actionable.\n\n` +
            `User question: ${request.prompt}`
        ),
    ];

    // Add relevant history
    const previousMessages = chatContext.history.filter(h => h instanceof vscode.ChatRequestTurn);
    if (previousMessages.length > 0) {
        const lastFew = previousMessages.slice(-3);
        for (const turn of lastFew) {
            const reqTurn = turn as vscode.ChatRequestTurn;
            messages.unshift(vscode.LanguageModelChatMessage.User(`Previous question: ${reqTurn.prompt}`));
        }
    }

    try {
        const response = await request.model.sendRequest(messages, {}, token);

        for await (const chunk of response.text) {
            if (token.isCancellationRequested) { break; }
            stream.markdown(chunk);
        }
    } catch (err) {
        if (err instanceof vscode.LanguageModelError) {
            stream.markdown(`Sorry, I encountered an error communicating with the language model: ${err.message}\n`);
        } else {
            throw err;
        }
    }

    // Add file references
    for (const file of targetFiles) {
        stream.reference(vscode.Uri.file(file));
    }

    return { metadata: { command: undefined } };
}
