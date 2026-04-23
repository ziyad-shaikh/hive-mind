# Hive Mind — Future Roadmap

## Context

Hive Mind is a VS Code extension that builds a dependency graph of any workspace and exposes it to AI agents via LM tools. The goal is to give agents **structural awareness** of massive codebases (10k–1M+ files) so they can make changes confidently without reading every file.

### What we have today (v0.x)

| Capability | Status | Notes |
|---|---|---|
| Static import parsing | ✅ Done | 15 languages, regex-based |
| C/C++ header resolution | ✅ Improved | compile_commands.json, basename disambiguation, include path search |
| Symbol indexing | ✅ Done | VS Code document symbol provider, batch indexed |
| Git co-change analysis | ✅ Done | 500-commit window, coupling threshold |
| `getContext` bundle tool | ✅ Done | One-call: deps + dependents + tests + co-changed + symbols + optional content |
| `planChange` tool | ✅ Done | Scored file ranking: modify / read / test / peripheral |
| Schema-diagram graph | ✅ Done | Canvas-based, hierarchical, interactive |

### What we can't solve with static analysis alone

These are the **hard problems** that require fundamentally different approaches. This document tracks what we know, what's feasible, and what to build next.

---

## Phase 1: Near-Term (Can Build Now)

### 1.1 Semantic Search Tool

**Problem:** Agents can find files by structure (imports, symbols) but not by *meaning*. "Find all error handling code" or "where is the network retry logic?" require semantic understanding.

**Approach:**
- Use VS Code's built-in `workspace.findTextInFiles` for keyword/regex search as a baseline
- Add a `hivemind_search` tool that combines text search with structural proximity scoring
- Files that are structurally connected to the search results get boosted
- Future: integrate with local embedding models if VS Code exposes an API

**Effort:** Medium — tool implementation is straightforward, quality tuning is iterative.

### 1.2 Cross-Language Boundary Mapping

**Problem:** Many large projects have polyglot boundaries — C++ calling Python via pybind11, JS calling native modules via N-API, Java calling C via JNI, etc. These are invisible to per-language parsers.

**Approach:**
- Detect known binding patterns: `PYBIND11_MODULE`, `napi_create_function`, `JNI_OnLoad`, `extern "C"`, `cgo` comments
- Create synthetic edges in the graph between the binding file and the target language file
- Start with C++↔Python (pybind11) and C++↔JS (N-API) as the most common cases

**Effort:** Medium — pattern matching is mechanical, but coverage across binding styles is a long tail.

### 1.3 Build System Integration

**Problem:** Build systems (CMake, Bazel, Meson, Make) define the **actual** dependency graph, include paths, and compilation units. We're currently guessing what the build system already knows.

**Approach:**
- **CMake:** Parse `CMakeLists.txt` for `target_include_directories`, `add_library`, `add_executable`, `target_link_libraries`
- **Bazel:** Parse `BUILD` files for `cc_library`, `cc_binary` deps
- **compile_commands.json:** Already implemented for include paths; extend to extract defines (-D flags) that affect conditional compilation
- Map build targets to file groups → enables "what target does this file belong to?" queries

**Effort:** High — each build system is its own parser. Start with CMake (most common in C++ repos).

---

## Phase 2: Medium-Term (Needs Research)

### 2.1 Runtime / Dynamic Dependencies

**Problem:** Static analysis misses runtime-resolved dependencies:
- **Plugin systems:** `dlopen()`, `LoadLibrary()`, `importlib.import_module()`
- **Factory patterns:** `Registry::create("widget_type")` — the string maps to a class at runtime
- **Virtual dispatch:** `base->doThing()` — which concrete implementation?
- **Config-driven wiring:** YAML/JSON/XML files that specify which classes to instantiate

**What we can do now:**
- Detect `dlopen` / `LoadLibrary` / `import()` calls and flag them as "dynamic dependency — resolution unknown"
- Parse common config formats (JSON, YAML) for class name strings that match known symbols
- Add a `hivemind_dynamicDeps` tool that lists files with dynamic loading patterns

**What we can't do yet:**
- Resolve which concrete implementation is used at a given call site (needs type analysis or runtime tracing)
- Track plugin discovery paths without running the build system

**Research needed:** Can we use `compile_commands.json` + clangd's AST to resolve virtual dispatch? Can we hook into debugger sessions to capture runtime dependency traces?

### 2.2 Dependency Injection Container Analysis

**Problem:** DI frameworks (Spring, Guice, Angular, .NET DI, Dagger) wire dependencies through configuration rather than imports. A file can depend on an interface it never imports directly — the container resolves it.

**What we can do now:**
- Detect DI annotations: `@Inject`, `@Autowired`, `@Injectable`, `@Component`, `[Inject]`
- Match interface → implementation by naming convention (e.g., `IFooService` → `FooService`)
- Parse Angular `NgModule` declarations/providers and Spring `@Configuration` classes

