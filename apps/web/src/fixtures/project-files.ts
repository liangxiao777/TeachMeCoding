import { uid } from './demo-data'
import type { CodeFile, Space } from './types'

export const fileLanguage = (name: string): CodeFile['language'] =>
  name.endsWith('.rs') ? 'rust' : name.endsWith('.py') ? 'python' : 'text'

export function entryPath(space: Space, id: string | null): string {
  const entry = [...space.directories, ...space.files].find((e) => e.id === id)
  if (!entry) return ''
  const parent = entryPath(space, entry.parentId)
  return parent ? `${parent}/${entry.name}` : entry.name
}

export function ancestorIds(space: Space, parentId: string | null): string[] {
  if (!parentId) return []
  const parent = space.directories.find((d) => d.id === parentId)
  return parent ? [...ancestorIds(space, parent.parentId), parent.id] : []
}

export function projectChildren(space: Space, parentId: string | null) {
  return [
    ...space.directories.filter((d) => d.parentId === parentId).map((d) => ({ ...d, kind: 'directory' as const })),
    ...space.files.filter((f) => f.parentId === parentId).map((f) => ({ ...f, kind: 'file' as const })),
  ].sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) : a.kind === 'directory' ? -1 : 1,
  )
}

export function openProjectFile(space: Space, id: string): Space {
  const file = space.files.find((f) => f.id === id)
  if (!file) return space
  return {
    ...space,
    activeFileId: id,
    selectedEntryId: id,
    ideOpen: true,
    openFileIds: space.openFileIds.includes(id) ? space.openFileIds : [...space.openFileIds, id],
    expandedDirectoryIds: [...new Set([...space.expandedDirectoryIds, ...ancestorIds(space, file.parentId)])],
  }
}

export function closeProjectFile(space: Space, id: string): Space {
  const index = space.openFileIds.indexOf(id)
  const openFileIds = space.openFileIds.filter((x) => x !== id)
  return {
    ...space,
    openFileIds,
    activeFileId:
      space.activeFileId === id ? (openFileIds[Math.min(index, openFileIds.length - 1)] ?? null) : space.activeFileId,
  }
}

function nameError(space: Space, name: string, parentId: string | null, exceptId?: string) {
  if (!name || name === '.' || name === '..' || /[\\/\u0000-\u001f]/.test(name))
    return '请输入有效名称，不包含路径分隔符'
  if (projectChildren(space, parentId).some((e) => e.id !== exceptId && e.name === name))
    return '此目录中已存在同名文件或文件夹'
  return null
}

export function addProjectEntry(space: Space, value: string, kind: 'file' | 'directory', parentId: string | null) {
  const name = value.trim()
  const error = nameError(space, name, parentId)
  if (error) return { space, error }
  const id = uid(kind)
  const next = {
    ...space,
    selectedEntryId: id,
    expandedDirectoryIds: [...new Set([...space.expandedDirectoryIds, ...ancestorIds(space, parentId)])],
  }
  if (kind === 'directory')
    return {
      space: {
        ...next,
        directories: [...space.directories, { id, name, parentId }],
        expandedDirectoryIds: [...next.expandedDirectoryIds, id],
      },
      error: null,
    }
  const language = fileLanguage(name)
  const file: CodeFile = { id, name, parentId, language, content: language === 'rust' ? 'fn main() {\n    \n}' : '' }
  return { space: openProjectFile({ ...next, files: [...space.files, file] }, id), error: null }
}

export function renameProjectEntry(space: Space, id: string, value: string) {
  const entry = [...space.directories, ...space.files].find((e) => e.id === id)
  if (!entry) return { space, error: '文件或目录不存在' }
  const name = value.trim()
  const error = nameError(space, name, entry.parentId, id)
  if (error) return { space, error }
  return {
    space: {
      ...space,
      directories: space.directories.map((d) => (d.id === id ? { ...d, name } : d)),
      files: space.files.map((f) => (f.id === id ? { ...f, name, language: fileLanguage(name) } : f)),
    },
    error: null,
  }
}

export function resolveProjectPath(space: Space, path: string) {
  const parts = path.startsWith('/') ? [] : entryPath(space, space.terminalDirectoryId).split('/').filter(Boolean)
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) return undefined
      parts.pop()
    } else parts.push(part)
  }
  const normalized = parts.join('/')
  if (!normalized) return { kind: 'directory' as const, id: null }
  const directory = space.directories.find((d) => entryPath(space, d.id) === normalized)
  if (directory) return { kind: 'directory' as const, id: directory.id }
  const file = space.files.find((f) => entryPath(space, f.id) === normalized)
  return file ? { kind: 'file' as const, id: file.id } : undefined
}
