import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  prepareHarnessArtifact,
  publishHarnessArtifact,
} from "../src/artifacts-node.ts";
import { openHarnessReleaseArtifact } from "../src/artifacts.ts";

const roots: string[] = [];
const authorizedKey = (reference: string, path: string) =>
  `authorized/${reference}/${path}`;
const selectedKey = (_reference: string, path: string) => `selected/${path}`;
const identityKey = (_reference: string, path: string) => path;

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => NodeFSP.rm(root, { force: true, recursive: true }))
  );
});

const setup = async () => {
  const root = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "artifact-publish-")
  );
  roots.push(root);
  const codex = NodePath.join(root, "codex");
  await NodeFSP.mkdir(codex);
  await NodeFSP.writeFile(
    NodePath.join(codex, "manifest.json"),
    '{"version":"test"}'
  );
  await NodeFSP.writeFile(
    NodePath.join(codex, "engine.wasm"),
    new Uint8Array([0, 97, 115, 109])
  );
  const output = NodePath.join(root, "output");
  const identity = await prepareHarnessArtifact({
    components: { codex },
    computer: {
      manifestSha256: "c".repeat(64),
      sourceIdentity: "b".repeat(64),
    },
    harness: "codex",
    output,
    sourceIdentity: "a".repeat(64),
  });
  return { identity, output };
};

describe("artifact publication through supplied authority", () => {
  it("uses the injected key mapping and publishes a reopenable manifest last", async () => {
    const { identity, output } = await setup();
    const objects = new Map<string, Uint8Array>();
    const writes: string[] = [];
    const store = {
      put: async (path: string, bytes: Uint8Array) => {
        writes.push(path);
        objects.set(path, Uint8Array.from(bytes));
      },
      read: async (path: string) => {
        const bytes = objects.get(path);
        if (!bytes) {
          throw new Error("missing");
        }
        return Uint8Array.from(bytes);
      },
    };
    const result = await publishHarnessArtifact(identity, output, {
      key: authorizedKey,
      store,
    });
    const reopened = await openHarnessReleaseArtifact(identity, {
      read: async (reference, path) =>
        store.read(authorizedKey(reference, path)),
    });
    expect([...(await reopened.read("codex/engine.wasm"))]).toEqual([
      0, 97, 115, 109,
    ]);
    expect(result).toEqual({ ...identity, bytes: 22, files: 2 });
    expect(writes.at(-1)).toBe(
      authorizedKey(identity.artifactRef, "manifest.json")
    );
    expect(writes.every((path) => path.startsWith("authorized/"))).toBe(true);
  });

  it("withholds the manifest when a store corrupts a payload and its supplied buffer", async () => {
    const { identity, output } = await setup();
    const objects = new Map<string, Uint8Array>();
    const store = {
      put: async (path: string, bytes: Uint8Array) => {
        bytes[0] = 255;
        objects.set(path, bytes);
      },
      read: async (path: string) => objects.get(path) ?? new Uint8Array(),
    };
    await expect(
      publishHarnessArtifact(identity, output, { key: selectedKey, store })
    ).rejects.toThrow("HARNESS_ARTIFACT_UPLOAD_READBACK_FAILED");
    expect(
      objects.has(selectedKey(identity.artifactRef, "manifest.json"))
    ).toBe(false);
  });

  it("fails final open verification if manifest storage changes its canonical bytes", async () => {
    const { identity, output } = await setup();
    const objects = new Map<string, Uint8Array>();
    const store = {
      put: async (path: string, bytes: Uint8Array) => {
        const stored = Uint8Array.from(bytes);
        if (path === "manifest.json") {
          stored[0] = 255;
        }
        objects.set(path, stored);
      },
      read: async (path: string) => objects.get(path) ?? new Uint8Array(),
    };
    await expect(
      publishHarnessArtifact(identity, output, { key: identityKey, store })
    ).rejects.toMatchObject({
      code: "MANIFEST_HASH_MISMATCH",
    });
  });
});
