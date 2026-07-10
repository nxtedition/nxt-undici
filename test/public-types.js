import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'tap'

const require = createRequire(import.meta.url)
const tsc = require.resolve('typescript/bin/tsc')
const root = fileURLToPath(new URL('..', import.meta.url))

function findTypeScriptFiles(directory) {
  if (!existsSync(directory)) {
    return []
  }

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)

    if (entry.isDirectory()) {
      return findTypeScriptFiles(path)
    }

    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : []
  })
}

const inputs = [
  join(root, 'test/type-stubs/upstream-undici.d.ts'),
  join(root, 'lib/index.d.ts'),
  ...findTypeScriptFiles(join(root, 'type-tests')),
]

test('public declarations compile', (t) => {
  execFileSync(
    process.execPath,
    [
      tsc,
      '--noEmit',
      '--strict',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      ...inputs,
    ],
    { cwd: root, stdio: 'inherit' },
  )
  t.pass('public declarations compiled')
  t.end()
})
