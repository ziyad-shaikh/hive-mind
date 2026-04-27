# Hive Mind — Development Instructions

## Project Overview

Hive Mind is a VS Code extension that pre-computes a dependency graph of any workspace and exposes it to AI agents via Language Model (LM) tools. The primary target is **massive C and C++ codebases** (10k–1M+ files). All languages are supported, but C/C++ is the priority — every design decision should be evaluated through the lens of "does this work well for a 100k-file C++ runtime with fragmented headers and no language server?"

## Architecture

```
src/
├── extension.ts                    # Activation, command registration, wiring
├── scaffold.ts                     # Scaffolds .github/ instructions + skills into user workspaces
├── analyzer/
│   ├── DependencyAnalyzer.ts       # Core graph engine — parsing, resolution, BFS, serialization
│   ├── SymbolAnalyzer.ts           # VS Code document symbol indexing
│   └── GitAnalyzer.ts              # Git log parsing, co-change matrix
├── chat/
│   └── HiveMindParticipant.ts      # @hivemind chat participant (/impact, /deps, /cycles)
├── graph/
│   └── GraphPanel.ts               # Canvas-based schema-diagram WebView
└── tools/
    └── index.ts                    # All 11 Copilot LM tools
```

### Key Files

- **DependencyAnalyzer.ts** (~1200 lines) — The most critical file. Contains all language parsers (regex-based), import resolution for 15+ languages, the `headerIndex` for C/C++, `compile_commands.json` parsing, include path discovery, BFS graph traversal, and serialization. **Most changes land here.**
- **tools/index.ts** (~900 lines) — All LM tool implementations. Each tool is a class implementing `vscode.LanguageModelTool<T>` with an `invoke()` method returning `LanguageModelToolResult`. Registration happens in `registerTools()` at the bottom.
- **GraphPanel.ts** (~615 lines) — Self-contained WebView. Generates full HTML/CSS/JS in `getHtml()`. Static hierarchical layout, not force-directed.

## Build & Run

```bash
npm install          # Install dependencies
npm run compile      # Compile TypeScript → out/
npx tsc -p ./        # Same as above, useful for quick checks
```

Press **F5** to launch the Extension Development Host (debug mode).

Package for distribution:
```bash
npx @vscode/vsce package --allow-missing-repository
```

## C/C++ is the Priority

This extension exists primarily to solve C/C++ dependency analysis at scale. When making any change, consider:

### Header Resolution Pipeline

The C/C++ header resolution in `DependencyAnalyzer.ts` follows this order:

1. **Relative path** — `#include "foo.h"` → resolve relative to the including file's directory
2. **Include paths** — Search paths from `compile_commands.json` (`-I`, `-isystem` flags) and common directories (`include/`, `src/`, `third_party/`, etc.)
3. **Relative path in index** — Match the full include path (e.g., `net/socket.h`) against workspace-relative paths
4. **Basename with disambiguation** — Match by filename alone; if multiple files share the basename, pick the one closest to the including file (longest common path prefix)

### compile_commands.json

The analyzer searches for `compile_commands.json` in: root, `build/`, `out/`, `cmake-build-debug/`, `cmake-build-release/`. It extracts `-I` and `-isystem` include paths. This is the most reliable way to resolve angle-bracket includes in large C/C++ projects.

### What Doesn't Work Yet (C/C++ Gaps)

Consult `ROADMAP.md` for the full list, but key gaps:

- **Macros** — `#define` can generate includes, function calls, anything. We'd need a preprocessor pass.
- **Conditional compilation** — `#ifdef` branches are mutually exclusive. `compile_commands.json` provides `-D` flags but we don't use them yet.
- **Virtual dispatch** — `base->doThing()` — which concrete implementation? Needs type analysis.
- **Dynamic loading** — `dlopen()`, `LoadLibrary()` — runtime resolution, can't trace statically.
- **Cross-language bindings** — pybind11, N-API, JNI — not yet detected.

When implementing new features, always test against C/C++ scenarios first. If a feature only works for TypeScript/JavaScript, it's incomplete.

## Coding Patterns

### LM Tool Pattern

Every tool follows this exact structure:

```typescript
interface MyToolInput { filePath: string; /* ... */ }

class MyTool implements vscode.LanguageModelTool<MyToolInput> {
    constructor(private readonly analyzer: DependencyAnalyzer /*, ... */) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<MyToolInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { filePath } = options.input;
        const resolved = this.analyzer.resolveFilePath(filePath);
        if (!resolved) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`⚠️ File "${filePath}" not found in index.`),
            ]);
        }
        // ... tool logic ...
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(markdownOutput),
        ]);
    }
}
```

Then register in `registerTools()` and add `languageModelTools` entry in `package.json`.

### File Resolution

Always use `this.analyzer.resolveFilePath(input)` to normalize file paths. It handles relative paths, absolute paths, and fuzzy basename matching. Never use raw file paths from tool input directly.

### Output Format

All tool outputs are **Markdown**. Use tables for structured data, bullet lists for file lists. Include counts in headers (e.g., `## Files That Import This (14)`). Keep outputs concise — agents have limited context windows.

## Testing Changes

1. **Compile first:** `npx tsc -p ./` — must produce zero errors
2. **F5 debug:** Open a test workspace (ideally a C/C++ project) and verify tools work via Copilot Chat
3. **Check the Output panel:** "Hive Mind" channel shows indexing stats, include paths discovered, and edge counts
4. **Verify C/C++ resolution:** Open a `.cpp` file, use `@hivemind /deps` — confirm headers resolve correctly

## Do NOT

- Add external runtime dependencies. The extension must be zero-dependency (only `vscode` and `fs`/`path` from Node).
- Use `vscode.workspace.findTextInFiles` — it's not in the stable API for our minimum VS Code version (1.87.0).
- Break the `headerIndex` type (`Map<string, string[]>`) — it's intentionally an array to handle basename collisions in large C/C++ codebases.
- Add force-directed physics to the graph. The schema-diagram layout is intentional and final.
- Ignore the `.vscodeignore` when packaging — `out/` must be included, `src/` must be excluded.

## Key APIs

| Method | File | Purpose |
|--------|------|---------|
| `analyzer.resolveFilePath(path)` | DependencyAnalyzer | Normalize any path input to absolute |
| `analyzer.getRelatedFiles(path)` | DependencyAnalyzer | `{ dependencies, dependents }` |
| `analyzer.getDependencies(path, depth)` | DependencyAnalyzer | Transitive imports |
| `analyzer.getImpact(path, depth)` | DependencyAnalyzer | Transitive dependents |
| `analyzer.getTestFiles(path)` | DependencyAnalyzer | Associated test files |
| `analyzer.getAllFilePaths()` | DependencyAnalyzer | Every indexed file (absolute paths) |
| `analyzer.toRelative(absPath)` | DependencyAnalyzer | Convert to workspace-relative display path |
| `analyzer.getNodeCount()` | DependencyAnalyzer | Number of indexed files |
| `symbolAnalyzer.getExportedSymbols(path)` | SymbolAnalyzer | Top-level exports of a file |
| `symbolAnalyzer.findSymbol(name)` | SymbolAnalyzer | Cross-workspace symbol search |
| `gitAnalyzer.getCoChangedFiles(path)` | GitAnalyzer | Files with high co-change coupling |
