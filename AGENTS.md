<!-- agentsmesh:codex-rule-index:start -->

## Additional Rule Files

- [Project conventions](.codex/instructions/common.md): General guidance with no file glob restriction.
<!-- agentsmesh:codex-rule-index:end -->

<!-- agentsmesh:root-generation-contract:start -->

## AgentsMesh Generation Contract

`agentsmesh.yaml` selects targets/features (`agentsmesh.local.yaml` overrides locally), and `.agentsmesh` is the only place to add or edit canonical items: `rules/_root.md`, `rules/*.md`, `commands/*.md`, `agents/*.md`, `skills/*/SKILL.md` plus supporting files, `mcp.json`, `hooks.yaml`, `permissions.yaml`, and `ignore`; if missing run `agentsmesh init`, use `agentsmesh import --from <tool>` for native configs, `agentsmesh install <source>` or `install --sync` for reusable packs, then run `agentsmesh generate`. Use `diff`, `lint`, `check`, `watch`, `matrix`, and `merge` as needed; never edit generated tool files.

<!-- agentsmesh:root-generation-contract:end -->
