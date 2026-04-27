# Q&A Log

Append-only log of learning-oriented questions about claude-bioflow.
Newest entries at the bottom. See repo `CLAUDE.md` principle 3.

---

## 2026-04-27 — How does scSurvival load into a notebook? Is the local venv used?

**Q:** How is the venv at `/home/lili/claude-bioflow/hub/workspaces/li86/local_projects/scsurvival/venv` loaded into an ipynb? Or is scSurvival installed somewhere else?

**A:** The local venv is **not** loaded by any notebook. scSurvival is installed into the image-bundled `/venv` as a PEP 660 editable install whose `.pth` redirects imports to the project source.

Concrete chain:

- The container registers only two Jupyter kernels: `python3` → `/venv/bin/python` and `ir` → system R. Nothing points at `local_projects/scsurvival/venv`.
- Inside `/venv/bin/python`, `import scSurvival` resolves to `/workspace/local_projects/scsurvival/repo/scSurvival/__init__.py`.
- The redirection lives at `/venv/lib/python3.12/site-packages/__editable__.scsurvival-1.3.0.pth` — created by `pip install -e .` run from `/venv/bin/pip` against `local_projects/scsurvival/repo`.
- The orphan venv at `local_projects/scsurvival/venv` was itself spawned by `/venv/bin/python -m venv …` (per its `pyvenv.cfg`) but never registered as a kernel, so no notebook touches it.

Mental model:

- One container = exactly two kernels by design (`python3`, `ir`). Don't add more — `metadata.kernelspec.name` outside that set fails on first execute.
- To add a Python package for notebooks, install into `/venv` (`/venv/bin/pip install <pkg>`). The bundled `/venv` is chowned to `node` at container start so runtime installs persist in the container's overlay (NOT the image).
- For live development of a package, use editable install (`pip install -e ./path/to/repo`) — package metadata lives in `/venv`, sources stay in the project tree, edits show up without reinstall.
- "Package metadata in `/venv`, sources in the project" is what makes a project-local venv look load-bearing when it isn't.

Cleanup hint: `rm -rf local_projects/scsurvival/venv` is safe — nothing depends on it.

---

## 2026-04-27 — Shared vs user CLAUDE.md: which dominates?

**Q:** We have 2 layers of CLAUDE.md (shared, user). What is dominating?

**A:** Neither — there is no runtime layering. Only the user's CLAUDE.md is loaded.

Mechanics:

- `hub/scripts/add-user.sh` copies `shared/CLAUDE.md` → `<user>/CLAUDE.md` once at provisioning, only if the user doesn't already have one. After that the two files are independent.
- The container bind-mount list mounts `<user>/CLAUDE.md` → `/workspace/CLAUDE.md`. `shared/CLAUDE.md` is not mounted; only `shared/reference`, `shared/projects`, `shared/skills` are.
- Claude Code discovery walks up from `cwd=/workspace` to `/`. Nothing exists above, so `/workspace/CLAUDE.md` is the only CLAUDE.md the SDK sees.

Consequence: edits to `shared/CLAUDE.md` don't propagate to existing users. You either re-`cp` after each edit, or use Claude Code's `@path` import to point the user CLAUDE.md at a shared file mounted into the container (the standard "shared base + user override" pattern).

Three plumbing options if true layering is wanted:

1. **Template + manual re-sync** (status quo): `cp shared/CLAUDE.md <user>/CLAUDE.md` after each template edit. Cheapest. Overwrites user-local edits.
2. **`@include` at runtime**: bind-mount `shared/CLAUDE.md` to e.g. `/workspace/.bioflow/shared.md`; user CLAUDE.md begins with `@/workspace/.bioflow/shared.md`. Live updates, user file owns local overrides. Modest add-user.sh change.
3. **Concat at boot**: entrypoint composes shared+user → /tmp file, mounts that. More machinery, same outcome as option 2.

---

## 2026-04-27 — What is `@include` in CLAUDE.md? How does it work?

**Q:** What is `@include`? How does `@include` work?

**A:** Claude Code's memory-import syntax. Writing `@<path>` inside `CLAUDE.md` (or any memory file) inlines the referenced file's contents into the system prompt when Claude Code loads memory at the start of a turn.

Syntax (note: examples below are inside a code fence so the importer ignores them — the parser skips fenced/backticked text):

```
@/workspace/.bioflow/shared.md      # absolute path
@./team/style-guide.md              # relative to this CLAUDE.md
@~/dotfiles/global-claude.md        # home-relative
```

Mechanics:

- The import is recursive — an included file can include others, depth-capped (~5 levels).
- Relative paths resolve against the importing file's directory.
- Imports are skipped inside fenced code blocks and inline backticks, so the syntax itself can be documented without firing.
- Re-evaluated every turn (CLAUDE.md is re-read), so edits to imported files take effect on the next user message — no restart.
- It's an *inline* mechanic, not a layered override system. Imported text and surrounding text concatenate into the same system prompt. To "override" the imported content, place user-specific instructions *after* the `@…` line so the later text wins.
- Imported files are plain markdown — not skills. For skill-style routing, use `.claude/skills/` instead.

Bioflow application: bind-mount `shared/CLAUDE.md` into each container at e.g. `/workspace/.bioflow/shared.md`, seed each user's `CLAUDE.md` with `@/workspace/.bioflow/shared.md` as the first line, and shared edits will flow live to every workspace while user files own local overrides.
