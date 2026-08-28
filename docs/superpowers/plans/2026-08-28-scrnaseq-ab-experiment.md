# scRNA-seq A/B Experiment Setup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare two isolated container arms and a clean CHPC input so the same scRNA-seq task prompt can be run with and without accumulated lab knowledge, and scored.

**Architecture:** Arm A is `claude-bioflow-li86` left as-is except that prior work on this dataset is quarantined. Arm B is `claude-bioflow-control`, recreated without the shared bind mounts so it has no domain skills and no readable shared tree. Both arms are raised to the same model and pointed at one staged FASTQ directory on CHPC. Neither arm is driven by an agent — the operator pastes an identical prompt into each container's LabWeaver UI.

**Tech Stack:** Docker bind mounts, `hub/scripts/recreate-user.sh`, Claude Code `settings.json`, OpenSSH `ControlMaster`, CHPC SLURM, Cell Ranger.

**Spec:** `docs/superpowers/specs/2026-08-28-scrnaseq-ab-experiment-design.md`

## Global Constraints

- Never modify anything under `hub/workspaces/shared/` — that tree is bind-mounted read-write or read-only into `li86`, `control`, `test1`, `test2` and `test3`. Editing it contaminates arm A and every other user.
- Arm A (`claude-bioflow-li86`) gets exactly one change: the C4 quarantine. Its skills, `settings.json`, `CLAUDE.md`, `.mcp.json` and memory store are not touched.
- Model for both arms: `claude-opus-4-8`.
- CHPC account for both arms: `u6025146` on `notchpeak.chpc.utah.edu`.
- Staged input path, identical for both arms: `/uufs/chpc.utah.edu/common/home/jonesk-group2/agent-omics/singlecellrnaseq/A8163_mSS_ab_input/Fastq`
- Both arms work in `/workspace/local_projects/A8163_mSS_ab/`.
- The task prompt is fixed before either run starts and is byte-identical between arms. Do not reword it between runs.
- Duo MFA needs a TTY. Any `ssh -MNf` to open a ControlMaster is an operator action run via `docker exec -it`, never automated.
- Default behaviour of `hub/scripts/recreate-user.sh` must be unchanged for every user other than `control`.

---

### Task 1: Write a dedicated `recreate-control.sh` encoding the documented baseline

**Files:**
- Create: `hub/scripts/recreate-control.sh`
- Reference: `hub/users.md` (section "control — baseline container"), `hub/scripts/recreate-user.sh:150-205`

**Interfaces:**
- Consumes: nothing.
- Produces: `hub/scripts/recreate-control.sh`, taking no arguments, run by Task 3. It recreates `claude-bioflow-control` with the baseline mount set documented in `hub/users.md` plus the two experiment-required additions. `hub/scripts/recreate-user.sh` is **not** modified.

`hub/users.md` carries a standing instruction: *"Never run `recreate-user.sh` or `add-user.sh` against `control`."* That script applies the standard mount set, which is exactly what broke this baseline on 2026-08-10. A `SHARED_MOUNTS=0` flag on `recreate-user.sh` would still be running the forbidden script, and would leave the next operator one forgotten flag away from breaking it again. A dedicated script encodes the baseline as code so it cannot drift back.

`ID_HASH` is derived deterministically from the container name (`recreate-user.sh:152`), so it stays `1095be4c…` and the one-click URL plus the nginx `lw_service` route keep working across the recreate.

- [ ] **Step 1: Record the current mount count as the baseline**

```bash
docker inspect claude-bioflow-control --format '{{len .Mounts}}'
```

Expected: `18` — the contaminated standard set.

- [ ] **Step 2: Write the script**

Create `hub/scripts/recreate-control.sh` with exactly this content, then `chmod +x` it:

