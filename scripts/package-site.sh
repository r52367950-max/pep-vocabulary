#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${project_root}"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Commit the reviewed source before packaging a published Site." >&2
  exit 65
fi
source_commit="$(git rev-parse HEAD)"
archive_path="${1:-${project_root}/outputs/site.tar.gz}"
archive_path="$(realpath -m "${archive_path}")"
command -v python3 >/dev/null || { echo "Site packaging requires Python 3." >&2; exit 69; }
python3 scripts/release-archive.py check-source "${project_root}" "${source_commit}"

# Neither ignored files nor the developer's installed executables enter this
# private exact-commit checkout. npm verifies the lockfile in a new dependency tree.
staging_path="$(mktemp -d -t ciji-release.XXXXXX)"
trap 'rm -rf -- "${staging_path}"' EXIT
mkdir "${staging_path}/source"
git --no-replace-objects archive "${source_commit}" | tar -x -C "${staging_path}/source"
release_root="${staging_path}/source"
unset SITES_ENV_READY SITES_PROJECT_ROOT SITES_RUNTIME_ROOT
bash "${release_root}/scripts/sites-env.sh" -- bash scripts/install-ci.sh
bash "${release_root}/scripts/sites-env.sh" -- bash scripts/build-verified.sh

python3 "${release_root}/scripts/release-archive.py" package "${release_root}" "${staging_path}/site.tar.gz"
if [[ "$(git rev-parse HEAD)" != "${source_commit}" || -n "$(git status --porcelain)" ]]; then
  echo "Reviewed source changed during the build; commit and package it again." >&2
  exit 65
fi
python3 scripts/release-archive.py check-source "${project_root}" "${source_commit}"
# Publish only the archive whose complete contents were read back and verified.
mkdir -p "$(dirname "${archive_path}")"
archive_temp="$(mktemp "${archive_path}.XXXXXX")"
trap 'rm -rf -- "${staging_path}"; rm -f -- "${archive_temp}"' EXIT
cp "${staging_path}/site.tar.gz" "${archive_temp}"
mv -f -- "${archive_temp}" "${archive_path}"

echo "Packaged freshly built committed source ${source_commit} into ${archive_path}"
