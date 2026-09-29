# Migration contract — pi-system-one on pi 0.99 classifiers

Read this before editing. It is the source of truth for the API you are coding against.
`src/types.ts` and `src/system-one.ts` are already migrated and must NOT be edited by you.

## What changed underneath

`SystemOneClient` (in `src/system-one.ts`) no longer talks to `@typesafe-ai/sdk`. It calls
`pi.modelRegistry.classify()`. `@typesafe-ai/sdk` is uninstalled.

### New public surface of `SystemOneClient`

| member | shape |
| --- | --- |
| `attach(registry)` / `detach()` | give it pi's model registry, or take it away |
| `setProviderOverrides({ provider?, model?, temperature? })` | `baseURL` is **gone** |
| `isConfigured(): boolean` | true once a registry is attached |
| `getProviderInfo(): Promise<SystemOneProviderInfo \| null>` | **now async** |
| `listAvailable(): Promise<ClassifierModelInfo[]>` | `{ provider, id, name, api }` |
| `evaluate(request, signal?)` | unchanged signature |
| `stats` | `provider` is now `string`, not a fixed union |

`SystemOneProviderInfo` is now `{ provider, model, label, api, auth, source }`.
`auth` is a short human string such as `'ok'`, `'stored'` or `'not configured'`.
`source` is `'settings' | 'env' | 'default'`.

**Removed — do not call, do not re-add:** `getConfig`, `getKeyOrigin`, `setApiKey`,
`getLayaHealthStatus`, `checkLayaHealth`, `setHealthStatusListener`, `FALLBACK_STATUSES`,
`resolveSystemOneProvider`, `resolveFallbackProvider`, `isProviderFallbackError`,
`inferProviderFromBaseURL`, `SYSTEM_ONE_PROVIDERS`, `LAYA_MAX_STATE_CHARS`, `laya`,
and every `baseURL` / `apiKey` / `secretsDir` setting or env var.

`classify()` never rejects: it returns a `ClassifierResult` whose `stopReason` is
`'stop' | 'error' | 'aborted'`. The client already handles retry-on-error, so **never**
add your own try/catch around a different provider.

### Question types

`type: 'noul'` still compiles everywhere and is canonicalised to `'bool'` at request time.
`type: 'bool'` is the name to use in new code. Answer objects still accept `type: 'noul'`.

`bool` `criteria` is now optional in this package: `src/system-one.ts` supplies `Yes`/`No`
when it is missing, and renders any structured criteria you pass to prose. **You do not
need to rewrite structured `instructions` or `criteria` objects** — `renderInstruction()`
in `src/types.ts` flattens `{ question, inspect, goal, note }` and `{ what, examples }`
into readable prose. Leave them as they are unless a literal `'noul'` needs to become
`'bool'`.

### Answer shapes

| question | answer field | notes |
| --- | --- | --- |
| choice | `value` = chosen option id, `distribution` = per-option probabilities, `confidence` | unchanged from what you already read |
| bool | `value` = probability (0..1) | unchanged |
| score | `value` = expected level, `confidence` | **`legend` and `distribution` are gone** |

`state` is always wrapped into an object by the client, so a `state` you pass as a string
or array still works and arrives as `{ state: … }`.

### Validation now enforced before any request

`validateQuestion()` in `src/types.ts` rejects: empty instructions, a choice with fewer than
2 or more than 62 options, a score with fewer than 2 or more than 10 levels, and unlabelled
options or levels. If a question you build would fail this, fix the question — do not relax
the limits.

### Settings

`SystemOneSettings` (`src/config.ts`) lost `baseURL` and gained `temperature: string`.
Setting groups are now `'Modes' | 'Classifier'`. `PROVIDER_VALUES` is
`['auto','typesafe','openrouter','cloudflare-workers-ai','vercel-ai-gateway','opencode']`,
but the real list comes from `client.listAvailable()`.

### Auth

This package no longer reads, stores or displays an API key. `pi` owns `auth.json` and each
provider's env var. Status and settings output must describe **auth status**, never a key,
and must never print a secret.

## Checks

```
cd /mnt/extra-ssd/dev/projects2/pi-extensions
npx tsc --noEmit -p packages/pi-system-one/tsconfig.json   # must not report errors in your files
cd packages/pi-system-one && npm test                      # node --test --import tsx test/*.test.ts
```

Other agents are editing other files at the same time, so `tsc` will still report errors
outside your files. Ignore those; only your own files must be clean.
