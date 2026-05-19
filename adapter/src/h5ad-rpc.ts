// h5ad.* RPCs — single-cell / spatial AnnData viewer backend.
//
// One dedicated KernelBridge session per adapter (separate from notebook
// kernels). AnnData objects are cached in the Python session by absolute
// path + mtime, so a series of plot calls against the same file doesn't
// re-read the HDF5 file every time.
//
// All plots are rendered via scanpy / squidpy as PNG bytes and shipped to
// the frontend as base64. PNG over JSON is a deliberate v1 trade-off:
// reuses mature plotting (correct legends, colorbars, spatial alignment)
// at the cost of per-point interactivity.

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { KernelBridge } from "./kernel.js";

export type H5adKernelFactory = (sessionId: string) => KernelBridge;

/** Python helper sent once per fresh kernel — defines the cache + plot helpers. */
const PY_HELPERS = `
import os, json, base64, io, traceback
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import scanpy as sc
import numpy as np

sc.settings.verbosity = 0
sc.settings.set_figure_params(dpi=100, facecolor="white")

# path -> (mtime_ns, AnnData)
_AD_CACHE: dict = {}

# Per-call output path. Set by the calling cell before each helper call so
# results land in a known file — we deliberately avoid print() because the
# kernel-bridge iopub/shell channels race on large stream messages and
# late chunks can lose their cell_id tagging.
_H5AD_OUT_PATH: str = ""

def _load(path: str):
    st = os.stat(path)
    cached = _AD_CACHE.get(path)
    if cached and cached[0] == st.st_mtime_ns:
        return cached[1]
    ad = sc.read_h5ad(path)
    _AD_CACHE[path] = (st.st_mtime_ns, ad)
    return ad

def _fig_to_b64(fig=None, *, max_w_px: int = 1400) -> str:
    if fig is None:
        fig = plt.gcf()
    # Cap output width so we don't ship 4MB PNGs.
    w_in, h_in = fig.get_size_inches()
    target_dpi = min(150, int(max_w_px / max(w_in, 0.1)))
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=target_dpi, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    return base64.b64encode(buf.getvalue()).decode("ascii")

def _emit(obj):
    if not _H5AD_OUT_PATH:
        raise RuntimeError("_H5AD_OUT_PATH not set before helper call")
    tmp = _H5AD_OUT_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, default=str)
    os.replace(tmp, _H5AD_OUT_PATH)

def h5ad_introspect(path: str):
    ad = _load(path)
    obs = ad.obs
    # Categorical columns get unique values; numeric columns get summary stats.
    obs_cols = []
    for name in obs.columns:
        col = obs[name]
        dtype = str(col.dtype)
        if hasattr(col, "cat"):
            cats = list(map(str, col.cat.categories[:200]))
            obs_cols.append({"name": name, "dtype": "categorical", "n_categories": len(col.cat.categories), "categories": cats})
        elif np.issubdtype(col.dtype, np.number):
            try:
                lo = float(np.nanmin(col.values))
                hi = float(np.nanmax(col.values))
            except Exception:
                lo, hi = None, None
            obs_cols.append({"name": name, "dtype": "numeric", "min": lo, "max": hi})
        else:
            obs_cols.append({"name": name, "dtype": dtype})

    # var index = gene names. Send full list for prefix search; clamp to 50k.
    var_names = [str(x) for x in ad.var_names[:50000]]

    obsm_keys = sorted([str(k) for k in ad.obsm.keys()])
    embeddings = [k for k in obsm_keys if k.startswith("X_")]

    # Spatial detection — both .uns['spatial'] (scanpy convention) and
    # obsm['spatial'] (coords). Library IDs come from uns.
    spatial_info = None
    if "spatial" in ad.uns and isinstance(ad.uns["spatial"], dict):
        libs = []
        for lib_id, lib_dict in ad.uns["spatial"].items():
            entry = {"library_id": str(lib_id)}
            if isinstance(lib_dict, dict):
                images = lib_dict.get("images")
                if isinstance(images, dict):
                    entry["images"] = sorted(list(images.keys()))
            libs.append(entry)
        spatial_info = {"library_ids": libs, "has_coords": "spatial" in ad.obsm}
    elif "spatial" in ad.obsm:
        spatial_info = {"library_ids": [], "has_coords": True}

    qc_hints = {
        "has_total_counts": "total_counts" in obs.columns,
        "has_n_genes_by_counts": "n_genes_by_counts" in obs.columns,
        "has_pct_counts_mt": "pct_counts_mt" in obs.columns,
    }

    _emit({
        "ok": True,
        "shape": list(ad.shape),
        "obs_cols": obs_cols,
        "var_names": var_names,
        "var_count": int(ad.n_vars),
        "obsm_keys": obsm_keys,
        "embeddings": embeddings,
        "spatial": spatial_info,
        "qc": qc_hints,
        "layers": sorted([str(k) for k in ad.layers.keys()]),
    })

def h5ad_qc(path: str):
    ad = _load(path)
    # Compute QC metrics on the fly if missing. Don't mutate the cached
    # object's .var (only .obs gets new columns), so re-running is cheap.
    needed = {"total_counts", "n_genes_by_counts"}
    if not needed.issubset(ad.obs.columns):
        # mt prefix is a reasonable default; if no mt genes, scanpy just
        # gives pct_counts_mt = 0.
        ad.var["mt"] = ad.var_names.str.upper().str.startswith("MT-") | ad.var_names.str.upper().str.startswith("MT.")
        sc.pp.calculate_qc_metrics(ad, qc_vars=["mt"], percent_top=None, log1p=False, inplace=True)

    cols = ["n_genes_by_counts", "total_counts"]
    if "pct_counts_mt" in ad.obs.columns:
        cols.append("pct_counts_mt")

    fig, axes = plt.subplots(1, len(cols) + 1, figsize=(4.5 * (len(cols) + 1), 4))
    for ax, key in zip(axes[:len(cols)], cols):
        sc.pl.violin(ad, key, jitter=0.4, ax=ax, show=False)
        ax.set_title(key)
    sc.pl.scatter(ad, x="total_counts", y="n_genes_by_counts",
                  color="pct_counts_mt" if "pct_counts_mt" in ad.obs.columns else None,
                  ax=axes[-1], show=False)
    axes[-1].set_title("counts vs genes")
    fig.tight_layout()
    _emit({"ok": True, "png": _fig_to_b64(fig)})

def h5ad_embedding(path: str, basis: str = "X_umap", color: str = None, point_size: float = None):
    ad = _load(path)
    basis = basis or "X_umap"
    if basis not in ad.obsm:
        raise ValueError(f"basis '{basis}' not found in obsm; available: {list(ad.obsm.keys())}")
    sc_basis = basis[2:] if basis.startswith("X_") else basis
    kwargs = {"basis": sc_basis, "show": False, "frameon": True}
    if color:
        kwargs["color"] = color
    if point_size is not None:
        kwargs["size"] = float(point_size)
    fig = sc.pl.embedding(ad, return_fig=True, **kwargs)
    _emit({"ok": True, "png": _fig_to_b64(fig)})

def h5ad_spatial(path: str, color: str = None, library_id: str = None,
                 img_alpha: float = 1.0, spot_size: float = None,
                 show_image: bool = True):
    ad = _load(path)
    kwargs = {"show": False, "frameon": True}
    if color:
        kwargs["color"] = color
    if library_id:
        kwargs["library_id"] = library_id
    if spot_size is not None:
        kwargs["size"] = float(spot_size)
    if not show_image:
        kwargs["img_key"] = None
    else:
        kwargs["alpha_img"] = float(img_alpha)
    fig = sc.pl.spatial(ad, return_fig=True, **kwargs)
    _emit({"ok": True, "png": _fig_to_b64(fig)})
`;

