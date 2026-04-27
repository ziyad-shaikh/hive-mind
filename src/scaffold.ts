import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// ─────────────────────────────────────────────────────────────────────────────
// Content templates for scaffolded files
// ─────────────────────────────────────────────────────────────────────────────

const INSTRUCTIONS_CONTENT = `---
description: "Use when modifying code, fixing bugs, refactoring, adding features, or planning changes across files. Provides Hive Mind dependency-graph tools for structural awareness of the codebase."
applyTo: "**"
---

# Hive Mind — AI Agent Instructions

You have access to Hive Mind tools that give you structural awareness of this codebase.
These tools pre-compute the dependency graph, git co-change history, and symbol index
so you don't need to read every file to understand the architecture.

## Tool Selection Guide

| Situation | Tool | Why |
|---|---|---|
| Starting work on any file | \`hivemind_getContext\` | One call returns deps, dependents, tests, co-changed files, symbols. Replaces 5 separate lookups. |
| Planning a multi-file change | \`hivemind_planChange\` | Returns scored file lists: what to modify, read, test, and watch. Don't guess — ask the graph. |
| Searching for code by keyword | \`hivemind_search\` | Like grep but ranks results by structural proximity. Pass \`contextFile\` to bias toward a specific area. |
| Checking what breaks if you change a file | \`hivemind_getImpact\` | Returns all downstream dependents (files that import the target). |
| Finding a function/class/type definition | \`hivemind_findSymbol\` | Searches the symbol index across all indexed files. |
| Checking for circular dependencies | \`hivemind_detectCycles\` | Finds all import cycles — useful before refactoring. |
| Finding test files for a source file | \`hivemind_getTestFiles\` | Finds associated test files by naming convention. |
| Finding files that change together | \`hivemind_coChanged\` | Git history analysis — surfaces implicit coupling. |

## Workflow

1. **Before touching any file:** Call \`hivemind_getContext\` on the target file. Read the context bundle to understand its role.
2. **Before multi-file changes:** Call \`hivemind_planChange\` with a description of what you're doing. Follow its plan.
3. **When searching:** Use \`hivemind_search\` with a \`contextFile\` parameter when you know the neighborhood you care about.
4. **After making changes:** Call \`hivemind_getImpact\` on modified files to verify you haven't missed downstream consumers.
5. **For symbol-level lookups:** Use \`vscode_listCodeUsages\` (language server) for precise references. Use \`hivemind_findSymbol\` when the language server isn't available or you need a broader search.

## Important Notes

- Hive Mind's graph is **structural** (import/include relationships). It does not track runtime dispatch, reflection, or DI wiring.
- For C/C++ codebases, Hive Mind parses \`compile_commands.json\` for include paths. If headers aren't resolving, the project may need a build first.
- The graph is re-indexed on file save. If you create new files, they'll be picked up automatically.
- \`hivemind_search\` searches only indexed files (source code). It won't search node_modules, build outputs, etc.
`;

const SKILL_CONTENT = `---
name: hivemind-workflow
description: "Use when making complex multi-file changes, refactoring across modules, investigating impact of changes, understanding unfamiliar code areas, or onboarding to a new part of the codebase. Orchestrates Hive Mind dependency-graph tools in an optimal sequence."
---

# Hive Mind Workflow

Structured workflow for navigating and modifying large codebases using Hive Mind's dependency graph tools.

## When to Use

- Making changes that span multiple files
- Refactoring a module or interface
- Investigating "what would break if I change X?"
- Onboarding to an unfamiliar area of the codebase
- Tracing a bug across file boundaries

## Procedures

### Investigate a File

1. Call \`hivemind_getContext\` with the file path and a brief task description
2. Review the context bundle — pay attention to:
   - **Exported symbols** — these are the file's public API
   - **Dependents** — these files will break if you change the API
   - **Co-changed files** — these often need coordinated updates
3. If you need the file's source code, call \`hivemind_getContext\` again with \`includeContent: true\`

### Plan a Change

1. Call \`hivemind_planChange\` with the primary file and a description of the change
2. Follow the output categories in order:
   - **Files to Modify** — make changes here
   - **Files to Read** — understand these before changing anything
   - **Tests to Run/Update** — verify these pass after your changes
   - **Possibly Affected** — check these if the change is broad
3. For each file in "Files to Modify", call \`hivemind_getContext\` to understand its specific connections

### Search for Related Code

1. Call \`hivemind_search\` with your search query
2. If you know which area of the codebase you care about, pass \`contextFile\` to boost structurally nearby results
3. For regex patterns, set \`isRegex: true\`
4. Review the structural score column — high scores indicate files that are both text-relevant and architecturally connected

### Verify No Missed Impact

After completing changes:
1. For each modified file, call \`hivemind_getImpact\` with depth 2
2. Cross-reference with the original \`planChange\` output
3. If new files appear that weren't in the plan, investigate them

### Check Architecture Health

1. Call \`hivemind_detectCycles\` to find circular dependencies
2. Call \`hivemind_getFullGraph\` to see the overall structure
3. Look for hub files (many connections) — these are high-risk change targets
`;

