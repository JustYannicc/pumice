import type {
  HarnessCheckResult,
  HarnessEligibilityReason,
  HarnessMetric,
  HarnessProofEnvironment,
  HarnessProvider,
  HarnessReleaseArtifact,
  HarnessReleaseEligibility,
  HarnessReleaseProof,
  HarnessReleaseSelection,
  HarnessReleaseSelectionEvent,
} from "./types.js";

export const HARNESS_PROVIDERS = ["claude-code", "agent-sdk", "codex"] as const;
export const HARNESS_PROOF_ENVIRONMENTS = [
  "local-workerd",
  "deployed-do",
] as const;
export const REQUIRED_HARNESS_CHECKS = [
  "unchangedSource",
  "boot",
  "toolTurn",
  "resume",
  "mcp",
  "interrupt",
] as const;

export class HarnessReleaseLedgerError extends Error {
  readonly code:
    | "INVALID_RECORD"
    | "IMMUTABLE_CONFLICT"
    | "ARTIFACT_NOT_FOUND"
    | "IDENTITY_MISMATCH"
    | "CORRUPT_STORAGE";

  constructor(code: HarnessReleaseLedgerError["code"]) {
    super(code);
    this.code = code;
    this.name = "HarnessReleaseLedgerError";
  }
}

const objectRecord = (input: unknown): Record<string, unknown> => {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new HarnessReleaseLedgerError("INVALID_RECORD");
  }
  return input as Record<string, unknown>;
};

export const normalizeNonEmptyString = (input: unknown): string => {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new HarnessReleaseLedgerError("INVALID_RECORD");
  }
  return input;
};

export const normalizeProvider = (input: unknown): HarnessProvider => {
  if (!HARNESS_PROVIDERS.some((provider) => provider === input)) {
    throw new HarnessReleaseLedgerError("INVALID_RECORD");
  }
  return input as HarnessProvider;
};

export const normalizeExpectedRevision = (input: unknown) => {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new HarnessReleaseLedgerError("INVALID_RECORD");
  }
  return input as number;
};

const normalizeEnvironment = (input: unknown): HarnessProofEnvironment => {
  if (
    !HARNESS_PROOF_ENVIRONMENTS.some((environment) => environment === input)
  ) {
    throw new HarnessReleaseLedgerError("INVALID_RECORD");
  }
  return input as HarnessProofEnvironment;
};

export const normalizeArtifact = (input: unknown): HarnessReleaseArtifact => {
  const value = objectRecord(input);
  return {
    artifactHash: normalizeNonEmptyString(value.artifactHash),
    artifactRef: normalizeNonEmptyString(value.artifactRef),
    createdAt: normalizeNonEmptyString(value.createdAt),
    fixtureIdentity: normalizeNonEmptyString(value.fixtureIdentity),
    provider: normalizeProvider(value.provider),
    releaseId: normalizeNonEmptyString(value.releaseId),
    sourceIdentity: normalizeNonEmptyString(value.sourceIdentity),
  };
};

const normalizeMetric = (input: unknown, integer: boolean): HarnessMetric => {
  const value = objectRecord(input);
  if (value.state === "unmeasured") {
    return {
      reason: normalizeNonEmptyString(value.reason),
      state: "unmeasured",
    };
  }
  if (
    value.state !== "measured" ||
    typeof value.value !== "number" ||
    !Number.isFinite(value.value)
  ) {
    throw new HarnessReleaseLedgerError("INVALID_RECORD");
  }
  if (value.value < 0 || (integer && !Number.isSafeInteger(value.value))) {
    throw new HarnessReleaseLedgerError("INVALID_RECORD");
  }
  return { state: "measured", value: value.value };
};

const normalizeCheck = (input: unknown): HarnessCheckResult => {
  if (input !== "pending" && input !== "passed" && input !== "rejected") {
    throw new HarnessReleaseLedgerError("INVALID_RECORD");
  }
  return input;
};

export const normalizeProof = (input: unknown): HarnessReleaseProof => {
  const value = objectRecord(input);
  const checks = objectRecord(value.checks);
  const metrics = objectRecord(value.metrics);
  return {
    artifactHash: normalizeNonEmptyString(value.artifactHash),
    checks: Object.fromEntries(
      REQUIRED_HARNESS_CHECKS.map((check) => [
        check,
        normalizeCheck(checks[check]),
      ])
    ) as HarnessReleaseProof["checks"],
    environment: normalizeEnvironment(value.environment),
    fixtureIdentity: normalizeNonEmptyString(value.fixtureIdentity),
    metrics: {
      bootTimeMs: normalizeMetric(metrics.bootTimeMs, false),
      moduleBytes: normalizeMetric(metrics.moduleBytes, true),
      peakHeapBytes: normalizeMetric(metrics.peakHeapBytes, true),
    },
    proofId: normalizeNonEmptyString(value.proofId),
    provider: normalizeProvider(value.provider),
    recordedAt: normalizeNonEmptyString(value.recordedAt),
    releaseId: normalizeNonEmptyString(value.releaseId),
    sourceIdentity: normalizeNonEmptyString(value.sourceIdentity),
  };
};

