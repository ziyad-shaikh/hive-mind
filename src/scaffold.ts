import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// ─────────────────────────────────────────────────────────────────────────────
// Instruction file templates (no agents, no skills — just instructions)
// ─────────────────────────────────────────────────────────────────────────────

const GENERAL_INSTRUCTIONS = `---
description: "Use when modifying code, fixing bugs, refactoring, adding features, or planning changes across files. Provides Hive Mind dependency-graph tools for structural awareness of the codebase."
applyTo: "**"
---

# Hive Mind — Tool Usage Instructions

You have access to Hive Mind tools that give you structural awareness of this codebase.
These tools pre-compute the dependency graph, git co-change history, and symbol index
so you don't need to read every file to understand the architecture.

## Behavioral Principles

1. **Think Before Acting** — State assumptions, surface tradeoffs. When impact is large (>20 files), pause and summarize before editing.
2. **Simplicity First** — Use \`hivemind_getContext\` (one call replaces 5 lookups). Don't over-explore once the graph gives a clear answer.
3. **Surgical Changes** — Touch only what you must. The graph shows exact affected files — don't guess or sweep broadly.
4. **Goal-Driven Execution** — Define success criteria, verify with graph tools after changes, name the build target or test to run.

## Tool Selection Guide

| Situation | Tool | Why |
|---|---|---|
| Starting work on any file | \`hivemind_getContext\` | One call returns deps, dependents, tests, co-changed files, symbols. |
| Planning a multi-file change | \`hivemind_planChange\` | Returns scored file lists: modify, read, test, watch. |
| Searching for code by keyword | \`hivemind_search\` | Ranks results by structural proximity. Pass \`contextFile\` to bias. |
| What breaks if I change a file | \`hivemind_getImpact\` | All downstream dependents. |
| Finding a symbol definition | \`hivemind_findSymbol\` | Cross-workspace symbol index search. |
| Circular dependencies | \`hivemind_detectCycles\` | All import cycles. |
| Test files for a source file | \`hivemind_getTestFiles\` | By naming convention and proximity. |
| Files that change together | \`hivemind_coChanged\` | Git history co-change coupling. |
| Unused includes (C/C++) | \`hivemind_unusedIncludes\` | Cross-references header symbols vs source identifiers. |
| CodeQL / SAST alerts | \`hivemind_getCodeQLAlerts\` | Local SARIF or GitHub Code Scanning API. |
| CI build warnings | \`hivemind_getCIWarnings\` | Annotations from latest GitHub Actions run. |

## Workflow

1. **Before touching any file:** \`hivemind_getContext\` on the target.
2. **Before multi-file changes:** \`hivemind_planChange\` with a description. Follow its plan.
3. **When searching:** \`hivemind_search\` with \`contextFile\` when you know the neighborhood.
4. **After changes:** \`hivemind_getImpact\` on modified files to verify no missed consumers.

## Notes

- The graph is **structural** (import/include). It does not track runtime dispatch, reflection, or DI wiring.
- For C/C++, includes resolve via \`compile_commands.json\` → active project profile → workspace heuristics.
- The graph re-indexes on file save. New files are picked up automatically.
- \`hivemind_search\` searches only indexed source files, not build outputs.
`;

