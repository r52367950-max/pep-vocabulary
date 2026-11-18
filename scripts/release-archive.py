"""Exact release input and archive validation; uses only the Python standard library."""

import hashlib
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
import sys
import tarfile


def safe_name(name):
    parts = PurePosixPath(name).parts
    if not parts or name.startswith("/") or any(p in (".", "..") for p in parts):
        raise ValueError(f"Unsafe release path: {name}")
    if any(p.lower().startswith(".env") or p.lower().endswith((".pem", ".key", ".p12", ".pfx")) for p in parts):
        raise ValueError(f"Private file is forbidden in a release: {name}")


def regular_files(root, prefix):
    path = root / prefix
    safe_name(prefix)
    mode = path.lstat().st_mode
    if stat.S_ISREG(mode):
        return [prefix]
    if not stat.S_ISDIR(mode):
        raise ValueError(f"Release files must not be links or special files: {prefix}")
    result = []
    for child in sorted(path.iterdir()):
        result.extend(regular_files(root, f"{prefix}/{child.name}"))
    return result


def check_source(root, commit):
    tree = subprocess.check_output(["git", "--no-replace-objects", "ls-tree", "-rz", commit], cwd=root)
    expected = set()
    for entry in tree.split(b"\0"):
        if not entry:
            continue
        metadata, raw_name = entry.split(b"\t", 1)
        name = os.fsdecode(raw_name)
        # A checkout containing source symlinks or submodules is not an isolated
        # tracked-file build; reject before extracting or executing anything.
        if metadata.split()[0] not in (b"100644", b"100755"):
            raise ValueError(f"Release source must contain regular files: {name}")
        if name.startswith(("public/", "drizzle/")) or name == ".openai/hosting.json":
            safe_name(name)
            expected.add(name)
    actual = set()
    for prefix in ("public", "drizzle", ".openai/hosting.json"):
        actual.update(regular_files(root, prefix))
    if actual != expected:
        raise ValueError(f"Unreviewed release inputs: {sorted(actual - expected)}; missing: {sorted(expected - actual)}")


def fingerprint(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def package(root, archive):
    # These directories are freshly produced by the reviewed build in a private
    # checkout. Snapshot their exact regular members before tar reads any bytes.
    files = {}
    for prefix in ("dist", ".openai/hosting.json", "drizzle"):
        for name in regular_files(root, prefix):
            path = root / name
            files[name] = (path, path.stat().st_size, fingerprint(path))
            if name.startswith("drizzle/"):
                files["migrations/" + name[len("drizzle/"):]] = files[name]
    with tarfile.open(archive, "w:gz", dereference=True, format=tarfile.PAX_FORMAT) as output:
        for name, (path, _, _) in sorted(files.items()):
            output.add(path, arcname=name, recursive=False)
    verify_archive(archive, files)
    print(f"Verified {len(files)} exact regular archive members (paths, sizes and SHA-256).")


def verify_archive(archive, files):
    seen = set()
    with tarfile.open(archive, "r:gz") as source:
        for member in source:
            name = member.name
            if name not in files or name in seen or not member.isfile():
                raise ValueError(f"Unexpected archive member or type: {name}")
            _, size, digest = files[name]
            stream = source.extractfile(member)
            if member.size != size or hashlib.file_digest(stream, "sha256").hexdigest() != digest:
                raise ValueError(f"Release member changed while packaging: {name}")
            seen.add(name)
    if seen != files.keys():
        raise ValueError("Archive is missing approved members")


if __name__ == "__main__":
    try:
        action, root, argument = sys.argv[1:]
        if action == "check-source":
            check_source(Path(root), argument)
        elif action == "package":
            package(Path(root), Path(argument))
        else:
            raise ValueError("Unknown release operation")
    except (OSError, ValueError, tarfile.TarError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
