import * as NodeCrypto from "node:crypto";

import {
  HARNESS_RELEASE_ARTIFACT_MANIFEST_PATH,
  openHarnessReleaseArtifact,
  serializeHarnessReleaseArtifactManifest,
} from "../artifacts.js";
import type { HarnessReleaseArtifactIdentity } from "../artifacts.js";
import { artifactDirectorySource } from "./prepareArtifact.js";

export interface HarnessArtifactPublicationStore {
  readonly put: (key: string, bytes: Uint8Array) => Promise<void>;
  readonly read: (key: string) => Promise<Uint8Array>;
}

export interface HarnessArtifactPublicationDestination {
  readonly store: HarnessArtifactPublicationStore;
  readonly key: (artifactRef: string, path: string) => string;
}

/** The caller maps artifact paths into a namespace it has already authorized. */
export const publishHarnessArtifact = async (
  identity: HarnessReleaseArtifactIdentity,
  directory: string,
  destination: HarnessArtifactPublicationDestination
) => {
  const selected = { ...identity };
  const { store } = destination;
  const local = artifactDirectorySource(directory);
  const artifact = await openHarnessReleaseArtifact(selected, local);
  const key = (path: string) => destination.key(selected.artifactRef, path);
  const remote = {
    read: async (_reference: string, path: string) => store.read(key(path)),
  };
  for (const path of Object.keys(artifact.manifest.files).toSorted()) {
    const bytes = await artifact.read(path);
    await store.put(key(path), bytes);
    const received = await remote.read(selected.artifactRef, path);
    const expected = artifact.manifest.files[path];
    if (expected === undefined) {
      throw new Error("HARNESS_ARTIFACT_UPLOAD_READBACK_FAILED");
    }
    if (
      received.byteLength !== expected.bytes ||
      NodeCrypto.createHash("sha256").update(received).digest("hex") !==
        expected.sha256
    ) {
      throw new Error("HARNESS_ARTIFACT_UPLOAD_READBACK_FAILED");
    }
  }
  const manifest = serializeHarnessReleaseArtifactManifest(artifact.manifest);
  await store.put(key(HARNESS_RELEASE_ARTIFACT_MANIFEST_PATH), manifest);
  await openHarnessReleaseArtifact(selected, remote);
  return {
    ...selected,
    bytes: Object.values(artifact.manifest.files).reduce(
      (total, file) => total + file.bytes,
      0
    ),
    files: Object.keys(artifact.manifest.files).length,
  };
};
