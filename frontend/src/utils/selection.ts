import type { editor } from 'monaco-editor'
import type { ArtifactSelection } from '@/stores/selection'

// A selection rides in the user message as a tagged block ahead of the typed
// text, so the agent sees what and where it is, and the chat can show it as a
// quote instead of raw tags.
const MAX_CHARS = 20_000
const BLOCK = /<selection source="([^"]*)"(?: where="([^"]*)")?>\n([\s\S]*?)\n<\/selection>\n*/

const attr = (s: string) => s.replace(/"/g, "'")

export function selectionBlock(sel: ArtifactSelection): string {
  const text = sel.text.length > MAX_CHARS
    ? `${sel.text.slice(0, MAX_CHARS)}\n…[${sel.text.length - MAX_CHARS} characters cut]`
    : sel.text
  const where = sel.where ? ` where="${attr(sel.where)}"` : ''
  return `<selection source="${attr(sel.source)}"${where}>\n${text}\n</selection>`
}

/** Split a sent message into its selection (if any) and the rest. */
export function splitSelection(content: string): { selection: ArtifactSelection | null; rest: string } {
  const m = BLOCK.exec(content)
  if (!m) return { selection: null, rest: content }
  return {
    selection: { source: m[1]!, where: m[2], text: m[3]! },
    rest: content.slice(0, m.index) + content.slice(m.index + m[0].length),
  }
}

/** "lines 3-5" (1-based, inclusive), or "line 3". */
function lineRange(start: number, end: number): string {
  return start === end ? `line ${start}` : `lines ${start}-${end}`
}

/** Report a Monaco editor's non-empty selections with their line range. */
export function watchEditorSelection(
  ed: editor.IStandaloneCodeEditor,
  onSelect: (text: string, lines: string) => void,
): void {
  ed.onDidChangeCursorSelection(({ selection }) => {
    const text = ed.getModel()?.getValueInRange(selection) ?? ''
    if (text.trim()) onSelect(text, lineRange(selection.startLineNumber, selection.endLineNumber))
  })
}

/**
 * Report text selections made inside elements marked `data-selection-source`
 * (and optional `data-selection-where`); the innermost marked element wins.
 * Monaco editors keep their own selection, so they report it themselves.
 * Returns a function that stops watching.
 */
export function watchDomSelections(onSelect: (sel: ArtifactSelection) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const read = () => {
    const s = window.getSelection()
    if (!s || s.isCollapsed) return
    const text = s.toString().trim()
    const node = s.anchorNode
    const el = (node instanceof Element ? node : node?.parentElement)
      ?.closest<HTMLElement>('[data-selection-source]')
    if (!text || !el?.dataset.selectionSource) return
    onSelect({ source: el.dataset.selectionSource, where: el.dataset.selectionWhere, text })
  }
  const onChange = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(read, 200)
  }
  document.addEventListener('selectionchange', onChange)
  return () => {
    if (timer) clearTimeout(timer)
    document.removeEventListener('selectionchange', onChange)
  }
}
