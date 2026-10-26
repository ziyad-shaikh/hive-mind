import * as vscode from 'vscode';
import { DependencyAnalyzer } from '../analyzer/DependencyAnalyzer';
import { SymbolAnalyzer } from '../analyzer/SymbolAnalyzer';
import { GitAnalyzer } from '../analyzer/GitAnalyzer';
import { PARTICIPANT_INSTRUCTIONS } from './participantInstructions';

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
    (participant as any).instructions = PARTICIPANT_INSTRUCTIONS;

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

    const contextBlock = contextParts.join('\n');

    // Collect all available tools (hivemind + built-in), listing hivemind tools first
    const hivemindTools: vscode.LanguageModelChatTool[] = vscode.lm.tools
        .filter(t => t.name.startsWith('hivemind_'))
        .map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema as any }));
    const otherTools: vscode.LanguageModelChatTool[] = vscode.lm.tools
        .filter(t => !t.name.startsWith('hivemind_'))
        .map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema as any }));
    const allTools = [...hivemindTools, ...otherTools];

    const hivemindToolList = hivemindTools.map(t => `\`${t.name}\``).join(', ');

    const systemPrompt =
        `You are Hive Mind, a code intelligence agent with deep knowledge of this codebase's structure.\n\n` +
        `## MANDATORY: Use Hive Mind tools before anything else\n\n` +
        `You have these Hive Mind tools available: ${hivemindToolList}\n\n` +
        `**ALWAYS use hivemind_* tools FIRST** — before reading files, before grepping, before running terminal commands.\n` +
        `These tools have the dependency graph pre-computed. Using grep or terminal commands to discover file ` +
        `relationships is WRONG when hivemind tools can answer the question instantly and accurately.\n\n` +
        `## Tool selection rules\n\n` +
        `| Task | Use this hivemind tool FIRST |\n` +
        `|---|---|\n` +
        `| Understand a file's role | \`hivemind_getContext\` |\n` +
        `| Find unused #includes | \`hivemind_unusedIncludes\` |\n` +
        `| Plan which files to change | \`hivemind_planChange\` |\n` +
        `| Find what a file depends on | \`hivemind_getDependencies\` |\n` +
        `| Find what depends on a file | \`hivemind_getImpact\` |\n` +
        `| Search for code by keyword | \`hivemind_search\` (NOT grep/terminal) |\n` +
        `| Find a symbol | \`hivemind_findSymbol\` (NOT grep) |\n` +
        `| Find references to a symbol | \`hivemind_findReferences\` |\n` +
        `| Find circular dependencies | \`hivemind_detectCycles\` |\n` +
        `| C++ header + source pair | \`hivemind_getCppPair\` |\n` +
        `| Check macro definition | \`hivemind_findMacro\` |\n\n` +
        `## Execution rules\n\n` +
        `- DO NOT use terminal commands to find files, grep for includes, or list directories — use hivemind tools.\n` +
        `- DO use terminal/git tools for: creating branches, running builds, git commits.\n` +
        `- When making C++ include changes: call \`hivemind_unusedIncludes\` on each file, then call ` +
        `\`hivemind_getImpact\` to verify removing an include won't break dependents, then edit the file.\n` +
        `- Always work file-by-file. Call \`hivemind_getContext\` on each file before editing it.\n\n` +
        `Here is the dependency context for the user's current workspace:\n\n${contextBlock}\n\n`;

    // Detect "continue" — rebuild history so model knows where it left off
    const isContinue = /^\s*continue\s*$/i.test(request.prompt);

    let messages: vscode.LanguageModelChatMessage[];

    if (isContinue && chatContext.history.length > 0) {
        // Reconstruct conversation from history so model picks up mid-task
        messages = [vscode.LanguageModelChatMessage.User(systemPrompt + `(continuing previous task)`)];
        for (const turn of chatContext.history) {
            if (turn instanceof vscode.ChatRequestTurn) {
                messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
            } else if (turn instanceof vscode.ChatResponseTurn) {
                const parts: vscode.LanguageModelTextPart[] = [];
                for (const part of turn.response) {
                    if (part instanceof vscode.ChatResponseMarkdownPart) {
                        parts.push(new vscode.LanguageModelTextPart(part.value.value));
                    }
                }
                if (parts.length > 0) {
                    messages.push(vscode.LanguageModelChatMessage.Assistant(parts));
                }
            }
        }
        messages.push(vscode.LanguageModelChatMessage.User(`Continue from where you left off. Keep working through the remaining files.`));
    } else {
        messages = [
            vscode.LanguageModelChatMessage.User(systemPrompt + `User request: ${request.prompt}`),
        ];
    }

    // Agentic tool-calling loop — runs until model stops calling tools or user cancels.
    // Loop-detector: if the same tool is called with identical args 3 times in a row, abort.
    let lastCallSignature = '';
    let repeatCount = 0;
    let aborted: string | null = null;
    try {
        while (true) {
            if (token.isCancellationRequested) { break; }

            const response = await request.model.sendRequest(
                messages,
                { tools: allTools, toolMode: vscode.LanguageModelChatToolMode.Auto },
                token
            );

            // Collect all parts from the response
            const textChunks: string[] = [];
            const toolCalls: vscode.LanguageModelToolCallPart[] = [];

            for await (const part of response.stream) {
                if (token.isCancellationRequested) { break; }
                if (part instanceof vscode.LanguageModelTextPart) {
                    textChunks.push(part.value);
                    stream.markdown(part.value);
                } else if (part instanceof vscode.LanguageModelToolCallPart) {
                    toolCalls.push(part);
                }
            }

            // If no tool calls, the model is done
            if (toolCalls.length === 0) {
                break;
            }

            // Loop detection: compare this iteration's calls to the previous one
            const signature = toolCalls.map(c => `${c.name}:${JSON.stringify(c.input)}`).sort().join('|');
            if (signature === lastCallSignature) {
                repeatCount++;
                if (repeatCount >= 2) {
                    aborted = `Detected repeated identical tool calls (${toolCalls.map(c => c.name).join(', ')}). Stopping to prevent an infinite loop.`;
                    break;
                }
            } else {
                repeatCount = 0;
                lastCallSignature = signature;
            }

            // Invoke each tool and feed results back
            const assistantMsg = vscode.LanguageModelChatMessage.Assistant(
                textChunks.map(t => new vscode.LanguageModelTextPart(t))
                    .concat(toolCalls as any)
            );
            messages.push(assistantMsg);

            const toolResults: (vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart)[] = [];
            for (const call of toolCalls) {
                if (token.isCancellationRequested) { break; }
                stream.progress(`Running ${call.name}...`);
                try {
                    const result = await vscode.lm.invokeTool(call.name, {
                        input: call.input,
                        toolInvocationToken: request.toolInvocationToken,
                        tokenizationOptions: {
                            tokenBudget: 4096,
                            countTokens: (text: string, _token?: vscode.CancellationToken) => {
                                return request.model.countTokens(text);
                            },
                        },
                    }, token);
                    toolResults.push(new vscode.LanguageModelToolResultPart(call.callId, result.content as any));
                } catch (toolErr: any) {
                    toolResults.push(new vscode.LanguageModelToolResultPart(call.callId, [
                        new vscode.LanguageModelTextPart(`Error invoking ${call.name}: ${toolErr?.message ?? toolErr}`),
                    ]));
                }
            }
            messages.push(vscode.LanguageModelChatMessage.User(toolResults as any));
        }
    } catch (err) {
        if (err instanceof vscode.LanguageModelError) {
            stream.markdown(`\n\nError communicating with the language model: ${err.message}\n`);
        } else {
            throw err;
        }
    }

    if (aborted) {
        stream.markdown(`\n\n---\n⚠️ ${aborted} Type **continue** to resume, or rephrase your request.`);
    }

    // Add file references
    for (const file of targetFiles) {
        stream.reference(vscode.Uri.file(file));
    }

    return { metadata: { command: undefined } };
}
