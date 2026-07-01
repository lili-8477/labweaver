---
name: chpc-bridge
description: Use when running commands, submitting SLURM jobs, transferring files, or dispatching any task to the University of Utah CHPC cluster from claude-bioflow. Triggers on mentions of CHPC, notchpeak, kingspeak, `/uufs/chpc.utah.edu/`, SLURM, sbatch, `chpc-login`, or any "run on CHPC / submit to CHPC / get this file off CHPC" request.
---

# CHPC Bridge

Bridge between the claude-bioflow agent container and the University of Utah
CHPC cluster. One persistent multiplexed SSH connection, every remote action
goes through it.

## Core principle

**One master SSH connection, opened once interactively by the user, reused
silently by the agent for every subsequent command.**

Each `ssh chpc-login "<cmd>"` call piggybacks on the master socket — no TCP
handshake, no re-auth, no Duo prompt per command. Forgetting this is the
single biggest cause of stalls and per-step Duo pushes.

---

## 1. Architecture (read this first)

In claude-bioflow, the agent runs **inside a container** (typical name
`claude-bioflow-<workspace>`, e.g. `claude-bioflow-li86`) as user `node`,
`HOME=/home/node`. The container is the SSH client; CHPC is the server.

```
+----------------------+         +-------------------------+
|  host (your laptop)  |         | adapter container       |
|                      |         |  user: node             |
|  docker exec -it ... | <-----> |  HOME=/home/node        |
|  (you, interactive)  |         |  /home/node/.ssh/       |
|                      |         |  /home/node/.ssh/cm-... | <--- master socket
+----------------------+         +-----------+-------------+
                                             |
                                             | ssh chpc-login "..."
                                             v
                                  +--------------------------+
                                  | notchpeak.chpc.utah.edu  |
                                  +--------------------------+
```

Implications:
- The **host's** `~/.ssh/config` is irrelevant — the container has its own.
- All paths the agent uses for `ssh` / `scp` / `rsync` are from the
  container's POV.
- The master must be opened from a **host TTY** (`docker exec -it ...`)
  because CHPC requires Duo MFA. The agent (this tool) has no TTY and
  cannot do this part.
- Once the master is up, the agent and the user share it via the socket
  file in `/home/node/.ssh/`.

---

## 2. Is the bridge live? — start every session with this

Before any CHPC work, check the master:

```bash
ssh -O check chpc-login
```

| Output | Meaning | Next step |
| --- | --- | --- |
| `Master running (pid=…)` | Bridge live | Use freely. |
| `Control socket connect(...): No such file or directory` | Master not up | Ask the user to open it (§4). |
| `ssh: command not found` | Container never provisioned | Run §3 once. |
| `Could not resolve hostname …` | Config missing or wrong alias | Run §3 step 3b. |

---

## 3. One-time provisioning (skip if `ssh -O check` already works)

Most sessions can skip this. Only run when the container is freshly built
or `ssh` is missing.

### 3a. Install client tools (needs root inside container)

The agent runs as `node` (no sudo). The user must run these from the host:

```bash
# From the host
docker exec -u root <container-name> apt-get update -qq
docker exec -u root <container-name> apt-get install -y -qq openssh-client rsync
```

Container name for the active workspace is visible via `docker ps`
(e.g. `claude-bioflow-li86`).

### 3b. Create `.ssh` dir and config (agent can do this, runs as `node`)

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh

cat > ~/.ssh/config <<'EOF'
Host chpc-login
    HostName notchpeak.chpc.utah.edu
    User <UNID>
    ControlMaster auto
    ControlPath ~/.ssh/cm-%r@%h:%p
    ControlPersist 8h
    ServerAliveInterval 60
    ServerAliveCountMax 3
EOF