```bash
#!/bin/bash
# Recreate the `control` baseline container.
#
# DO NOT use recreate-user.sh or add-user.sh for this container. Those apply
# the standard mount set and silently restore everything the baseline exists
# to exclude -- that is what invalidated the baseline on 2026-08-10 (see the
# "control -- baseline container" section of hub/users.md).
#
# Mount set is the documented baseline, plus two additions required by the
# 2026-08-28 A/B experiment, both recorded in
# docs/superpowers/specs/2026-08-28-scrnaseq-ab-experiment-design.md:
#
#   .ssh            -- the control arm must reach CHPC; without it the arm
#                      fails on plumbing rather than on biology.
#   .claude/skills  -- carries exactly one skill, chpc-bridge, for the same
#                      reason. Domain skills stay out.
#
# Deliberately omitted: shared/{skills,projects,reference}, the shared
# CLAUDE.md, .mcp.json, agents, commands, .latch, and the MEMORY_* env.
# .claude/hooks IS mounted: those hooks write .audit.log, which the
# experiment greps for off-path CHPC reads, and li86 runs the identical
# set, so this is instrumentation rather than an asymmetry.
set -euo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKSPACE="${HUB_DIR}/workspaces/control"
NETWORK="claude-bioflow_bioflow-net"
NATS_HOST="claude-bioflow-nats"
ENV_FILE="${HUB_DIR}/.env"
CONTAINER="claude-bioflow-control"
IMAGE="${IMAGE:-claude-bioflow:dev}"

[[ -d "$WORKSPACE" ]] || { echo "No workspace at ${WORKSPACE}"; exit 1; }
[[ -f "$ENV_FILE" ]]  || { echo "Missing ${ENV_FILE}"; exit 1; }

set -a
. "${ENV_FILE}"
set +a

# Same derivation as recreate-user.sh:152, so the service ID recorded in
# users.md and the nginx lw_service route stay valid.
ID_HASH=$(printf 'claude-bioflow-control' | sha256sum | cut -c1-12)

if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
    docker stop "${CONTAINER}" >/dev/null
    docker rm   "${CONTAINER}" >/dev/null
fi

docker run -d \
    --name "${CONTAINER}" \
    --network "${NETWORK}" \
    --restart unless-stopped \
    -e "ID_HASH=${ID_HASH}" \
    -e "NATS_SERVERS=nats://${NATS_HOST}:4222" \
    -e "NATS_USER=agent" \
    -e "WORKSPACE_ROOT=/workspace" \
    -e "DEFAULT_PROJECT=/workspace" \
    -e "PG_URL=postgres://bioflow:${POSTGRES_PASSWORD}@claude-bioflow-postgres:5432/bioflow" \
    -e "USERNAME=control" \
    -e "HOME=/home/node" \
    -e "MEMORY_ENABLED=0" \
    -v "${WORKSPACE}/local_projects:/workspace/local_projects" \
    -v "${WORKSPACE}/.env:/workspace/.env:ro" \
    -v "${WORKSPACE}/.claude/settings.json:/home/node/.claude/settings.json" \
    -v "${WORKSPACE}/.claude/claude-projects:/home/node/.claude/projects" \
    -v "${WORKSPACE}/.claude/hooks:/home/node/.claude/hooks" \
    -v "${WORKSPACE}/.claude/skills:/home/node/.claude/skills-user" \
    -v "${WORKSPACE}/.ssh:/home/node/.ssh" \
    -w /workspace \
    "${IMAGE}"

docker exec -u root "${CONTAINER}" chown -R node:node /venv 2>/dev/null \
    && echo "  chown /venv -> node:node OK" \
    || echo "  chown /venv skipped"

echo "recreated ${CONTAINER} with the baseline mount set (ID_HASH=${ID_HASH})"
```

- [ ] **Step 3: Syntax-check and confirm no excluded path slipped in**

```bash
bash -n hub/scripts/recreate-control.sh && echo SYNTAX_OK
grep -c 'workspaces/shared\|SHARED_DIR\|mcp.json\|MEMORY_API_URL\|SIDECAR' hub/scripts/recreate-control.sh
```

Expected: `SYNTAX_OK`, then `0`.

- [ ] **Step 4: Confirm `recreate-user.sh` is untouched**

```bash
git diff --stat hub/scripts/recreate-user.sh
```

Expected: no output. The standard script must not change — every other user depends on it.

- [ ] **Step 5: Verify the derived ID hash matches the provisioned service ID**

```bash
printf 'claude-bioflow-control' | sha256sum | cut -c1-12
grep -o '1095be4c[a-f0-9]*' hub/users.md | head -1
```

Expected: the first command's 12 characters are the leading characters of the service ID in `users.md`. If they differ, stop — recreating would break the control's one-click URL and its nginx `lw_service` route.

- [ ] **Step 6: Commit**

```bash
git add hub/scripts/recreate-control.sh
git commit -m "feat(hub): dedicated recreate-control.sh so the baseline stops drifting"
```

---

### Task 2: Prepare the control workspace before recreating it

**Files:**
- Create: `hub/workspaces/control/.claude/skills/chpc-bridge/SKILL.md` (copied from the shared tree)
- Modify: `hub/workspaces/control/.claude/settings.json` (the `model` key)
- Modify: `hub/workspaces/control/.ssh/config` (uncomment and fill the `chpc-login` stanza)
- Delete: `hub/workspaces/control/.mcp.json`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: a `control` workspace whose per-user mounts already carry `chpc-bridge`, the `claude-opus-4-8` model, a working SSH host alias `chpc-login`, and no `.mcp.json`. Task 3 recreates the container over this workspace; Task 5 opens the ControlMaster against this alias.

