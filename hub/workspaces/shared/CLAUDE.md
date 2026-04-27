# Single-cell workflow conventions

Before answering any single-cell / spatial / multiomics question, **consult the
matching `sc-*` skill first** — the canonical best-practices references for this
workspace live there. Only fall back to parametric knowledge if no skill fits.

## Skill routing

| Topic | Skill |
| --- | --- |
| Technology choice, raw data, format interop | `sc-introduction` |
| QC, doublets, normalization, HVG, PCA/UMAP | `sc-preprocessing` |
| Clustering, annotation, integration | `sc-clustering-annotation` |
| Pseudotime, RNA velocity, CellRank | `sc-trajectory` |
| Differential expression, composition, GSEA | `sc-differential-expression` |
| pySCENIC, LIANA, NicheNet, CellChat | `sc-grn-communication` |
| Bulk deconvolution (CIBERSORTx, MuSiC, DWLS) | `sc-bulk-deconvolution` |
| scATAC-seq | `sc-atac` |
| Spatial (Visium, MERFISH, Xenium) | `sc-spatial` |
| CITE-seq / ADT | `sc-cite-seq` |
| TCR/BCR repertoire | `sc-immune-repertoire` |
| Multimodal integration (MOFA+, GLUE, WNN) | `sc-multimodal` |
| Reproducibility, containers, pipelines | `sc-reproducibility` |

Invoke via `/sc-<name>` or the Skill tool.

## Code conventions

- Python: prefer scanpy + anndata; tag analysis steps with `adata.uns["step_log"]`.
- R: prefer Seurat v5 and SingleCellExperiment; use `rpy2` only at the Python/R boundary.
- Write scripts (`script.py` / `script.R`), not notebooks, for standard pipelines.
- Put figures in `results/figures/`, processed objects in `results/`.

## Jupyter kernels

Every container ships exactly TWO registered kernels. The notebook tool's
kernel bridge spawns by `metadata.kernelspec.name` — if you set a name the
container doesn't have, cell execution fails with an "unknown kernel error".

| kernelspec.name | When to use | What it provides |
| --- | --- | --- |
| `python3` | Any Python-only notebook, including PyTorch / scanpy / scSurvival / etc. | `/venv/bin/python` — Python 3.12 + scanpy + torch 2.11 (CUDA-enabled if host has nvidia-container-toolkit) + anndata |
| `ir`      | R-only notebook (Seurat, SingleCellExperiment, edgeR, limma) | `/usr/bin/R` — R 4.5.3 + IRkernel + Seurat v5 + SoupX + scDblFinder |

Rules:

- **Do not invent a new kernelspec name.** Only `python3` and `ir` exist.
  Anything else will break on first execute. `scSurvival` is a Python package,
  not a kernel — use `python3` and `import scSurvival`.
- When creating a `.ipynb`, always write `"nbformat_minor": 5` and give every
  cell a stable `id` (UUID fragment). Legacy `nbformat` 4.2 notebooks lack
  cell ids and the execute-cell RPC throws "cell not found" until reopened.
- For mixed Python+R work, write a Python notebook and use `%load_ext rpy2.ipython`
  + `%%R` cells rather than switching kernels mid-notebook.
- GPU: `torch.cuda.is_available()` is True only when the host has
  `nvidia-container-toolkit` and the container was started with `--gpus all`.
  Don't hard-require it — check and fall back to CPU gracefully.

## Installing Python packages

`/venv` is the only Python kernel — install everything into it. Do **not** run `python -m venv …` to make a project-local venv; nothing in this stack can reach it (no kernel resolves there, and adding a new kernelspec breaks notebooks per the rule above).

Recipes:

- **PyPI package:** `/venv/bin/pip install <pkg>`
- **Editable install of a local repo (live-edit source):** `/venv/bin/pip install -e /workspace/local_projects/<name>/repo`
- **R package for the `ir` kernel:** `R -e 'install.packages("<pkg>")'`

`/venv` is chowned to `node` at container start, so installs persist in the container's overlay across restarts (lost only on container recreate). Editable installs leave a `.pth` in `/venv` and keep sources in the project tree, so edits are picked up without reinstall.

**Past mistake — don't repeat:** an agent ran `python -m venv local_projects/<pkg>/venv` to "isolate" a package, then `pip install -e .` into it, then *also* into `/venv` to make notebooks see the import. The local venv was orphan dead weight — no kernel pointed at it. If `/venv` pins genuinely conflict, surface the conflict and discuss bumping the pin instead of silently forking a venv.
