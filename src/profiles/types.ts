/**
 * X3 / project-profile schema. A profile is project-specific knowledge that
 * cannot be derived from generic static analysis: build flag sets, umbrella
 * headers, module-naming conventions, build-variant TU sets, etc.
 *
 * Hive Mind ships profiles for known repos (currently: sage-x3-runtime) and
 * loads one when its `match` rule fires against the active workspace.
 */

export interface ProjectProfile {
    /** Stable identifier — e.g., 'sage-x3-runtime'. */
    id: string;
    /** Human-readable name shown in the status bar. */
    displayName: string;
    /** Auto-detection rule. The first profile whose `match` is satisfied wins. */
    match: ProfileMatch;

    /** Build configurations: each maps a name → -D flags + include roots. */
    configurations: Record<string, BuildConfiguration>;
    /** Default config to pick when none is set. 'auto' = pick by host OS. */
    defaultConfiguration: string;

    /**
     * Headers included by a large fraction of TUs. Edges *through* these
     * headers are de-emphasised in impact / cycle / planChange computations
     * because they otherwise reduce the graph to a star.
     */
    umbrellaHeaders: string[];

    /** Module-naming convention. */
    modulePattern: ModulePattern;

    /** Test-file mapping (linux + windows). */
    testPattern: TestPattern;

    /** Headers produced by the build system, not present in the source tree. */
    generatedHeaders: GeneratedHeader[];

    /** Non-C++ source files we should still index for #include edges. */
    customSources: CustomSource[];

    /** Build variants — same source, different binaries. */
    buildVariants: BuildVariant[];

    /** Notable macros, classified for tool consumption. */
    macros: MacroClassification;

    /** Compiler-driver settings (replaces clang/clangd dependency). */
    compilerDriver: CompilerDriverConfig;
}

// ---------------------------------------------------------------------------

export type ProfileMatch =
    | { fileExists: string }
    | { anyOf: ProfileMatch[] }
    | { allOf: ProfileMatch[] };

export interface BuildConfiguration {
    /** Optional: inherit from another configuration before applying overrides. */
    extends?: string;
    /** -D flags as a string→value map. `null` value = remove an inherited define. */
    defines: Record<string, string | null>;
    /** Include roots, relative to workspace or absolute. */
    includeRoots: string[];
    /** Compiler-implicit defines (e.g. `_WIN64` from MSVC x64). */
    implicitDefines?: Record<string, string>;
}

export interface ModulePattern {
    /** Public/external header path — `{module}` is the placeholder. */
    external: string;
    /** Internal header path. */
    internal: string;
    /** Implementation glob — files matched here are part of the module. */
    implGlob: string;
    /** Curated list of modules known to follow the convention. */
    knownModules: string[];
}

export interface TestPattern {
    linux: { from: string; to: string };
    windows: { from: string; to: string };
}

export interface GeneratedHeader {
    name: string;
    /** Absolute or workspace-relative path of the source it's generated from. */
    generatedFrom?: string;
    /** Free-form note (e.g., the make target). */
    generatedBy?: string;
}

export interface CustomSource {
    extension: string;
    kind: 'bison' | 'bison-m4' | 'bison-fragment' | 'lex';
    /** Wrapper convention for the C/C++ prologue, e.g. '%{...%}'. */
    prologue: string;
}

export interface BuildVariant {
    name: string;
    description: string;
    extraSources: string[];
    /** TUs that should NOT be compiled in this variant, even though they're in
     * the common list. Empty = no exclusions. */
    excludedSources?: string[];
}

export interface MacroClassification {
    /** Expand to nothing structurally interesting — agent can ignore. */
    transparent: string[];
    /** Defined differently per platform — find-references cross-platform must
     * be handled with care. */
    platformConditional: string[];
}

export interface CompilerDriverConfig {
    windows: CompilerInvocation;
    linux: CompilerInvocation;
    /** Additional platforms can be added later (darwin, aix). */
    [platform: string]: CompilerInvocation | undefined;
}

export interface CompilerInvocation {
    /** Executable name. Discovered from PATH / standard install locations. */
    exe: string;
    preprocessFlags: string[];
    syntaxOnlyFlags: string[];
    /** Where to read this file's actual build flags from. */
    discoverFlagsFrom: string;
}
