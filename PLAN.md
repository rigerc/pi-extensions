# Plan: Extension to Fix Skill Invocation Path

## Context

The user wants to create an extension that fixes a bug in Pi's skill invocation. When a user invokes a skill (via `/skill:name` command), the "References are relative to" path is incorrectly calculated and prefixed before the skill content.

The bug is in `harness/skills.ts` and `core/agent-session.ts` - the path calculation doesn't correctly handle all skill locations (e.g., `.agents/skills/` vs `.pi/skills/`). For example, a skill in `.agents/skills/my-skill/SKILL.md` incorrectly gets prefixed with "References are relative to .pi/".

## Approach

Since the bug is in skill loading (not system prompt), the extension needs to intercept skill content before it's used. The extension will:

1. Detect when a skill is being loaded (via `read` tool call targeting a SKILL.md file)
2. Calculate the correct base directory from the actual skill file path
3. Return the skill content with the correct "References are relative to" prefix

### Implementation Details

The extension will likely need to:

- Register a `tool_call` handler to intercept file reads
- Detect if the file being read is a skill's SKILL.md
- Calculate the correct directory from the actual file path
- Return the modified content with the correct prefix

## Files to Create

- `~/.pi/agent/extensions/skill-path-fixer.ts` (or in project `.pi/extensions/`)

## Reuse

- Extension API: `@mariozechner/pi-coding-agent` → `ExtensionAPI`
- Tool events: `tool_call` to intercept skill file reads
- Type imports from `@mariozechner/pi-coding-agent`

## Steps

- [ ] Investigate how Pi loads skill content (look at harness/skills.ts and core/agent-session.ts in Pi source)
- [ ] Create extension file in appropriate location
- [ ] Register a `tool_call` handler to intercept reads on SKILL.md files
- [ ] When a skill SKILL.md is read, calculate the correct base directory from the actual file path
- [ ] Prefix the skill content with the correct "References are relative to <correct-path>\n\n"
- [ ] Test with a skill in `.agents/skills/` to verify the fix

## Verification

1. Place a skill in `.agents/skills/my-skill/SKILL.md`
2. Run Pi and invoke the skill via `/skill:my-skill`
3. Verify the skill content is prefixed with "References are relative to .agents/skills/my-skill/" (not `.pi/`)
4. Test that reading references within the skill works correctly

## Questions for User

1. **What hook should the extension use?** The `tool_call` event can intercept tool execution - is this the right approach, or is there a better way to intercept skill loading?

2. **Should it fix all skill reads or be selective?** Should it only fix skills in certain locations (like `.agents/`), or all skills?

3. **Where is the Pi source located?** To properly understand the path calculation bug, do you have the Pi source code available to examine?
