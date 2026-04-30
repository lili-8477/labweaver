// Walk a DataTransferItemList (from a drag-drop) into a flat list of files,
// preserving each file's relative path inside the dropped folder structure.
//
// Uses webkitGetAsEntry (non-standard but supported in Chromium, Firefox,
// and Safari). For pure-file drops, the relativePath is just the file name.

export interface DroppedFile {
  file: File
  relativePath: string  // e.g. "folder/sub/file.txt" or "file.txt"
}

interface FileSystemEntryLike {
  isFile: boolean
  isDirectory: boolean
  name: string
  file?: (cb: (f: File) => void, err?: (e: Error) => void) => void
  createReader?: () => { readEntries: (cb: (entries: FileSystemEntryLike[]) => void) => void }
}

export async function walkDataTransferItems(items: DataTransferItemList): Promise<DroppedFile[]> {
  const out: DroppedFile[] = []
  const entries: FileSystemEntryLike[] = []

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.kind !== 'file') continue
    const entry = (item as DataTransferItem & {
      webkitGetAsEntry?: () => FileSystemEntryLike | null
    }).webkitGetAsEntry?.()
    if (entry) entries.push(entry)
  }

  for (const entry of entries) {
    await walkEntry(entry, '', out)
  }
  return out
}

async function walkEntry(entry: FileSystemEntryLike, prefix: string, out: DroppedFile[]): Promise<void> {
  const here = prefix ? `${prefix}/${entry.name}` : entry.name
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((resolve, reject) => {
      entry.file!((f) => resolve(f), (e) => reject(e))
    })
    out.push({ file, relativePath: here })
    return
  }
  if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader()
    // readEntries returns at most ~100 entries per call; loop until empty.
    let batch: FileSystemEntryLike[] = []
    do {
      batch = await new Promise<FileSystemEntryLike[]>((resolve) => {
        reader.readEntries((es) => resolve(es))
      })
      for (const child of batch) {
        await walkEntry(child, here, out)
      }
    } while (batch.length > 0)
  }
}
