import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import NodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  artifactDirectorySource,
  prepareHarnessArtifact,
} from "../src/artifacts-node.ts";
import { openHarnessReleaseArtifact } from "../src/artifacts.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFSP>();
  return {
    ...actual,
    lstat: vi.fn(actual.lstat),
    mkdir: vi.fn(actual.mkdir),
    mkdtemp: vi.fn(actual.mkdtemp),
    open: vi.fn(actual.open),
    readFile: vi.fn(actual.readFile),
    readdir: vi.fn(actual.readdir),
    realpath: vi.fn(actual.realpath),
    rmdir: vi.fn(actual.rmdir),
    symlink: vi.fn(actual.symlink),
    unlink: vi.fn(actual.unlink),
  };
});

const roots: string[] = [];
const setup = async () => {
  const root = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "artifact-prepare-race-")
  );
  roots.push(root);
  const cli = NodePath.join(root, "cli");
  const sdk = NodePath.join(root, "sdk");
  await NodeFSP.mkdir(NodePath.join(cli, "chunks"), { recursive: true });
  await NodeFSP.mkdir(sdk);
  await NodeFSP.writeFile(
    NodePath.join(cli, "manifest.json"),
    '{"mainModule":"entry.js"}'
  );
  await NodeFSP.writeFile(
    NodePath.join(cli, "chunks", "runtime.js"),
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
    root,
    sdk,
  };
};

afterEach(async () => {
  const actual = await vi.importActual<typeof NodeFSP>("node:fs/promises");
  await Promise.all(
    roots
      .splice(0)
      .map((root) => actual.rm(root, { force: true, recursive: true }))
  );
  vi.mocked(NodeFSP.mkdir).mockReset();
  vi.mocked(NodeFSP.mkdtemp).mockReset();
  vi.mocked(NodeFSP.realpath).mockReset();
  vi.mocked(NodeFSP.readdir).mockReset();
  vi.mocked(NodeFSP.lstat).mockReset();
  vi.mocked(NodeFSP.open).mockReset();
  vi.mocked(NodeFSP.readFile).mockReset();
  vi.mocked(NodeFSP.symlink).mockReset();
  vi.mocked(NodeFSP.unlink).mockReset();
  vi.mocked(NodeFSP.rmdir).mockReset();
  vi.mocked(NodeFSP.mkdir).mockImplementation(actual.mkdir);
  vi.mocked(NodeFSP.mkdtemp).mockImplementation(actual.mkdtemp);
  vi.mocked(NodeFSP.realpath).mockImplementation(actual.realpath);
  vi.mocked(NodeFSP.readdir).mockImplementation(actual.readdir);
  vi.mocked(NodeFSP.lstat).mockImplementation(actual.lstat);
  vi.mocked(NodeFSP.open).mockImplementation(actual.open);
  vi.mocked(NodeFSP.readFile).mockImplementation(actual.readFile);
  vi.mocked(NodeFSP.symlink).mockImplementation(actual.symlink);
  vi.mocked(NodeFSP.unlink).mockImplementation(actual.unlink);
  vi.mocked(NodeFSP.rmdir).mockImplementation(actual.rmdir);
});

