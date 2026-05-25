---
label: Trekker session recovery
description: Instruct the agent to reconstruct Trekker context by fetching current tasks, ready tasks, and searching for recent activity.
---

The user has resumed a session. Reconstruct Trekker context:
1. Run `trekker_list_tasks` with `status: "in_progress"` to see what task was active
2. Run `trekker_ready` to see what's available next
3. If the in_progress task exists, run `trekker_get_task` on its ID for full details
4. Summarize what you found to the user and ask how they want to proceed
