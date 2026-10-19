import type {
  HarnessProvider,
  HarnessReleaseArtifact,
  HarnessReleaseLedgerStore,
  HarnessReleaseLedgerTransaction,
  HarnessReleaseProof,
  HarnessReleaseSelection,
  HarnessReleaseSelectionEvent,
} from "../../src/releases.ts";

interface MemoryState {
  artifacts: Map<string, HarnessReleaseArtifact>;
  proofs: Map<string, HarnessReleaseProof>;
  selections: Map<HarnessProvider, HarnessReleaseSelection>;
  events: Map<HarnessProvider, HarnessReleaseSelectionEvent[]>;
}

const copyArtifact = (
  artifact: HarnessReleaseArtifact
): HarnessReleaseArtifact => ({
  ...artifact,
});

const copyProof = (proof: HarnessReleaseProof): HarnessReleaseProof => ({
  ...proof,
  checks: { ...proof.checks },
  metrics: {
    bootTimeMs: { ...proof.metrics.bootTimeMs },
    moduleBytes: { ...proof.metrics.moduleBytes },
    peakHeapBytes: { ...proof.metrics.peakHeapBytes },
  },
});

const copySelection = (
  selection: HarnessReleaseSelection
): HarnessReleaseSelection => ({
  ...selection,
});

const copyEvent = (
  event: HarnessReleaseSelectionEvent
): HarnessReleaseSelectionEvent => ({
  ...event,
});

const copyState = (state: MemoryState): MemoryState => ({
  artifacts: new Map(
    [...state.artifacts].map(([key, value]) => [key, copyArtifact(value)])
  ),
  events: new Map(
    [...state.events].map(([key, values]) => [key, values.map(copyEvent)])
  ),
  proofs: new Map(
    [...state.proofs].map(([key, value]) => [key, copyProof(value)])
  ),
  selections: new Map(
    [...state.selections].map(([key, value]) => [key, copySelection(value)])
  ),
});

const artifactKey = (provider: HarnessProvider, releaseId: string) =>
  `${provider}\0${releaseId}`;

const emptySelection = (
  provider: HarnessProvider
): HarnessReleaseSelection => ({
  action: null,
  changedAt: null,
  currentReleaseId: null,
  lastGreenReleaseId: null,
  provider,
  revision: 0,
});

export const createMemoryLedgerStore = () => {
  let state: MemoryState = {
    artifacts: new Map(),
    events: new Map(),
    proofs: new Map(),
    selections: new Map(),
  };
  let nextCasConflict: {
    readonly selection: HarnessReleaseSelection;
    readonly event: HarnessReleaseSelectionEvent;
  } | null = null;

  const store: HarnessReleaseLedgerStore = {
    transaction<T>(
      operation: (transaction: HarnessReleaseLedgerTransaction) => T
    ): T {
      const draft = copyState(state);
      const transaction: HarnessReleaseLedgerTransaction = {
        appendProof(proof) {
          draft.proofs.set(proof.proofId, copyProof(proof));
        },
        appendSelectionEvent(event) {
          const events = draft.events.get(event.provider) ?? [];
          draft.events.set(event.provider, [...events, copyEvent(event)]);
        },
        compareAndSwapSelection(provider, expectedRevision, next) {
          const current =
            draft.selections.get(provider) ?? emptySelection(provider);
          if (current.revision !== expectedRevision) {
            return false;
          }
          if (nextCasConflict !== null) {
            draft.selections.set(
              provider,
              copySelection(nextCasConflict.selection)
            );
            const events = draft.events.get(provider) ?? [];
            draft.events.set(provider, [
              ...events,
              copyEvent(nextCasConflict.event),
            ]);
            nextCasConflict = null;
            return false;
          }
          draft.selections.set(provider, copySelection(next));
          return true;
        },
        getArtifact(provider, releaseId) {
          const artifact = draft.artifacts.get(
            artifactKey(provider, releaseId)
          );
          return artifact === undefined ? null : copyArtifact(artifact);
        },
        getProof(proofId) {
          const proof = draft.proofs.get(proofId);
          return proof === undefined ? null : copyProof(proof);
        },
        getSelection(provider) {
          const selection = draft.selections.get(provider);
          return selection === undefined
            ? emptySelection(provider)
            : copySelection(selection);
        },
        insertArtifact(artifact) {
          draft.artifacts.set(
            artifactKey(artifact.provider, artifact.releaseId),
            copyArtifact(artifact)
          );
        },
        listProofs(provider, releaseId) {
          return [...draft.proofs.values()]
            .filter(
              (proof) =>
                proof.provider === provider && proof.releaseId === releaseId
            )
            .map(copyProof);
        },
        listSelectionEvents(provider) {
          return (draft.events.get(provider) ?? []).map(copyEvent);
        },
        wasEverGreen(provider, releaseId) {
          return (draft.events.get(provider) ?? []).some(
            (event) =>
              event.action === "green" && event.toReleaseId === releaseId
          );
        },
      };

      const result = operation(transaction);
      state = draft;
      return result;
    },
  };

  return {
    simulateNextCasConflict(
      selection: HarnessReleaseSelection,
      event: HarnessReleaseSelectionEvent
    ) {
      nextCasConflict = {
        selection: copySelection(selection),
        event: copyEvent(event),
      };
    },
    store,
  };
};