chmod 600 ~/.ssh/config
```

Replace `<UNID>` with the user's CHPC username. **Ask the user if you don't
know it** — do not invent one.

### 3c. Verify reachability

```bash
getent hosts notchpeak.chpc.utah.edu
timeout 5 bash -c '</dev/tcp/notchpeak.chpc.utah.edu/22' && echo TCP_OK
```

If `TCP_OK` doesn't print: the user is off-campus and needs U of U VPN, or
the container's network egress is restricted.

---

## 4. Opening the master — user-only step

Only the user can authenticate (CHPC password + Duo MFA); the agent has no
TTY for a Duo push or passcode entry.

**Primary path (preferred):** the bioFlow UI has a **CHPC pill** in the top
bar (right of the connection badge). The user clicks it, enters their CHPC
password, picks Duo push or paste a passcode, and approves on their phone.
Pill flips to green `CHPC · <UNID>` once the master is up. **Do not suggest
the docker exec command below as a primary path — the UI is the supported
flow.**

After the pill is green, the agent verifies:

```bash
ssh -O check chpc-login          # "Master running (pid=…)"
ssh chpc-login 'hostname && whoami'
```

**Closing:** the pill on an up bridge uses a two-step "click to arm, click
again within 3 s to disconnect" pattern — a single accidental click does
NOT drop the connection. Don't run `ssh -O exit` reflexively just because
something looks stuck; the agent does not need to close the bridge between
commands. Let `ControlPersist 8h` expire it, or have the user click the
pill twice to disconnect manually.

**Fallback (headless / no UI available):** the same effect can be achieved
from a host terminal with `docker exec -it <container-name> ssh -NMf
chpc-login`. Only suggest this if the user explicitly cannot use the UI
(e.g. running pure CLI Claude Code outside the bioFlow container).

---

## 5. Dispatching work — three patterns

All commands below run **from inside the container** (i.e. from the agent's
shell). No `docker exec` prefix needed.

### Pattern A: Run a remote command

```bash
ssh chpc-login 'hostname && squeue -u $USER'
```

- Single-quote the remote payload to keep variable expansion on the remote.
- If you need local expansion mixed in, switch to double quotes and escape
  remote-side variables as `\$VAR`.

### Pattern B: Write a file on the remote (heredoc)

For SLURM scripts, configs, anything multi-line:

```bash
cat << 'EOF' | ssh chpc-login 'cat > /uufs/chpc.utah.edu/common/home/<group>/job.slurm'
#!/bin/bash
#SBATCH --job-name=demo
#SBATCH --account=notchpeak-shared-short
#SBATCH --partition=notchpeak-shared-short
#SBATCH --time=00:10:00
echo "hello from $(hostname)"
EOF
```

The quoted delimiter `'EOF'` disables **local** expansion, so `$(hostname)`
runs on the remote. Use unquoted `EOF` only when you want the local shell to
interpolate variables before transfer — pick deliberately.

### Pattern C: Transfer files

`scp` and `rsync` reuse the multiplexed master automatically (same Host
alias, same ControlPath).

```bash
# Pull a result file into the host-visible workspace
scp chpc-login:/uufs/chpc.utah.edu/common/home/<group>/results/x.tsv \
    /workspace/local_projects/<project>/results/

# Push a local directory up (recursive, preserve perms, progress)
rsync -avP /workspace/local_projects/<project>/scripts/ \
    chpc-login:/uufs/chpc.utah.edu/common/home/<group>/agent-omics/<project>/scripts/
