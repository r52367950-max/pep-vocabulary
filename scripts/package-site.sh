#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${project_root}"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Commit the reviewed source before packaging a published Site." >&2
  exit 65
fi
bash scripts/validate-artifact.sh

archive_path="${1:-${project_root}/outputs/site.tar.gz}"
mkdir -p "$(dirname "${archive_path}")"
archive_path="$(realpath -m "${archive_path}")"
staging_path="$(mktemp -d "${project_root}/outputs/.sites-package.XXXXXX")"
trap 'rm -rf -- "${staging_path}"' EXIT

# Wrangler resolves ../../migrations from dist/server. Keep the reviewed source
# tree and build metadata as well, including Drizzle's immutable journal.
mkdir -p "${staging_path}/migrations"
cp -a drizzle/. "${staging_path}/migrations/"
# Tar otherwise coalesces the identical migration files into hardlink entries,
# which the Sites archive validator rejects.
tar --hard-dereference -czf "${archive_path}" \
  -C "${project_root}" dist .openai/hosting.json drizzle \
  -C "${staging_path}" migrations

echo "Packaged committed source $(git rev-parse HEAD) into ${archive_path}"
