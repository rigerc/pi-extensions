---
name: trekker
description: Persistent task memory for AI agents in Pi. Use when planning, starting, updating, checkpointing, or completing project work tracked in Trekker.
---

# Trekker

Trekker is the source of truth for persistent task memory. Use `trekker quickstart` for the full CLI reference.

Core rules:

1. Search first with `trekker search <keyword>` before creating or starting related work.
2. Prefer continuing existing tasks over creating duplicates.
3. Keep at most one task `in_progress` unless the user explicitly chooses otherwise.
4. Add progress/checkpoint comments before context loss, compaction, shutdown, or handoff.
5. Add a useful summary comment before marking a task completed.
6. Use task IDs returned by Trekker; never invent IDs.
7. Use `--toon` where available for compact output.

Useful commands:

```bash
trekker quickstart
trekker search "keyword"
trekker --toon task list --status in_progress
trekker ready
trekker history --limit 10
trekker task show TREK-1
trekker comment list TREK-1
trekker task update TREK-1 -s in_progress
trekker comment add TREK-1 -a "pi" -c "Checkpoint: ..."
trekker comment add TREK-1 -a "pi" -c "Summary: ..."
trekker task update TREK-1 -s completed
```
