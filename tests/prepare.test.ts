import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  artifactDirectorySource,
  prepareHarnessArtifact,
} from "../src/artifacts-node.ts";
import { openHarnessReleaseArtifact } from "../src/artifacts.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => NodeFSP.rm(root, { force: true, recursive: true }))
  );
});
const setup = async () => {
  const root = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "artifact-prepare-")
  );
  roots.push(root);
  const cli = NodePath.join(root, "cli");
  const sdk = NodePath.join(root, "sdk");
  await NodeFSP.mkdir(NodePath.join(cli, "chunks"), { recursive: true });
  await NodeFSP.mkdir(sdk);
  const manifest = '{ "schemaVersion": 1, "mainModule": "entry.js" }\n';
  await NodeFSP.writeFile(NodePath.join(cli, "manifest.json"), manifest);
  await NodeFSP.writeFile(
    NodePath.join(cli, "chunks/%2F%24bunfs.js"),
    "export const cli=1;"
  );
  await NodeFSP.writeFile(
    NodePath.join(sdk, "manifest.json"),
    '{"mainModule":"sdk.js"}'
  );
  await NodeFSP.writeFile(NodePath.join(sdk, "sdk.js"), "export const sdk=1;");
  return {
    cli,
    input: {
      components: { cli, sdk },
      computer: {
        manifestSha256: "c".repeat(64),
        sourceIdentity: "b".repeat(64),
      },
      harness: "claude-code" as const,
      output: NodePath.join(root, "output"),
      sourceIdentity: "a".repeat(64),
    },
    manifest,
    root,
    sdk,
  };
};

describe("Harness artifact preparation", () => {
  it("preserves raw provider bytes and binds both components in one identity", async () => {
    const { root, sdk, manifest, input } = await setup();
    const identity = await prepareHarnessArtifact(input);
    const outputIdentity = await NodeFSP.lstat(input.output);
    const outputDirectory = await NodeFSP.stat(input.output);
    expect(outputDirectory.isDirectory()).toBe(true);
    if (NodePath.sep === "/") {
      expect(outputDirectory.mode.toString(8).slice(-3)).toBe("700");
    }
    const stagingPath = await NodeFSP.realpath(input.output);
    const envelope = await NodeFSP.readFile(
      NodePath.join(input.output, "manifest.json"),
      "utf-8"
    );
    expect(envelope).not.toContain(stagingPath);
    const outputManifest = await NodeFSP.readFile(
      NodePath.join(input.output, "cli", "manifest.json")
    );
    const artifact = await openHarnessReleaseArtifact(
      identity,
      artifactDirectorySource(input.output)
    );
    expect(
      new TextDecoder().decode(await artifact.read("cli/manifest.json"))
    ).toBe(manifest);
    expect(
      new TextDecoder().decode(await artifact.read("cli/chunks/%2F%24bunfs.js"))
    ).toBe("export const cli=1;");
    expect(artifact.rawManifests.sdk?.mainModule).toBe("sdk.js");
    await NodeFSP.writeFile(
      NodePath.join(sdk, "sdk.js"),
      "export const sdk=2;"
    );
    const changed = await prepareHarnessArtifact({
      ...input,
      output: NodePath.join(root, "changed"),
    });
    expect(changed.artifactHash).not.toBe(identity.artifactHash);
    await expect(prepareHarnessArtifact(input)).rejects.toThrow(
      "HARNESS_ARTIFACT_OUTPUT_EXISTS"
    );
    const outputAfterRepeat = await NodeFSP.lstat(input.output);
    expect(outputAfterRepeat.dev).toBe(outputIdentity.dev);
    expect(outputAfterRepeat.ino).toBe(outputIdentity.ino);
    expect(
      await NodeFSP.readFile(
        NodePath.join(input.output, "cli", "manifest.json")
      )
    ).toEqual(outputManifest);
    expect(new TextDecoder().decode(await artifact.read("sdk/sdk.js"))).toBe(
      "export const sdk=1;"
    );
  });

  it("rejects a pre-existing public destination without changing it", async () => {
    const { root, input } = await setup();
    const marker = NodePath.join(input.output, "owner.txt");
    await NodeFSP.mkdir(input.output);
    await NodeFSP.writeFile(marker, "keep this directory");
    const original = await NodeFSP.lstat(input.output);

    await expect(prepareHarnessArtifact(input)).rejects.toThrow(
      "HARNESS_ARTIFACT_OUTPUT_EXISTS"
    );
    const current = await NodeFSP.lstat(input.output);
    expect(current.dev).toBe(original.dev);
    expect(current.ino).toBe(original.ino);
    expect(await NodeFSP.readFile(marker, "utf-8")).toBe("keep this directory");
    expect(await NodeFSP.readdir(root)).toContain("output");
  });

  it("refuses incomplete pairs and escaping symlinks without publishing a manifest", async () => {
    const { root, cli, input } = await setup();
    await expect(
      prepareHarnessArtifact({ ...input, components: { cli } })
    ).rejects.toThrow("HARNESS_ARTIFACT_COMPONENTS_INVALID");
    await NodeFSP.symlink(
      NodePath.join(root, "sdk/sdk.js"),
      NodePath.join(cli, "external.js")
    );
    await expect(prepareHarnessArtifact(input)).rejects.toThrow(
      "HARNESS_ARTIFACT_SYMLINK"
    );
    await expect(NodeFSP.lstat(input.output)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses an output inside a component before recursively copying it", async () => {
    const { cli, input } = await setup();
    await expect(
      prepareHarnessArtifact({ ...input, output: NodePath.join(cli, "output") })
    ).rejects.toThrow("HARNESS_ARTIFACT_OUTPUT_INSIDE_INPUT");
  });
});
