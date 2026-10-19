import { diffNewBuiltinGaps, findBuiltinGaps } from "./builtin-gap.ts";
import type {
  BuiltinGap,
  BuiltinCapabilityManifest,
  BunCapabilityGap,
} from "./builtin-gap.ts";
import { inventoryBunApis } from "./bun-api-inventory.ts";
import type { BunApiInventory } from "./bun-api-inventory.ts";
import { inventoryCodegenFeatures } from "./codegen-inventory.ts";
import type { CodegenFinding } from "./codegen-inventory.ts";
import { guardedBunUseLocations } from "./release-inventory-bindings.ts";
import { inventoryReleaseImports } from "./release-inventory-imports.ts";
import type {
  BuiltinUse,
  ScannableModule,
  UnresolvedReference,
} from "./release-inventory-imports.ts";

export type {
  BuiltinUse,
  ScannableModule,
  UnresolvedReference,
} from "./release-inventory-imports.ts";

export interface ReleaseInventoryInput {
  readonly release: {
    readonly version: string;
    readonly platform: string;
    readonly bunVersion: string | null;
  };
  readonly binary: { readonly bytes: number; readonly sha256: string };
  readonly graph: {
    readonly entry: number;
    readonly flags: number;
    readonly recordSize: number;
  };
  readonly modules: readonly ScannableModule[];
  readonly capabilities: BuiltinCapabilityManifest;
}

export interface ModuleCounts {
  readonly count: number;
  readonly bytes: number;
  readonly javascriptCount: number;
  readonly javascriptBytes: number;
  readonly reachableCount: number;
  readonly reachableJavascriptCount: number;
  readonly reachableJavascriptBytes: number;
}

export interface ClaudeReleaseInventory {
  readonly schemaVersion: 1;
  readonly release: ReleaseInventoryInput["release"];
  readonly binary: ReleaseInventoryInput["binary"];
  readonly graph: ReleaseInventoryInput["graph"];
  readonly modules: ModuleCounts;
  readonly bunApis: BunApiInventory;
  readonly builtins: readonly BuiltinUse[];
  readonly napiModules: readonly {
    readonly index: number;
    readonly key: string;
    readonly name: string;
    readonly bytes: number;
  }[];
  readonly unresolvedReferences: readonly UnresolvedReference[];
  readonly unresolvedBareReferences: readonly UnresolvedReference[];
  readonly codegenFindings: readonly CodegenFinding[];
  readonly builtinGaps: readonly BuiltinGap[];
  readonly bunCapabilityGaps: readonly BunCapabilityGap[];
}

function compare(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

// Keep release input checks together so malformed metadata fails before any
// TypeScript parsing or inventory collection begins.
// oxlint-disable-next-line eslint/complexity -- Release metadata is one input validation boundary.
function validate(input: ReleaseInventoryInput): void {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(input.release.version)) {
    throw new Error("Invalid Claude release version");
  }
  if (!input.release.platform) {
    throw new Error("Release platform is required");
  }
  if (
    input.release.bunVersion !== null &&
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(input.release.bunVersion)
  ) {
    throw new Error("Invalid Bun version");
  }
  if (
    !Number.isSafeInteger(input.binary.bytes) ||
    input.binary.bytes < 1 ||
    !/^[a-f0-9]{64}$/u.test(input.binary.sha256)
  ) {
    throw new Error("Invalid binary identity");
  }
  if (!Number.isSafeInteger(input.graph.entry) || input.graph.entry < 0) {
    throw new Error("Invalid graph entry index");
  }
  const indexes = new Set<number>();
  for (const module of input.modules) {
    if (
      !Number.isSafeInteger(module.index) ||
      module.index < 0 ||
      indexes.has(module.index)
    ) {
      throw new Error(`Duplicate or invalid module index ${module.index}`);
    }
    if (!Number.isSafeInteger(module.bytes) || module.bytes < 0) {
      throw new Error(`Invalid module byte length: ${module.name}`);
    }
    if (!module.key || module.key.startsWith("/") || !module.name) {
      throw new Error(`Invalid module identity: ${module.name}`);
    }
    if (module.loader === 1 && typeof module.source !== "string") {
      throw new Error(`Missing decoded JavaScript source: ${module.name}`);
    }
    indexes.add(module.index);
  }
  if (!indexes.has(input.graph.entry)) {
    throw new Error(`Graph entry module ${input.graph.entry} is absent`);
  }
}

function decodedJavaScriptSource(module: ScannableModule): string {
  if (module.loader !== 1 || typeof module.source !== "string") {
    throw new Error(`Missing decoded JavaScript source: ${module.name}`);
  }
  return module.source;
}

