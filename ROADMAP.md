# Hive Mind — Roadmap

## Honest Premise

Hive Mind exists primarily to make AI agents better at working in **massive C/C++ codebases**. Today (v0.x) we're a useful but limited graph-navigation aid. The hard refactoring failures developers complain about — `#ifdef`-blind edits, missed virtual overrides, macro-expansion mistakes, "looks right but doesn't link" — are not solved by static regex parsing. **They never will be.** The only path to actually solving them runs through the clang/clangd ecosystem.

This roadmap is organized around that reality.

---

## Where We Are (v0.x)

| Capability | Status | Honest Assessment |
|---|---|---|
| Static import parsing (15 langs) | ✅ Done | Regex-based, fragile on multi-line and macro-pasted includes |
| C/C++ header resolution | ✅ Done | basename + `compile_commands.json` include paths; ~80% accurate |
| Header/source pair lookup (`getCppPair`) | ✅ Done | Real win for AI agents — catches the #1 mistake |
| Macro definition index (`findMacro`) | ✅ Done | Returns definitions only; does NOT expand |
| Symbol indexing | ✅ Done | VS Code DocumentSymbolProvider; not AST-precise |
| Git co-change | ✅ Done | Useful coupling signal |
| `getContext` / `planChange` bundles | ✅ Done | Reduce N tool calls to one |
| Structural-aware search | ✅ Done | Better than raw grep, not as good as semantic search |

**What this means for `runtime`-class repos:** routine refactors are noticeably less painful for AI agents. Hard refactors — the ones developers actually complain about — are unchanged.

---

## What Static Analysis Cannot Solve

| Problem | Why Regex Can't Fix It |
|---|---|
| Macro **expansion** | `FCIMPL3(foo, ...)` could expand to anything. We see the `#define`, not the result at the call site. |
| `#ifdef` resolution | Multiple definitions of the same symbol exist; only one is active per build configuration. We index all of them. |
| Virtual dispatch | `base->doThing()` could call any of N implementations. Needs type analysis. |
| Template instantiation | Declarations are visible; instantiated specializations across TUs are not. |
| Cross-language bindings (pybind11/N-API/JNI) | Pattern-matchable but lossy without compiler-level information. |
| Build verification | "Does it actually link?" is the only ground truth. We don't run the compiler. |

Every entry above is a **clang problem**. We need a clang-grade toolchain in the loop.

---

## The C++ Excellence Path (Priority Track)

This is the work that takes Hive Mind from "tolerable" to "actually good" for native code. Items 1–4 are sequenced; later items depend on earlier ones.

### 1. clangd LSP Client Foundation **← in progress, started now**

**Why it's first:** Everything else in this section requires it. clangd already does AST parsing, `compile_commands.json`-aware indexing, per-configuration `#ifdef` evaluation, and exposes references / definitions / type hierarchy / call hierarchy via LSP. We don't need to build any of that — we need to **talk** to it.

**Scope:**
- Detect clangd availability (PATH, VS Code clangd extension, or user-configured path)
- Spawn clangd as a child process and speak LSP over stdio (JSON-RPC framing)
- Lazy startup — don't spawn until first query
- Surface health/version in the `Hive Mind` output channel
- Provide a typed async API: `definition`, `references`, `implementations`, `documentSymbols`, `hover`, `prepareCallHierarchy`, `incomingCalls`, `outgoingCalls`, `prepareTypeHierarchy`, `subtypes`, `supertypes`

**Non-goals for this step:** wiring into existing tools, replacing the regex parser. The first deliverable is the client itself with one smoke-test query.

**Status:** Foundation file shipped. See [src/analyzer/ClangdClient.ts](src/analyzer/ClangdClient.ts).

### 2. AST-Precise Symbol Tools (clangd-backed)

**New / upgraded tools, each conditional on clangd being available:**

- `hivemind_findReferences` — true LSP `textDocument/references` (replaces grep-by-symbol-name)
- `hivemind_findOverrides` — `textDocument/implementation` for virtual dispatch
- `hivemind_callHierarchy` — incoming/outgoing call chains
- `hivemind_typeHierarchy` — supertypes / subtypes for refactoring class hierarchies
- Upgrade `hivemind_findSymbol` to prefer clangd results over regex when available, and to **mark which `#ifdef` configuration each result is active in**

**Why this matters:** virtual dispatch and overrides are currently invisible. This single feature is the largest improvement to refactor safety in C++.

