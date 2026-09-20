#!/usr/bin/env bash
set -euo pipefail

umask 077

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
product_env="${FINTS_PRODUCT_ENV:-/home/openclaw/.config/lib-fints/product.env}"
output_dir="${COMMERZBANK_OUTPUT_DIR:-/home/openclaw/.local/share/lib-fints/commerzbank}"
state_dir="${FINTS_RUNTIME_DIR:-/home/openclaw/.local/state/lib-fints}"
state_file="${COMMERZBANK_STATE_FILE:-$state_dir/commerzbank-3100-state.json}"

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
	node --check "$repo_dir/examples/commerzbank-data.mjs"
	node --check "$repo_dir/examples/lib/banking-state.mjs"
	printf 'Commerzbank 3100 preflight passed.\n'
	exit 0
fi

exec 9>"$state_dir/commerzbank-3100.lock"
if ! flock -n 9; then
	printf 'Another Commerzbank 3100 retrieval is already running.\n' >&2
	exit 75
fi

commerzbank_bank_id="${COMMERZBANK_BANK_ID:-20040000}"
commerzbank_user_id="${COMMERZBANK_USER_ID:-}"
commerzbank_pin="${COMMERZBANK_PIN:-}"

if [[ -z "$commerzbank_user_id" ]]; then
	read -r -p 'Commerzbank HBCI participant number: ' commerzbank_user_id
fi
if [[ -z "$commerzbank_pin" ]]; then
	read -r -s -p 'Commerzbank Online Banking PIN: ' commerzbank_pin
	printf '\n'
fi
if [[ -z "$commerzbank_user_id" || -z "$commerzbank_pin" ]]; then
	printf 'Participant number and PIN are required.\n' >&2
	exit 1
fi

trap 'unset commerzbank_pin COMMERZBANK_PIN' EXIT INT TERM

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
output_file="$output_dir/commerzbank-3100-$timestamp.json"

cd "$repo_dir"
if [[ ! -f dist/index.js ]]; then
	if [[ -x node_modules/.bin/tsc ]]; then
		./node_modules/.bin/tsc
	else
		pnpm run build
	fi
fi

COMMERZBANK_BANK_ID="$commerzbank_bank_id" \
COMMERZBANK_USER_ID="$commerzbank_user_id" \
COMMERZBANK_PIN="$commerzbank_pin" \
COMMERZBANK_ACCOUNT_ENDING=3100 \
COMMERZBANK_STATEMENT_FORMAT="${COMMERZBANK_STATEMENT_FORMAT:-camt}" \
COMMERZBANK_STATE_FILE="$state_file" \
COMMERZBANK_OUTPUT="$output_file" \
	node --env-file="$product_env" examples/commerzbank-data.mjs

chmod 600 "$output_file"
printf 'Saved Commerzbank account ...3100 data to %s\n' "$output_file"
