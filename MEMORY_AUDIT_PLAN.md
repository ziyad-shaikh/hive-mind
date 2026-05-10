# Memory Audit — Plan

A future Hive Mind feature that integrates AddressSanitizer and Valgrind into the
extension so Copilot can run a deep memory-safety audit on the X3 runtime (or any
profiled C/C++ workspace) on demand.

This document is a reference, not a commitment. Pick it up when (1) Phases 1–7 are
stable and (2) the runtime has a runnable test target we can drive.

---

## Goal

Give the AI agent a tool that returns **structured, file:line-keyed memory-safety
findings** for the impact set of a code change — without the developer having to
reproduce a build or hand-paste sanitizer logs.

Concretely, a tool call like:

```
hivemind_memoryAudit({
    seedFile: "src/apl/apl_main.cpp",
    runner: "make test-apl"
})
```

returns:

```
{
    runner: "make test-apl",
    instrumentation: "asan",
    durationMs: 18430,
    findings: [
        {
            kind: "heap-use-after-free",
            file: "src/apl/apl_main.cpp",
            line: 1842,
            stack: [...],
            allocation: { file: "src/apl/apl_alloc.cpp", line: 412 },
            free:       { file: "src/apl/apl_alloc.cpp", line: 437 },
            ownershipHint: "MyClass::~MyClass calls deallocate() before subscribers",
        },
        ...
    ],
    summary: { errors: 3, leaks: 12, leakedBytes: 5840 }
}
```

The agent can then combine this with `hivemind_callHierarchy` and
`hivemind_typeHierarchy` to **suggest who should own the free** rather than just
report symptoms.

---

## Why this is hard (and worth doing carefully)

A naïve "shell out to valgrind" wrapper would be low value — developers can already
do that. The leverage Hive Mind adds:

1. **Targeted instrumentation.** Use the impact graph (`getImpact`) so we
   instrument *only* the impacted TUs, not the whole binary. Speeds up runs
   from minutes to seconds for typical change sets.
2. **Cross-referenced output.** Resolve every stack frame against the workspace
   index. Frames in third-party / system code are collapsed; frames in the
   user's modified code are expanded with the full call hierarchy.
3. **Ownership inference.** When ASan reports a leak at `T* p = new T()`, walk
   `findReferences(p)` + `typeHierarchy(T)` to identify which class is the
   conventional owner (e.g. the only RAII wrapper that takes `T*`).
4. **Profile-aware build.** Reuse the X3 profile's flags so we don't need a
   separate build configuration; just add `-fsanitize=address` (or equivalent
   MSVC flags) on top of the existing flag set.

---

## Tool Surface

One new LM tool: `hivemind_memoryAudit`.

| Field | Type | Required | Description |
|---|---|---|---|
| `seedFile` | string | yes | The changed file. Used to scope instrumentation. |
| `runner` | string | yes | Shell command that exercises the changed code. Must exit 0 on success. |
| `runnerCwd` | string | no | Working directory for `runner`. Default = workspace root. |
| `instrumentation` | enum | no | `"auto"` (default) \| `"asan"` \| `"valgrind"` \| `"msan"`. |
| `maxImpactedTUs` | number | no | Cap on TU count for the rebuild. Default 30. |
| `timeoutMs` | number | no | Total wall-clock cap. Default 5 min. |
| `keepArtifacts` | boolean | no | If true, persist the instrumented binary for re-runs. |

Also one config setting:

```
"hivemind.memoryAudit.defaultRunner": "<command>"
```

so the user only has to specify it once per workspace.

---

## Implementation Phases

### Phase A — Compiler-flag plumbing (1–2 days)

Extend `CompilerDriver.ts` to accept an `instrumentation` flag and emit the right
`-fsanitize=...` / `/fsanitize=address` extras alongside the existing profile
defines + include set.

- **Linux/Mac (g++ / clang):** `-fsanitize=address -fno-omit-frame-pointer -g -O1`
- **Windows (cl.exe ≥ 16.9):** `/fsanitize=address /Zi`. Requires linking with
  `clang_rt.asan_dynamic-x86_64.dll` and is incompatible with `/RTC1` / `/MTd`.
  Detect and surface a clear error if the active configuration uses these.
- **Valgrind:** no extra compile flags — just add a `-g` if not present.

Add unit tests under `scripts/x3-profile/` modelled on `12-test-module-graph.mjs`.

### Phase B — Build the instrumented subset (2–3 days)

Rebuild only the TUs in `getImpact(seedFile)` plus their direct dependencies, into
a *separate* `.obj/.o` cache so we don't pollute the user's normal build.

