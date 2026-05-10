## X3 profile data collectors

Node scripts that scrape the Sage X3 runtime repo (default: `../../../runtime`)
to produce the inputs needed for `src/profiles/sage-x3-runtime.json`.

Run order:

```
node 00-run-all.mjs
```

Outputs land in `data/` as a single `x3-runtime-snapshot.json` plus per-step
intermediates. Re-run any time the runtime build system changes.

Individual scripts (each writes to `data/<n>-<name>.json`):

| # | Script                           | Extracts                                                |
|---|----------------------------------|---------------------------------------------------------|
| 1 | `01-collect-vcxproj.mjs`         | MSVC PreprocessorDefinitions + include dirs per config  |
| 2 | `02-collect-makefile.mjs`        | gcc -D flags + -I paths per build target                |
| 3 | `03-find-umbrella-headers.mjs`   | Headers included by >25% of TUs (umbrella candidates)   |
| 4 | `04-validate-module-triplets.mjs`| `<m>ext.h` / `<m>in.h` / `<m>*.cpp` triplets            |
| 5 | `05-collect-grammar-includes.mjs`| `#include` edges from .y/.ym4/.x/.l prologue blocks     |
| 6 | `06-collect-build-variants.mjs`  | sadora / sadpgs / sadoss source-set differences         |

No external dependencies — pure Node 18+ stdlib.
