# Hive Mind — Demo Script

> **One-liner:** Hive Mind pre-computes the dependency graph of your codebase so that AI agents — and you — never miss an affected file when making changes.

---

## Prerequisites

- A medium/large C++ project open in VS Code (Redis, LLVM/Clang, or any repo with `compile_commands.json`)
- Extension installed and activated (status bar shows `$(pulse) Hive Mind: ...`)
- Copilot Chat available for sections 7–9
- Optional: clangd installed for AST-precise features (section 9)

---

## Flow

### 1. Cold Start — "Zero-config indexing" (30s)

**What it is:**  
When you open a workspace, Hive Mind scans every source file and builds a dependency graph by parsing `#include`, `import`, `require`, and `use` statements. This "indexing" creates an in-memory map of which file depends on which — no compiler, no build system, no language server required. For C/C++, it also reads `compile_commands.json` to resolve angle-bracket includes like `#include <net/socket.h>` to the actual file on disk.

**Demo steps:**
1. Open the project — watch the status bar: `$(pulse) Hive Mind: Indexing...`
2. Wait 2–5 seconds — it completes: e.g., *"2,400 files · 8,100 edges"*
3. Point out: no build needed, no LSP needed, works instantly

**Talking point:** *"This works on a fresh clone. No cmake, no compile, no waiting for IntelliSense. It parses the raw text of every file and resolves imports using the same heuristics a compiler would — relative paths, include paths from compile_commands.json, and basename disambiguation for large header-heavy codebases."*

---

### 2. Sidebar Tree View — "Always-visible structure" (1 min)

**What it is:**  
The sidebar gives you a live, always-visible breakdown of the current file's structural relationships — what it imports (dependencies) and what imports it (dependents). It also surfaces architectural signals like "hub files" (files with the most connections, often the riskiest to change) and "orphan files" (dead code candidates with zero connections). This replaces manually grep-ing through includes to understand a file's role.

**Demo steps:**
1. Click the **Hive Mind** icon in the Activity Bar (pulse icon)
2. Open a central `.h` file — sidebar updates instantly with **Dependencies** and **Dependents**
3. Expand **Hub Files** — "these are the files where a one-line change can break 50 other files"
4. Expand **Orphan Files** — "these have zero connections — potential dead code"
5. Expand **Circular Dependencies** — "these create build order issues and tight coupling"

**Talking point:** *"Every time you switch tabs, the sidebar updates. You always know where you are in the architecture without running a command. Hub files are your load-bearing walls — refactoring them requires extra care."*

---

### 3. File Explorer Decorations — "Architecture health at a glance" (30s)

**What it is:**  
Badges appear directly on files in the Explorer — 🔥 marks hub files (architectural hotspots) and ⚠ marks files participating in circular dependencies. This lets you spot risky files at a glance while browsing, without running any command. It's like a code health dashboard embedded into your file tree.

**Demo steps:**
1. Open the Explorer panel
2. Scroll through — point out 🔥 badges on hub files
3. Find a ⚠ badge — "this file is part of a circular dependency chain"

**Talking point:** *"You can visually see which files are load-bearing walls vs. which are isolated utilities. New team members immediately understand the codebase's risk areas without reading any documentation."*

---

### 4. Graph Visualization — "See the architecture" (1 min)

**What it is:**  
The graph renders a hierarchical layout showing how files connect through imports. Unlike force-directed graphs that turn into spaghetti at scale, this uses a structured layout where the focused file is at the center and dependencies fan out by depth level. You can expand/collapse depth to explore transitive relationships without losing orientation.

**Demo steps:**
1. Right-click a file → **"Hive Mind: Focus Graph on Current File"**
2. Show the hierarchical layout — focused file at center, deps fanning out
3. Click **Expand** — 2nd-level transitive dependencies appear
4. Click a node → file opens in editor
5. Click another node → graph refocuses on that file

**Talking point:** *"This isn't a pretty picture — it's a navigation tool. Click through the graph to trace dependency chains. In C++ codebases with 50+ includes per file, this is the only way to understand the structure without memorizing the codebase."*

---

