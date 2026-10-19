import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const { dirname, join } = path;
const repository = dirname(import.meta.dirname);
const manifest = JSON.parse(
  await readFile(join(repository, "package.json"), "utf-8")
);
const temporary = await mkdtemp(join(tmpdir(), "pumice-package-"));
const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, stdio: "inherit" });
try {
  run("pnpm", ["pack", "--pack-destination", temporary], repository);
  const archive = join(temporary, `pumice-${manifest.version}.tgz`);
  await writeFile(
    join(temporary, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      packageManager: manifest.packageManager,
      dependencies: {
        pumice: `file:${archive}`,
        effect: manifest.peerDependencies.effect,
      },
      devDependencies: {
        typescript: manifest.devDependencies.typescript,
        "@types/node": manifest.devDependencies["@types/node"],
      },
    })
  );
  run("pnpm", ["install", "--ignore-scripts"], temporary);
  const installed = JSON.parse(
    await readFile(join(temporary, "node_modules/pumice/package.json"), "utf-8")
  );
  assert.equal(installed.version, manifest.version);
  assert.equal(installed.name, "pumice");
  await writeFile(
    join(temporary, "consumer.mts"),
    `
import { openHarnessReleaseArtifact, type HarnessReleaseArtifactIdentity } from "pumice/artifacts";
import { artifactDirectorySource, prepareHarnessArtifact, publishHarnessArtifact, type PrepareHarnessArtifactInput } from "pumice/artifacts/node";
import { createHarnessReleaseLedger, type HarnessReleaseLedgerStore } from "pumice/releases";
export const readPrepared = async (input: PrepareHarnessArtifactInput) => {
  const identity: HarnessReleaseArtifactIdentity = await prepareHarnessArtifact(input);
  return openHarnessReleaseArtifact(identity, artifactDirectorySource(input.output));
};
export const makeLedger = (store: HarnessReleaseLedgerStore) => createHarnessReleaseLedger(store);
export { publishHarnessArtifact };
`
  );
  await writeFile(
    join(temporary, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2023",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        allowImportingTsExtensions: false,
        types: ["node"],
      },
      include: ["consumer.mts"],
    })
  );
  run("pnpm", ["exec", "tsc", "-p", "tsconfig.json"], temporary);
  await writeFile(
    join(temporary, "runtime.mjs"),
    `
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { openHarnessReleaseArtifact } from "pumice/artifacts";
import { artifactDirectorySource, prepareHarnessArtifact, publishHarnessArtifact } from "pumice/artifacts/node";
import { REQUIRED_HARNESS_CHECKS } from "pumice/releases";
await mkdir("input");
await writeFile("input/manifest.json", '{"mainModule":"entry.wasm"}');
const payload = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
await writeFile("input/entry.wasm", payload);
const identity = await prepareHarnessArtifact({
  harness: "codex", sourceIdentity: "a".repeat(64),
  computer: { sourceIdentity: "b".repeat(64), manifestSha256: "c".repeat(64) },
  components: { codex: "input" }, output: "prepared",
});
const local = await openHarnessReleaseArtifact(identity, artifactDirectorySource("prepared"));
assert.deepEqual(await local.read("codex/entry.wasm"), payload);
const objects = new Map();
const order = [];
const key = (reference, path) => reference + "/" + path;
const store = {
  async put(path, bytes) { order.push(path); objects.set(path, bytes.slice()); },
  async read(path) { const bytes = objects.get(path); assert.ok(bytes); return bytes.slice(); },
};
const published = await publishHarnessArtifact(identity, "prepared", { key, store });
assert.equal(order.at(-1), key(identity.artifactRef, "manifest.json"));
assert.equal(published.files, 2);
const remote = await openHarnessReleaseArtifact(identity, { read: (reference, path) => store.read(key(reference, path)) });
assert.deepEqual(await remote.read("codex/entry.wasm"), payload);
assert.deepEqual([...REQUIRED_HARNESS_CHECKS], ["unchangedSource", "boot", "toolTurn", "resume", "mcp", "interrupt"]);
await assert.rejects(import("pumice/internal/types"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
`
  );
  run(process.execPath, ["runtime.mjs"], temporary);
  console.log(
    "Installed archive passed ESM exports, declarations, prepare/read/publish and private-path checks."
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
