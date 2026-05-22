---
name: am-command-skillshare-recommend
description: Analyze codebase with repomix, search skillshare for relevant skills, and recommend top 5
x-agentsmesh-kind: command
x-agentsmesh-name: skillshare-recommend
x-agentsmesh-allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
---

Generate a skill profile of this repository using repomix, then search the skillshare registry for relevant community skills and recommend the best matches.

Focus on **domain-relevant skills**: ones that match what this project _is_ (e.g., skill systems, extension patterns, package management, skill authoring, configuration management). Deprioritize generic tooling, CI, and AI/LLM skills unless they directly match a unique aspect of the project.

## Workflow

1. **Determine repo name**: Extract the repository name from `git remote -v` (e.g., `origin  git@github.com:user/repo.git` → `repo`). Use that as `<repo name>`.

2. **Run repomix**: Execute:

   ```bash
   npx -y repomix --skill-generate --no-dot-ignore --skill-output .skillshare/skills/<repo name> --force
   ```

3. **Analyze generated files**: Read the generated files in `.skillshare/skills/<repo name>/` — examine the skill profile, detected patterns, languages, frameworks, and conventions captured by repomix.

4. **Extract tech stack signals**: From the repomix-generated skill profile, extract every distinct:
   - Language (e.g., TypeScript, Python, Rust, Go)
   - Framework / runtime (e.g., React, Next.js, Vue, Svelte, Django, FastAPI, Express)
   - Major library or tool (e.g., Prisma, Tailwind, Docker, Redis, PostgreSQL)
   - Testing approach (e.g., Vitest, Playwright, pytest, Jest)
   - Detected convention or pattern (e.g., monorepo, microservices, GraphQL, REST)

5. **Populate up to 3 queries and run multi-search aggregation**: From the repomix tech-stack, craft **at most 3 queries** — they should target **domain-relevant skills** (e.g., skill systems, extension patterns, package management, skill authoring, configuration management). Avoid queries about tooling, CI, testing, or generic AI/LLM topics unless they match a unique project need. Execute the script below.

   ```bash
   # ── Populate with 1-3 domain-targeted queries ──
   QUERIES=(
     "skill system"
     "extension pattern"
     "configuration management"
   )

   # ── Automated aggregation script ──
   RESULTS_DIR=$(mktemp -d)
   ALL="$RESULTS_DIR/_all.json"
   echo '[]' > "$ALL"

   echo "=== Running ${#QUERIES[@]} targeted searches ==="
   for q in "${QUERIES[@]}"; do
     safe=$(echo "$q" | tr -s ' /' '_')
     out="$RESULTS_DIR/$safe.json"
     echo "  Searching: $q"
     skillshare search "$q" --json --limit 10 > "$out" 2>/dev/null
     if [[ $? -ne 0 || ! -s "$out" ]]; then
       echo "    ⚠  Empty"
       continue
     fi
     is_valid=$(jq 'if type == "array" and length > 0 then true else false end' "$out" 2>/dev/null)
     if [[ "$is_valid" != "true" ]]; then
       echo "    ⚠  No results"
       continue
     fi
     # Tag each result with its source query then merge
     jq --arg q "$q" '[.[] | . + {_source: $q}]' "$out" > "${out}.tagged" 2>/dev/null
     jq -s 'add' "$ALL" "${out}.tagged" > "${ALL}.tmp" 2>/dev/null && mv "${ALL}.tmp" "$ALL"
   done

   echo ""
   echo "=== Aggregating and deduplicating ==="
   AGGREGATED="$RESULTS_DIR/aggregated.json"

   # Deduplicate by Name, sort by Stars descending, track matched queries
   jq '
     group_by(.Name)
     | map(
         first as $orig
         | {
             name: $orig.Name,
             description: $orig.Description,
             stars: ($orig.Stars // 0),
             owner: $orig.Owner,
             source: $orig.Source,
             repo: $orig.Repo,
             tags: $orig.Tags // [],
             matched_by: [.[] | ._source] | unique
           }
       )
     | sort_by(-.stars)
     | to_entries
     | map(.key += 1 | { rank: .key, name: .value.name, description: .value.description, stars: .value.stars, owner: .value.owner, source: .value.source, repo: .value.repo, tags: .value.tags, matched_by: .value.matched_by })
   ' "$ALL" > "$AGGREGATED" 2>/dev/null

   if [[ ! -s "$AGGREGATED" ]]; then
     echo "No valid results could be aggregated."
     cat "$ALL" 2>/dev/null | head -c 2000 || true
     rm -rf "$RESULTS_DIR"
     exit 1
   fi

   echo ""
   echo "╔══════════════════════════════════════════════════════════╗"
   echo "║             SKILLSHARE RECOMMENDATIONS                  ║"
   echo "╚══════════════════════════════════════════════════════════╝"
   jq -r '
     .[] |
     "\(.rank). \(.name)
        ⭐ \(.stars) stars  |  Owner: \(.owner // "?")
        \(.description // "(no description)")
        Matched by: \(if (.matched_by | length) > 0 then (.matched_by | join(", ")) else "direct search" end)
     "' "$AGGREGATED" 2>&1 | head -120

   cp "$AGGREGATED" ".skillshare/skills/<repo name>/aggregated-results.json"
   echo ""
   echo "Full results saved to: .skillshare/skills/<repo name>/aggregated-results.json"
   rm -rf "$RESULTS_DIR"
   ```

6. **Review and recommend top 5**: Read the leaderboard from the script output. Pick the **5 most relevant skills** based on:
   - How well the skill matches the project's **domain** (its purpose, not its toolchain)
   - Description alignment with the project
   - Practical benefit for day-to-day development
   - **Avoid** generic tooling, CI, or AI/LLM skills unless they have a unique, non-obvious fit

   For each of the 5 recommendations, explain:
   - What domain/technologies from the codebase it maps to
   - Why it was selected over other candidates
   - How it would benefit development on this project
