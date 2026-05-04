// One-shot image upload for chat attachments. Each image goes to a UUID-named
// file under local_projects/.chat-attachments/ — the existing upload-http
// allowlist already covers that subtree, so no backend change is needed.

const SUBDIR = 'local_projects/.chat-attachments'
const MAX_BYTES = 10 * 1024 * 1024
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export interface ChatAttachment {
  id: string
  /** Original filename (display only). */
  fileName: string
  /** Object URL for the thumbnail; revoke when removed. */
  previewUrl: string
  /** Absolute path inside the workspace once uploaded; empty until done. */
  workspacePath: string
  /** Image media type for the SDK content block. */
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  state: 'uploading' | 'done' | 'error'
  /** 0-100, only meaningful while state is 'uploading'. */
  progress: number
  error?: string
}

// File objects live OUTSIDE reactive state — Vue 3's `reactive()` doesn't
// proxy File/Blob (they fall in the INVALID target bucket), but pinning them
// in a side Map also makes it impossible to accidentally mutate `att.file =
// proxiedFile` and then send a stale reference to XHR. Cleared on remove.
const filesById = new Map<string, File>()

export function isImage(file: File): boolean {
  return ALLOWED.has(file.type)
}

export function makeAttachment(file: File): ChatAttachment {
  const id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random())
  filesById.set(id, file)
  return {
    id,
    fileName: file.name,
    previewUrl: URL.createObjectURL(file),
    workspacePath: '',
    mediaType: file.type as ChatAttachment['mediaType'],
    state: 'uploading',
    progress: 0,
  }
}

export function discardAttachmentFile(id: string): void {
  filesById.delete(id)
}

const UPLOAD_TIMEOUT_MS = 60_000

/** PUT the file to /upload/<SUBDIR>/<uuid>.<ext>. Reports progress via
 *  the optional callback. Resolves with the absolute workspace path the
 *  agent should read. Rejects on timeout, network, or HTTP errors. */
export function uploadAttachment(
  attachmentId: string,
  onProgress?: (pct: number) => void,
): Promise<string> {
  const file = filesById.get(attachmentId)
  if (!file) return Promise.reject(new Error('Attachment file missing'))
  if (!ALLOWED.has(file.type)) {
    return Promise.reject(new Error('Unsupported image type'))
  }
  if (file.size > MAX_BYTES) {
    return Promise.reject(new Error('Image exceeds 10 MB limit'))
  }

  const ext = extFor(file)
  const destPath = `${SUBDIR}/${attachmentId}${ext}`
  const url = '/upload/' + destPath.split('/').map(encodeURIComponent).join('/')

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url, true)
    xhr.timeout = UPLOAD_TIMEOUT_MS
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100))
      }
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100)
        resolve(`/workspace/${destPath}`)
      } else {
        let msg = `HTTP ${xhr.status}`
        try { msg = JSON.parse(xhr.responseText).error || msg } catch { /* not JSON */ }
        reject(new Error(msg))
      }
    }
    xhr.onerror = () => reject(new Error('Network error'))
    xhr.ontimeout = () => reject(new Error('Upload timed out'))
    xhr.send(file)
  })
}

function extFor(file: File): string {
  const m = /\.[a-z0-9]+$/i.exec(file.name)
  if (m) return m[0].toLowerCase()
  switch (file.type) {
    case 'image/png': return '.png'
    case 'image/jpeg': return '.jpg'
    case 'image/gif': return '.gif'
    case 'image/webp': return '.webp'
    default: return ''
  }
}
