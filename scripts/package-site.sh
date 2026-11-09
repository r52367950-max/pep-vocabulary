#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${project_root}"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Commit the reviewed source before packaging a published Site." >&2
  exit 65
fi
source_commit="$(git rev-parse HEAD)"
# dist is ignored and can outlive a checkout. Always replace it with a fresh
# build of the reviewed source before trusting any executable archive content.
bash scripts/sites-env.sh -- bash scripts/build-verified.sh
if [[ "$(git rev-parse HEAD)" != "${source_commit}" || -n "$(git status --porcelain)" ]]; then
  echo "Reviewed source changed during the build; commit and package it again." >&2
  exit 65
fi

archive_path="${1:-${project_root}/outputs/site.tar.gz}"
mkdir -p "$(dirname "${archive_path}")" "${project_root}/outputs"
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

echo "Packaged freshly built committed source ${source_commit} into ${archive_path}"