describe("public artifact preparation race boundaries", () => {
  it("rejects a listed source directory replaced by an external symlink", async () => {
    const { root, cli, input } = await setup();
    const actual = await vi.importActual<typeof NodeFSP>("node:fs/promises");
    const canonicalCli = await actual.realpath(cli);
    const chunks = NodePath.join(cli, "chunks");
    const external = NodePath.join(root, "external");
    await actual.mkdir(external);
    await actual.writeFile(NodePath.join(external, "outside.js"), "outside");
    let replaced = false;

    vi.mocked(NodeFSP.readdir).mockImplementation(async (path, options) => {
      const entries = await actual.readdir(path, options);
      if (path === canonicalCli && !replaced) {
        replaced = true;
        await actual.rename(chunks, NodePath.join(cli, "chunks-original"));
        await actual.symlink(external, chunks, "dir");
      }
      return entries;
    });

    await expect(prepareHarnessArtifact(input)).rejects.toThrow(
      "HARNESS_ARTIFACT_SYMLINK"
    );
    expect(replaced).toBe(true);
    await expect(actual.lstat(input.output)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a source file replaced after its identity check", async () => {
    const { root, sdk, input } = await setup();
    const actual = await vi.importActual<typeof NodeFSP>("node:fs/promises");
    const sourceFile = NodePath.join(sdk, "sdk.js");
    const canonicalSourceFile = NodePath.join(
      await actual.realpath(sdk),
      "sdk.js"
    );
    const externalFile = NodePath.join(root, "external.js");
    await actual.writeFile(externalFile, "outside");
    let replaced = false;

    vi.mocked(NodeFSP.open).mockImplementation(async (path, flags, mode) => {
      if (path === canonicalSourceFile && flags === "r" && !replaced) {
        replaced = true;
        await actual.rename(sourceFile, NodePath.join(sdk, "sdk-original.js"));
        await actual.symlink(externalFile, sourceFile);
      }
      return actual.open(path, flags, mode);
    });

    await expect(prepareHarnessArtifact(input)).rejects.toThrow(
      "HARNESS_ARTIFACT_FILE_CHANGED"
    );
    expect(replaced).toBe(true);
    await expect(actual.lstat(input.output)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves a foreign public output while failed preparation cleans owned staging", async () => {
    const { input, cli } = await setup();
    const actual = await vi.importActual<typeof NodeFSP>("node:fs/promises");
    await actual.writeFile(NodePath.join(cli, "manifest.json"), "[]");
    const marker = NodePath.join(input.output, "foreign.txt");
    let replacement: { dev: number; ino: number } | undefined;
    let stagingPath: string | undefined;
    let injected = false;

    vi.mocked(NodeFSP.readFile).mockImplementation(async (path, options) => {
      const bytes = await actual.readFile(path, options);
      const filePath = path.toString();
      if (
        !injected &&
        filePath.includes(".harness-artifact-stage-") &&
        NodePath.basename(NodePath.dirname(filePath)) === "cli" &&
        NodePath.basename(filePath) === "manifest.json"
      ) {
        injected = true;
        stagingPath = NodePath.dirname(NodePath.dirname(filePath));
        await actual.mkdir(input.output);
        const stat = await actual.lstat(input.output);
        replacement = { dev: stat.dev, ino: stat.ino };
        await actual.writeFile(marker, "foreign output contents");
        const foreignComponent = NodePath.join(input.output, "cli");
        await actual.mkdir(foreignComponent);
        await actual.writeFile(
          NodePath.join(foreignComponent, "manifest.json"),
          "[]"
        );
      }
      return bytes;
    });

    await expect(prepareHarnessArtifact(input)).rejects.toThrow(
      "RAW_MANIFEST_NOT_OBJECT"
    );
    expect(injected).toBe(true);
    const current = await actual.lstat(input.output);
    expect(current.dev).toBe(replacement?.dev);
    expect(current.ino).toBe(replacement?.ino);
    expect(await actual.readFile(marker, "utf-8")).toBe(
      "foreign output contents"
    );
    expect(
      await actual.readFile(
        NodePath.join(input.output, "cli", "manifest.json"),
        "utf-8"
      )
    ).toBe("[]");
    if (!stagingPath) {
      throw new Error("Missing owned staging path");
    }
    await expect(actual.lstat(stagingPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves a destination another writer claims during publication", async () => {
    const { input } = await setup();
    const actual = await vi.importActual<typeof NodeFSP>("node:fs/promises");
    const marker = NodePath.join(input.output, "other-owner.txt");
    const output = NodePath.join(
      await actual.realpath(NodePath.dirname(input.output)),
      "output"
    );
    let claimed: { dev: number; ino: number } | undefined;
    let created = false;

    vi.mocked(NodeFSP.symlink).mockImplementation(
      async (target, path, type) => {
        if (path === output && !created) {
          created = true;
          await actual.mkdir(input.output);
          await actual.writeFile(marker, "keep this directory");
          const stat = await actual.lstat(input.output);
          claimed = { dev: stat.dev, ino: stat.ino };
        }
        return actual.symlink(target, path, type);
      }
    );

    await expect(prepareHarnessArtifact(input)).rejects.toThrow(
      "HARNESS_ARTIFACT_OUTPUT_EXISTS"
    );
    expect(created).toBe(true);
    const current = await actual.lstat(input.output);
    expect(current.dev).toBe(claimed?.dev);
    expect(current.ino).toBe(claimed?.ino);
    expect(await actual.readFile(marker, "utf-8")).toBe("keep this directory");
  });

  it("keeps the final envelope unavailable until payload writes finish and the artifact publishes", async () => {
    const { input } = await setup();
    const actual = await vi.importActual<typeof NodeFSP>("node:fs/promises");
    let checks = 0;

    vi.mocked(NodeFSP.open).mockImplementation(async (path, flags, mode) => {
      const handle = await actual.open(path, flags, mode);
      const filePath = path.toString();
      const isFinalEnvelope =
        NodePath.basename(filePath) === "manifest.json" &&
        NodePath.basename(NodePath.dirname(filePath)).startsWith(
          ".harness-artifact-stage-"
        );
      if (
        flags !== "wx" ||
        !filePath.includes(".harness-artifact-stage-") ||
        isFinalEnvelope
      ) {
        return handle;
      }
      return {
        close: () => handle.close(),
        readFile: () => handle.readFile(),
        stat: () => handle.stat(),
        writeFile: async (bytes) => {
          await handle.writeFile(bytes);
          checks += 1;
          await expect(
            artifactDirectorySource(input.output).read("", "manifest.json")
          ).rejects.toMatchObject({ code: "ENOENT" });
        },
      } as Awaited<ReturnType<typeof NodeFSP.open>>;
    });

    const identity = await prepareHarnessArtifact(input);
    expect(checks).toBeGreaterThan(0);
    const opened = await openHarnessReleaseArtifact(
      identity,
      artifactDirectorySource(input.output)
    );
    expect(opened.manifest.sourceIdentity).toBe(input.sourceIdentity);
  });
});
