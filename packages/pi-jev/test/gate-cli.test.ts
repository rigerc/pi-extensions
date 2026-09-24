import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

test("gate CLI runs from another directory and ships its TypeScript loader", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jev-cli-"));
  try {
    const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.ok(manifest.dependencies.tsx, "the loader is needed in production installs");
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("../bin/jev-gate.js", import.meta.url)), "--help",
    ], { cwd, encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: jev-gate/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
