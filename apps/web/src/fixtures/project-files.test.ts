import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rustInProgressSpace } from './demo-data'
import i18n from '../i18n'
import { formatNotice } from '../i18n/notice'
import {
  addProjectEntry,
  closeProjectFile,
  entryPath,
  openProjectFile,
  projectChildren,
  renameProjectEntry,
  resolveProjectPath,
} from './project-files'
import { runCommandFor, runFile } from './code-runner'

test('nested paths distinguish identical names and follow directory renames without changing identity', () => {
  let space = rustInProgressSpace()
  space = openProjectFile({ ...space, expandedDirectoryIds: [] }, 'f_parser')
  assert.deepEqual(space.expandedDirectoryIds, ['dir_src', 'dir_utils'])
  space = openProjectFile(space, 'f_test_parser')
  space = renameProjectEntry(space, 'dir_src', 'source').space
  assert.equal(entryPath(space, 'f_parser'), 'source/utils/parser.rs')
  assert.equal(entryPath(space, 'f_test_parser'), 'tests/parser.rs')
  assert.deepEqual(resolveProjectPath(space, '/source/utils/parser.rs'), { kind: 'file', id: 'f_parser' })
  space = { ...space, terminalDirectoryId: 'dir_utils' }
  assert.deepEqual(resolveProjectPath(space, '../../tests/parser.rs'), { kind: 'file', id: 'f_test_parser' })
  assert.equal(resolveProjectPath(space, '../../../tests/parser.rs'), undefined)
  assert.deepEqual(resolveProjectPath(space, '/'), { kind: 'directory', id: null })
  assert.deepEqual(space.openFileIds, ['f_move', 'f_parser', 'f_test_parser'])
})

test('name collisions are local to a directory and include folders; config files keep their names', async () => {
  const space = rustInProgressSpace()
  for (const name of ['', '.', '..', 'a/b.rs', 'a\\b.rs', '\u0000']) {
    assert.ok(addProjectEntry(space, name, 'file', null).error)
  }
  assert.ok(addProjectEntry(space, 'src', 'file', null).error)
  assert.ok(addProjectEntry(space, 'parser.rs', 'directory', 'dir_utils').error)
  const result = addProjectEntry(space, 'parser.rs', 'file', 'dir_examples')
  assert.equal(result.error, null)
  assert.equal(entryPath(result.space, result.space.activeFileId), 'examples/parser.rs')
  const config = addProjectEntry(space, 'settings.json', 'file', 'dir_utils').space
  assert.equal(config.files.at(-1)?.name, 'settings.json')
  assert.equal(config.files.at(-1)?.language, 'text')
  const collision = renameProjectEntry(space, 'f_parser', 'mod.rs').error
  await i18n.changeLanguage('en')
  assert.equal(formatNotice(collision), 'A file or folder with this name already exists in this directory.')
  await i18n.changeLanguage('zh-CN')
  assert.equal(formatNotice(collision), '此目录中已存在同名文件或文件夹')
  await i18n.changeLanguage('en')
  assert.equal(renameProjectEntry(config, config.activeFileId!, 'script.py').space.files.at(-1)?.language, 'python')
  assert.deepEqual(
    projectChildren(space, 'dir_src').map((e) => e.name),
    ['utils', 'lib.rs', 'main.rs'],
  )
})

test('closing a tab selects its neighbor without deleting content or opening duplicates', () => {
  const original = rustInProgressSpace()
  let space = openProjectFile(openProjectFile(original, 'f_main'), 'f_parser')
  space = openProjectFile(space, 'f_main')
  assert.deepEqual(space.openFileIds, ['f_move', 'f_main', 'f_parser'])
  space = closeProjectFile(space, 'f_main')
  assert.equal(space.activeFileId, 'f_parser')
  space = closeProjectFile(space, 'f_parser')
  assert.equal(space.activeFileId, 'f_move')
  space = closeProjectFile(space, 'f_move')
  assert.equal(space.activeFileId, null)
  assert.deepEqual(space.openFileIds, [])
  assert.deepEqual(space.files, original.files)
})

test('simulated runtime reports nested source paths and generated commands quote spaces', () => {
  assert.equal(runCommandFor('/examples/my demo.rs', 'rust'), 'rustc "/examples/my demo.rs" && "./my demo"')
  assert.equal(runCommandFor('/samples/hello world.py', 'python'), 'python "/samples/hello world.py"')
  const rust = rustInProgressSpace().files.find((f) => f.id === 'f_move')!
  assert.match(runFile('examples/move_demo.rs', rust.content, 'rust').stderr.join('\n'), /examples\/move_demo.rs:6:/)
  assert.match(
    runFile('nested/problem.py', 'y = torch.ones(2, 3)\nprint(x + y)', 'python').stderr.join('\n'),
    /nested\/problem.py/,
  )
})
