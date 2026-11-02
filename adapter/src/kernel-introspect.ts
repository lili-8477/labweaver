// Snippets the notebook's Variables panel runs in the kernel. Each prints one
// JSON object to stdout: { name: { type, repr, shape } }, shape being a
// "(rows, cols)" string or null. Names starting with "_" (Python) or "."
// (R) are private and left out.

const PYTHON_VARIABLES =
  "import json as _j, types as _t\n" +
  "_SKIP = {'In','Out','get_ipython','exit','quit','open'}\n" +
  "_o = {}\n" +
  "for _k, _v in list(globals().items()):\n" +
  "    if _k.startswith('_'): continue\n" +
  "    if _k in _SKIP: continue\n" +
  "    if isinstance(_v, _t.ModuleType): continue\n" +
  "    _tn = type(_v).__name__\n" +
  "    try:\n" +
  "        _r = repr(_v)\n" +
  "        if len(_r) > 200: _r = _r[:200] + '...'\n" +
  "    except Exception:\n" +
  "        _r = '<repr failed>'\n" +
  "    _shape = None\n" +
  "    try:\n" +
  "        _shape = str(tuple(_v.shape)) if hasattr(_v, 'shape') else None\n" +
  "    except Exception:\n" +
  "        pass\n" +
  "    _o[_k] = {'type': _tn, 'repr': _r, 'shape': _shape}\n" +
  "print(_j.dumps(_o))\n";

// Base R only (no jsonlite). Runs inside local() so it leaves nothing in the
// user's global environment; str(max.level = 0) keeps big objects (a Seurat
// object, a large data.frame) to a one-line summary.
const R_VARIABLES = String.raw`invisible(local({
  esc <- function(s) {
    s <- gsub("\\", "\\\\", s, fixed = TRUE)
    s <- gsub("\"", "\\\"", s, fixed = TRUE)
    s <- gsub("[[:cntrl:]]", " ", s)
    paste0("\"", s, "\"")
  }
  env <- globalenv()
  out <- character(0)
  for (k in ls(env)) {
    v <- get(k, envir = env)
    r <- tryCatch(
      paste(trimws(utils::capture.output(utils::str(v, max.level = 0, give.attr = FALSE, vec.len = 3))), collapse = " "),
      error = function(e) "<repr failed>")
    if (nchar(r) > 200) r <- paste0(substr(r, 1, 200), "...")
    d <- tryCatch(dim(v), error = function(e) NULL)
    shape <- if (is.null(d)) "null" else esc(paste0("(", paste(d, collapse = ", "), ")"))
    out <- c(out, paste0(esc(k), ":{\"type\":", esc(class(v)[1]), ",\"repr\":", esc(r), ",\"shape\":", shape, "}"))
  }
  cat(paste0("{", paste(out, collapse = ","), "}\n"))
}))
`;

/** Introspection code for a notebook's kernelspec ("ir" is IRkernel). */
export function variablesCode(kernelspec: string): string {
  return kernelspec === "ir" ? R_VARIABLES : PYTHON_VARIABLES;
}
