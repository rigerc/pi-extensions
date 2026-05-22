---
name: am-command-init-rules
description: Initialize non-obvious modular rules for the codebase
x-agentsmesh-kind: command
x-agentsmesh-name: init-rules
x-agentsmesh-allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
  - question
---

Generate modular, path-scoped rules that are **non-obvious, project-specific, and actionable** using a 3-phase workflow.

## Phase 1: Discovery (Find Non-Obvious Patterns)

Analyze the repository to identify project-specific conventions, not generic patterns:

1. Use Glob to map file types and directory structure
2. Read framework configs (`package.json`, `go.mod`, etc.) for project-specific dependencies
3. Grep for repeated custom patterns (e.g., internal utility usage, error handling wrappers, custom types)
4. Identify existing anti-patterns or inconsistent practices to codify as rules
5. Suggest rule topics based on **project-specific** findings, not generic categories

## Phase 2: Configuration

For each rule, use the `question` tool to gather:

- Rule topic (prioritize project-specific conventions over generic ones)
- Scope: global or path-specific (use `globs:` for file scoping)
- Target tools (optional `targets:` array)
- Team-specific non-obvious rules to include

## Phase 3: Generation (Non-Obvious Rules Only)

Create rule files in `rules/` with strict guidelines:

### Frontmatter Format

```markdown
---
description: Project-specific API response convention
targets: [claude-code, cursor]
globs: ['src/api/**/*.ts']
---

- All endpoints must return the project's `ApiEnvelope<T>` type (never raw objects)
- Include `requestId` matching the `traceId` from the project's logger
- Use `handleApiError` wrapper for all catch blocks (no raw error throws)
```

### Rule Requirements

- **Non-obvious only**: Reject generic advice (e.g., "validate input", "write tests")
- **Project-specific**: Capture team conventions, custom patterns, or edge cases
- **Succinct**: 5-15 bullet points per rule (10-15 lines max excluding frontmatter)
- **Actionable**: Clear, specific to the codebase (e.g., "use `withTransaction` wrapper" not "handle DB errors")
- **Organized**: Use subdirectories by topic (`frontend/`, `backend/`, `testing/`)

### Bad vs Good Rule Examples

❌ Obvious (reject): "Use strict TypeScript. Never use `any`."
✅ Non-obvious (accept): "Prefer project's `Result<T, E>` type over throws for all service layer errors"

After creating rules, suggest running `agentsmesh generate` to deploy to configured AI tools.
