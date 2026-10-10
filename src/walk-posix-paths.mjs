import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

// A walk is a filesystem observation, not an inference: it lists what is
// under root and says nothing about what those files mean. Type-slicing,
// registry-reading, and graphing are separate services layered on top by
// a caller, never imported here.
const WALK_TYPE = "PosixPathWalk";

function slash(path) {
  return path.split(sep).join("/");
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A pattern with no "*" matches a segment exactly ("node_modules", ".git").
// A pattern with "*" becomes a lite glob over the whole segment (no "**",
// no "?", no character classes) — "test-*" matches any segment starting
// with "test-", which is the prefix case falling out of the same rule.
function segmentMatcher(pattern) {
  if (!pattern.includes("*")) return (name) => name === pattern;
  const regexp = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`);
  return (name) => regexp.test(name);
}

async function sha256OfFile(path) {
  const bytes = await readFile(path);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

// Walks the real filesystem under root and reports the file, symlink, and
// directory entries it finds — deterministically sorted, digested, and with
// no ambient exclusion policy: the caller decides what "node_modules" means.
// `digest: false` skips content hashing (sha256: null on file entries) so
// large trees can be walked at directory-listing cost; the default keeps the
// digested contract existing consumers settle against.
export async function walkPosixPaths({ root, excludes = [], digest = true } = {}) {
  if (typeof root !== "string" || !root) throw new TypeError("root is required");
  if (!Array.isArray(excludes)) throw new TypeError("excludes must be an array");
  if (typeof digest !== "boolean") throw new TypeError("digest must be a boolean");
  const matchers = excludes.map(segmentMatcher);
  const absoluteRoot = resolve(root);

  const files = [];
  let directories = 0;
  let excluded = 0;

  async function walk(absoluteDir, relativeDir) {
    const entries = await readdir(absoluteDir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (matchers.some((matches) => matches(entry.name))) {
        excluded += 1;
        continue;
      }
      const absolutePath = resolve(absoluteDir, entry.name);
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : slash(entry.name);
      const status = await lstat(absolutePath);
      if (status.isSymbolicLink()) {
        // Never followed: recorded as its own entry, never traversed, even
        // when the link target is a directory.
        files.push({ path: relativePath, kind: "symlink", bytes: status.size, sha256: null });
      } else if (status.isDirectory()) {
        directories += 1;
        await walk(absolutePath, relativePath);
      } else if (status.isFile()) {
        files.push({ path: relativePath, kind: "file", bytes: status.size, sha256: digest ? await sha256OfFile(absolutePath) : null });
      }
      // Other node kinds (sockets, fifos, devices) are neither files,
      // directories, nor symlinks in this walk's terms and are skipped.
    }
  }

  await walk(absoluteRoot, "");
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return Object.freeze({
    type: WALK_TYPE,
    root: absoluteRoot,
    files: Object.freeze(files.map((file) => Object.freeze(file))),
    directories,
    excluded,
  });
}
