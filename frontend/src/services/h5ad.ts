/**
 * h5ad viewer RPC client.
 *
 * Mirrors the contract in adapter/src/h5ad-rpc.ts:
 *   h5ad_introspect(path)         → metadata for picking what to plot
 *   h5ad_plot(path, kind, params) → { png } base64 PNG
 *
 * Plot calls can take several seconds on first load (AnnData read), then
 * cached. Pick a generous timeout.
 */

import { natsService } from './nats'

export interface ObsColumn {
  name: string
  dtype: string
  n_categories?: number
  categories?: string[]
  min?: number
  max?: number
}

export interface SpatialInfo {
  library_ids: Array<{ library_id: string; images?: string[] }>
  has_coords: boolean
}

export interface H5adIntrospection {
  shape: [number, number]
  obs_cols: ObsColumn[]
  var_names: string[]
  var_count: number
  obsm_keys: string[]
  embeddings: string[]
  spatial: SpatialInfo | null
  qc: {
    has_total_counts: boolean
    has_n_genes_by_counts: boolean
    has_pct_counts_mt: boolean
  }
  layers: string[]
}

export type PlotKind = 'qc' | 'embedding' | 'spatial'

export interface PlotResult {
  png: string  // base64-encoded PNG (no data: prefix)
}

const PLOT_TIMEOUT_MS = 180_000

export async function introspectH5ad(path: string): Promise<H5adIntrospection> {
  const res = (await natsService.invoke(
    'h5ad_introspect',
    { path },
    PLOT_TIMEOUT_MS,
  )) as Record<string, unknown> & { success: boolean }
  if (!res?.success) {
    throw new Error('h5ad_introspect failed')
  }
  return res as unknown as H5adIntrospection
}

export async function plotH5ad(
  path: string,
  kind: PlotKind,
  params: Record<string, unknown> = {},
): Promise<PlotResult> {
  const res = (await natsService.invoke(
    'h5ad_plot',
    { path, kind, params },
    PLOT_TIMEOUT_MS,
  )) as { success: boolean; png?: string }
  if (!res?.success || !res.png) {
    throw new Error('h5ad_plot failed')
  }
  return { png: res.png }
}