Run this task **before** Task 3, while the shared tree is still mounted — Step 1 copies `chpc-bridge` out of it, and after the recreate that source is gone from the container.

These are per-user host paths, safe to edit. `hub/workspaces/control/.claude/skills/` is root-owned, so the copy goes through the container as root.

- [ ] **Step 1: Copy `chpc-bridge` into the control's per-user skills dir**

`/home/node/.claude/skills-user` is the in-container mount of `hub/workspaces/control/.claude/skills`, so writing there persists across the recreate.

```bash
docker exec -u root claude-bioflow-control bash -lc '
  mkdir -p /home/node/.claude/skills-user/chpc-bridge &&
  cp /workspace/shared/skills/chpc-bridge/SKILL.md /home/node/.claude/skills-user/chpc-bridge/SKILL.md &&
  chown -R node:node /home/node/.claude/skills-user/chpc-bridge'
```

- [ ] **Step 2: Verify the copy landed on the host side**

```bash
wc -l hub/workspaces/control/.claude/skills/chpc-bridge/SKILL.md
```

Expected: `385` lines. The authoritative check is that it matches the shared original byte for byte:

```bash
diff hub/workspaces/shared/skills/chpc-bridge/SKILL.md \
     hub/workspaces/control/.claude/skills/chpc-bridge/SKILL.md && echo IDENTICAL
```

Expected: `IDENTICAL`

- [ ] **Step 3: Raise the control's model to match arm A**

```bash
python3 - <<'PY'
import json, pathlib
p = pathlib.Path("hub/workspaces/control/.claude/settings.json")
d = json.loads(p.read_text())
assert d["model"] == "claude-sonnet-4-6", f"unexpected starting model: {d['model']}"
d["model"] = "claude-opus-4-8"
p.write_text(json.dumps(d, indent=2) + "\n")
print("model ->", d["model"])
PY
```

Expected: `model -> claude-opus-4-8`

- [ ] **Step 4: Confirm both arms now agree on the model**

```bash
python3 -c "
import json
a=json.load(open('hub/workspaces/li86/.claude/settings.json'))['model']
b=json.load(open('hub/workspaces/control/.claude/settings.json'))['model']
print(a, b, 'MATCH' if a==b else 'MISMATCH')"
```

Expected: `claude-opus-4-8 claude-opus-4-8 MATCH`

- [ ] **Step 5: Write the control's SSH config**

The file is currently a fully commented-out template. Replace it with an active stanza. `ControlPath` is per-container, so it will not collide with arm A's socket.

```bash
cat > hub/workspaces/control/.ssh/config <<'EOF'
Host chpc-login
    HostName notchpeak.chpc.utah.edu
    User u6025146
    ControlMaster auto
    ControlPath ~/.ssh/cm-%r@%h:%p
    ControlPersist 8h
    ServerAliveInterval 60
    ServerAliveCountMax 3
    StrictHostKeyChecking accept-new
    UserKnownHostsFile ~/.ssh/known_hosts
EOF
chmod 600 hub/workspaces/control/.ssh/config
```

- [ ] **Step 6: Verify the config parses and resolves the alias**

```bash
docker exec claude-bioflow-control ssh -G chpc-login | grep -E '^(hostname|user|controlmaster) '
```

Expected:

```
hostname notchpeak.chpc.utah.edu
user u6025146
controlmaster auto
```

- [ ] **Step 7: Remove the memory MCP from the control workspace**

`hub/users.md` specifies the baseline has no MCP servers; the contaminated recreate on 2026-08-10 added `.mcp.json` (`bioflow-memory`). Task 3 stops mounting it, but delete the file too, so a future standard recreate cannot silently re-expose it.

```bash
rm -f hub/workspaces/control/.mcp.json
ls hub/workspaces/control/.mcp.json 2>&1
```

Expected: `No such file or directory`

- [ ] **Step 8: Commit**

The workspace tree may be gitignored; `git add -f` if so, otherwise skip the commit and note it in the run log.

```bash
git add -f hub/workspaces/control/.claude/settings.json hub/workspaces/control/.ssh/config
git commit -m "chore(control): match arm A's model and enable the CHPC host alias for the A/B run"
```

---

### Task 3: Recreate the control container on the baseline mount set

**Files:**
- Modify: none (runs `hub/scripts/recreate-control.sh` from Task 1)

**Interfaces:**
- Consumes: `hub/scripts/recreate-control.sh` from Task 1; the prepared workspace from Task 2.
- Produces: a running `claude-bioflow-control` with 7 mounts, zero shared-tree paths, no MCP server, and exactly one skill (`chpc-bridge`). Task 6's capture script reads its transcripts from `hub/workspaces/control/.claude/claude-projects/`.

