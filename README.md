# Hive Mind

> A VS Code extension that gives GitHub Copilot **structural awareness** of your codebase — what imports what, what breaks when something changes, what files change together — without reading every file.

Hive Mind pre-computes the dependency graph, symbol index, and git co-change history of your workspace once, then exposes that knowledge to AI agents through **17 first-class language-model tools**, an interactive **dependency graph webview**, a **module-level architecture view**, a **co-change heat map**, and a `@hivemind` chat participant.

It is purpose-built for **large, polyglot, C/C++-heavy codebases** where naïve grep-and-read agents fall over. It ships with a built-in profile for the [Sage X3 Runtime](https://www.sage.com/en-us/products/sage-x3/) — but the architecture is generic, and adding a new profile is a single JSON file.

---

## Why this exists

AI agents are great at code they can see — and lost on code they can't. In a 10k-file C++ workspace, an agent that has to grep for every symbol and read every file makes mistakes a structural analyzer would catch instantly:

- **Header refactor breaks 50 TUs.** Grep didn't surface them.
- **Virtual method changed.** Three subclasses still override the old signature.
- **Macro renamed.** It expanded into a function name in 12 call sites — none visible to grep.
- **Build variant edited.** The change accidentally landed in the Oracle backend's exclusive sources.

Hive Mind closes these gaps. Each tool is designed to be one structurally-aware call instead of N grep-and-read round trips.

---

## Highlights

### 17 Copilot LM Tools

The agent-facing tool surface, grouped by what they do:

| Category | Tools |
|---|---|
| **Bundled context** | `hivemind_getContext` · `hivemind_planChange` |
| **Graph navigation** | `hivemind_getDependencies` · `hivemind_getImpact` · `hivemind_getRelatedFiles` · `hivemind_getFullGraph` · `hivemind_detectCycles` · `hivemind_getTestFiles` |
| **Symbol search** | `hivemind_findSymbol` · `hivemind_search` · `hivemind_coChanged` |
| **C/C++ specific** | `hivemind_getCppPair` · `hivemind_findMacro` · `hivemind_findReferences` · `hivemind_findOverrides` · `hivemind_callHierarchy` · `hivemind_typeHierarchy` · `hivemind_macroExpand` · `hivemind_buildSubset` |

The C/C++ tools work without any LSP — they use a built-in tree-sitter index plus your project's profile (or `compile_commands.json` if present). No clangd required.

See `HOW-TO.md` for example I/O for every tool.

### Interactive Dependency Graph

Pan/zoom canvas showing the dependency graph centered on any file, with depth controls, hover highlighting, click-to-navigate, and live updates as you save files.

### Module Graph (profile-driven)

Aggregates the file-level graph into module-level nodes and edges using the active project profile's `modulePattern`. For Sage X3, this turns 431 source files into 25 module bubbles connected by aggregated #include traffic — a single picture of the runtime's architecture.

Click a module to inspect its triplet (`<m>ext.h` / `<m>in.h` / `src/<m>*.cpp`) and the file list, grouped by extension.

### Co-Change Heat Map

Files that historically change together with the active file, scored by git history. Surfaces hidden coupling that the import graph cannot show.

### `@hivemind` Chat Participant

Use `@hivemind` in Copilot Chat with these slash commands:
- `/impact` — downstream impact for the current file
- `/deps` — import tree
- `/cycles` — circular dependency report

Or just ask freeform questions about the codebase architecture.

### Built-in project profiles

Hive Mind ships with a curated profile for the **Sage X3 Runtime** — encoding 5 build configurations, 25 known modules, 4 build variants (Oracle / PostgreSQL / ODBC / LDAP backends), umbrella headers, generated headers, and grammar prologue conventions. Adding a profile for another project is a single JSON file.

---

## Installation

### Option 1 — Install a release `.vsix` (recommended)

1. Go to the repository's **Releases** page and download the latest `.vsix`.
2. In VS Code, open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) → **Extensions: Install from VSIX...** → select the file.

Or from the terminal:

```bash
code --install-extension hive-mind-0.1.0.vsix
```

### Option 2 — Build from source

**Prerequisites:** Node.js 20+, npm, Git.

```bash
git clone <repository-url>
cd hive-mind
npm install
npm run compile
npm test                                 # 16 tests, ~10 s
npx @vscode/vsce package --allow-missing-repository
code --install-extension hive-mind-0.1.0.vsix
```

### Option 3 — Run in development

Press `F5` in VS Code with this repo open. A new "Extension Development Host" window launches with Hive Mind installed.

---

## Quick start

After installing:

