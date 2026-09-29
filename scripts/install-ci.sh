#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "${SITES_ENV_READY:-}" != "1" ]]; then
  exec "${script_dir}/sites-env.sh" -- "$0" "$@"
fi
for command in flock timeout; do
  command -v "${command}" >/dev/null || { echo "install-ci.sh requires ${command}." >&2; exit 69; }
done
runtime_root="${SITES_PROJECT_ROOT}/.sites-runtime"
mkdir -p "${runtime_root}"
exec 9>"${runtime_root}/install.lock"
flock -n 9 || { echo "Another dependency install is running for this project." >&2; exit 75; }
# Respect the lockfile and verify its package integrity through npm. An install
# timeout/failure is reported directly; it never falls back to a different version.
timeout --signal=TERM --kill-after="${SITES_INSTALL_KILL_AFTER:-15s}" \
  "${SITES_INSTALL_TIMEOUT:-8m}" npm ci --prefer-offline --no-audit --no-fund
[[ -x "${SITES_PROJECT_ROOT}/node_modules/.bin/vinext" ]] || {
  echo "Dependency installation did not produce the required build tool." >&2; exit 69;
}