This piggybacks on `BuildSubset` but produces actual object files (not just
syntax-only). Needs a linker step too; we'll require the user to provide a
`runner` that includes their normal build command, and we'll set environment
variables (`CC`, `CXX`, `CFLAGS`, etc.) that the build system picks up.

For X3 specifically: add a profile field
`compilerDriver.sanitizerHooks.envVars = { CXXFLAGS: "..." }` so we know which
env vars the makefile honours.

### Phase C — Execute + parse output (2 days)

Spawn `runner` with the instrumented build's binary on PATH (or LD_PRELOAD for
ASan). Capture stdout/stderr. Parse:

- **ASan output** has a stable format: `==PID==ERROR: AddressSanitizer: <kind>`
  followed by stack frames as `#0 0xADDR in symbol /path:line`. Build a small
  state machine.
- **Valgrind output** is similar but uses `==PID== Invalid read of size N` etc.
- Extract: kind, primary site, allocation site, free site (where applicable),
  N-frame stack, byte counts.

Persist findings keyed by `(seedFile, runner, mtimeOfSeed)` in the global cache
so re-runs against unchanged code return instantly.

### Phase D — Cross-reference + ownership inference (2–3 days)

For each finding, post-process:

1. Resolve every stack frame's `path:line` to a workspace file via
   `analyzer.resolveFilePath`. Drop frames in `extlib/`, `node_modules/`, etc.
2. For leaks: `findReferences` on the leaked type's allocation symbol →
   identify the closest RAII wrapper / smart-pointer-typed declaration in the
   call chain. That's the suggested owner.
3. For use-after-free: `callHierarchy(direction: "outgoing")` on the freeing
   function to spot any caller that re-uses the pointer.

This is the part that turns raw sanitizer output into agent-actionable guidance.

### Phase E — Tool integration + scaffold update (0.5 day)

Register `hivemind_memoryAudit` in `tools/index.ts`. Update the C++ scaffold
templates to mention it under "after a refactor that touches allocation".

---

## Open Questions

1. **Runner source of truth.** Does X3 have a one-liner test command we can
   wire up by default, or does every developer need to set
   `hivemind.memoryAudit.defaultRunner` themselves? (Check `make test`,
   `windows/projects/tests/*.vcxproj`, the CI configs.)
2. **MSVC ASan limits.** ASan on Windows with cl.exe is finicky — incompatible
   with `/MTd`, `/RTC1`, and (until recently) `/EHsc`. Confirm what the X3
   Windows build uses; if any are blockers, document a clean-build profile.
3. **Symbolisation.** Need `addr2line` (or `dbghelp.dll` on Windows) on PATH
   for stack frames to be readable. Bundle? Expect the user to install? (Most
   distros + the LLVM install already include it.)
4. **Container vs host.** If X3 builds in a Docker container, the audit must
   either run inside the container too, or the host needs the same toolchain.
   Expose `runnerInDocker: <image-name>` as an option.
5. **Privacy.** Sanitizer output can include local paths and process memory
   in error context. Make sure we don't accidentally exfiltrate this through
   cloud-AI tool results without truncation.

---

## Estimated Effort

- **Phase A:** 1–2 days (compiler flags, tests).
- **Phase B:** 2–3 days (build subset with codegen).
- **Phase C:** 2 days (parsing).
- **Phase D:** 2–3 days (cross-reference + ownership inference).
- **Phase E:** half a day (tool registration + docs).

**Total:** 7–10 working days for a v1 that handles the X3 runtime end-to-end on
Linux. Add 2–3 days for Windows/MSVC ASan support if needed.

---

## Risks

- **Build-system coupling.** The richer our build integration, the more brittle
  it becomes against X3's makefile changes. Keep the "build" step as
  user-supplied (`runner`) and only inject env vars / flags.
- **False positives.** ASan can flag third-party libs we don't control. Need a
  workspace-scoped allow/deny list. Default: ignore frames outside the
  workspace tree.
- **Performance.** ASan slows execution 2-3×; Valgrind 10-50×. Make this
  explicit in the tool description and cap by `timeoutMs`.

---

## Decision Points (revisit before starting)

1. Is the value still there given Copilot's growing direct shell access? — If
   the agent can already shell out and parse output, Hive Mind's leverage shrinks
   to ownership inference. That's still real but maybe phase D becomes the *only*
   phase worth shipping.
2. Should this live in Hive Mind, or as a separate companion extension? — It's
   a fundamentally different runtime cost profile (minutes vs the milliseconds
   of every other tool). A separate extension may be cleaner.