- [ ] **Step 1: Recreate on the baseline mount set**

```bash
hub/scripts/recreate-control.sh
```

Expected: the container id, then `recreated claude-bioflow-control with the baseline mount set (ID_HASH=1095be4c…)`.

- [ ] **Step 2: Verify the mount set shrank to the baseline**

```bash
docker inspect claude-bioflow-control --format '{{len .Mounts}}'
docker inspect claude-bioflow-control --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}
{{end}}' | grep -c 'workspaces/shared'
```

Expected: `7`, then `0`.

- [ ] **Step 3: Verify the shared tree is unreadable from inside**

This is the check the tombstone approach would have failed, and the one that catches a standard-recreate regression.

```bash
docker exec claude-bioflow-control bash -lc '
  cat /workspace/shared/skills/ss-mouse-celltype/SKILL.md 2>&1 | head -1;
  ls /workspace/shared 2>&1;
  cat /workspace/.bioflow/shared.md 2>&1 | head -1;
  cat /workspace/.mcp.json 2>&1 | head -1'
```

Expected: all four lines are "No such file or directory" errors. If any returns content, stop — the arm is not isolated and the run is invalid.

- [ ] **Step 4: Verify the skill set is exactly `chpc-bridge`**

```bash
docker exec claude-bioflow-control bash -lc 'ls ~/.claude/skills/'
```

Expected: `chpc-bridge` and nothing else. In particular `ss-mouse-celltype` and `single-cell` must be absent.

- [ ] **Step 5: Verify arm A was not disturbed**

```bash
docker exec claude-bioflow-li86 bash -lc 'ls ~/.claude/skills/ | wc -l; ls ~/.claude/skills/ss-mouse-celltype/'
wc -l hub/workspaces/shared/skills/ss-mouse-celltype/SKILL.md
```

Expected: `41`, then `SKILL.md`, then `278 hub/workspaces/shared/skills/ss-mouse-celltype/SKILL.md`. The shared tree must be byte-identical to before.

- [ ] **Step 6: Verify the container is healthy and reachable in the UI**

```bash
docker ps --filter name=claude-bioflow-control --format '{{.Names}} {{.Status}}'
```

Expected: `claude-bioflow-control Up ... (healthy)`. Then open the control workspace in the LabWeaver UI via its one-click URL from `hub/users.md` and confirm the chat responds to a trivial message such as `hello`. Do not ask it anything about the dataset — that would pollute the transcript.

- [ ] **Step 7: Clear the BROKEN banner in `hub/users.md`**

`hub/users.md` still carries *"BROKEN as of 2026-08-10 — do not use as a baseline until rebuilt."* Task 3 is that rebuild, so the banner is now stale and would mislead the next operator into distrusting a valid baseline.

Replace the blockquote in the "control — baseline container" section with a rebuild note recording: the rebuild date (2026-08-28), that `hub/scripts/recreate-control.sh` now owns the mount set, the two deliberate additions (`.ssh`, `.claude/skills` holding only `chpc-bridge`), that `.claude/hooks` is retained as experiment instrumentation, and that `.mcp.json` was deleted. Keep the standing *"Never run `recreate-user.sh` or `add-user.sh` against `control`"* warning — point it at the new script.

`hub/users.md` is gitignored and holds credentials. Edit it in place; do not commit it, and do not quote its contents into any committed file.

```bash
grep -c 'BROKEN as of 2026-08-10' hub/users.md
```

Expected: `0`

---

### Task 4: Quarantine arm A's prior work on this dataset

**Files:**
- Create: `hub/workspaces/li86/_quarantine_ab/` (holds four moved directories)
- Modify: `hub/workspaces/li86/local_projects/` (four directories removed)

**Interfaces:**
- Consumes: nothing.
- Produces: an arm A workspace with no prior A8163/mSS outputs on disk. Task 8's reversal moves them back.

`_quarantine_ab/` sits beside `local_projects/`, which is the only part of that tree bind-mounted into the container, so the quarantined directories become invisible to arm A.

- [ ] **Step 1: Confirm the four directories and record their sizes**

```bash
du -sh hub/workspaces/li86/local_projects/{A8163_mSS,A8608_mSS,mSS_SCRNAseq,srt-for-monocle3-7bda}
```

Expected: roughly `16K`, `9.5M`, `1.1M`, `778M`.

- [ ] **Step 2: Move them out of the mounted tree**

