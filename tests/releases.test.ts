import { describe, expect, it } from "vite-plus/test";

import {
  createHarnessReleaseLedger,
  REQUIRED_HARNESS_CHECKS,
} from "../src/releases.ts";
import type {
  HarnessMetric,
  HarnessProofEnvironment,
  HarnessReleaseArtifact,
  HarnessReleaseLedger,
  HarnessReleaseProof,
  HarnessReleaseSelection,
} from "../src/releases.ts";
import { createMemoryLedgerStore } from "./fixtures/ledgerStore.ts";

const release = (releaseId: string): HarnessReleaseArtifact => ({
  artifactHash: `sha256-${releaseId}`,
  artifactRef: `fixture-artifact://${releaseId}`,
  createdAt: "2026-10-19T00:00:00.000Z",
  fixtureIdentity: `fixture-${releaseId}`,
  provider: "codex",
  releaseId,
  sourceIdentity: `source-${releaseId}`,
});

const checks = (
  overrides: Partial<HarnessReleaseProof["checks"]> = {}
): HarnessReleaseProof["checks"] =>
  Object.fromEntries(
    REQUIRED_HARNESS_CHECKS.map((check) => [
      check,
      overrides[check] ?? "passed",
    ])
  ) as HarnessReleaseProof["checks"];

const measured = (value: number): HarnessMetric => ({
  state: "measured",
  value,
});

const proof = (
  artifact: HarnessReleaseArtifact,
  environment: HarnessProofEnvironment,
  proofId: string,
  options: {
    readonly checks?: HarnessReleaseProof["checks"];
    readonly peakHeapBytes?: HarnessMetric;
  } = {}
): HarnessReleaseProof => ({
  artifactHash: artifact.artifactHash,
  checks: options.checks ?? checks(),
  environment,
  fixtureIdentity: artifact.fixtureIdentity,
  metrics: {
    bootTimeMs: measured(120),
    moduleBytes: measured(8192),
    peakHeapBytes: options.peakHeapBytes ?? measured(4096),
  },
  proofId,
  provider: artifact.provider,
  recordedAt: "2026-10-19T00:01:00.000Z",
  releaseId: artifact.releaseId,
  sourceIdentity: artifact.sourceIdentity,
});

const recordGreenEvidence = (
  ledger: HarnessReleaseLedger,
  artifact: HarnessReleaseArtifact
) => {
  ledger.recordProof(
    proof(artifact, "local-workerd", `${artifact.releaseId}-local`)
  );
  ledger.recordProof(
    proof(artifact, "deployed-do", `${artifact.releaseId}-deployed`)
  );
};

const selectGreen = (
  ledger: HarnessReleaseLedger,
  artifact: HarnessReleaseArtifact,
  expectedRevision: number,
  changedAt: string
) =>
  ledger.compareAndSwapLastGreen({
    changedAt,
    expectedRevision,
    provider: artifact.provider,
    releaseId: artifact.releaseId,
  });

const selection = (
  releaseId: string,
  revision: number,
  changedAt: string
): HarnessReleaseSelection => ({
  action: "green",
  changedAt,
  currentReleaseId: releaseId,
  lastGreenReleaseId: releaseId,
  provider: "codex",
  revision,
});