function setDiff(left: Set<string>, right: Set<string>) {
  return {
    added: [...right].filter((value) => !left.has(value)).toSorted(compare),
    removed: [...left].filter((value) => !right.has(value)).toSorted(compare),
  };
}

/** Analyze only caller-decoded loader-1 sources; decoding and manifest I/O stay outside this portable core. */
export function scanClaudeReleaseInventory(
  input: ReleaseInventoryInput
): ClaudeReleaseInventory {
  validate(input);
  const modules = [...input.modules].toSorted((a, b) => a.index - b.index);
  const javascript = modules.filter((module) => module.loader === 1);
  const importInventory = inventoryReleaseImports(
    modules,
    input.graph.entry,
    input.capabilities.nodeBuiltinModules
  );
  const codegenModules = javascript.filter((module) =>
    importInventory.reachableIndexes.has(module.index)
  );
  const bunApis = inventoryBunApis(
    codegenModules.map((module) => ({
      name: module.name,
      source: decodedJavaScriptSource(module),
    }))
  );
  const moduleKeys = new Map(
    modules.map((module) => [module.name, module.key])
  );
  const guardedBunUses = guardedBunUseLocations(codegenModules, bunApis);
  const allGaps = findBuiltinGaps(
    bunApis,
    importInventory.builtins,
    input.capabilities,
    moduleKeys,
    guardedBunUses
  );
  const bunCapabilityGaps = allGaps.filter(
    (gap): gap is BunCapabilityGap => gap.kind === "bun-api"
  );
  const builtinGaps = allGaps.filter(
    (gap): gap is BuiltinGap => gap.kind === "node-builtin"
  );
  const reachable = modules.filter((module) =>
    importInventory.reachableIndexes.has(module.index)
  );
  const napiModules = reachable
    .filter((module) => module.loader === 10)
    .map((module) => ({
      index: module.index,
      key: module.key,
      name: module.name,
      bytes: module.bytes,
    }))
    .toSorted((a, b) => a.index - b.index);
  const codegenFindings = inventoryCodegenFeatures(
    codegenModules.map((module) => ({
      name: module.name,
      key: module.key,
      source: decodedJavaScriptSource(module),
      ...(module.format === undefined ? {} : { format: module.format }),
    }))
  );
  return {
    schemaVersion: 1,
    release: input.release,
    binary: input.binary,
    graph: {
      entry: input.graph.entry,
      flags: input.graph.flags,
      recordSize: input.graph.recordSize,
    },
    modules: {
      count: modules.length,
      bytes: modules.reduce((sum, module) => sum + module.bytes, 0),
      javascriptCount: javascript.length,
      javascriptBytes: javascript.reduce(
        (sum, module) => sum + module.bytes,
        0
      ),
      reachableCount: reachable.length,
      reachableJavascriptCount: codegenModules.length,
      reachableJavascriptBytes: codegenModules.reduce(
        (sum, module) => sum + module.bytes,
        0
      ),
    },
    bunApis,
    builtins: importInventory.builtins,
    napiModules,
    unresolvedReferences: importInventory.unresolvedReferences,
    unresolvedBareReferences: importInventory.unresolvedBareReferences,
    codegenFindings,
    builtinGaps,
    bunCapabilityGaps,
  };
}

export interface ReleaseInventoryDiff {
  readonly schemaVersion: 1;
  readonly baselineVersion: string;
  readonly candidateVersion: string;
  readonly addedBunMembers: readonly string[];
  readonly removedBunMembers: readonly string[];
  readonly addedBuiltinImports: readonly string[];
  readonly removedBuiltinImports: readonly string[];
  readonly addedNapiModules: readonly string[];
  readonly removedNapiModules: readonly string[];
  readonly addedCodegenOperations: readonly string[];
  readonly removedCodegenOperations: readonly string[];
  readonly addedProcPaths: readonly string[];
  readonly removedProcPaths: readonly string[];
  readonly moduleCountChanges: readonly {
    readonly field: keyof ModuleCounts;
    readonly baseline: number;
    readonly candidate: number;
  }[];
  readonly binaryBytesChange: {
    readonly baseline: number;
    readonly candidate: number;
  } | null;
  readonly bunVersionChange: {
    readonly baseline: string | null;
    readonly candidate: string | null;
  } | null;
  readonly newUnguardedNames: readonly (BuiltinGap | BunCapabilityGap)[];
  readonly unresolvedReferences: readonly UnresolvedReference[];
  readonly unresolvedBareReferences: readonly UnresolvedReference[];
}