### 5. Impact Preview on Save — "Know your blast radius" (1 min)

**What it is:**  
Every time you save a file, Hive Mind walks the reverse dependency graph (up to 2 levels deep) and tells you how many downstream files could be affected by your change. This is the "blast radius" — in C/C++, changing a header's function signature means every `.cpp` that includes it (directly or transitively) may fail to compile. You see this *before* you push, not after CI fails 10 minutes later.

**Demo steps:**
1. Open a `.h` file (ideally a hub file with many dependents)
2. Make a trivial edit (add a comment), save
3. Notification appears: *"Saving `core/buffer.h` impacts 47 files: parser.cpp, lexer.cpp, ..."*
4. Click **"Show All"** — full list opens in the Output panel
5. Dismiss the notification

**Talking point:** *"This is your pre-commit sanity check. In a 100k-file codebase, you can't manually trace what you might break. This tells you instantly — before you push, before CI runs, before your teammates find out."*

---

### 6. Co-Change Heat Map — "Hidden coupling revealed" (1 min)

**What it is:**  
This panel analyzes your git history (last 500 commits) to find files that frequently change together in the same commit — regardless of whether they have any import relationship. Files tagged "hidden coupling" are the dangerous ones: they have no `#include` or `import` between them, yet developers always modify them together. This reveals architectural coupling that no static analysis can detect — things like a config file that must be updated whenever a feature module changes.

**Demo steps:**
1. Run command: **"Hive Mind: Show Co-Change Heat Map"** (or right-click → context menu)
2. Panel opens showing co-changed files with colored bars
3. Point out the color scale: red = high coupling, green = low
4. Find a row tagged **"hidden coupling"** — "these two files have no import between them, but they changed together in 15 out of 20 commits"
5. Find a row tagged **"dependency"** — "this coupling is expected, it's in the import graph"
6. Click a row to open the file

**Talking point:** *"The import graph only shows explicit relationships. Git history shows implicit ones — 'these files always change together because of a business rule, a convention, or a design decision that was never documented.' This is the coupling that causes bugs when someone forgets to update the other file."*

---

### 7. Copilot Chat Integration — "@hivemind knows the graph" (2–3 min)

**What it is:**  
The `@hivemind` chat participant lets you ask natural language questions about code structure and get answers backed by the pre-computed graph. Instead of the AI guessing which files are related (which it does poorly in large C++ repos), it queries the actual dependency index. This means Copilot's answers about "what would break" are grounded in real structural data, not hallucinated from file names.

**Demo steps:**
1. Open Copilot Chat
2. Type: `@hivemind What files would break if I change this?`
   - Shows impact analysis with file list
3. Type: `@hivemind /deps`
   - Shows what the current file depends on
4. Type: `@hivemind /impact`
   - Shows reverse dependencies (what depends on this)
5. Type: `@hivemind /cycles`
   - Reports circular dependency chains in the workspace

**Talking point:** *"Without this, Copilot has to guess which files matter based on file names and folder structure. With this, it queries the actual graph. The difference: it stops suggesting edits to files that aren't even connected to what you're working on, and it stops missing files that ARE connected but live in unexpected directories."*

---

### 8. LM Tools in Agent Mode — "AI never misses a file" (2–3 min)

**What it is:**  
When Copilot operates in agent mode (multi-step autonomous tasks), it automatically calls Hive Mind tools like `planChange`, `getCppPair`, and `getImpact` to figure out which files to read and modify. This solves the #1 failure mode of AI-assisted C++ refactoring: the AI edits `foo.cpp` but forgets to update the declaration in `foo.h`, or misses a dependent file three includes away. The graph ensures it finds every affected file before writing code.

**Demo steps:**
1. Open a `.cpp` file with a function you want to rename
2. Ask Copilot (agent mode): *"Rename the `processRequest` function and update all callers"*
3. Watch the tool calls in the chat panel:
   - `hivemind_planChange` → ranks files by modification priority
   - `hivemind_getCppPair` → finds the `.h` file paired with this `.cpp`
   - `hivemind_getImpact` → finds all downstream consumers