describe("public harness release ledger contract", () => {
  it("rolls back fixture writes when a transaction throws", () => {
    const memory = createMemoryLedgerStore();
    const ledger = createHarnessReleaseLedger(memory.store);
    const candidate = release("rollback");

    expect(() =>
      memory.store.transaction((transaction) => {
        transaction.insertArtifact(candidate);
        throw new Error("abort transaction");
      })
    ).toThrow("abort transaction");
    expect(
      ledger.getArtifact(candidate.provider, candidate.releaseId)
    ).toBeNull();
  });

  it("requires passing checks and measured metrics from local and deployed proof", () => {
    const memory = createMemoryLedgerStore();
    const ledger = createHarnessReleaseLedger(memory.store);
    const candidate = release("complete-proof");
    ledger.registerArtifact(candidate);
    ledger.recordProof(
      proof(candidate, "local-workerd", "complete-proof-local")
    );

    expect(
      ledger.getEligibility(candidate.provider, candidate.releaseId)
    ).toEqual({
      reasons: ["missing-deployed-proof"],
      status: "pending",
    });
    expect(
      selectGreen(ledger, candidate, 0, "2026-10-19T00:02:00.000Z").status
    ).toBe("not-green");

    ledger.recordProof(
      proof(candidate, "deployed-do", "complete-proof-deployed")
    );
    expect(
      ledger.getEligibility(candidate.provider, candidate.releaseId)
    ).toEqual({
      reasons: [],
      status: "green",
    });
    expect(
      selectGreen(ledger, candidate, 0, "2026-10-19T00:03:00.000Z").status
    ).toBe("selected");
  });

  it("keeps artifact and proof identities immutable", () => {
    const memory = createMemoryLedgerStore();
    const ledger = createHarnessReleaseLedger(memory.store);
    const candidate = release("immutable");
    ledger.registerArtifact(candidate);
    expect(ledger.registerArtifact({ ...candidate })).toEqual(candidate);
    expect(() =>
      ledger.registerArtifact({ ...candidate, artifactHash: "sha256-replaced" })
    ).toThrow("IMMUTABLE_CONFLICT");

    const localProof = proof(candidate, "local-workerd", "immutable-local");
    ledger.recordProof(localProof);
    expect(ledger.recordProof({ ...localProof })).toEqual(localProof);
    expect(() =>
      ledger.recordProof({
        ...localProof,
        recordedAt: "2026-10-20T00:00:00.000Z",
      })
    ).toThrow("IMMUTABLE_CONFLICT");
    expect(() =>
      ledger.recordProof({
        ...proof(candidate, "deployed-do", "wrong-source"),
        sourceIdentity: "source-from-another-artifact",
      })
    ).toThrow("IDENTITY_MISMATCH");
    expect(ledger.listProofs(candidate.provider, candidate.releaseId)).toEqual([
      localProof,
    ]);
  });

  it("refuses pending, rejected, or unmeasured evidence as the current release", () => {
    const cases: readonly {
      readonly releaseId: string;
      readonly environment: HarnessProofEnvironment;
      readonly checks?: HarnessReleaseProof["checks"];
      readonly peakHeapBytes?: HarnessMetric;
      readonly expected: "pending" | "rejected";
    }[] = [
      {
        checks: checks({ resume: "pending" }),
        environment: "local-workerd",
        expected: "pending",
        releaseId: "pending-check",
      },
      {
        checks: checks({ interrupt: "rejected" }),
        environment: "deployed-do",
        expected: "rejected",
        releaseId: "rejected-check",
      },
      {
        environment: "local-workerd",
        expected: "pending",
        peakHeapBytes: {
          reason: "heap counter unavailable",
          state: "unmeasured",
        },
        releaseId: "unmeasured-heap",
      },
    ];

    for (const scenario of cases) {
      const memory = createMemoryLedgerStore();
      const ledger = createHarnessReleaseLedger(memory.store);
      const candidate = release(scenario.releaseId);
      ledger.registerArtifact(candidate);
      ledger.recordProof(
        proof(
          candidate,
          "local-workerd",
          `${scenario.releaseId}-local`,
          scenario.environment === "local-workerd" ? scenario : {}
        )
      );
      ledger.recordProof(
        proof(
          candidate,
          "deployed-do",
          `${scenario.releaseId}-deployed`,
          scenario.environment === "deployed-do" ? scenario : {}
        )
      );

      expect(
        selectGreen(ledger, candidate, 0, "2026-10-19T00:04:00.000Z")
      ).toMatchObject({
        eligibility: { status: scenario.expected },
        status: "not-green",
      });
      expect(ledger.getSelection(candidate.provider)).toMatchObject({
        currentReleaseId: null,
        revision: 0,
      });
    }
  });

  it("returns a CAS conflict when another green selection wins", () => {
    const memory = createMemoryLedgerStore();
    const ledger = createHarnessReleaseLedger(memory.store);
    const candidate = release("cas-loser");
    const winner = release("cas-winner");
    ledger.registerArtifact(candidate);
    ledger.registerArtifact(winner);
    recordGreenEvidence(ledger, candidate);
    recordGreenEvidence(ledger, winner);
    const winningSelection = selection(
      winner.releaseId,
      1,
      "2026-10-19T00:05:00.000Z"
    );
    memory.simulateNextCasConflict(winningSelection, {
      action: "green",
      changedAt: winningSelection.changedAt ?? "",
      fromReleaseId: null,
      lastGreenReleaseId: winner.releaseId,
      provider: winner.provider,
      reason: null,
      revision: winningSelection.revision,
      toReleaseId: winner.releaseId,
    });

    expect(
      ledger.compareAndSwapLastGreen({
        changedAt: "2026-10-19T00:06:00.000Z",
        expectedRevision: 0,
        provider: candidate.provider,
        releaseId: candidate.releaseId,
      })
    ).toEqual({ selection: winningSelection, status: "conflict" });
    expect(ledger.resolveCurrent(winner.provider)?.releaseId).toBe(
      winner.releaseId
    );
    expect(ledger.listSelectionEvents(winner.provider)).toHaveLength(1);
  });

  it("requires current proof eligibility before pinning back to a historical green release", () => {
    const memory = createMemoryLedgerStore();
    const ledger = createHarnessReleaseLedger(memory.store);
    const earlier = release("historical-green");
    const current = release("current-green");
    ledger.registerArtifact(earlier);
    ledger.registerArtifact(current);
    recordGreenEvidence(ledger, earlier);
    recordGreenEvidence(ledger, current);

    expect(
      selectGreen(ledger, earlier, 0, "2026-10-19T00:07:00.000Z").status
    ).toBe("selected");
    expect(
      selectGreen(ledger, current, 1, "2026-10-19T00:08:00.000Z").status
    ).toBe("selected");

    ledger.recordProof(
      proof(earlier, "deployed-do", "historical-proof-now-pending", {
        checks: checks({ toolTurn: "pending" }),
      })
    );
    expect(
      ledger.pinBack({
        changedAt: "2026-10-19T00:09:00.000Z",
        expectedRevision: 2,
        provider: earlier.provider,
        reason: "restore earlier release",
        releaseId: earlier.releaseId,
      })
    ).toMatchObject({
      eligibility: { status: "pending" },
      status: "not-green",
    });
    expect(ledger.resolveCurrent(current.provider)?.releaseId).toBe(
      current.releaseId
    );
    expect(ledger.listSelectionEvents(current.provider)).toHaveLength(2);

    ledger.recordProof(
      proof(earlier, "deployed-do", "historical-proof-restored")
    );
    expect(
      ledger.pinBack({
        changedAt: "2026-10-19T00:10:00.000Z",
        expectedRevision: 2,
        provider: earlier.provider,
        reason: "restore earlier release after fresh evidence",
        releaseId: earlier.releaseId,
      }).status
    ).toBe("selected");
    expect(ledger.resolveCurrent(current.provider)?.releaseId).toBe(
      earlier.releaseId
    );
    expect(ledger.getSelection(current.provider).lastGreenReleaseId).toBe(
      current.releaseId
    );
  });
});
