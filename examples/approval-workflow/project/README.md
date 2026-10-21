# Ledger sync (synthetic)

A tiny stand-in for a service integration. Everything here is synthetic: the
endpoint ends in `.invalid`, and the environment file holds fake values only.

- `integrations/ledger/config.json` names the integration's API version and the
  environment variables it reads.
- `env/ledger.dummy.env` is the dummy environment file (fake values).
- `scripts/verify.mjs` checks that the configuration and the environment file
  agree. It prints counts and variable names, never values.
