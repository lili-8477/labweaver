// GET /archive?path=<rel>&path=<rel>[&name=<zip name>]: the Files panel's
// folder and multi-file download, as one zip streamed to the browser (nginx
// proxies /archive here, like /upload/). Each path is checked like a file
// read (fs-rpc.ts isHidden); folders are walked here so secrets at any depth
// and symlinks are left out. Python's zipfile writes the zip: it streams to a
// pipe and handles ZIP64, so a folder of large data files works.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";
import { isHidden } from "./fs-rpc.js";

/** The absolute path of a workspace-relative path a read may use, or throw. */
function readPath(root: string, rel: string): string {
  if (path.isAbsolute(rel)) throw new Error(`path must be workspace-relative: ${rel}`);
  const segs = rel.split("/").filter((s) => s !== "" && s !== ".");
  if (segs.includes("..")) throw new Error(`path must not contain "..": ${rel}`);
  if (segs.some(isHidden)) throw new Error(`access denied for secret path: ${rel}`);
  return path.join(root, ...segs);
}

// Reads "<absolute path>\t<name in the zip>" lines; already-compressed and
// large files are stored, the rest deflated at a fast level.
const ZIP_PY = String.raw`
import os, sys, zipfile
STORED = {".gz", ".zip", ".bz2", ".xz", ".zst", ".bam", ".cram", ".h5ad", ".h5", ".loom", ".parquet",
          ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".mp4", ".pdf"}
with zipfile.ZipFile(sys.stdout.buffer, "w", zipfile.ZIP_DEFLATED, compresslevel=1, allowZip64=True) as z:
    for line in sys.stdin:
        src, arc = line.rstrip("\n").split("\t", 1)
        big = os.path.getsize(src) > 64 * 1024 * 1024
        z.write(src, arc, zipfile.ZIP_STORED if big or os.path.splitext(src)[1].lower() in STORED else zipfile.ZIP_DEFLATED)
`;

/** Every regular file under `abs` (or `abs` itself), skipping secrets and symlinks. */
async function filesUnder(abs: string): Promise<string[]> {
  const st = await fs.lstat(abs);
  if (st.isSymbolicLink()) return [];
  if (st.isFile()) return [abs];
  if (!st.isDirectory()) return [];
  const out: string[] = [];
  for (const e of (await fs.readdir(abs, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (isHidden(e.name) || e.isSymbolicLink()) continue;
    out.push(...await filesUnder(path.join(abs, e.name)));
  }
  return out;
}

const send = (res: ServerResponse, status: number, error: string) => {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ error }));
};

export async function handleArchive(req: IncomingMessage, res: ServerResponse, workspaceRoot: string): Promise<void> {
  const url = new URL(req.url ?? "/", "http://x");
  const rels = url.searchParams.getAll("path");
  if (rels.length === 0) return send(res, 400, "path required");

  const pairs: string[] = [];
  for (const rel of rels) {
    let abs: string;
    try {
      abs = readPath(workspaceRoot, rel);
    } catch (e) {
      return send(res, 403, (e as Error).message);
    }
    if (!(await fs.lstat(abs).catch(() => null))) return send(res, 404, `not found: ${rel}`);
    // Names in the zip start at the selected item: "p/sub/b.txt" for folder p.
    const parent = path.dirname(abs);
    for (const f of await filesUnder(abs)) pairs.push(`${f}\t${path.relative(parent, f)}`);
  }

  const name = (url.searchParams.get("name") ?? (rels.length === 1 ? path.basename(rels[0]!) : "files"))
    .replace(/[^\w.-]+/g, "_") || "files";
  res.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="${name}.zip"`,
    "Cache-Control": "no-store",
  });
  const py = spawn("python3", ["-c", ZIP_PY], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  py.stderr.on("data", (d) => { stderr = (stderr + d).slice(-1000); });
  py.stdout.pipe(res);
  // A closed tab stops the zip instead of finishing it for nobody.
  res.on("close", () => { if (!res.writableFinished) py.kill(); });
  py.on("close", (code) => {
    if (code !== 0 && !res.destroyed) {
      console.warn(`[archive] zip failed (${code}): ${stderr.trim()}`);
      res.destroy();
    }
  });
  py.stdin.end(pairs.length ? `${pairs.join("\n")}\n` : "");
}
