// Upload files or folders from the chat composer into the chat's project.
// Uploads never create a project: the chat must already be bound to one
// (chats.project_dir). The next message tells the agent what arrived.

import { queueUpload } from '@/services/upload'
import { useUploadsStore } from '@/stores/uploads'
import type { DroppedFile } from '@/utils/dnd'
import { joinPath, parentOf } from '@/utils/path'

/** Files from a file or folder picker, each with its path inside the picked folder. */
export function pickedFiles(list: FileList): DroppedFile[] {
  return Array.from(list).map(file => ({
    file,
    relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
  }))
}

/** Queue each file into `projectDir`, keeping its folder path. `done` settles
 *  when every upload has: the files that arrived, and how many failed. */
export function queueProjectUploads(files: DroppedFile[], projectDir: string): {
  ids: string[]
  done: Promise<{ ok: DroppedFile[]; failed: number }>
} {
  const uploads = useUploadsStore()
  const queued = files.map(({ file, relativePath }) => queueUpload(file, joinPath(projectDir, parentOf(relativePath))))
  const done = Promise.allSettled(queued.map(q => q.promise)).then(rs => ({
    // A cancel resolves too; its entry says so.
    ok: files.filter((_, i) => rs[i]!.status === 'fulfilled'
      && uploads.items.find(u => u.id === queued[i]!.id)?.state !== 'canceled'),
    failed: rs.filter(r => r.status === 'rejected').length,
  }))
  return { ids: queued.map(q => q.id), done }
}

/** The first message after an upload: where the files are, then the user's text.
 *  A folder is one line with its file count, so a big folder stays short. */
export function composeUploadNote(projectDir: string, files: DroppedFile[], userText: string): string {
  const top = new Map<string, number>()
  for (const { relativePath } of files) {
    const slash = relativePath.indexOf('/')
    const entry = slash < 0 ? relativePath : `${relativePath.slice(0, slash)}/`
    top.set(entry, (top.get(entry) ?? 0) + 1)
  }
  const lines = [...top].map(([entry, n]) =>
    `- /workspace/${projectDir}/${entry}${entry.endsWith('/') ? ` (${n} file${n === 1 ? '' : 's'})` : ''}`)
  const fallback = `Take a look at what I uploaded and tell me what you can do with ${files.length === 1 ? 'it' : 'them'}.`
  return [`Uploaded to the project:`, ...lines, ``, userText || fallback].join('\n')
}
