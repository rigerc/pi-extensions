# Pi extensions

An npm monorepo for extensions to the [Pi coding agent](https://pi.dev). Its current package, [@rigerc/pi-system-one](packages/pi-system-one/README.md), adds semantic tool and skill routing, typed System One decisions, and optional automation through a Jev-compatible provider.

## Package

**[`@rigerc/pi-system-one`](packages/pi-system-one/README.md)** provides tool and skill discovery, Choice/Noul/Score evaluations, optional automatic routing and tool checks, and a gate CLI. It supports TypeSafe, OpenRouter, and an explicitly selected local Laya server.

The [package README](packages/pi-system-one/README.md) covers provider setup, configuration, commands, tools, and migration from `pi-jev`. See its [changelog](packages/pi-system-one/CHANGELOG.md) for release history.

## Install in Pi

```bash
pi install npm:@rigerc/pi-system-one
```

For a hosted provider, set its credential before using System One features. For example:

```bash
export TYPESAFE_API_KEY=ts_...
```

OpenRouter credentials and a local Laya setup are also supported; follow the [provider setup guide](packages/pi-system-one/README.md#setup). In Pi, run `/system-one status` to inspect the selected configuration and `/system-one test` to check inference. Automatic routing is opt-in.

## Develop locally

Requires Node.js 20 or newer and npm. From the repository root:

```bash
npm ci
npm run check
npm test
```

`npm run check` typechecks the workspace. `npm test` runs the package test suite. Use `npm run test:watch` for Vitest watch mode, or `npm run publish:dry` to inspect the package contents before a release.

The root `package.json` defines the npm workspace and shared commands; the extension code, tests, and package metadata live under `packages/pi-system-one/`. The `docs/` directory contains research and reference material, including snapshots of other projects under `docs/context/`; it is not part of the published package.

## Contributing and security

Run `npm run check` and `npm test` before opening a pull request. Use [GitHub issues](https://github.com/rigerc/pi-extensions/issues) for bugs and feature requests. Report security issues through the [security policy](packages/pi-system-one/SECURITY.md), rather than a public issue.

The published package is licensed under [MIT](packages/pi-system-one/LICENSE).