```

**Land downloads in `/workspace/local_projects/<project>/`** — that path is
the only bidirectional bridge to the host, so the user can see the files
without `docker cp`. Anywhere else in the container is overlay-only.

---

## 6. SLURM dispatch idiom

### jonesk lab allocation (default for this workspace)

For all production and GPU jobs in the Jones lab, use:

```
#SBATCH --account=jonesk-gpu-np
#SBATCH --partition=jonesk-gpu-np
#SBATCH --gres=gpu
#SBATCH --time=24:00:00
#SBATCH --cpus-per-task=12
#SBATCH --mem=96G
```

### Conda environment routing

**Always use the correct env for the language — do not mix.**

| Task | Env | What it provides |
|---|---|---|
| R scripts (Seurat, DESeq2, edgeR) | `R_env` | R 4.5.1 · Seurat 5.5.0 · dplyr · ggplot2 |
| Python scripts (scanpy, scVI, scANVI, PyTorch) | `scvi-env` | Python · scanpy 1.10.1 · scvi-tools 1.1.2 · anndata 0.10.7 |

Source conda before activating in any SLURM script:

```bash
source /uufs/chpc.utah.edu/common/home/u6025146/software/pkg/miniconda3/etc/profile.d/conda.sh
conda activate R_env       # for R scripts
# or
conda activate scvi-env    # for Python / scvi-tools scripts
```

Never activate `R_env` for Python work or `scvi-env` for R work — the envs are not interchangeable.

### jonesk GPU job template

```bash
cat << 'SLURM_EOF' | ssh chpc-login 'cat > /uufs/chpc.utah.edu/common/home/jonesk-group2/agent-omics/<project>/<name>.slurm'
#!/bin/bash
#SBATCH --job-name=<name>
#SBATCH --account=jonesk-gpu-np
#SBATCH --partition=jonesk-gpu-np
#SBATCH --gres=gpu
#SBATCH --time=24:00:00
#SBATCH --cpus-per-task=12
#SBATCH --mem=96G
#SBATCH --output=/uufs/chpc.utah.edu/common/home/jonesk-group2/agent-omics/<project>/logs/%x_%j.out
#SBATCH --error=/uufs/chpc.utah.edu/common/home/jonesk-group2/agent-omics/<project>/logs/%x_%j.err

set -euo pipefail
source /uufs/chpc.utah.edu/common/home/u6025146/software/pkg/miniconda3/etc/profile.d/conda.sh
conda activate R_env

cd /uufs/chpc.utah.edu/common/home/jonesk-group2/agent-omics/<project>

