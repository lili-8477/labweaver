#!/usr/bin/env python3
"""Memory builder, parse step (docs/superpowers/specs/2026-11-09-memory-builder-plugin-design.md).

The adapter runs this inside the member's container, where the files and the
parsers are. It never writes anything: it reads a file or folder under the
workspace and prints what it found.

    memory-builder.py scan  <workspace> <path>   -> one JSON object: files and an estimate
    memory-builder.py parse <workspace> <path> [--tables per_row|per_table]
                                                 -> JSON lines, one item each:
        {"type": "entry", ...}     a table row (or table), already categorised
        {"type": "document", ...}  a document's text, for the adapter's model step
        {"type": "skipped", ...}   a file left out, and why

<path> is relative to <workspace>. Content is data: nothing here executes it.
"""
import argparse
import csv
import hashlib
import json
import os
import re
import sys
import zipfile

MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_FILES = 500
MAX_ROWS = 5000
MAX_DOC_CHARS = 60_000
NAME_MAX, DESC_MAX, BODY_MAX = 80, 200, 1500

TABLES = {".csv", ".tsv", ".xlsx"}
DOCUMENTS = {".pdf", ".docx", ".md", ".txt", ".rst", ".html", ".htm",
             ".py", ".r", ".sh", ".nf", ".smk", ".wdl", ".ipynb"}
SKIP_DIRS = {"node_modules", "__pycache__", "venv"}

# Header names (lower-case, non-alphanumerics as _) that mark a table's category.
DATA_RECORD_COLS = {"order_id", "order", "order_no", "order_number", "sample_id", "library", "library_id",
                    "run_id", "flowcell", "lane", "barcode", "fastq"}
INVENTORY_COLS = {"reagent", "catalog", "catalog_number", "cat_no", "lot", "lot_number", "vendor", "supplier",
                  "quantity", "qty", "stock", "location", "freezer", "box", "strain", "mouse_line",
                  "genotype", "expiry", "expiration"}
# Columns copied into facets, by facet key.
FACET_COLS = {
    "order_id": {"order_id", "order", "order_no", "order_number"},
    "sample": {"sample", "sample_id"},
    "cell_line": {"cell_line"},
    "reagent": {"reagent"},
    "gene": {"gene"},
    "dataset": {"dataset"},
    "tool": {"tool"},
    "pipeline": {"pipeline"},
    "run_id": {"run_id", "run"},
    "species": {"species", "organism"},
}
# Columns that name a row, in order of preference.
NAME_COLS = ["order_id", "order", "order_no", "order_number", "sample_id", "sample", "name", "reagent",
             "strain", "mouse_line", "cell_line", "catalog", "id"]


def norm(header):
    return re.sub(r"[^a-z0-9]+", "_", str(header).strip().lower()).strip("_")


def clip(text, n):
    text = text.strip()
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


class BuildError(Exception):
    pass


def resolve(workspace, rel):
    root = os.path.realpath(workspace)
    path = os.path.realpath(os.path.join(root, rel))
    if path != root and not path.startswith(root + os.sep):
        raise BuildError(f"{rel} is outside the workspace")
    if not os.path.exists(path):
        raise BuildError(f"{rel} does not exist")
    return root, path


def walk(root, path):
    """Yield (relative path, absolute path, action, kind, reason) for each file."""
    if os.path.isfile(path):
        candidates = [path]
    else:
        candidates = []
        for dirpath, dirnames, filenames in os.walk(path):
            dirnames[:] = sorted(d for d in dirnames if not d.startswith(".") and d not in SKIP_DIRS)
            candidates.extend(os.path.join(dirpath, f) for f in sorted(filenames) if not f.startswith("."))
    for i, abs_path in enumerate(candidates):
        rel = os.path.relpath(abs_path, root)
        ext = os.path.splitext(abs_path)[1].lower()
        kind = "table" if ext in TABLES else "document" if ext in DOCUMENTS else None
        if os.path.islink(abs_path):
            yield rel, abs_path, "skip", kind, "symbolic link"
        elif i >= MAX_FILES:
            yield rel, abs_path, "skip", kind, f"over the {MAX_FILES}-file limit"
        elif kind is None:
            yield rel, abs_path, "skip", None, "not a document or table (binary or data file)"
        elif os.path.getsize(abs_path) > MAX_FILE_BYTES:
            yield rel, abs_path, "skip", kind, "larger than 20 MB"
        else:
            yield rel, abs_path, "parse", kind, None


# ─── tables ──────────────────────────────────────────────────────────────

def read_tables(path):
    """[(sheet name or None, header, rows)] with cells as stripped strings."""
    ext = os.path.splitext(path)[1].lower()
    if ext == ".xlsx":
        import openpyxl
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        out = []
        for ws in wb.worksheets:
            rows = [["" if c is None else str(c).strip() for c in r] for r in ws.iter_rows(values_only=True)]
            rows = [r for r in rows if any(r)]
            if rows:
                out.append((ws.title, rows[0], rows[1:]))
        return out
    with open(path, newline="", encoding="utf-8-sig", errors="replace") as f:
        rows = [[c.strip() for c in r] for r in csv.reader(f, delimiter="\t" if ext == ".tsv" else ",")]
    rows = [r for r in rows if any(r)]
    return [(None, rows[0], rows[1:])] if rows else []


def table_category(cols):
    data, inv = len(cols & DATA_RECORD_COLS), len(cols & INVENTORY_COLS)
    if data == 0 and inv == 0:
        return "reference"
    return "data_record" if data >= inv else "inventory"