/** Compare the candidate to a baseline by semantic names, with candidate locations for new gaps. */
export function diffReleaseInventories(
  baseline: ClaudeReleaseInventory,
  candidate: ClaudeReleaseInventory
): ReleaseInventoryDiff {
  const paths = (inventory: ClaudeReleaseInventory) =>
    new Set(inventory.bunApis.members.map((member) => member.path));
  const builtinNames = (inventory: ClaudeReleaseInventory) =>
    new Set(
      inventory.builtins.flatMap((item) => [
        ...item.imports.map(
          (entry) => `${item.canonicalBuiltin}:${entry.kind}:${entry.imported}`
        ),
        ...item.memberUses.map(
          (entry) =>
            `${item.canonicalBuiltin}:member:${entry.via}:${entry.member}`
        ),
        ...item.dynamicMemberUses.map(
          (entry) => `${item.canonicalBuiltin}:dynamic-member:${entry.via}`
        ),
      ])
    );
  const napiNames = (inventory: ClaudeReleaseInventory) =>
    new Set(inventory.napiModules.map((module) => module.key));
  const codegenOperations = (inventory: ClaudeReleaseInventory) =>
    new Set(
      inventory.codegenFindings
        .filter((finding) => finding.kind !== "proc-path")
        .map((finding) => finding.operation)
    );
  const procPaths = (inventory: ClaudeReleaseInventory) =>
    new Set(
      inventory.codegenFindings
        .filter((finding) => finding.kind === "proc-path")
        .map((finding) => finding.literal ?? finding.operation)
    );
  const bunDiff = setDiff(paths(baseline), paths(candidate));
  const builtinDiff = setDiff(builtinNames(baseline), builtinNames(candidate));
  const napiDiff = setDiff(napiNames(baseline), napiNames(candidate));
  const codegenDiff = setDiff(
    codegenOperations(baseline),
    codegenOperations(candidate)
  );
  const procPathDiff = setDiff(procPaths(baseline), procPaths(candidate));
  const moduleCountChanges = (
    Object.keys(baseline.modules) as (keyof ModuleCounts)[]
  )
    .filter((field) => baseline.modules[field] !== candidate.modules[field])
    .map((field) => ({
      field,
      baseline: baseline.modules[field],
      candidate: candidate.modules[field],
    }));
  const newUnguardedNames = diffNewBuiltinGaps(
    [...baseline.builtinGaps, ...baseline.bunCapabilityGaps],
    [...candidate.builtinGaps, ...candidate.bunCapabilityGaps]
  );
  return {
    schemaVersion: 1,
    baselineVersion: baseline.release.version,
    candidateVersion: candidate.release.version,
    addedBunMembers: bunDiff.added,
    removedBunMembers: bunDiff.removed,
    addedBuiltinImports: builtinDiff.added,
    removedBuiltinImports: builtinDiff.removed,
    addedNapiModules: napiDiff.added,
    removedNapiModules: napiDiff.removed,
    addedCodegenOperations: codegenDiff.added,
    removedCodegenOperations: codegenDiff.removed,
    addedProcPaths: procPathDiff.added,
    removedProcPaths: procPathDiff.removed,
    moduleCountChanges,
    binaryBytesChange:
      baseline.binary.bytes === candidate.binary.bytes
        ? null
        : {
            baseline: baseline.binary.bytes,
            candidate: candidate.binary.bytes,
          },
    bunVersionChange:
      baseline.release.bunVersion === candidate.release.bunVersion
        ? null
        : {
            baseline: baseline.release.bunVersion,
            candidate: candidate.release.bunVersion,
          },
    newUnguardedNames,
    unresolvedReferences: candidate.unresolvedReferences,
    unresolvedBareReferences: candidate.unresolvedBareReferences,
  };
}

export function assertNoNewUnguardedNames(diff: ReleaseInventoryDiff): void {
  if (!diff.newUnguardedNames.length) {
    return;
  }
  throw new Error(
    diff.newUnguardedNames
      .map(
        (gap) =>
          `${gap.module}:${gap.line}:${gap.column}: ${gap.name} (${gap.reason})`
      )
      .join("\n")
  );
}

export function assertInventoryIsClosed(
  inventory: ClaudeReleaseInventory
): void {
  if (
    !inventory.unresolvedReferences.length &&
    !inventory.unresolvedBareReferences.length
  ) {
    return;
  }
  const failures = [
    ...inventory.unresolvedReferences,
    ...inventory.unresolvedBareReferences,
  ]
    .toSorted((a, b) => compare(a.module, b.module) || a.offset - b.offset)
    .map(
      (item) =>
        `${item.module}:${item.line}:${item.column}: ${item.kind} ${item.specifier}`
    );
  throw new Error(failures.join("\n"));
}

/** Stable JSON string for a machine-readable inventory or diff. */
export function serializeReleaseInventory(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
