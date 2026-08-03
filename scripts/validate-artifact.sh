#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${SITES_ENV_READY:-}" != "1" ]]; then
  exec "${script_dir}/sites-env.sh" -- "$0" "$@"
fi

worker="${SITES_PROJECT_ROOT}/dist/server/index.js"
hosting="${SITES_PROJECT_ROOT}/dist/.openai/hosting.json"

[[ -f "${worker}" ]] || {
  echo "Missing Sites Worker entry: dist/server/index.js" >&2
  exit 66
}
[[ -f "${hosting}" ]] || {
  echo "Missing packaged Sites manifest: dist/.openai/hosting.json" >&2
  exit 66
}

node --input-type=module - "${hosting}" <<'NODE'
import { readFile } from "node:fs/promises";
const [hostingPath] = process.argv.slice(2);
const manifest = JSON.parse(await readFile(hostingPath, "utf8"));
if (manifest.d1 !== "DB") throw new Error("Packaged Sites manifest must declare the D1 binding as DB");
NODE

grep -q 'export{.*default' "${worker}" || grep -q 'export default' "${worker}" || {
  echo "dist/server/index.js must expose a default Worker export" >&2
  exit 66
}

echo "Validated Sites artifact: Worker export and D1 hosting manifest are present. Runtime execution is tested through Wrangler because Node cannot resolve cloudflare:workers imports."
