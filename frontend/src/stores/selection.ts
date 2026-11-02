import { defineStore } from 'pinia'
import { ref } from 'vue'

/** Text the user selected in an artifact (file, notebook, h5ad, memory). */
export interface ArtifactSelection {
  /** What the text is from: a workspace path, or e.g. "memory: <name>". */
  source: string
  /** Where in it: "lines 10-21", "cell 3, lines 1-4", "cell 3 output". */
  where?: string
  text: string
}

// Keeps the last non-empty selection: clicking into the chat box collapses
// the page's selection, and the user still means the text they highlighted.
// Sent with the next message, then cleared; the composer chip can drop it.
export const useSelectionStore = defineStore('selection', () => {
  const current = ref<ArtifactSelection | null>(null)

  function set(sel: ArtifactSelection) {
    if (sel.text.trim()) current.value = sel
  }

  function clear() {
    current.value = null
  }

  return { current, set, clear }
})
