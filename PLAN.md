# Plan: Create 5 files in `tmp/` with random sentences

## Context

The user previously had 5 files in `tmp/` (file1.txt–file5.txt) each containing a random sentence. Those files were deleted. The goal is to recreate them with fresh random sentences.

## Approach

Use a simple bash script to:

1. Ensure the `tmp/` directory exists.
2. Write 5 uniquely random sentences, one per file (`file1.txt` through `file5.txt`).

## Files to modify

- `tmp/file1.txt` — create
- `tmp/file2.txt` — create
- `tmp/file3.txt` — create
- `tmp/file4.txt` — create
- `tmp/file5.txt` — create

## Reuse

N/A — this is a standalone file-generation task with no dependencies on existing code.

## Steps

- [ ] Run `mkdir -p tmp` to ensure the directory exists.
- [ ] Write 5 distinct random sentences to `tmp/file1.txt` through `tmp/file5.txt`.

## Verification

- `ls -la tmp/` should show 5 files.
- `cat tmp/file*.txt` should display 5 different sentences.
