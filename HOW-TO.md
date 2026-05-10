# Hive Mind — How To

A practical guide. Each section is a real workflow with the tool calls that solve it.

> If you just want a feature reference, see the [README](./README.md). This document is task-oriented.

## Table of contents

- [5-minute setup](#5-minute-setup)
- [Concept primer: what Hive Mind sees](#concept-primer-what-hive-mind-sees)
- [Workflow 1 — Investigate an unfamiliar file](#workflow-1--investigate-an-unfamiliar-file)
- [Workflow 2 — Plan a multi-file change](#workflow-2--plan-a-multi-file-change)
- [Workflow 3 — Safely rename a C/C++ symbol](#workflow-3--safely-rename-a-cc-symbol)
- [Workflow 4 — Modify a virtual method](#workflow-4--modify-a-virtual-method)
- [Workflow 5 — Decode a confusing macro](#workflow-5--decode-a-confusing-macro)
- [Workflow 6 — "Did I break the build?"](#workflow-6--did-i-break-the-build)
- [Workflow 7 — Find hidden coupling via co-change](#workflow-7--find-hidden-coupling-via-co-change)
- [Workflow 8 — Get a bird's-eye architecture view](#workflow-8--get-a-birds-eye-architecture-view)
- [The 17 tools, in detail](#the-17-tools-in-detail)
- [Project profiles](#project-profiles)
- [Troubleshooting](#troubleshooting)

---

## 5-minute setup

1. **Install** the extension (see [README → Installation](./README.md#installation)).
2. **Open a workspace** — anything from a 50-file repo up to 100k+ files.
3. **Wait for indexing** — the status bar shows progress. A 10k-file C/C++ workspace takes ~5–15 seconds on first run; cached re-opens are instant.
4. **Run `Hive Mind: Scaffold AI Instructions & Skills`** from the Command Palette. This drops six files under `.github/`:
   - `instructions/hivemind.instructions.md` and `cpp.instructions.md`
   - `skills/hivemind-workflow/SKILL.md` and `cpp-refactor/SKILL.md`
   - `agents/hivemind.agent.md` and `cpp-refactor.agent.md`

   These teach Copilot **when** to call each Hive Mind tool. Without them the agent will still see the tools but use them less optimally.
5. **Start chatting** — type `@hivemind /impact` in Copilot Chat with a file open, or just ask normal questions about the codebase.

---

## Concept primer: what Hive Mind sees

Hive Mind builds **three indices** at startup, then keeps them up to date as you save files:

| Index | What it stores | Built from |
|---|---|---|
| **Dependency graph** | File → file edges (who imports/includes whom) | Tree-sitter for C/C++; light parsers for everything else |
| **Symbol index** | Named decls per file (functions, classes, types, enums) | Same parsers |
| **Co-change index** | File → file co-occurrence in commits | `git log` over the last N commits |

For C/C++ projects with an active **profile**, Hive Mind also builds a **scope resolver** index on top of tree-sitter — every class with its base list, every method with its `virtual`/`override` flags, every function with its callee list. This is what powers the AST-precise tools (`findReferences`, `findOverrides`, `callHierarchy`, `typeHierarchy`).

What Hive Mind **does not** see:
- Macro-generated symbols (use `hivemind_macroExpand` to inspect a specific call site)
- Dynamic loading (`dlopen`, `LoadLibrary`)
- Runtime function-pointer / `std::function` callbacks
- Template instantiation sites (declarations are visible; per-TU instantiations are not tracked)

When you hit one of these gaps, the right answer is usually `hivemind_buildSubset` — let the compiler tell you.

---

## Workflow 1 — Investigate an unfamiliar file

**Scenario:** You open `apl_main.cpp` and have no idea what it does, who calls it, or what it depends on.

**With Hive Mind:** one tool call.

```
hivemind_getContext({
    filePath: "src/apl/apl_main.cpp",
    task: "understanding what this file does"
})
```

Returns: dependencies (what it imports), dependents (who imports it), test files, top co-changed files, exported symbols. All in one bundle. Pass `includeContent: true` to also get the source (capped at 200 lines).

**For Copilot Chat users:**

```
@hivemind /deps
@hivemind what does this file do? Use hivemindContext for grounding.
```

---

## Workflow 2 — Plan a multi-file change

**Scenario:** You're about to rename `Logger::write` to `Logger::log`. You want a list of all files that need updating, ranked by how risky each one is to touch.

```
hivemind_planChange({
    filePath: "src/util/Logger.h",
    description: "rename Logger::write to Logger::log"
})
```

Returns four scored lists:
- **Files to Modify** — must change to keep the build green
- **Files to Read** — context you need to understand the change
- **Tests to Run** — exercising the affected code
- **Possibly Affected** — graph-neighbours not directly impacted but worth a glance

For C/C++ workspaces with an active profile, `planChange` automatically filters out files in **other build variants** so you don't get false-positive "must modify" entries from the Oracle backend when you're working on PostgreSQL code.

---

## Workflow 3 — Safely rename a C/C++ symbol

**Scenario:** You're renaming `processRequest` to `handleRequest` in a C++ codebase. The function exists in 3 platform variants under `#ifdef`s, and there's a callback registry that takes a function name as a string.

```
hivemind_findReferences({
    symbolName: "processRequest",
    maxResults: 200
})
```

Returns every reference in the workspace, **with confidence flags**:

```
Found 47 reference(s) across 14 file(s) (tree-sitter + scope filter; high — name is unique)

## src/net/server.cpp (12 refs)
- L84: int processRequest(Request& r) { _(decl)_
- L142: return processRequest(req);
- L201: auto h = &processRequest;
...
```

Each hit's confidence:
- **`high`** — the name is unique workspace-wide; safe to mass-rename.
- **`medium`** — 2–4 distinct declarations exist; verify scope per site.
- **`low`** — the name is overloaded or extremely common; treat as a list of *candidates*.

Comments, string literals, and dead `#ifdef` branches are stripped before matching. The string-literal callback registry will not appear — you'll have to grep for it separately, but Hive Mind won't hide it either.

For maximum confidence, follow up with:

```
hivemind_buildSubset({
    filePath: "src/net/server.cpp"   // any file you changed
})
```

This runs `cl.exe /Zs` (Windows) or `g++ -fsyntax-only` (Linux/Mac) on every TU in the impact set. Compile errors tell you immediately which call sites you missed.

---

## Workflow 4 — Modify a virtual method

**Scenario:** You want to add a parameter to `Renderer::draw(int x, int y)` — a virtual method with unknown overrides.

Step 1: enumerate the overrides.

```
hivemind_findOverrides({ symbolName: "draw" })
```

Output:

```
Found 5 implementation(s) across 5 derived class(es)

Confidence breakdown: 4 high · 1 medium · 0 low.

## CanvasRenderer
- L42 in src/canvas/canvas_renderer.cpp — confidence high (param count match), 2 param(s)
## SvgRenderer
- L67 in src/svg/svg_renderer.cpp — confidence high (param count match), 2 param(s)
## NullRenderer
- L18 in test/mocks/null_renderer.h — confidence medium (no override keyword observed), 2 param(s)
...
```

Step 2: check the supertype side too.

```
hivemind_typeHierarchy({
    symbolName: "Renderer",
    direction: "subtypes",
    depth: 2
})
```

Confirms every derived class. If `findOverrides` and `typeHierarchy` agree on the count, you have a complete picture.

Step 3: change the base, change every `high`-confidence override, manually verify the `medium` one.

Step 4: `hivemind_buildSubset` to confirm.

---

## Workflow 5 — Decode a confusing macro

**Scenario:** You see `FCIMPL3(MyClass, doSomething, x, y, z)` and have no idea what it expands to.

Step 1: locate the definition.

```
hivemind_findMacro({ name: "FCIMPL3", exact: true })
```

Output: every `#define FCIMPL3 ...` in the workspace. If multiple definitions exist (platform variants), all are returned with their `#ifdef` context.

Step 2: get the **actual expansion** at a specific call site.

```
hivemind_macroExpand({
    filePath: "src/runtime/dispatch.cpp",
    line: 142,
    contextLines: 3
})
```

Hive Mind runs the real preprocessor (`cl.exe /E` / `g++ -E`) using the file's flags from `compile_commands.json` (or the active profile). You get the *actual* expansion for that TU — accounting for `#ifdef`s, `-D` flags, and recursive expansion.

> Headers cannot be expanded directly — call `macroExpand` on a `.cpp` that includes the header.

---

## Workflow 6 — "Did I break the build?"

**Scenario:** You changed a public header. Before pushing, you want a fast "does it still compile?" check across every TU that includes it.

```
hivemind_buildSubset({
    filePath: "include/Logger.h"
})
```

Runs `-fsyntax-only` (or `/Zs`) on every TU in the impact set, with the right flags per TU. Returns pass/fail per TU plus diagnostics:

```
seedFile: include/Logger.h
totalTUsConsidered: 38
tusCompiled: 38
tusPassed: 35
tusFailed: 3
durationMs: 12480

Failures:
- src/net/server.cpp — error C2660: 'Logger::write' does not take 2 arguments
- src/util/parser.cpp — error C2660: 'Logger::write' does not take 2 arguments
- test/util/test_parser.cpp — error C2660: 'Logger::write' does not take 2 arguments
```

5–20× faster than a real build. Catches what matters most for refactors: missing decls, wrong types, broken includes, ambiguous overloads.

---

## Workflow 7 — Find hidden coupling via co-change

**Scenario:** You're refactoring `auth.cpp`. The import graph shows 3 dependents. Are there other files that historically change with it?

Run **Hive Mind: Show Co-Change Heat Map** with `auth.cpp` open. The webview shows:

- Files that change together in git history, sorted by frequency
- Tagged as `dependency`, `dependent`, or **`hidden coupling`** (no import edge but still co-changed)

Hidden-coupling entries are the high-value hits. Configuration files, schema migrations, related test files — the kind of files an import-graph-only refactor will silently miss.

For agents: `hivemind_coChanged({ filePath: "src/auth/auth.cpp" })`.

---

## Workflow 8 — Get a bird's-eye architecture view

**For polyglot or non-X3 codebases:**

Run **Hive Mind: Show Full Code Graph**. Pan/zoom the canvas. Hub files (most connections) are larger; click any node to recenter.

**For X3 (or any profiled C/C++ codebase):**

Run **Hive Mind: Show Module Graph (profile-driven)**. The 25 X3 modules render as bubbles connected by aggregated `#include` traffic — a single picture of the runtime architecture. Click a module to see its triplet (`<m>ext.h` / `<m>in.h` / `src/<m>*.cpp`) and file list. Build-variant-tagged modules (Oracle/PostgreSQL/etc.) are tinted differently.

---

## The 17 tools, in detail

### Bundled / planning

| Tool | Required | Optional | What it returns |
|---|---|---|---|
| `hivemind_getContext` | `filePath` | `task`, `includeContent` | Deps + dependents + tests + co-changed + symbols. One-call replacement for 5 separate lookups. |
| `hivemind_planChange` | `filePath`, `description` | — | Scored lists: Modify / Read / Test / Watch. Variant-aware on profiled C/C++ projects. |

### Graph navigation

| Tool | Required | Optional | What it returns |
|---|---|---|---|
| `hivemind_getDependencies` | `filePath` | `depth` | Files this file imports (transitively up to `depth`). |
| `hivemind_getImpact` | `filePath` | — | Files that import this file (downstream). |
| `hivemind_getRelatedFiles` | `filePath` | — | Both directions in one call. |
| `hivemind_getFullGraph` | — | `maxNodes` | Stats: file count, edges, hubs, language breakdown, cycles. |
| `hivemind_detectCycles` | — | — | Every circular import chain. |
| `hivemind_getTestFiles` | `filePath` | — | Associated test files by naming convention. |

### Symbol search

| Tool | Required | Optional | What it returns |
|---|---|---|---|
| `hivemind_findSymbol` | `symbolName` | — | Every definition of a function/class/type/var across the workspace. |
| `hivemind_search` | `query` | `isRegex`, `caseSensitive`, `maxResults`, `contextFile`, `includeSnippets` | Text/regex search ranked by structural proximity. Pass `contextFile` to bias toward a specific area. |
| `hivemind_coChanged` | `filePath` | — | Files that historically change together (git history). |

### C/C++ specific

| Tool | Required | Optional | What it returns |
|---|---|---|---|
| `hivemind_getCppPair` | `filePath` | — | The matching header/source/inline files for a C/C++ file. Profile-aware module-triplet expansion. |
| `hivemind_findMacro` | `name` | `exact`, `maxResults` | Every `#define` of a macro, with body, type (object-/function-like), and `#ifdef` context. |
| `hivemind_findReferences` | `symbolName` | `maxResults`, `includeDeclaration` | Every reference to a symbol, with `high`/`medium`/`low` confidence. Tree-sitter; no LSP. |
| `hivemind_findOverrides` | `symbolName` | `maxResults` | Every concrete override of a virtual method. |
| `hivemind_callHierarchy` | `symbolName` | `direction` (`incoming`/`outgoing`/`both`), `depth` (1–2), `maxPerLevel` | Callers and/or callees of a function. |
| `hivemind_typeHierarchy` | `symbolName` | `direction` (`supertypes`/`subtypes`/`both`), `depth` (1–3), `maxPerLevel` | Bases and/or derived classes. |
| `hivemind_macroExpand` | `filePath`, `line` | `contextLines`, `timeoutMs` | The real preprocessor expansion at a source line. Runs `cl.exe /E` / `g++ -E`. |
| `hivemind_buildSubset` | `filePath` | `maxTUs`, `depth`, `perFileTimeoutMs`, `totalBudgetMs`, `parallelism`, `explicitTUs` | Pass/fail + diagnostics from `-fsyntax-only` / `/Zs` across every impacted TU. |

---

## Project profiles

A **profile** encodes project-specific knowledge that static analysis can't infer:

- Build configurations (`-D` flags, include roots) per platform
- Umbrella headers (de-emphasised in impact analysis)
- Module-naming conventions (`<m>ext.h` / `<m>in.h` / `src/<m>*.cpp`)
- Test-file mapping (Linux vs Windows conventions)
- Build variants (e.g. Oracle vs PostgreSQL backends)
- Generated headers, custom source extensions

Hive Mind ships with one profile out of the box: **`sage-x3-runtime`**, auto-detected when `include/adx_include.h` exists in the workspace.

### Adding a profile

1. Create `src/profiles/<your-project>.json` modelled on `sage-x3-runtime.json`.
2. Add it to the `BUILTIN_PROFILES` array in `src/profiles/index.ts`.
3. Recompile.

The match rule supports `fileExists`, `anyOf`, and `allOf` combinators — see `src/profiles/types.ts` for the schema. Open a PR to upstream your profile.

---

## Troubleshooting

### "No active Hive Mind project profile" in the Module Graph

The Module Graph only renders when a profile matches the workspace. Either:
- Your workspace doesn't trigger any built-in profile's match rule. Check `src/profiles/<profile>.json` → `match` field.
- The profile's match rule fires (e.g. `fileExists: include/adx_include.h`), but no files matching the profile's `modulePattern.knownModules` are in the index.

Run **Hive Mind: Re-analyze Workspace** first. If still empty, check the Output panel (`View → Output → Hive Mind`) for parse errors.

### `hivemind_macroExpand` fails with "no compiler found"

Hive Mind looks for `cl.exe` (Windows) → `g++` (Linux/Mac) → `clang` (fallback) in this order. If none is on PATH:

- **Windows:** open a "Developer Command Prompt for VS 2022" before launching VS Code, or set `hivemind.clangPath` to the cl.exe path.
- **Linux/Mac:** install build-essentials / clang via your package manager.

### `hivemind_findReferences` reports `medium` or `low` confidence everywhere

That's likely correct. Common identifiers like `Init`, `run`, `process` truly are ambiguous workspace-wide. The tool surfaces the ambiguity rather than hiding it. For mass renames in such cases, prefer `hivemind_findOverrides` (for methods) or restrict to a specific class via the qualified name (`MyClass::run`).

### The dependency graph is missing C/C++ headers

Check whether the profile's include roots match your layout. Without a profile and without `compile_commands.json`, Hive Mind falls back to scanning common directories (`include/`, `src/`, etc.). For non-conventional layouts, generate a `compile_commands.json` (CMake: `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON`; bear/compdb for Make/Ninja).

### Index is stale after a `git pull`

Run **Hive Mind: Invalidate Graph Cache & Reindex**. The cache is mtime-keyed and usually self-heals, but big rebases can confuse it.

### Tests fail in CI but pass locally

The test suite needs `npm run compile` to have run — check your CI step ordering. Tree-sitter WASM files must be in `node_modules/web-tree-sitter/` and `node_modules/tree-sitter-cpp/`; `npm ci` should install them.

---

## Going further

- **[README](./README.md)** — overview, install, commands.
- **[ROADMAP](./ROADMAP.md)** — what's next.
- **[MEMORY_AUDIT_PLAN](./MEMORY_AUDIT_PLAN.md)** — the planned ASan/Valgrind tool.
- **The scaffolded `.github/instructions/` and `.github/skills/` files** — these are the canonical reference for *when* an AI agent should call each tool. They're written for Copilot but are equally useful as developer documentation.

Found a bug or have a feature idea? Open an issue on the project's GitHub repository.
