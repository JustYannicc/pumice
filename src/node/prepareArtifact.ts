import type { HarnessReleaseArtifactIdentity } from "../artifacts.js";
import { prepareHarnessArtifactWithFileSystem } from "./prepareArtifact.internal.js";
import type { PrepareHarnessArtifactInput } from "./prepareArtifact.internal.js";

export { artifactDirectorySource } from "./prepareArtifact.internal.js";
export type { PrepareHarnessArtifactInput } from "./prepareArtifact.internal.js";

export const prepareHarnessArtifact = (
  input: PrepareHarnessArtifactInput
): Promise<HarnessReleaseArtifactIdentity> =>
  prepareHarnessArtifactWithFileSystem(input);
