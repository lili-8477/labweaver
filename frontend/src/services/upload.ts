import { useUploadsStore } from '@/stores/uploads'

const MAX_SIZE = 2 * 1024 * 1024 * 1024  // 2 GiB

// XHR objects are kept off the Pinia state — making them reactive would cause
// Vue to deep-proxy XMLHttpRequest internals and break the upload.
const liveXhrs = new Map<string, XMLHttpRequest>()

let queueTail: Promise<unknown> = Promise.resolve()

export interface QueueResult {
  id: string
  promise: Promise<void>
}

/** Queue a file for upload. Returns the entry id and a promise that resolves
 *  on done/canceled and rejects on error. Sequential: one at a time. */
export function queueUpload(file: File, destDir: string): QueueResult {
  const id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random())
  const destPath = destDir ? `${destDir.replace(/\/$/, '')}/${file.name}` : file.name

  const uploads = useUploadsStore()
  uploads.add({
    id,
    fileName: file.name,
    destPath,
    state: 'pending',
    bytesSent: 0,
    totalBytes: file.size,
  })

  if (file.size > MAX_SIZE) {
    uploads.update(id, { state: 'error', error: 'File exceeds 2 GB limit' })
    return { id, promise: Promise.reject(new Error('size')) }
  }

  const promise = queueTail.then(() => runUpload(id, file))
  queueTail = promise.catch(() => {})  // keep queue alive on errors
  return { id, promise }
}

function runUpload(id: string, file: File): Promise<void> {
  const uploads = useUploadsStore()
  const entry = uploads.items.find(i => i.id === id)
  if (!entry || entry.state === 'canceled' || entry.state === 'error') {
    return Promise.resolve()
  }

  return new Promise<void>((resolve, reject) => {
    const url = '/upload/' + entry.destPath.split('/').map(encodeURIComponent).join('/')
    const xhr = new XMLHttpRequest()
    liveXhrs.set(id, xhr)
    xhr.open('PUT', url, true)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) uploads.update(id, { bytesSent: e.loaded })
    }
    xhr.onload = () => {
      liveXhrs.delete(id)
      if (xhr.status >= 200 && xhr.status < 300) {
        uploads.update(id, { state: 'done', bytesSent: entry.totalBytes })
        resolve()
      } else {
        let msg = `HTTP ${xhr.status}`
        try { msg = JSON.parse(xhr.responseText).error || msg } catch { /* not JSON */ }
        uploads.update(id, { state: 'error', error: msg })
        reject(new Error(msg))
      }
    }
    xhr.onerror = () => {
      liveXhrs.delete(id)
      uploads.update(id, { state: 'error', error: 'Network error' })
      reject(new Error('network'))
    }
    xhr.onabort = () => {
      liveXhrs.delete(id)
      uploads.update(id, { state: 'canceled' })
      resolve()
    }
    uploads.update(id, { state: 'uploading', startedAt: Date.now() })
    xhr.send(file)
  })
}

export function cancelUpload(id: string): void {
  const uploads = useUploadsStore()
  const xhr = liveXhrs.get(id)
  if (xhr) {
    xhr.abort()
  } else {
    uploads.update(id, { state: 'canceled' })
  }
}

/** Re-queue a failed upload from byte 0. Caller must still hold the original
 *  File handle (we don't keep it in the store to avoid Vue-proxying it). */
export function retryUpload(id: string, file: File): void {
  const uploads = useUploadsStore()
  uploads.update(id, { state: 'pending', bytesSent: 0, error: undefined })
  const promise = queueTail.then(() => runUpload(id, file))
  queueTail = promise.catch(() => {})
}
