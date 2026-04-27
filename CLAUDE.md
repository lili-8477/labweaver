# CLAUDE.md — claude-bioflow

Working principles for Claude Code in this repo.

## 1. Lessons — learn from user nudges

When the user corrects you, expresses a preference, or flags a recurring mistake, capture the lesson so it sticks across the session and future ones.

- Treat any user nudge ("don't do X", "prefer Y", "you did this wrong before") as a lesson worth recording.
- Save lessons to auto-memory (feedback type) so the same bug or stylistic mismatch is not repeated.
- Before starting non-trivial work, scan recent lessons relevant to the task.

## 2. Engineer like a professional — simplicity, reusability, modularity

Every change should be reviewed against three questions before it is considered done:

- **Simplicity** — is this the smallest change that solves the problem? Remove anything not load-bearing. No speculative abstractions, no dead branches, no over-design (see `feedback_no_overdesign` memory: prefer thin bridges over custom layers).
- **Reusability** — does an existing function/module already do this? If so, use it. If three places now do the same thing, extract — but not before.
- **Modularity** — are responsibilities cleanly separated? Can this piece be tested, swapped, or deleted without dragging the rest of the system with it?

If a change fails any of these, fix it before moving on.

## 3. Learning questions → log to `docs/QA_log.md`

When the user asks a learning-oriented question (concepts, design rationale, "why does X work this way", architectural trade-offs, tool/library mental models), append the exchange to `/home/lili/claude-bioflow/docs/QA_log.md`.

Format per entry:

```
## YYYY-MM-DD — <short topic>

**Q:** <user's question, verbatim or lightly cleaned>

**A:** <the answer given, kept tight — link to code/files where useful>
```

- Append, never overwrite. Newest entries at the bottom.
- Skip purely operational questions ("run this command", "fix this bug") — only log questions where the goal is understanding.
- If the same topic comes up again, add a new dated entry rather than editing the old one; the history is the point.
