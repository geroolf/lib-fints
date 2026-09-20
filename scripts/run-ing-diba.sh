#!/usr/bin/env bash
set -euo pipefail

umask 077

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
product_env="${FINTS_PRODUCT_ENV:-/home/openclaw/.config/lib-fints/product.env}"
output_dir="${ING_OUTPUT_DIR:-/home/openclaw/.local/share/lib-fints/ing}"
state_dir="${FINTS_RUNTIME_DIR:-/home/openclaw/.local/state/lib-fints}"

if [[ ! -r "$product_env" ]]; then
	printf 'Product configuration is not readable: %s\n' "$product_env" >&2
	exit 1
fi

mkdir -p "$output_dir" "$state_dir"
chmod 700 "$output_dir" "$state_dir"

if [[ "${BANK_RUNNER_PREFLIGHT_ONLY:-0}" == "1" ]]; then
	command -v flock >/dev/null
	node --env-file="$product_env" -e \
		"if (!/^[A-Z0-9]{25}$/.test(process.env.FINTS_PRODUCT_ID || '')) process.exit(1)"
	node --check "$repo_dir/examples/ing-portfolio.mjs"
	printf 'ING DiBa preflight passed.\n'
	exit 0
fi

exec 9>"$state_dir/ing-diba.lock"
if ! flock -n 9; then
	printf 'Another ING DiBa retrieval is already running.\n' >&2
	exit 75
fi

ing_user_id="${ING_USER_ID:-}"
ing_pin="${ING_PIN:-}"

if [[ -z "$ing_user_id" ]]; then
	read -r -p 'ING access number / user name: ' ing_user_id
fi
if [[ -z "$ing_pin" ]]; then
	read -r -s -p 'ING Online Banking PIN: ' ing_pin
	printf '\n'
fi
if [[ -z "$ing_user_id" || -z "$ing_pin" ]]; then
	printf 'ING user name and PIN are required.\n' >&2
	exit 1
fi

trap 'unset ing_pin ING_PIN' EXIT INT TERM

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
output_file="$output_dir/ing-diba-$timestamp.json"

cd "$repo_dir"
if [[ ! -f dist/index.js ]]; then
	if [[ -x node_modules/.bin/tsc ]]; then
		./node_modules/.bin/tsc
	else
		pnpm run build
	fi
fi

ING_USER_ID="$ing_user_id" \
ING_PIN="$ing_pin" \
ING_DEPOT_ENDING="${ING_DEPOT_ENDING:-4267}" \
ING_ACCOUNT_ENDING="${ING_ACCOUNT_ENDING:-0604}" \
ING_OUTPUT="$output_file" \
	node --env-file="$product_env" examples/ing-portfolio.mjs

chmod 600 "$output_file"
printf 'Saved ING DiBa data to %s\n' "$output_file"