```bash
mkdir -p hub/workspaces/li86/_quarantine_ab
mv hub/workspaces/li86/local_projects/A8163_mSS \
   hub/workspaces/li86/local_projects/A8608_mSS \
   hub/workspaces/li86/local_projects/mSS_SCRNAseq \
   hub/workspaces/li86/local_projects/srt-for-monocle3-7bda \
   hub/workspaces/li86/_quarantine_ab/
```

- [ ] **Step 3: Verify arm A can no longer see them**

```bash
docker exec claude-bioflow-li86 bash -lc 'ls /workspace/local_projects/ | grep -iE "mSS|monocle3" || echo NONE_VISIBLE'
ls hub/workspaces/li86/_quarantine_ab/
```

Expected: `NONE_VISIBLE`, then the four directory names listed in the quarantine.

- [ ] **Step 4: Verify nothing else references the answer object from inside the container**

```bash
docker exec claude-bioflow-li86 bash -lc 'grep -rl "srt_for_monocle3\|cell_type" /workspace/local_projects/ 2>/dev/null | head'
```

Expected: no output, or only files unrelated to A8163. Any remaining file that carries the A8163 cell-type table must be moved into the quarantine too, and the extra path recorded in the run log.

- [ ] **Step 5: Record the quarantine in the run log**

```bash
mkdir -p docs/experiments/2026-08-28-scrnaseq-ab
{ echo "## Quarantine — $(date -Iseconds)"
  echo
  echo "Moved out of li86/local_projects for the duration of the run:"
  ls hub/workspaces/li86/_quarantine_ab/ | sed 's/^/- /'
} >> docs/experiments/2026-08-28-scrnaseq-ab/run-log.md
git add docs/experiments/2026-08-28-scrnaseq-ab/run-log.md
git commit -m "docs(experiment): record arm A quarantine"
```

---

### Task 5: Open the CHPC bridges and stage a clean FASTQ input

**Files:**
- Create: `/uufs/chpc.utah.edu/common/home/jonesk-group2/agent-omics/singlecellrnaseq/A8163_mSS_ab_input/Fastq/` on CHPC (hard links)
- Modify: `docs/experiments/2026-08-28-scrnaseq-ab/run-log.md`

**Interfaces:**
- Consumes: the `chpc-login` alias from Task 2.
- Produces: a staged input directory, identical for both arms, containing only FASTQ hard links. Referenced verbatim by the task prompt in Task 6.

- [ ] **Step 1: Operator opens both ControlMasters**

Duo needs a TTY, so these two commands are run by the operator, not by an agent. Each will prompt for a Duo push.

```bash
docker exec -it claude-bioflow-li86    ssh -MNf chpc-login
docker exec -it claude-bioflow-control ssh -MNf chpc-login
```

- [ ] **Step 2: Verify both bridges are up**

```bash
for c in li86 control; do
  echo -n "$c: "
  docker exec claude-bioflow-$c bash -lc 'timeout 20 ssh -o BatchMode=yes chpc-login hostname' 2>&1 | tail -1
done
```

Expected: a notchpeak hostname for both. A `Could not resolve hostname chpc` error means the alias was mistyped — the alias is `chpc-login`, not `chpc`. A hang or Duo prompt means the master in Step 1 did not persist.

- [ ] **Step 3: Inventory the source FASTQs**

```bash
docker exec claude-bioflow-li86 bash -lc '
  ssh chpc-login "ls -l /uufs/chpc.utah.edu/common/home/jonesk-group2/agent-omics/singlecellrnaseq/A8163_mSS/Fastq/"'
```

Expected: a list of `*_S<n>_L<lane>_R[12]_001.fastq.gz` files. Record the sample names and the file count in the run log — they are needed to verify the staging in Step 5.

- [ ] **Step 4: Stage hard links into a neutral directory**

Hard links rather than symlinks: a symlink's target would reveal the original project path (and therefore the sibling `scripts/cellranger_rerun_fixed.slurm` answer key) under `ls -l`. Hard links need the same filesystem, which holds since both paths are under `jonesk-group2`.

```bash
docker exec claude-bioflow-li86 bash -lc '
  ssh chpc-login "
    SRC=/uufs/chpc.utah.edu/common/home/jonesk-group2/agent-omics/singlecellrnaseq/A8163_mSS/Fastq
    DST=/uufs/chpc.utah.edu/common/home/jonesk-group2/agent-omics/singlecellrnaseq/A8163_mSS_ab_input/Fastq
    mkdir -p \"\$DST\" && ln \"\$SRC\"/*.fastq.gz \"\$DST\"/ && ls \"\$DST\" | wc -l"'
```

Expected: the same file count as Step 3. If `ln` reports `Invalid cross-device link`, fall back to `cp -l` on the same filesystem, or `rsync -a` as a last resort — and note the fallback in the run log, since a copy doubles the storage.

