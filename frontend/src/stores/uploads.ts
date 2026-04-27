import { defineStore } from 'pinia'
import { ref } from 'vue'

export type UploadState = 'pending' | 'uploading' | 'done' | 'error' | 'canceled'

export interface UploadEntry {
  id: string
  fileName: string
  destPath: string        // workspace-relative path, e.g. "local_projects/foo/bar.txt"
  state: UploadState
  bytesSent: number
  totalBytes: number
  error?: string
  startedAt?: number
}

export const useUploadsStore = defineStore('uploads', () => {
  const items = ref<UploadEntry[]>([])

  function add(entry: UploadEntry) {
    items.value.push(entry)
  }

  function update(id: string, patch: Partial<UploadEntry>) {
    const it = items.value.find(i => i.id === id)
    if (it) Object.assign(it, patch)
  }

  function remove(id: string) {
    items.value = items.value.filter(i => i.id !== id)
  }

  function clearFinished() {
    items.value = items.value.filter(i => i.state === 'pending' || i.state === 'uploading')
  }

  return { items, add, update, remove, clearFinished }
})