def row_facets(header_keys, row):
    facets = {}
    for key, cols in FACET_COLS.items():
        vals = [row[i] for i, h in enumerate(header_keys) if h in cols and i < len(row) and row[i]]
        if vals:
            facets[key] = [clip(v, 200) for v in vals]
    return facets


def table_entries(rel, abs_path, digest, per_table):
    for sheet, header, rows in read_tables(abs_path):
        keys = [norm(h) for h in header]
        category = table_category(set(keys))
        where = f"{os.path.basename(rel)}" + (f" ({sheet})" if sheet else "")
        rows = [r for r in rows if any(r)][:MAX_ROWS]
        base = {"type": "entry", "category": category, "origin": rel, "origin_sha256": digest}
        if per_table:
            lines = ["\t".join(header)] + ["\t".join(r) for r in rows]
            yield {**base, "name": clip(where, NAME_MAX),
                   "description": clip(f"Table {where}: {len(rows)} rows; columns {', '.join(header)}", DESC_MAX),
                   "body": clip("\n".join(lines), BODY_MAX), "facets": {}}
            continue
        name_col = next((keys.index(c) for c in NAME_COLS if c in keys), None)
        for n, row in enumerate(rows, start=1):
            pairs = [(header[i], v) for i, v in enumerate(row) if v and i < len(header)]
            name = row[name_col] if name_col is not None and name_col < len(row) and row[name_col] else f"{where} row {n}"
            summary = ", ".join(f"{h}={v}" for h, v in pairs[:4])
            yield {**base, "name": clip(name, NAME_MAX),
                   "description": clip(f"Row {n} of {where}: {summary}", DESC_MAX),
                   "body": clip("\n".join(f"{h}: {v}" for h, v in pairs), BODY_MAX),
                   "facets": row_facets(keys, row)}


def count_rows(abs_path):
    return sum(len([r for r in rows if any(r)][:MAX_ROWS]) for _, _, rows in read_tables(abs_path))


# ─── documents ───────────────────────────────────────────────────────────

def document_text(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == ".pdf":
        import pypdf
        text = "\n".join((p.extract_text() or "") for p in pypdf.PdfReader(path).pages)
        if not text.strip():
            import fitz
            with fitz.open(path) as doc:
                text = "\n".join(page.get_text() for page in doc)
        return text
    if ext == ".docx":
        with zipfile.ZipFile(path) as z:
            xml = z.read("word/document.xml").decode("utf-8", "replace")
        paragraphs = re.findall(r"<w:p[ >].*?</w:p>", xml, flags=re.S)
        return "\n".join("".join(re.findall(r"<w:t[^>]*>([^<]*)</w:t>", p)) for p in paragraphs)
    if ext in (".html", ".htm"):
        from bs4 import BeautifulSoup
        with open(path, encoding="utf-8", errors="replace") as f:
            soup = BeautifulSoup(f.read(), "html.parser")
        for tag in soup(["script", "style", "nav", "footer", "header", "aside", "form"]):
            tag.decompose()
        return soup.get_text("\n")
    if ext == ".ipynb":
        with open(path, encoding="utf-8", errors="replace") as f:
            cells = json.load(f).get("cells", [])
        return "\n\n".join("".join(c.get("source", [])) for c in cells)
    with open(path, encoding="utf-8", errors="replace") as f:
        return f.read()


def collapse(text):
    return re.sub(r"\n{3,}", "\n\n", re.sub(r"[ \t]+", " ", text)).strip()


# ─── commands ────────────────────────────────────────────────────────────

def scan(workspace, rel):
    root, path = resolve(workspace, rel)
    files, rows, docs = [], 0, 0
    for frel, fabs, action, kind, reason in walk(root, path):
        item = {"path": frel, "size": os.path.getsize(fabs), "action": action, "kind": kind}
        if reason:
            item["reason"] = reason
        files.append(item)
        if action == "parse" and kind == "table":
            try:
                rows += count_rows(fabs)
            except Exception:  # noqa: BLE001 — a bad table is reported at parse time
                pass
        elif action == "parse":
            docs += 1
    return {"files": files, "estimate": {"table_rows": rows, "documents": docs}}


def parse(workspace, rel, per_table):
    root, path = resolve(workspace, rel)
    for frel, fabs, action, kind, reason in walk(root, path):
        if action == "skip":
            yield {"type": "skipped", "path": frel, "reason": reason}
            continue
        try:
            digest = sha256_of(fabs)
            if kind == "table":
                yield from table_entries(frel, fabs, digest, per_table)
            else:
                text = collapse(document_text(fabs))
                if not text:
                    yield {"type": "skipped", "path": frel, "reason": "no text found"}
                    continue
                yield {"type": "document", "path": frel, "sha256": digest, "text": text[:MAX_DOC_CHARS],
                       "truncated": len(text) > MAX_DOC_CHARS}
        except Exception as e:  # noqa: BLE001 — one unreadable file must not stop a folder
            yield {"type": "skipped", "path": frel, "reason": f"could not read: {e}"}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("command", choices=["scan", "parse"])
    ap.add_argument("workspace")
    ap.add_argument("path")
    ap.add_argument("--tables", choices=["per_row", "per_table"], default="per_row")
    args = ap.parse_args(argv)
    try:
        if args.command == "scan":
            print(json.dumps(scan(args.workspace, args.path)))
        else:
            for item in parse(args.workspace, args.path, args.tables == "per_table"):
                print(json.dumps(item), flush=True)
    except BuildError as e:
        print(json.dumps({"error": str(e)}))
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
