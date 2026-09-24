#!/usr/bin/env node

// Resolve the runtime loader from this package, regardless of the caller's cwd.
import "tsx";
await import("./jev-gate-runner.ts");