**What we can't do yet:**
- Resolve runtime-conditional bindings (`if (env === 'prod') bind(Foo).to(ProdFoo)`)
- Handle multi-module DI graphs where the wiring is split across packages

**Research needed:** How to parse DI container config without executing it? Can we build a "DI graph" overlay that sits alongside the import graph?

### 2.3 Convention-Based Coupling

**Problem:** Many codebases follow implicit conventions that create dependencies invisible to import analysis:
- Rails: `UsersController` → `User` model → `users` table → `users/index.html.erb`
- Django: `views.py` → `models.py` → `urls.py` → templates
- React: `UserList.tsx` → `UserList.test.tsx` → `UserList.module.css` → `UserList.stories.tsx`
- C++: `foo.h` ↔ `foo.cpp` (already handled), but also `foo_test.cpp`, `foo_mock.h`, `foo_bench.cpp`

**Approach:**
- Define convention profiles per framework/language
- Match files by naming pattern + directory structure
- Allow user-defined convention rules in settings

**Effort:** Medium — the matching logic is simple, defining good default conventions per ecosystem is the work.

---

## Phase 3: Long-Term (Architectural Evolution)

### 3.1 Incremental Persistent Index

**Problem:** Re-analyzing 100k+ files on every VS Code startup is slow. The current in-memory graph is rebuilt from scratch each time.

**Approach:**
- Serialize the graph to a workspace-local SQLite or flat file
- On startup, load the cached graph, then diff against file modification times
- Only re-parse changed files
- Add a file watcher that updates the graph incrementally (partially implemented)

**Considerations:**
- Need a cache invalidation strategy for when the project structure changes fundamentally
- compile_commands.json changes should trigger full re-analysis of C/C++ files
- Graph serialization format should be versioned

### 3.2 Multi-Repository / Monorepo Support

**Problem:** Large organizations have multiple repos, or monorepos with internal package boundaries. Cross-package dependencies need different handling than within-package ones.

**Approach:**
- Detect package boundaries: `package.json`, `Cargo.toml`, `CMakeLists.txt`, `BUILD`, `go.mod`
- Add a "package" layer above the file layer in the graph
- `planChange` should distinguish between "changes within my package" vs. "changes that cross package boundaries" (much higher risk)

### 3.3 Context Budget Management

**Problem:** Even with curated context from `getContext` and `planChange`, the agent's context window has limits. For a file with 50 dependents, you can't read all of them.

**Approach:**
- Add token estimation to tool outputs (rough line count → token estimate)
- Add a `hivemind_prioritize` tool: given a context budget (in tokens) and a task, return the highest-value files to read that fit within the budget
- Support iterative context loading: agent asks for top-5, does work, asks for next-5 if needed

### 3.4 Agent Feedback Loop

**Problem:** The graph is static — it doesn't learn from agent behavior. If an agent consistently reads file B after asking about file A, that's a signal B should be surfaced proactively.

**Approach:**
- Log tool invocations per session (file requested → files the agent actually opened)
- Build a "co-access" graph analogous to the git co-change graph
- Use this to improve `getContext` and `planChange` scoring over time

---

## Known Limitations (Accept and Document)

These are fundamental limitations we should document clearly rather than try to solve:

| Limitation | Why It's Hard | Mitigation |
|---|---|---|
| Duck typing (Python, JS) | No static type info → can't resolve method dispatch | Rely on naming conventions + git co-change |
| Macro-heavy C/C++ | `#define` can generate imports, function calls, anything | Would need preprocessor pass; compile_commands.json helps with -D flags |
| Generated code | Protobuf, Thrift, gRPC stubs aren't in source | Detect `.proto`/`.thrift` files and map to generated output dirs |
| Conditional compilation | `#ifdef` branches are mutually exclusive | compile_commands.json provides the active defines for each TU |
| Reflection-heavy code | Java/C# reflection, Python `getattr` | Flag files with reflection patterns; can't resolve targets |

---

## Implementation Priority

If building sequentially, this is the recommended order:

1. **Semantic search tool** — highest agent impact, relatively easy
2. **Convention-based coupling** — catches C++ .h↔.cpp↔_test.cpp patterns many large codebases rely on
3. **Build system integration (CMake)** — gives ground truth for C++ include paths and compilation units
4. **Cross-language boundary mapping** — important for polyglot repos
5. **Incremental persistent index** — performance; becomes critical above ~20k files
6. **Context budget management** — quality; becomes critical with very large context bundles
7. **DI container analysis** — enterprise codebases
8. **Runtime/dynamic deps** — hard; diminishing returns for static analysis
9. **Agent feedback loop** — needs usage data first
