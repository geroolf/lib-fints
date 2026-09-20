# Commerzbank data test

The runner uses Commerzbank's FinTS 3.0 PIN/TAN endpoint and downloads every data type
that the bank advertises for each returned account: balances, booked transactions,
credit-card transactions, and current depot holdings.

Before the first test, Commerzbank HBCI access with PIN/TAN and photoTAN must be active.
Use the HBCI participant number from the Commerzbank welcome letter as the user ID. The
bank ID is the account's 8-digit BLZ; for a German IBAN, these are digits 5 through 12.

Build the library first:

```sh
pnpm install --frozen-lockfile
pnpm run build
```

The registered product ID is already stored only in the ignored local `.env` file. Enter
the Commerzbank values in the current zsh session so the PIN does not enter shell history:

```zsh
read "COMMERZBANK_BANK_ID?Commerzbank BLZ (8 digits): "
read "COMMERZBANK_USER_ID?Commerzbank HBCI participant number: "
read -s "COMMERZBANK_PIN?Commerzbank Online Banking PIN: "; echo
export COMMERZBANK_BANK_ID COMMERZBANK_USER_ID COMMERZBANK_PIN
COMMERZBANK_OUTPUT=./commerzbank-data.json node --env-file=.env examples/commerzbank-data.mjs
unset COMMERZBANK_BANK_ID COMMERZBANK_USER_ID COMMERZBANK_PIN
```

The runner lets you select the TAN method and medium when the bank offers more than one.
For a photoTAN cryptogram, it temporarily writes an owner-only image below macOS's temp
folder, prints its path for scanning, and removes it after the TAN has been entered.

With no dates, FinTS requests all transactions that Commerzbank makes available. To ask
for a specific period, use `YYYY-MM-DD` dates:

```zsh
COMMERZBANK_FROM=2025-01-01 COMMERZBANK_TO=2026-09-09 \
  COMMERZBANK_OUTPUT=./commerzbank-data.json \
  node --env-file=.env examples/commerzbank-data.mjs
```

To test the oldest available transaction for one account without triggering balance,
card, or portfolio requests for the other accounts, filter by its final four digits and
request an intentionally old start date:

```zsh
COMMERZBANK_ACCOUNT_ENDING=3100 \
  COMMERZBANK_TRANSACTIONS_ONLY=1 \
  COMMERZBANK_FROM=2020-01-01 \
  COMMERZBANK_OUTPUT=./commerzbank-3100-history.json \
  node --env-file=.env examples/commerzbank-data.mjs
```

After synchronization, the runner prints the maximum lookback in days advertised by
Commerzbank's CAMT or MT940 FinTS parameters. The bank can still return less history for
a newly opened account or reject/truncate a request that predates its available data.

Commerzbank currently advertises a longer MT940 window than CAMT. Force MT940 for the
same single-account test with:

```zsh
COMMERZBANK_ACCOUNT_ENDING=3100 \
  COMMERZBANK_TRANSACTIONS_ONLY=1 \
  COMMERZBANK_STATEMENT_FORMAT=mt940 \
  COMMERZBANK_INCLUDE_RAW_MT940=1 \
  COMMERZBANK_FROM=2026-03-20 \
  COMMERZBANK_OUTPUT=./commerzbank-3100-mt940-raw.json \
  node --env-file=.env examples/commerzbank-data.mjs
```

`COMMERZBANK_STATEMENT_FORMAT` accepts `auto` (the default), `camt`, or `mt940` and
fails before retrieval when the selected account does not advertise the requested format.
Raw MT940 capture is opt-in and requires an output path; the JSON is created with owner-only
permissions and stores the bank's original booked-statement stream as `rawMT940Data`.

To fetch one electronic account-statement document through HKEKA for account `3100`:

```zsh
COMMERZBANK_ACCOUNT_ENDING=3100 \
  COMMERZBANK_ELECTRONIC_STATEMENTS_ONLY=1 \
  COMMERZBANK_STATEMENT_DIR=./commerzbank-statements \
  COMMERZBANK_OUTPUT=./commerzbank-3100-estatements.json \
  node --env-file=.env examples/commerzbank-data.mjs
```

The test deliberately requests at most one document, prefers PDF when supported, and
does not acknowledge the receipt token returned by the bank. The document directory is
created with `0700` permissions and each file with `0600`. If indexed selection is
advertised, a specific document can be requested by supplying both
`COMMERZBANK_STATEMENT_YEAR` and `COMMERZBANK_STATEMENT_NUMBER`.

The JSON masks account and IBAN values to their final four digits. Transaction details
can still contain sensitive names, references, and payment descriptions, so the output
file is created with owner-only permissions. The runner does not persist the PIN or the
synchronized FinTS configuration.

If your HBCI customer ID differs from the participant number, set
`COMMERZBANK_CUSTOMER_ID` for the command. `FINTS_DEBUG=1` enables raw protocol debug
output and should be avoided unless needed because it can contain sensitive banking data.

## Server runner for account 3100

On the OpenClaw server, the wrapper is permanently restricted to the account ending in
`3100`. It loads the product registration from the protected server configuration, asks
for the HBCI participant number and PIN in the terminal, and writes a timestamped
owner-only JSON file:

```sh
cd /home/openclaw/projects/lib-fints
./scripts/run-commerzbank-3100.sh
```

The default transaction format is CAMT. To request the longer advertised MT940 period,
start it as `COMMERZBANK_STATEMENT_FORMAT=mt940 ./scripts/run-commerzbank-3100.sh`.
The PIN is not echoed and is not saved. Transactions are requested before the balance.

The server wrapper persists reusable FinTS synchronization metadata at
`/home/openclaw/.local/state/lib-fints/commerzbank-3100-state.json`. This private
owner-only file contains the bank-provided system ID, BPD/UPD account metadata, selected
TAN method, and TAN medium. It never contains the participant number, PIN, TAN, or
product registration number. After the first successful synchronization, later runs use
`FinTSConfig.fromBankingInformation()` and skip the unconditional full synchronization.

For the daily transaction-only path, run:

```sh
COMMERZBANK_TRANSACTIONS_ONLY=1 ./scripts/run-commerzbank-3100.sh
```

An unattended caller can additionally set `FINTS_NONINTERACTIVE=1`. If Commerzbank
requires a TAN, the runner does not wait or write a challenge image; it exits with status
`75` and the marker `TAN_REQUIRED`. `COMMERZBANK_FORCE_SYNC=1` explicitly refreshes the
saved synchronization metadata when necessary.
