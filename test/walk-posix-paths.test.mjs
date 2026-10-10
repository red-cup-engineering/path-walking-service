import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { walkPosixPaths } from "../src/walk-posix-paths.mjs";

async function sha256sum(path) {
  return `sha256:${createHash("sha256").update(await readFile(path)).digest("hex")}`;
}

async function buildFixture() {
  const root = await mkdtemp(join(tmpdir(), "path-walking-"));
  // The symlink target lives outside root entirely, so anything found under
  // it in a walk would prove the symlink was followed rather than recorded.
  const outsideTarget = await mkdtemp(join(tmpdir(), "path-walking-outside-"));
  await mkdir(join(root, "src", "nested"), { recursive: true });
  await mkdir(join(root, "node_modules", "left-pad"), { recursive: true });
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, "README.md"), "# fixture\n");
  await writeFile(join(root, "src", "index.mjs"), "export {};\n");
  await writeFile(join(root, "src", "nested", "data.json"), "{}\n");
  await writeFile(join(root, "src", "nested", "notes"), "no extension\n");
  await writeFile(join(root, "node_modules", "left-pad", "index.js"), "module.exports = {};\n");
  await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(outsideTarget, "hidden.txt"), "should not be walked\n");
  await symlink(outsideTarget, join(root, "src", "linked-dir"));
  return { root, outsideTarget };
}

test("walks a real tree, digesting files and skipping symlinked directories", async () => {
  const { root, outsideTarget } = await buildFixture();
  try {
    const walk = await walkPosixPaths({ root, excludes: ["node_modules", ".git"] });
    assert.equal(walk.type, "PosixPathWalk");
    assert.equal(walk.root, root);

    const paths = walk.files.map((file) => file.path);
    assert.deepEqual(paths, [
      "README.md",
      "src/index.mjs",
      "src/linked-dir",
      "src/nested/data.json",
      "src/nested/notes",
    ]);

    const symlinkEntry = walk.files.find((file) => file.path === "src/linked-dir");
    assert.equal(symlinkEntry.kind, "symlink");
    assert.equal(symlinkEntry.sha256, null);
    assert.equal(paths.some((path) => path.includes("hidden.txt")), false, "symlinked dir must not be traversed");

    const readme = walk.files.find((file) => file.path === "README.md");
    assert.equal(readme.kind, "file");
    assert.equal(readme.sha256, await sha256sum(join(root, "README.md")));
    assert.equal(readme.bytes, (await readFile(join(root, "README.md"))).byteLength);

    // node_modules (1 dir entry) and .git (1 dir entry) pruned at their own segment.
    assert.equal(walk.excluded, 2);
    // src, src/nested — node_modules and .git are excluded before their
    // interiors are ever visited, so they do not add to the count.
    assert.equal(walk.directories, 2);

    assert.ok(Object.isFrozen(walk));
    assert.ok(Object.isFrozen(walk.files));
    assert.ok(Object.isFrozen(walk.files[0]));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outsideTarget, { recursive: true, force: true });
  }
});

test("two walks of the same tree are byte-identical", async () => {
  const { root, outsideTarget } = await buildFixture();
  try {
    const first = await walkPosixPaths({ root, excludes: ["node_modules", ".git"] });
    const second = await walkPosixPaths({ root, excludes: ["node_modules", ".git"] });
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outsideTarget, { recursive: true, force: true });
  }
});

test("with no excludes, node_modules and .git are walked like anything else", async () => {
  const { root, outsideTarget } = await buildFixture();
  try {
    const walk = await walkPosixPaths({ root });
    const paths = walk.files.map((file) => file.path);
    assert.ok(paths.includes("node_modules/left-pad/index.js"));
    assert.ok(paths.includes(".git/HEAD"));
    assert.equal(walk.excluded, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outsideTarget, { recursive: true, force: true });
  }
});

test("glob-lite exclude matches a segment prefix", async () => {
  const root = await mkdtemp(join(tmpdir(), "path-walking-glob-"));
  try {
    await mkdir(join(root, "build-output"), { recursive: true });
    await writeFile(join(root, "build-output", "bundle.js"), "1\n");
    await writeFile(join(root, "keep.js"), "1\n");
    const walk = await walkPosixPaths({ root, excludes: ["build-*"] });
    assert.deepEqual(walk.files.map((file) => file.path), ["keep.js"]);
    assert.equal(walk.excluded, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("root is required", async () => {
  await assert.rejects(() => walkPosixPaths({}), TypeError);
});

test("digest: false skips content hashing but keeps every other field", async () => {
  const { root, outsideTarget } = await buildFixture();
  try {
    const walk = await walkPosixPaths({ root, digest: false });
    const files = walk.files.filter((f) => f.kind === "file");
    assert.ok(files.length > 0);
    for (const file of files) assert.equal(file.sha256, null);
    const digested = await walkPosixPaths({ root });
    assert.deepEqual(walk.files.map((f) => f.path), digested.files.map((f) => f.path));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outsideTarget, { recursive: true, force: true });
  }
});