### 3. Macro Expansion Tool (`hivemind_macroExpand`)

**Approach:** Run `clang -E -P` on a single file with the same flags from `compile_commands.json`, extract the expansion of a specific line range, return it. Cache by `(file, line, flags-hash)`.

**Why it matters:** Tells the AI what `FCIMPL3(MyMethod, ...)` actually becomes in *this specific TU*. Closes the macro-blindness gap that `findMacro` only partially addresses.

**Risks:** Slow on first call per file; some preprocessor flags break things; needs clang on PATH separately from clangd.

### 4. Per-Configuration `#ifdef` Awareness

clangd already does this internally — it parses each TU under the configuration declared in `compile_commands.json`. By using clangd as the source of truth (item 2), we inherit this for free for query results. To extend to our own indexing:

- Tag every regex-discovered symbol/include with the `#if`/`#ifdef` context it appears under
- When clangd returns a definition, record which configuration it's active in
- `findSymbol` results are grouped by configuration, with the active-for-current-build variant marked

### 5. Build Subset Tool (`hivemind_buildSubset`)

Given a list of changed files, compute the minimal `make` / `msbuild` / `cmake --build --target` invocation that exercises the changes. Read `compile_commands.json` to map file → TU; map TU → target via project-specific heuristics (CMake `cmake_install.cmake`, Bazel `bazel query`, makefile dependency graph as a fallback).

**Why it matters:** "Does this build?" is the ground truth in C++. Right now AI says "I think this is correct" with no way to verify cheaply. A 30-second targeted build beats a 30-minute full rebuild.

### 6. Persistent Incremental Index

Once clangd is in the loop and indexing 100k files, restarting VS Code can't mean re-doing all of it. Cache the dependency graph + symbol index + macro index to a workspace-local file (SQLite or compact binary), invalidate by file mtime + `compile_commands.json` hash.

This was already on the old roadmap as an aspirational item. With clangd integrated it becomes **mandatory** — clangd's own index is huge but ours on top of it is non-trivial too.

---

## Adjacent / Lower-Priority Work

These are valuable but **not** on the C++ excellence critical path. Park them.

### Cross-Language Boundary Mapping
pybind11 / N-API / JNI / cgo. Useful for polyglot repos, irrelevant for `runtime`-style codebases until the C++ side is solid. **Deprioritized** vs. the old roadmap.

### Convention-Based Coupling (test/mock/bench files)
Already partially handled by `getTestFiles`. Extend to `_mock.h` / `_bench.cpp` etc. Cheap, modest value. **Tactical, can land any time.**

### DI Container Analysis (Spring, Angular, etc.)
Enterprise feature. Not relevant to native runtime work. **Deprioritized.**

### Semantic Search via Embeddings
Was on the old roadmap. With `hivemind_search` already shipping a useful structural-text hybrid, the marginal lift from embeddings is small until VS Code surfaces a stable embedding API. **Wait for platform support.**

### Agent Feedback Loop
Logging which files agents actually open after a context request. Interesting once we have telemetry; premature now. **Wait for usage data.**

---

## Known Limitations We Will Document, Not Solve

| Limitation | Why It's Permanent |
|---|---|
| Reflection (Java/C#/Python `getattr`) | Resolved at runtime; no static answer exists |
| Plugin discovery via `dlopen`/`LoadLibrary` | Same — runtime-resolved |
| String-keyed registries / factories | "Widget"-style lookups need either runtime tracing or a project-specific schema |
| Generated code that isn't checked in | Build-system specific; case-by-case mitigation |

For these, we add **detection + clear flagging** in tool outputs ("this file uses `dlopen` — runtime targets unknown") rather than pretending we have answers.

---

## Build Order (Sequential, Honest)

1. **clangd LSP client foundation** — STARTED. No user-visible feature; unlocks everything that follows.
2. **One pilot tool backed by clangd** — `hivemind_findReferences`. Validates the client end-to-end on a real project.
3. **Find overrides / call hierarchy / type hierarchy tools** — the big C++ refactor wins.
4. **Macro expansion tool** — `clang -E` per-TU.
5. **`#ifdef` configuration tagging** — fold clangd's per-config view into our results.
6. **Build subset tool** — make "does it compile?" cheap.
7. **Persistent incremental index** — performance hardening.

Items 1–3 take Hive Mind from "useful aid" to "the primary tool I want my AI agent to use on `runtime`." Items 4–7 are the polish that makes it production-grade.
