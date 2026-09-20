# ING portfolio test

Build the library first:

```sh
pnpm install --frozen-lockfile
pnpm run build
```

The registered product ID is stored only in the ignored local `.env` file. It is not part
of the tracked source code. ING expects the 10-digit access number (the last 10 digits of
the IBAN) as the user ID and no separate customer ID.

Enter credentials into the current zsh session without putting the PIN in shell history:

```zsh
read "ING_USER_ID?ING 10-digit access number: "
read -s "ING_PIN?ING PIN: "; echo
export ING_USER_ID ING_PIN
node --env-file=.env examples/ing-portfolio.mjs
unset ING_USER_ID ING_PIN
```

The runner interactively selects the TAN method, TAN medium (when needed), and depot.
It fetches the current portfolio plus supported balances and account transactions for
every account ING returns. The JSON also lists bank-wide and account-specific FinTS
capabilities, including whether ING advertises `HKWDU` depot transactions.

With no dates, the runner requests all transactions the bank makes available. An optional
date range can be supplied in `YYYY-MM-DD` format:

```zsh
ING_FROM=2025-01-01 ING_TO=2026-09-09 node --env-file=.env examples/ing-portfolio.mjs
```

To save the potentially large result with owner-only permissions, set an output path:

```zsh
ING_OUTPUT=./ing-data.json node --env-file=.env examples/ing-portfolio.mjs
```

The runner uses ING's current FinTS endpoint, `https://fints.ing.de/fints/`, and bank
code `50010517`. It does not persist the PIN or synchronized banking information.

## Server runner

On the OpenClaw server, the wrapper is preconfigured for depot `...4267` and
Extra-Konto `...0604`. It loads the product registration from the protected server
configuration, asks for the ING user name and PIN in the terminal, and writes a
timestamped owner-only JSON file:

```sh
cd /home/openclaw/projects/lib-fints
./scripts/run-ing-diba.sh
```

The PIN is not echoed and is not saved. Transactions are requested before the balance.