- [ ] **Step 5: Verify the staged directory leaks nothing**

```bash
docker exec claude-bioflow-control bash -lc '
  ssh chpc-login "
    D=/uufs/chpc.utah.edu/common/home/jonesk-group2/agent-omics/singlecellrnaseq/A8163_mSS_ab_input
    ls -la \$D/Fastq | head -5; echo ---; ls -la \$D"'
```

Expected: `Fastq/` contains only `.fastq.gz` entries with a link count of 2 and **no** `->` symlink arrows; the parent `A8163_mSS_ab_input/` contains only `Fastq`. No `scripts/`, no `outs/`, no reference directory.

- [ ] **Step 6: Record the staging in the run log**

```bash
{ echo; echo "## FASTQ staging — $(date -Iseconds)"; echo
  echo "Staged path: /uufs/.../singlecellrnaseq/A8163_mSS_ab_input/Fastq"
  echo "File count: <N from step 4>"
  echo "Samples: <sample names from step 3>"
} >> docs/experiments/2026-08-28-scrnaseq-ab/run-log.md
git add docs/experiments/2026-08-28-scrnaseq-ab/run-log.md
git commit -m "docs(experiment): record CHPC FASTQ staging"
```

---

### Task 6: Freeze the task prompt and build the capture harness

**Files:**
- Create: `docs/experiments/2026-08-28-scrnaseq-ab/task-prompt.txt`
- Create: `docs/experiments/2026-08-28-scrnaseq-ab/capture.sh`
- Create: `docs/experiments/2026-08-28-scrnaseq-ab/scoring.md`

**Interfaces:**
- Consumes: the staged path from Task 5.
- Produces: `task-prompt.txt`, pasted verbatim into both UIs in Task 7; `capture.sh <arm-letter> <workspace-name>`, run once per arm in Task 8, writing to `arm-<letter>/`.

- [ ] **Step 1: Write the frozen task prompt**

```bash
mkdir -p docs/experiments/2026-08-28-scrnaseq-ab
cat > docs/experiments/2026-08-28-scrnaseq-ab/task-prompt.txt <<'EOF'
Analyze the single-cell RNA-seq dataset A8163_mSS, a mouse synovial sarcoma model.

Raw FASTQ files are on CHPC at:
/uufs/chpc.utah.edu/common/home/jonesk-group2/agent-omics/singlecellrnaseq/A8163_mSS_ab_input/Fastq

Compute runs on CHPC — reach it over SSH and submit heavy work through SLURM. Do not process the data inside this container.

Take it from FASTQ to annotated cell types:

1. Alignment and counting from the FASTQ files.
2. Quality control and doublet handling.
3. Normalization, dimensionality reduction, clustering, UMAP.
4. Assign a biological cell type to every cluster, and give the marker evidence behind each call.
5. Report anything notable about what this tumor expresses.

Work in /workspace/local_projects/A8163_mSS_ab/. Leave your scripts, SLURM submissions, figures and a written summary there so the analysis can be reproduced.
EOF
```

- [ ] **Step 2: Verify the prompt names nothing under test**

The prompt must not leak the transgene reference, the fusion, or any cell-type vocabulary.

```bash
grep -icE 'SS18|SSX|transgene|GRCm39|mkref|barnyard|biphasic|monophasic|macrophage|fibroblast|endothelial|harmony|scrublet|cellranger' \
  docs/experiments/2026-08-28-scrnaseq-ab/task-prompt.txt
```

Expected: `0`. Any hit means the prompt is telling the control the answer.

- [ ] **Step 3: Write the capture script**