4. Copilot edits all the right files — including the header

**Talking point:** *"Without Hive Mind, the AI would grep for the function name and miss overloads, files that use it through a typedef, and headers that declare it in a different namespace. With the graph, it knows the exact set of files to touch. The #1 cause of broken AI-generated C++ refactors — missing the header update — is eliminated."*

---

### 9. C++ Killer Features — "What grep can't do" (2 min)

**What it is:**  
These tools address problems unique to C/C++ that are unsolvable by text search: header/source pair matching (`foo.h` ↔ `foo.cpp` ↔ `foo_inl.h`), macro definition lookup across thousands of headers, and AST-precise cross-references via clangd that correctly handle overloads, templates, and `#ifdef` branches. In macro-heavy codebases (like .NET runtime, Chromium, or game engines), finding what `FCIMPL3(...)` actually expands to is impossible without running the preprocessor — these tools do exactly that.

**Demo steps:**
1. **Header/Source Pair:**
   - Open a `.cpp` file
   - In chat: `#hivemindCppPair` → instantly shows paired `.h` and `.inl` files
   - "The AI always knows to check both files"

2. **Macro Lookup:**
   - Find a `SCREAMING_CASE` identifier in code
   - In chat: `#hivemindMacro` → shows the `#define` location, body, and whether it's function-like or object-like
   - "In a repo with 10,000 headers, finding which one defines `MY_ASSERT` takes seconds, not minutes"

3. **AST-Precise References (requires clangd):**
   - Position cursor on a function name
   - In chat: `#hivemindRefs` → every usage across the codebase, zero false positives
   - "No matches from comments, strings, or unrelated functions with the same name in a different namespace"

**Talking point:** *"Grep gives you text matches. These tools give you semantic matches. In C++ where the same identifier can mean completely different things depending on namespace, overload set, and #ifdef configuration, this is the difference between a correct refactor and a broken build."*

---

## Key Messages to Reinforce Throughout

| Message | When to say it |
|---------|---------------|
| "Zero dependencies, zero config" | Cold start |
| "Works without a build system" | Sidebar + graph |
| "Scales to 100k+ files" | Point at status bar file count |
| "The import graph shows explicit coupling" | Sidebar, Impact Preview |
| "Git history shows implicit coupling" | Co-Change Heat Map |
| "AI gets full structural context" | Chat + Agent Mode |
| "Eliminates the #1 C++ refactoring mistake" | Agent Mode — missing `.h` update |
| "What grep can't do" | C++ killer features |

---

## Recommended Demo Projects

| Project | Size | Why it's good |
|---------|------|---------------|
| [Redis](https://github.com/redis/redis) | ~400 C files | Clear hub files (`server.h`), fast to index, obvious impact chains |
| [LLVM/Clang](https://github.com/llvm/llvm-project) (subset) | ~5k files | Deep include chains, `compile_commands.json` available, macro-heavy |
| [SQLite](https://github.com/nicedoc/sqlite) | ~150 files | Simple enough to trace manually, validates graph correctness |
| Any internal C++ project with `compile_commands.json` | Varies | Most impressive — shows it works on *their* code |

---

## Troubleshooting During Demo

| Problem | Fix |
|---------|-----|
| Status bar stays on "Indexing..." | Check `hiveMind.maxFiles` setting — may need to increase for large repos |
| Co-Change Heat Map shows "Git history not available" | Run `Hive Mind: Re-analyze Workspace` — git analysis runs in background |
| No file decorations visible | Refresh: `Hive Mind: Refresh Tree` command |
| clangd features show "not available" | Run `Hive Mind: Check clangd Status` — verify clangd is installed |
| Sidebar shows 0 dependencies for a `.h` file | File may only have dependents (nothing it imports). Switch to a `.cpp` file |

---

## Closing Statement

*"Every AI coding assistant today struggles with large C++ codebases because they don't understand the structure. They guess based on file names, grep for text, and miss half the impacted files. Hive Mind gives them — and you — a pre-computed map of the entire codebase. The result: fewer broken builds, fewer missed files, and refactoring that actually works at scale."*
