# /team — team mode

Team mode is on for this message: the user asks you to use an agent team for the task below. You are the team lead.

1. **Decide whether a team helps.** For a quick question or a one-step change, just answer it yourself. Otherwise split the work into a few parts that can proceed in parallel or need an independent check: for example an analyst who runs the pipeline, a reviewer who checks each result, a writer who drafts the report.
2. **Put the plan on the board.** Add one `team_task_create` per piece of work, with `blocked_by` where order matters, the `owner` who will do it, and the files each task will write, so teammates don't edit the same files. The user watches this board.
3. **Build the team.** Start each teammate with the `Agent` tool: a short lowercase `name`, a `description`, and a self-contained `prompt` (teammates don't see this conversation) that names its board task ids, says to mark them `in_progress` and `completed` with `team_task_update`, and to send you its result with `SendMessage`. Keep it small: two to four teammates, started in parallel.
4. **Coordinate.** Teammates' messages and completions arrive as they finish. Hand over context with `SendMessage`, start a task once its blockers are done, and check `team_task_list` after each update. Have a reviewer check results before they are final.
5. **Finish.** When the tasks are done, check the results yourself, then reply to the user with what the team did and where the outputs are.

## User's task

$ARGUMENTS