interface H5adServiceDeps {
  serviceId: string;
  workspaceRoot: string;
  kernelFactory: H5adKernelFactory;
}

export class H5adService {
  private kernel: KernelBridge | null = null;
  private helpersInstalled = false;

  constructor(private deps: H5adServiceDeps) {}

  private sessionId(): string {
    // Stable per-adapter session id so re-introspect calls hit the same
    // Python process (and therefore the AnnData cache).
    return `h5ad_${this.deps.serviceId.slice(0, 12)}`;
  }

  private ensureKernel(): KernelBridge {
    if (this.kernel) return this.kernel;
    this.kernel = this.deps.kernelFactory(this.sessionId());
    return this.kernel;
  }

  private resolve(relPath: string): string {
    const normalized = path.normalize(relPath).replace(/^(\.\.[/\\])+/, "");
    const abs = path.resolve(this.deps.workspaceRoot, normalized);
    if (!abs.startsWith(this.deps.workspaceRoot)) {
      throw new Error("path escapes workspace");
    }
    return abs;
  }

  private async installHelpers(): Promise<void> {
    if (this.helpersInstalled) return;
    const k = this.ensureKernel();
    const cellId = `h5ad_install_${createHash("sha256").update(PY_HELPERS).digest("hex").slice(0, 8)}`;
    const { reply } = await k.executeAndCollect(cellId, PY_HELPERS);
    if (reply.status !== "ok") {
      throw new Error(`h5ad helper install failed: ${reply.error ?? "unknown"}`);
    }
    this.helpersInstalled = true;
  }