export const normalizeSelectionEvent = (
  input: unknown
): HarnessReleaseSelectionEvent => {
  const value = objectRecord(input);
  const { action } = value;
  if (action !== "green" && action !== "pinback") {
    throw new HarnessReleaseLedgerError("CORRUPT_STORAGE");
  }
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) {
    throw new HarnessReleaseLedgerError("CORRUPT_STORAGE");
  }
  return {
    action,
    changedAt: normalizeNonEmptyString(value.changedAt),
    fromReleaseId:
      value.fromReleaseId === null
        ? null
        : normalizeNonEmptyString(value.fromReleaseId),
    lastGreenReleaseId: normalizeNonEmptyString(value.lastGreenReleaseId),
    provider: normalizeProvider(value.provider),
    reason:
      value.reason === null ? null : normalizeNonEmptyString(value.reason),
    revision: value.revision as number,
    toReleaseId: normalizeNonEmptyString(value.toReleaseId),
  };
};

// oxlint-disable-next-line eslint/complexity -- The persisted selection's nullability and revision invariants are one validation boundary.
export const normalizeSelection = (input: unknown): HarnessReleaseSelection => {
  const value = objectRecord(input);
  const revision = normalizeExpectedRevision(value.revision);
  const { currentReleaseId } = value;
  const { lastGreenReleaseId } = value;
  const { action } = value;
  const { changedAt } = value;
  if (
    (currentReleaseId !== null && typeof currentReleaseId !== "string") ||
    (lastGreenReleaseId !== null && typeof lastGreenReleaseId !== "string") ||
    (action !== null && action !== "green" && action !== "pinback") ||
    (changedAt !== null && typeof changedAt !== "string") ||
    (revision === 0 &&
      (currentReleaseId !== null ||
        lastGreenReleaseId !== null ||
        action !== null ||
        changedAt !== null)) ||
    (revision > 0 &&
      (currentReleaseId === null ||
        lastGreenReleaseId === null ||
        action === null ||
        changedAt === null))
  ) {
    throw new HarnessReleaseLedgerError("CORRUPT_STORAGE");
  }
  return {
    action,
    changedAt: changedAt === null ? null : normalizeNonEmptyString(changedAt),
    currentReleaseId:
      currentReleaseId === null
        ? null
        : normalizeNonEmptyString(currentReleaseId),
    lastGreenReleaseId:
      lastGreenReleaseId === null
        ? null
        : normalizeNonEmptyString(lastGreenReleaseId),
    provider: normalizeProvider(value.provider),
    revision,
  } as HarnessReleaseSelection;
};

export const equalRecords = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);

const latestProofs = (proofs: readonly HarnessReleaseProof[]) => {
  const latest = new Map<HarnessProofEnvironment, HarnessReleaseProof>();
  for (const proof of proofs) {
    latest.set(proof.environment, proof);
  }
  return latest;
};

export const releaseEligibility = (
  proofs: readonly HarnessReleaseProof[]
): HarnessReleaseEligibility => {
  const latest = latestProofs(proofs);
  const reasons: HarnessEligibilityReason[] = [];
  for (const environment of HARNESS_PROOF_ENVIRONMENTS) {
    const proof = latest.get(environment);
    if (proof === undefined) {
      reasons.push(
        environment === "local-workerd"
          ? "missing-local-proof"
          : "missing-deployed-proof"
      );
      continue;
    }
    if (Object.values(proof.checks).some((result) => result === "rejected")) {
      reasons.push("checks-rejected");
    } else if (
      Object.values(proof.checks).some((result) => result === "pending")
    ) {
      reasons.push("checks-pending");
    }
    if (
      Object.values(proof.metrics).some(
        (metric) => metric.state !== "measured"
      ) &&
      !reasons.includes("metrics-unmeasured")
    ) {
      reasons.push("metrics-unmeasured");
    }
  }
  if (reasons.length === 0) {
    return { status: "green", reasons: [] };
  }
  return {
    reasons,
    status: reasons.includes("checks-rejected") ? "rejected" : "pending",
  };
};