```bash
cat > docs/experiments/2026-08-28-scrnaseq-ab/capture.sh <<'EOF'
#!/bin/bash
# Capture one arm's evidence after its run finishes.
# Usage: ./capture.sh a li86
#        ./capture.sh b control
set -euo pipefail

ARM="${1:?arm letter, a or b}"
WS="${2:?workspace name, e.g. li86}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "${HERE}/../../.." && pwd)"
OUT="${HERE}/arm-${ARM}"
SRC="${REPO}/hub/workspaces/${WS}"

mkdir -p "${OUT}"

# Session transcripts written by Claude Code.
cp -r "${SRC}/.claude/claude-projects" "${OUT}/transcripts" 2>/dev/null \
    || echo "warn: no transcripts at ${SRC}/.claude/claude-projects"

# Audit trail: every Bash/Write/Edit call, and every sbatch submission.
for f in .audit.log .jobs.log; do
    find "${SRC}" -maxdepth 3 -name "${f}" -exec cp {} "${OUT}/" \; 2>/dev/null || true
done

# The arm's own working tree.
if [[ -d "${SRC}/local_projects/A8163_mSS_ab" ]]; then
    cp -r "${SRC}/local_projects/A8163_mSS_ab" "${OUT}/work"
else
    echo "warn: arm ${ARM} produced no A8163_mSS_ab directory"
fi

# Leakage check: did this arm read outside the staged input?
grep -oE '/uufs/[^ "'"'"')]*' "${OUT}"/.audit.log 2>/dev/null \
    | grep -v 'A8163_mSS_ab_input' | sort -u > "${OUT}/offpath-uufs.txt" || true

echo "captured arm ${ARM} (${WS}) -> ${OUT}"
echo "off-path CHPC accesses: $(wc -l < "${OUT}/offpath-uufs.txt" 2>/dev/null || echo 0)"
EOF
chmod +x docs/experiments/2026-08-28-scrnaseq-ab/capture.sh
bash -n docs/experiments/2026-08-28-scrnaseq-ab/capture.sh && echo SYNTAX_OK
```

Expected: `SYNTAX_OK`

- [ ] **Step 4: Write the scoring sheet**

```bash
cat > docs/experiments/2026-08-28-scrnaseq-ab/scoring.md <<'EOF'
# Scoring — A8163_mSS, arm A (li86, skills) vs arm B (control, none)

Ground truth is the lab's established A8163 taxonomy: 11 clusters,
42,141 cells, 32,286 genes. Held in `ss-mouse-celltype` (arm A's skill,
and the scorer's reference — never shown to arm B).

Scored by the operator after both arms finish. Fill both columns before
comparing, to avoid scoring the second arm against the first.

| Dimension | Arm A | Arm B | Notes |
|---|---|---|---|
| Reference genome used | | | GRCm39 + `SSX2_SSX18` transgene is correct; GRCh38+mm10 barnyard loses the transgene signal |
| `SSX2_SSX18` reported | | | y/n, and whether counts were non-zero |
| Clusters found | | | ground truth 11 |
| SS tumor states named | | | corded/epithelial, monophasic, PD, fibro-like, stem — vs. an undifferentiated "tumor cells" |
| Microenvironment resolved | | | TAM, endothelial, fibroblast, NK/T, mast, neutrophil |
| Marker evidence given | | | per-cluster markers with a test named, vs. assertion |
| QC thresholds | | | values chosen and whether justified |
| Doublet handling | | | method named |
| Turns to first count matrix | | | |
| Wall-clock to final annotation | | | |
| Reproducibility artifacts | | | scripts + SLURM files + written summary present |
| Off-path CHPC reads | | | from `offpath-uufs.txt`; a hit on the original `A8163_mSS` tree voids that arm's reference-choice score |

## Confound disclosure

The treatment is skills **plus** the `bioflow-memory` store **plus** the
workspace `CLAUDE.md`, not skills alone. Arm B has none of the three.
State this in any writeup; do not describe the result as isolating the
effect of skills.
EOF
```

- [ ] **Step 5: Commit the harness**

```bash
git add docs/experiments/2026-08-28-scrnaseq-ab/
git commit -m "docs(experiment): freeze the A/B task prompt, capture script and scoring sheet"
```

---

### Task 7: Run both arms

**Files:**
- Modify: `docs/experiments/2026-08-28-scrnaseq-ab/run-log.md`

**Interfaces:**
- Consumes: `task-prompt.txt` from Task 6; both containers from Tasks 3-5.
- Produces: two completed sessions and their timestamps, consumed by Task 8.

This task is operator-driven through the LabWeaver UI. No agent runs it.

- [ ] **Step 1: Pre-flight both arms**

```bash
for c in li86 control; do
  echo "== $c =="
  docker exec claude-bioflow-$c bash -lc 'ls ~/.claude/skills/ | tr "\n" " "; echo; timeout 20 ssh -o BatchMode=yes chpc-login hostname'
done
python3 -c "
import json
print(json.load(open('hub/workspaces/li86/.claude/settings.json'))['model'],
      json.load(open('hub/workspaces/control/.claude/settings.json'))['model'])"
```

Expected: li86 lists 41 skills, control lists only `chpc-bridge`, both print a notchpeak hostname, and both models read `claude-opus-4-8`. Do not start if any of these is off.

- [ ] **Step 2: Start a fresh session in each arm**

In the LabWeaver UI, open each workspace and start a **new** chat so no prior context carries in. Paste the contents of `task-prompt.txt` verbatim. Do not add a greeting, a clarification, or a follow-up hint.

- [ ] **Step 3: Record start times**

