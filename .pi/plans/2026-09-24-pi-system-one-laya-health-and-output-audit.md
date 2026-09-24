# Audit System One command output and add Laya health check

## Findings

- `/system-one status` reports the selected provider/model, but session stats may describe a different backend after hosted fallback. The labels do not distinguish configured target from the last backend that answered.
- The status command omits cost when zero and does not say whether the selected Laya process is reachable. `isConfigured()` only means its settings resolve; it is not a network check.
- `/system-one-settings` has a connectivity action that performs inference. Laya exposes a cheaper `GET /health` endpoint. Its JSON includes `status: "ok"`, `loaded`, and `device`; this route does not enforce the optional bearer token and a healthy response does not prove inference works.
- The current settings rows are built once when the overlay opens, so a Laya-only row must handle a provider switch made while the overlay remains open.

## Plan

1. Add a bounded Laya health probe to `SystemOneClient`, using the effective resolved Laya base URL plus `/health`. Validate HTTP success and `status: "ok"`; return the reported `loaded` models and device. Keep it separate from evaluation stats and do not fall back to a hosted provider. Reject the action clearly when Laya is not selected.
2. Add `/system-one health` (and its usage text) plus an **Actions · Check Laya health** setting row. Both paths use the same probe and display the endpoint, server status, loaded models, and device, or an actionable failure. Preserve the existing inference based connectivity test.
3. Audit `/system-one status` and related messages for resolved provider versus last successful request, configured versus reachable, cost display, keyless Laya auth, and accurate command help. Label the two provider concepts explicitly and show the last health result only if it belongs to the current endpoint; do not make status itself a network request.
4. Add focused tests for Laya health success, bad JSON/status, HTTP failure, timeout, custom base URL, non-Laya selection, settings row behavior, and corrected command output. Update README and changelog to explain the distinction between health and inference checks.
5. Run `npm run check` and `npm run test`; inspect the final diff for stale names and claims.

## API evidence

Laya `serve.py` implements `GET /health` with `{status: "ok", loaded: router.loaded, device: LAYA_DEVICE || "auto"}` and does not call its bearer auth guard on that route. The installed Laya 0.3.20 implementation at `/home/bond/dev/laya/.venv/lib/python3.13/site-packages/laya/serve.py` confirms this contract.
