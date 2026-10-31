import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function sourceRelativePath(value) {
  if (typeof value !== "string" || !value || isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.includes("\\") || value.includes("\0") || value.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`Unsafe source path: ${value}`);
  return value;
}

export function containedSourcePath(cacheRoot, name) {
  sourceRelativePath(name);
  const root = realpathSync(cacheRoot);
  const path = realpathSync(resolve(root, name));
  const rel = relative(root, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !lstatSync(path).isFile()) throw new Error(`Source escapes cache or is not a regular file: ${name}`);
  return path;
}

export function validateSourceLock(lock) {
  if (!lock || lock.schemaVersion !== 1 || !lock.files || typeof lock.files !== "object" || Array.isArray(lock.files)) throw new Error("Invalid source input lock");
  for (const [name, pin] of Object.entries(lock.files)) {
    sourceRelativePath(name);
    if (!pin || !/^[a-f0-9]{64}$/.test(pin.sha256) || !Number.isSafeInteger(pin.bytes) || pin.bytes <= 0) throw new Error(`Invalid source pin: ${name}`);
  }
}

const maxSourceBytes = 256 * 1024 * 1024;

// Source rebuilding already runs in the GNU/Linux/WSL build environment. The
// procfs path identifies the opened inode, including all parent components.
// Never fall back to pathname checks on platforms without this primitive.
export function readContainedSource(cacheRoot, name, { expectedBytes } = {}) {
  if (process.platform !== "linux" || !existsSync("/proc/self/fd")) throw new Error("Source input verification requires Linux/WSL procfs (/proc/self/fd); use the supported source-build environment.");
  sourceRelativePath(name);
  const root = realpathSync(cacheRoot);
  const path = containedSourcePath(root, name);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const actual = realpathSync(`/proc/self/fd/${fd}`);
    const rel = relative(root, actual);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Opened source escapes cache: ${name}`);
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Opened source is not a regular file: ${name}`);
    if (!Number.isSafeInteger(stat.size) || stat.size <= 0 || stat.size > maxSourceBytes) throw new Error(`Source exceeds file budget: ${name}`);
    if (expectedBytes !== undefined && stat.size !== expectedBytes) throw new Error(`Source size differs from reviewed pin: ${name}`);
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
      if (!count) throw new Error(`Source changed during bounded read: ${name}`);
      offset += count;
    }
    // Detect growth without reading the unexpected tail into memory.
    if (readSync(fd, Buffer.alloc(1), 0, 1, offset) || fstatSync(fd).size !== stat.size) throw new Error(`Source changed during bounded read: ${name}`);
    return bytes;
  } finally {
    closeSync(fd);
  }
}

export function readPinnedSource(cacheRoot, lock, name) {
  sourceRelativePath(name);
  const pin = Object.hasOwn(lock.files, name) && lock.files[name];
  if (!pin) throw new Error(`No reviewed source pin: ${name}. See docs/SOURCE_BUILDS.md; observed hashes are not approval.`);
  const bytes = readContainedSource(cacheRoot, name, { expectedBytes: pin.bytes });
  if (bytes.length !== pin.bytes || createHash("sha256").update(bytes).digest("hex") !== pin.sha256) throw new Error(`Source digest differs from reviewed pin: ${name}`);
  return bytes;
}

export function middleSourceRows(text) {
  return text.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [file, source] = line.split("\t");
    sourceRelativePath(file);
    if (!source || !source.trim()) throw new Error("Invalid middle-source metadata row");
    return { file: `open-data/mikigo-middle/${file}`, source };
  });
}

// Copy each verified byte string once. Parsers never reread the mutable cache.
export function snapshotSourceInputs(cacheRoot, lock, { requireLexiconInputs = true, requiredFiles = [] } = {}) {
  validateSourceLock(lock);
  const snapshot = mkdtempSync(join(tmpdir(), "pep-vocab-source-"));
  const copy = (name) => {
    const bytes = readPinnedSource(cacheRoot, lock, name);
    const output = join(snapshot, name);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, bytes, { flag: "wx" });
    return bytes;
  };
  try {
    const files = new Set([...Object.keys(lock.files), ...requiredFiles]);
    if (requireLexiconInputs) {
      const metadata = "open-data/mikigo-middle/files_complete.tsv";
      const bytes = copy(metadata);
      files.delete(metadata);
      const rows = middleSourceRows(bytes.toString("utf8"));
      if (!rows.length) throw new Error("Middle-source metadata is empty");
      for (const row of rows) files.add(row.file);
      const directory = "open-data/oewn/2025-plus-json";
      // Containment also applies to the directory before listing its candidates.
      const root = realpathSync(cacheRoot);
      const path = realpathSync(join(root, directory));
      const rel = relative(root, path);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("OEWN directory escapes source cache");
      const names = readdirSync(path).filter((name) => /^entries-.+\.json$/.test(name) || /^(noun|verb|adj|adv)\..+\.json$/.test(name));
      if (!names.some((name) => name.startsWith("entries-")) || !names.some((name) => /^(noun|verb|adj|adv)\./.test(name))) throw new Error("OEWN parsed source files are missing");
      for (const name of names) files.add(`${directory}/${name}`);
    }
    for (const name of files) copy(name);
    return { root: snapshot, cleanup: () => rmSync(snapshot, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(snapshot, { recursive: true, force: true });
    throw error;
  }
}
