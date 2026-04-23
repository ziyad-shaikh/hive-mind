# Hive Mind

A VS Code extension that builds a dependency graph of your entire workspace and exposes it to GitHub Copilot as a set of intelligent tools. Agents get structural awareness of your codebase — what imports what, what breaks when something changes, what files change together — without reading every file.

## Why

AI agents are good at reasoning about code they can see, but blind to code they can't. In a large codebase (10k+ files, C/C++ heavy, polyglot), an agent can't read every file to understand the architecture. Hive Mind pre-computes the structural graph once and serves it on demand.

- **One tool call instead of five.** `getContext` returns a file's dependencies, dependents, test files, co-changed files, and exported symbols in a single response.
- **Scored change plans.** `planChange` tells the agent which files to modify, which to read, which tests to run, and which files are peripherally affected — ranked by structural + git co-change signals.
- **Structural search.** `search` finds code by text/regex, then ranks results by dependency graph proximity — not just match count.

## Features

### 11 Copilot LM Tools

| Tool | What It Does |
|------|-------------|
| `hivemind_getContext` | Curated context bundle: deps + dependents + tests + co-changed + symbols in one call |
| `hivemind_planChange` | Given a file + task description, returns scored file lists: modify / read / test / watch |
| `hivemind_search` | Text/regex search ranked by structural proximity, with optional `contextFile` biasing |
| `hivemind_getDependencies` | Files that a given file imports (direct + transitive) |
| `hivemind_getImpact` | Files that import a given file (downstream consumers) |
| `hivemind_getRelatedFiles` | Both directions: imports + imported-by |
| `hivemind_getTestFiles` | Associated test files by naming convention |
| `hivemind_findSymbol` | Search for functions, classes, types across the workspace |
| `hivemind_coChanged` | Files that frequently change together (git history analysis) |
| `hivemind_detectCycles` | Circular dependency detection |
| `hivemind_getFullGraph` | Full graph stats: hubs, language breakdown, architecture overview |

### Interactive Dependency Graph

A canvas-based schema diagram showing the dependency hierarchy around any file. Supports pan/zoom, hover highlighting, click-to-navigate, and depth controls.

### @hivemind Chat Participant

Use `@hivemind` in Copilot Chat with commands:
- `/impact` — downstream impact analysis
- `/deps` — import tree
- `/cycles` — circular dependency report
- Freeform questions about code structure

### Language Support

TypeScript, JavaScript, Python, C, C++, C#, Go, Rust, Java, Kotlin, PHP, Ruby, Swift, Vue, Svelte, CSS/SCSS/SASS/LESS, and more.

### C/C++ Specific

- Parses `compile_commands.json` for include paths
- Disambiguates header collisions by path proximity
- Searches common include directories (`include/`, `src/`, `third_party/`, etc.)

## Installation

### From .vsix (recommended for private distribution)

1. Download or build the `.vsix` file (see below)
2. In VS Code, open the Command Palette (`Ctrl+Shift+P`)
3. Run **Extensions: Install from VSIX...**
4. Select the `hive-mind-x.x.x.vsix` file

Or from the terminal:

```
code --install-extension hive-mind-0.1.0.vsix
```

### Build from Source

**Prerequisites:** Node.js 18+, npm

```bash
git clone https://github.com/ziyad-shaikh/hive-mind.git
cd hive-mind
npm install
npm run compile
```

**Run in development mode:**

Press `F5` in VS Code — this opens a new window with the extension loaded. You can set breakpoints in the TypeScript source.

**Package as .vsix:**

```bash
npx @vscode/vsce package --allow-missing-repository
```

This creates `hive-mind-0.1.0.vsix` in the project root.

## Setup for AI Agents

After installing, run the command **Hive Mind: Scaffold AI Instructions & Skills** from the Command Palette. This creates:

- `.github/instructions/hivemind.instructions.md` — Teaches agents when and how to use each tool
- `.github/skills/hivemind-workflow/SKILL.md` — Step-by-step workflow for multi-file changes

These files are picked up automatically by GitHub Copilot and guide the agent to use Hive Mind tools in the right order.

## Commands

| Command | Description |
|---------|-------------|
| `Hive Mind: Show Full Code Graph` | Open the interactive dependency graph |
| `Hive Mind: Focus Graph on Current File` | Graph centered on the active file |
| `Hive Mind: Re-analyze Workspace` | Rebuild the index |
| `Hive Mind: Show Workspace Stats` | File count, edge count, languages, hub files |
| `Hive Mind: Show Circular Dependencies` | List all import cycles |
| `Hive Mind: Show Indexed Files` | List all files in the graph |
| `Hive Mind: Scaffold AI Instructions & Skills` | Generate `.github/` files for agent guidance |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `hiveMind.maxFiles` | 5000 | Maximum files to index. Increase for large workspaces. |
| `hiveMind.ignoredDirectories` | `[]` | Additional directory names to exclude from analysis. |

## Requirements

- VS Code 1.87.0 or later
- GitHub Copilot extension (for LM tools and chat participant features)
- Git (optional, for co-change analysis)