# --- workload ---
echo "host=$(hostname) job=$SLURM_JOB_ID gpu=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null || echo none)"
Rscript <script>.R
SLURM_EOF
```

### Short / CPU-only job (notchpeak-shared-short)

For lightweight tasks that don't need a GPU:

```bash
#SBATCH --account=notchpeak-shared-short
#SBATCH --partition=notchpeak-shared-short
#SBATCH --time=2:00:00
#SBATCH --cpus-per-task=8
#SBATCH --mem=16G
```

### Submit + capture job ID

```bash
JOBID=$(ssh chpc-login 'sbatch --parsable /uufs/chpc.utah.edu/common/home/jonesk-group2/agent-omics/<project>/<name>.slurm')
echo "Submitted $JOBID"
```

`--parsable` makes `sbatch` print only the numeric job ID — clean for
scripting.

### Monitor

```bash
ssh chpc-login "squeue -j $JOBID -o '%i %T %M %R'"
ssh chpc-login "sacct -j $JOBID --format=JobID,State,Elapsed,MaxRSS,ExitCode"
ssh chpc-login "tail -n 50 /uufs/chpc.utah.edu/common/home/jonesk-group2/agent-omics/<project>/logs/<name>_${JOBID}.out"
```

### Cancel

```bash
ssh chpc-login "scancel $JOBID"
```

---

## 7. Workspace conventions

- **Group storage root** (default for this workspace):
  `/uufs/chpc.utah.edu/common/home/jonesk-group2/agent-omics/`
  Subfolders by analysis type: `rnaseq/`, `chipseq/`, `cutandtag/`,
  `singlecellrnaseq/`, …
- **Scratch** (large, ephemeral, fast):
  `/scratch/general/nfs1/$USER/` or `/scratch/general/vast/$USER/` — use
  for intermediates that don't need to survive 60 days.
- **Logs**: always write a per-project `logs/` dir and direct `--output` /
  `--error` there. Don't pollute the home root with `slurm-<jobid>.out`.
- **Local artifact landing zone**: `/workspace/local_projects/<project>/`
  (host-visible). Send all CHPC pulls here.
- Make raw inputs read-only after staging:
  `ssh chpc-login "chmod -R a-w <path>/Fastq"`.

---

## 8. Persistence — what survives container lifecycle

Provisioning done via `docker exec` (apt install, `/home/node/.ssh`) lives
in the container's **overlay filesystem**:

| Event | Survives? |
| --- | --- |
| Process restart inside container | Yes |
| `docker restart <container>` | Yes |
| `docker compose down && up` (recreates) | **No — wiped** |
| Image rebuild | **No — wiped** |

For permanence, the user should:
1. Add `openssh-client rsync` to the relevant Dockerfile (`image/Dockerfile`).
2. Add a bind mount in compose:
   `- ./hub/workspaces/<workspace>/.ssh:/home/node/.ssh`
3. Move `~/.ssh/config` into `hub/workspaces/<workspace>/.ssh/config` on
   the host.

If `ssh -O check chpc-login` returns "command not found" or "No such file",
provisioning was wiped — re-run §3 and ask the user to re-open the master.

---

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `ssh: command not found` (inside container) | apt install was wiped (container recreated) | Re-run §3a as root via host. |
| `ssh: connect to host …: Connection refused` / timeout | Off-campus, no VPN, or container network blocked | User connects to U of U VPN; verify with `timeout 5 bash -c '</dev/tcp/notchpeak.chpc.utah.edu/22'`. |
| Every command re-prompts for Duo / password | Master not running | Ask user to click the CHPC pill in the UI (§4). |
| `Control socket connect(...): No such file or directory` | Stale `ControlPath` from a killed master | Ask user to click the CHPC pill — the auth flow opens a fresh master. Headless fallback: `docker exec claude-bioflow-<ws> ssh -O exit chpc-login 2>/dev/null; docker exec -it claude-bioflow-<ws> ssh -NMf chpc-login`. |
| `mux_client_request_session: read from master failed: Broken pipe` | Master died mid-session | Same as above. |
| `Permission denied (publickey,password)` on master open | Wrong UNID in config, or expired CHPC password | Verify UNID in `~/.ssh/config`; user logs into chpc.utah.edu portal to reset password if needed. |
| `bash: $VAR: unbound variable` on remote | Forgot to escape; local shell ate the variable | Single-quote the remote payload, or use `\$VAR` in double quotes. |
| Heredoc loses `$()` output unexpectedly | Quoted `'EOF'` vs unquoted `EOF` mismatch with intent | Quoted → no local expansion; unquoted → local expansion. Pick deliberately. |
| `sbatch: error: Invalid account` | Wrong `--account` for this user | `ssh chpc-login 'sacctmgr show assoc user=$USER format=Account,Partition'` to list valid pairs. |
| Job stuck in `PD` with `(QOSMaxJobsPerUserLimit)` | Hit short-queue cap | Wait, or switch to a standard allocation. |
| `scp`/`rsync` re-prompts despite master up | Used raw hostname instead of `chpc-login` alias | Always use the alias so multiplex applies. |
| Downloaded file invisible to host | Landed in container overlay, not in a mounted dir | Re-pull into `/workspace/local_projects/<project>/`. |

---

## 10. What this skill does *not* cover

- Downloading data from HCI GnoMEx (FDT, ORA decompression) — separate
  `hci-data-prep` skill.
- Loading specific software modules (`module load …`) — defer to analysis
  skills (`single-cell`, `chip-seq`, `differential-expression`, …) that
  know what they need.
- Long-running interactive sessions (`salloc`) — this skill is for
  fire-and-forget batch dispatch and ad-hoc remote commands.
- Making `.ssh` persist across container recreation — see §8 for the
  Dockerfile + compose changes that solve this permanently.