```bash
{ echo; echo "## Run — arm A start $(date -Iseconds)"; } >> docs/experiments/2026-08-28-scrnaseq-ab/run-log.md
```

Repeat for arm B at its actual start time.

- [ ] **Step 4: Let both arms run**

Cell Ranger on CHPC takes hours per sample. Answer only questions the agent asks about its own environment (credentials, permissions). Do **not** answer questions about references, cell types, or markers — if an arm asks one, record the question verbatim in the run log and reply that it should use its own judgement. An answered biology question invalidates that arm.

- [ ] **Step 5: Record end times and any interventions**

```bash
{ echo "## Run — arm A end $(date -Iseconds)"
  echo "Interventions: <verbatim questions asked and how they were answered, or NONE>"
} >> docs/experiments/2026-08-28-scrnaseq-ab/run-log.md
```

---

### Task 8: Capture, check for leakage, score, and reverse

**Files:**
- Create: `docs/experiments/2026-08-28-scrnaseq-ab/arm-a/`, `arm-b/`
- Modify: `docs/experiments/2026-08-28-scrnaseq-ab/scoring.md`

**Interfaces:**
- Consumes: `capture.sh` from Task 6; the finished runs from Task 7.
- Produces: the filled scoring sheet, and a restored environment.

- [ ] **Step 1: Capture both arms**

```bash
docs/experiments/2026-08-28-scrnaseq-ab/capture.sh a li86
docs/experiments/2026-08-28-scrnaseq-ab/capture.sh b control
```

Expected: `captured arm a (li86) -> .../arm-a` and the same for b, each with an off-path count.

- [ ] **Step 2: Review the leakage report**

```bash
cat docs/experiments/2026-08-28-scrnaseq-ab/arm-{a,b}/offpath-uufs.txt
```

Any path under `.../singlecellrnaseq/A8163_mSS/` (the original tree, not `A8163_mSS_ab_input`) means that arm reached the answer key. Record it in `scoring.md` and void that arm's reference-choice row rather than dropping the run.

- [ ] **Step 3: Fill the scoring sheet**

Read each arm's written summary and scripts under `arm-*/work/`, then complete every row of the table in `scoring.md` for **both** arms before comparing them. Cite the file and line backing each cell.

- [ ] **Step 4: Commit the results**

```bash
git add docs/experiments/2026-08-28-scrnaseq-ab/
git commit -m "docs(experiment): capture and score the A/B scRNA-seq run"
```

- [ ] **Step 5: Restore arm A's quarantined work**

```bash
mv hub/workspaces/li86/_quarantine_ab/* hub/workspaces/li86/local_projects/
rmdir hub/workspaces/li86/_quarantine_ab
docker exec claude-bioflow-li86 bash -lc 'ls /workspace/local_projects/ | grep -cE "mSS|monocle3"'
```

Expected: `4`

- [ ] **Step 6: Leave the control container on the baseline mount set**

Do **not** "restore" the control by running `hub/scripts/recreate-user.sh control`. `hub/users.md` forbids it, and running it is exactly what invalidated this baseline on 2026-08-10. The baseline mount set is the container's correct steady state — there is nothing to undo here.

Confirm it survived the run:

```bash
docker inspect claude-bioflow-control --format '{{len .Mounts}}'
docker exec claude-bioflow-control bash -lc 'ls ~/.claude/skills/'
```

Expected: `7`, then `chpc-bridge` alone.

The only experiment-specific residue is the CHPC access, which a future non-CHPC baseline does not need. Leave it unless a purist baseline is wanted; if it is, re-comment the SSH stanza in `hub/workspaces/control/.ssh/config` and drop the skill:

```bash
docker exec -u root claude-bioflow-control rm -rf /home/node/.claude/skills-user/chpc-bridge
```

- [ ] **Step 7: Remove the staged FASTQ directory on CHPC**

```bash
docker exec claude-bioflow-li86 bash -lc '
  ssh chpc-login "rm -rf /uufs/chpc.utah.edu/common/home/jonesk-group2/agent-omics/singlecellrnaseq/A8163_mSS_ab_input"'
```

Hard links mean removing these entries does not touch the original FASTQs. Confirm the originals survive:

```bash
docker exec claude-bioflow-li86 bash -lc '
  ssh chpc-login "ls /uufs/chpc.utah.edu/common/home/jonesk-group2/agent-omics/singlecellrnaseq/A8163_mSS/Fastq | wc -l"'
```

Expected: the original file count from Task 5 Step 3.

- [ ] **Step 8: Commit the restoration**

```bash
git add -A docs/experiments/2026-08-28-scrnaseq-ab/
git commit -m "docs(experiment): restore environment after the A/B run"
```
