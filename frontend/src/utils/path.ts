// Pure path helpers shared by FileTree.vue, MoveToModal.vue, and friends.
// Workspace-relative paths use forward-slash separators with no leading
// slash; "" is the workspace root.

export function basenameOf(p: string): string {
  if (!p) return p
  const i = p.lastIndexOf('/')
  return i < 0 ? p : p.slice(i + 1)
}

export function parentOf(p: string): string {
  if (!p) return ''
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}

export function joinPath(parent: string, name: string): string {
  if (!parent) return name
  return `${parent}/${name}`
}

export function isAncestorOrSelf(maybeAncestor: string, descendant: string): boolean {
  if (maybeAncestor === descendant) return true
  return descendant.startsWith(maybeAncestor + '/')
}