const CPP_INSTRUCTIONS = `---
description: "Use when modifying any C, C++, Objective-C, or CUDA source. Encodes rules for working with macro-heavy, header-driven, large native codebases using Hive Mind's C++-specific tools."
applyTo: "**/*.{c,cc,cpp,cxx,c++,cu,m,mm,h,hh,hpp,hxx,h++,cuh,inl,ipp,tpp,tcc}"
---

# C/C++ — Hive Mind Rules

Native code has failure modes that don't exist in managed languages. Follow these rules without exception.

## Five Hard Rules

### 1. Always pair the header with the source
Before editing any \`.cpp\`/\`.h\`, call \`hivemind_getCppPair\`. If you change a signature in one, update the other.

### 2. Treat headers as high-blast-radius
Before editing any \`.h\`/\`.hpp\`, call \`hivemind_getImpact\`. If >20 dependents, stop and ask the user.

### 3. SCREAMING_SNAKE_CASE → check for a macro first
Call \`hivemind_findMacro\` on any uppercase identifier before assuming it's a function. Use \`hivemind_macroExpand\` for the actual expansion at a call site.

### 4. \`#ifdef\` makes grep lie
Call \`hivemind_findSymbol\` to find ALL definitions. Apply changes consistently to every active variant.

### 5. Test the build narrowly
Use \`hivemind_buildSubset\` on the changed file for syntax-only compilation across its impact set.

## C/C++ Tool Cheat Sheet

| Situation | Tool |
|---|---|
| Starting on any .cpp/.h | \`hivemind_getCppPair\` + \`hivemind_getContext\` |
| About to edit a header | \`hivemind_getImpact\` (depth 2) — stop if >20 |
| Uppercase token | \`hivemind_findMacro\` (exact:true) |
| Renaming a symbol | \`hivemind_findReferences\` (confidence-tagged) |
| Virtual method | \`hivemind_findOverrides\` |
| Function callers/callees | \`hivemind_callHierarchy\` |
| Modifying a base class | \`hivemind_typeHierarchy\` (subtypes) |
| Actual macro expansion | \`hivemind_macroExpand\` |
| Verify build after refactor | \`hivemind_buildSubset\` |

## Refactor Protocol

### Phase 1 — Investigate
1. \`hivemind_getCppPair\` + \`hivemind_getContext\` on the primary file.
2. For renames: \`hivemind_findReferences\` (note confidence flags).
3. For virtual methods: \`hivemind_findOverrides\`.
4. For class changes: \`hivemind_typeHierarchy\` (subtypes, depth 2).
5. For signature changes: \`hivemind_callHierarchy\` (incoming).
6. For macros: \`hivemind_findMacro\` + \`hivemind_macroExpand\`.
7. Summarize findings before editing.

### Phase 2 — Plan
1. \`hivemind_planChange\` with description.
2. \`hivemind_getCppPair\` on every modify-list file.
3. \`hivemind_getImpact\` on every header in the modify list.
4. Show plan, ask for confirmation.

### Phase 3 — Execute
Source files first, then headers. Keep edits minimal.

### Phase 4 — Verify
1. \`hivemind_findReferences\` on old name → expect zero.
2. \`hivemind_buildSubset\` → review pass/fail per TU.
3. \`hivemind_getTestFiles\` → list tests to run.

## Known Limitations

- Conditional compilation: only active config's \`#ifdef\` branches are indexed.
- Dynamic loading: \`dlopen\`/\`LoadLibrary\` not visible in graph.
- Template instantiations: not tracked across TUs.
- Function pointers/callbacks: not covered by \`findOverrides\`.
- Macro-generated symbols: use \`macroExpand\` at call site.

When you hit a gap, fall back to manual reading and state your assumption.
`;

// ─────────────────────────────────────────────────────────────────────────────
// Scaffold command — writes .github/instructions/ only
// ─────────────────────────────────────────────────────────────────────────────

export async function scaffoldInstructions(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showWarningMessage('Hive Mind: No workspace folder open. Open a folder first.');
        return;
    }

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
    const generalFile = path.join(instructionsDir, 'hivemind.instructions.md');
    const cppFile = path.join(instructionsDir, 'cpp.instructions.md');

    // Check what already exists
    if (fs.existsSync(generalFile) && fs.existsSync(cppFile)) {
        const overwrite = await vscode.window.showWarningMessage(
            'Hive Mind instruction files already exist. Overwrite?',
            { modal: true },
            'Overwrite',
            'Cancel'
        );
        if (overwrite !== 'Overwrite') { return; }
    }

    fs.mkdirSync(instructionsDir, { recursive: true });
    fs.writeFileSync(generalFile, GENERAL_INSTRUCTIONS, 'utf-8');
    fs.writeFileSync(cppFile, CPP_INSTRUCTIONS, 'utf-8');

    vscode.window.showInformationMessage(
        'Hive Mind: Scaffolded .github/instructions/hivemind.instructions.md and cpp.instructions.md'
    );

    const doc = await vscode.workspace.openTextDocument(generalFile);
    await vscode.window.showTextDocument(doc, { preview: false });
}