  /**
   * Run a Python expression that calls one of the `h5ad_*` helpers and writes
   * its result to a temp file. We then read & delete the file. Going through
   * a file (vs print → kernel iopub stream) avoids the bridge's
   * shell/iopub channel race on large outputs — for big var_names lists
   * (>10k genes) the final stream chunks can arrive after execute_reply
   * and silently disappear.
   */
  private async runCall(callPython: string): Promise<Record<string, unknown>> {
    await this.installHelpers();
    const k = this.ensureKernel();
    const outPath = path.join(os.tmpdir(), `h5ad_${randomUUID()}.json`);
    const code = `_H5AD_OUT_PATH = ${JSON.stringify(outPath)}\n${callPython}\n`;
    const cellId = `h5ad_${createHash("sha256").update(callPython + ":" + Date.now()).digest("hex").slice(0, 12)}`;
    const { reply } = await k.executeAndCollect(cellId, code);
    if (reply.status !== "ok") {
      throw new Error(`h5ad call failed: ${reply.error ?? "unknown"}`);
    }
    let raw: string;
    try {
      raw = await fs.readFile(outPath, "utf8");
    } catch (e) {
      throw new Error(`h5ad result file missing: ${(e as Error).message}`);
    } finally {
      fs.unlink(outPath).catch(() => undefined);
    }
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch (e) {
      throw new Error(`h5ad result JSON parse failed: ${(e as Error).message}; raw=${raw.slice(0, 400)}`);
    }
  }

  async introspect(relPath: string): Promise<Record<string, unknown>> {
    const abs = this.resolve(relPath);
    const code = `h5ad_introspect(${JSON.stringify(abs)})`;
    return this.runCall(code);
  }

  async plot(
    relPath: string,
    kind: "qc" | "embedding" | "spatial",
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const abs = this.resolve(relPath);
    let code: string;
    if (kind === "qc") {
      code = `h5ad_qc(${JSON.stringify(abs)})`;
    } else if (kind === "embedding") {
      const basis = (params.basis as string) ?? "X_umap";
      const color = params.color != null ? JSON.stringify(String(params.color)) : "None";
      const size = params.point_size != null ? Number(params.point_size) : null;
      code = `h5ad_embedding(${JSON.stringify(abs)}, basis=${JSON.stringify(basis)}, color=${color}, point_size=${size === null ? "None" : size})`;
    } else if (kind === "spatial") {
      const color = params.color != null ? JSON.stringify(String(params.color)) : "None";
      const libId = params.library_id != null ? JSON.stringify(String(params.library_id)) : "None";
      const imgAlpha = params.img_alpha != null ? Number(params.img_alpha) : 1.0;
      const spot = params.spot_size != null ? Number(params.spot_size) : null;
      const showImg = params.show_image === false ? "False" : "True";
      code = `h5ad_spatial(${JSON.stringify(abs)}, color=${color}, library_id=${libId}, img_alpha=${imgAlpha}, spot_size=${spot === null ? "None" : spot}, show_image=${showImg})`;
    } else {
      throw new Error(`unknown plot kind: ${kind}`);
    }
    return this.runCall(code);
  }

  shutdown(): void {
    if (this.kernel) {
      this.kernel.shutdown();
      this.kernel = null;
      this.helpersInstalled = false;
    }
  }
}