const AGENT_CONTENT = `---
name: "Hive Mind"
description: "Use when navigating an unfamiliar codebase, planning multi-file changes, investigating blast radius of a refactor, tracing bugs across file boundaries, or onboarding to a new module. Orchestrates Hive Mind dependency-graph tools for structural codebase analysis."
tools: [read, edit, search, todo, hivemind_getContext, hivemind_planChange, hivemind_getImpact, hivemind_getDependencies, hivemind_search, hivemind_findSymbol, hivemind_detectCycles, hivemind_getTestFiles, hivemind_coChanged, hivemind_getRelatedFiles, hivemind_getFullGraph]
model: "Claude Sonnet 4.5 (Copilot)"
argument-hint: "Describe the task or file you want to investigate"
---

You are the Hive Mind agent — a structural navigation expert for large codebases.
Your primary inputs are the dependency graph, symbol index, and git co-change history
provided by Hive Mind tools. Use them aggressively before reading raw file contents.

## Core Principle

**Graph first, source second.** Never grep a codebase when a graph tool can answer the question faster and with architectural context.

## Constraints

- DO NOT read files at random. Always call \`hivemind_getContext\` on a file before opening it.
- DO NOT guess which files are affected by a change. Call \`hivemind_getImpact\` or \`hivemind_planChange\`.
- DO NOT search for symbols with grep. Use \`hivemind_findSymbol\` first.
- ONLY use \`edit\` tools after you have a complete picture of the change's scope.

## Standard Workflows

### Investigate a File or Module
1. Call \`hivemind_getContext\` — get dependencies, dependents, co-changed files, and exported symbols in one call.
2. Review the context bundle before reading any source.
3. If you need source content, call \`hivemind_getContext\` with \`includeContent: true\`.

### Plan a Multi-File Change
1. Call \`hivemind_planChange\` with the primary file and a description of the change.
2. Work through the plan in order: Files to Read → Files to Modify → Tests to Run.
3. For each file to modify, call \`hivemind_getContext\` to understand its specific connections.

### Trace a Bug Across File Boundaries
1. Identify the entry-point file.
2. Call \`hivemind_getDependencies\` with depth 2–3 to trace the call chain.
3. Use \`hivemind_findSymbol\` to locate specific functions or types.
4. Use \`hivemind_search\` with \`contextFile\` set to bias results toward the relevant module.

### Verify Change Impact
1. For each file you modified, call \`hivemind_getImpact\` with depth 2.
2. Cross-reference with the original \`hivemind_planChange\` output.
3. Investigate any new files that appear but weren't in the plan.

### Detect Architecture Problems
1. Call \`hivemind_detectCycles\` to find circular imports before any refactor.
2. Call \`hivemind_coChanged\` on hub files to surface hidden coupling.
3. Call \`hivemind_getFullGraph\` for an overview when onboarding to an unfamiliar codebase.

## Output Format

- Summarize structural findings (dependency counts, cycle paths, impact lists) in Markdown tables.
- When proposing changes, list affected files with their roles (modifier / reader / test).
- Keep responses concise — show graph data, not raw file dumps.
`;

// ─────────────────────────────────────────────────────────────────────────────
// Scaffold command
// ─────────────────────────────────────────────────────────────────────────────

export async function scaffoldInstructions(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showWarningMessage('Hive Mind: No workspace folder open. Open a folder first.');
        return;
    }

    // If multiple workspace folders, ask which one
    let targetRoot: string;
    if (workspaceFolders.length === 1) {
        targetRoot = workspaceFolders[0].uri.fsPath;
    } else {
        const picked = await vscode.window.showWorkspaceFolderPick({
            placeHolder: 'Select workspace folder to scaffold Hive Mind instructions in',
        });
        if (!picked) { return; }
        targetRoot = picked.uri.fsPath;
    }

    const instructionsDir = path.join(targetRoot, '.github', 'instructions');
    const skillDir = path.join(targetRoot, '.github', 'skills', 'hivemind-workflow');
    const agentsDir = path.join(targetRoot, '.github', 'agents');

    const instructionsFile = path.join(instructionsDir, 'hivemind.instructions.md');
    const skillFile = path.join(skillDir, 'SKILL.md');
    const agentFile = path.join(agentsDir, 'hivemind.agent.md');

    // Check what already exists
    const instructionsExist = fs.existsSync(instructionsFile);
    const skillExists = fs.existsSync(skillFile);
    const agentExists = fs.existsSync(agentFile);

    if (instructionsExist && skillExists && agentExists) {
        const overwrite = await vscode.window.showWarningMessage(
            'Hive Mind instructions, skill, and agent already exist. Overwrite?',
            { modal: true },
            'Overwrite',
            'Cancel'
        );
        if (overwrite !== 'Overwrite') { return; }
    }

    // Create directories
    fs.mkdirSync(instructionsDir, { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });

    // Write files
    const created: string[] = [];

    if (!instructionsExist || (instructionsExist && true)) {
        fs.writeFileSync(instructionsFile, INSTRUCTIONS_CONTENT, 'utf-8');
        created.push('.github/instructions/hivemind.instructions.md');
    }

    if (!skillExists || (skillExists && true)) {
        fs.writeFileSync(skillFile, SKILL_CONTENT, 'utf-8');
        created.push('.github/skills/hivemind-workflow/SKILL.md');
    }

    if (!agentExists || (agentExists && true)) {
        fs.writeFileSync(agentFile, AGENT_CONTENT, 'utf-8');
        created.push('.github/agents/hivemind.agent.md');
    }

    vscode.window.showInformationMessage(
        `Hive Mind: Scaffolded ${created.length} file(s):\n${created.join(', ')}`
    );

    // Open the agent file so the user can review it
    const doc = await vscode.workspace.openTextDocument(agentFile);
    await vscode.window.showTextDocument(doc, { preview: false });
}