1. Open any large workspace.
2. Wait a few seconds for indexing — watch the status bar tick from `Indexing...` to `N files · M edges`.
3. Open the Command Palette and try:
   - **Hive Mind: Show Full Code Graph** — interactive dependency graph
   - **Hive Mind: Show Module Graph** — module-level view (requires an active profile)
   - **Hive Mind: Show Co-Change Heat Map** — git-coupling view
   - **Hive Mind: Scaffold AI Instructions & Skills** — generates `.github/instructions/`, `.github/skills/`, `.github/agents/` files so Copilot uses Hive Mind tools correctly

For Copilot tool usage, the scaffolded instructions teach the agent when to call each tool. You can also pin a tool reference manually with `#hivemindContext`, `#hivemindPlan`, `#hivemindImpact`, etc.

See `HOW-TO.md` for the full developer guide.

---

## Commands

| Command | Description |
|---|---|
| `Hive Mind: Show Full Code Graph` | Interactive dependency graph webview |
| `Hive Mind: Focus Graph on Current File` | Graph centered on the active file |
| `Hive Mind: Show Module Graph (profile-driven)` | Module-level architecture view |
| `Hive Mind: Show Co-Change Heat Map` | Files that change together via git history |
| `Hive Mind: Re-analyze Workspace` | Force a full re-index |
| `Hive Mind: Show Workspace Stats` | File counts, hubs, cycles, language breakdown |
| `Hive Mind: Show Circular Dependencies` | Enumerate import cycles |
| `Hive Mind: Show Indexed Files` | List every file in the index |
| `Hive Mind: Scaffold AI Instructions & Skills` | Generate `.github/` files for Copilot guidance |
| `Hive Mind: Invalidate Graph Cache & Reindex` | Clear the disk cache and re-analyze |

---

## Configuration

| Setting | Default | Description |
|---|---|---|
| `hiveMind.maxFiles` | 5000 | Max files to index. Bump for very large workspaces. |
| `hiveMind.ignoredDirectories` | `[]` | Extra directory names to exclude (on top of `node_modules`, `.git`, `dist`, etc.). |
| `hiveMind.respectIfdefBranches` | `true` | Strip `#include`s in dead `#ifdef` branches based on profile-active `-D` flags. |
| `hivemind.clangPath` | `""` | Optional override for the C/C++ compiler used by `macroExpand` and `buildSubset`. Accepts `cl.exe`, `g++`, or `clang`. |

---

## Architecture (one-paragraph summary)

A `DependencyAnalyzer` walks the workspace once, parses each file with the appropriate parser (tree-sitter for C/C++, regex-light for the polyglot fallback), and builds a bidirectional file → file edge graph. A `CppScopeResolver` builds a per-file decl + call-edge index on top of tree-sitter for AST-precise C/C++ queries. A `GitAnalyzer` mines `git log` for co-change history. Results are persisted to disk between sessions via `GraphCache`. The 17 LM tools, three webview panels, the chat participant, and the dependency tree view are all read-only consumers of this index.

For C/C++ specifically, a `ProjectProfile` provides `-D` flags, include roots, module patterns, build variants, and umbrella header lists — so the same analysis works whether the project has `compile_commands.json` or not. Profiles are auto-detected via match rules (e.g. *"this is the X3 runtime if `include/adx_include.h` exists"*).

See `src/analyzer/`, `src/profiles/`, and `src/tools/index.ts` for the implementation.

---

## Development

```bash
npm install
npm run compile      # tsc -p .
npm run watch        # tsc -watch
npm test             # 16-test suite, ~10 s
npm run lint         # eslint src
npm run package      # build .vsix
```

The CI workflow (`.github/workflows/ci.yml`) runs install → lint → compile → test → package on every push and PR. The release workflow (`.github/workflows/release.yml`) fires on `v*` tag push, builds, and uploads the `.vsix` to a GitHub Release.

To cut a release:

```bash
# 1. Bump version
npm version patch    # or minor / major
# 2. Push tag
git push --follow-tags
# 3. Watch the Release workflow upload the .vsix
```

---

## Requirements

- **VS Code 1.87+**
- **GitHub Copilot** extension (for LM tools and chat participant)
- **Git** (optional, for co-change analysis)
- **A C/C++ compiler** (`cl.exe`, `g++`, or `clang`) — only needed for `macroExpand` and `buildSubset`

---

## Status

Hive Mind is **actively used on Sage X3 Runtime** (~10k files, hybrid Windows/Linux MSVC+g++ build). The Sage X3 profile is shipped and validated. Other profiles are easy to add — see the *Project profiles* section in `HOW-TO.md`.

See `ROADMAP.md` for upcoming features and `MEMORY_AUDIT_PLAN.md` for the planned ASan/Valgrind integration.

---

## License

TBD — pick a license before the first public release.
