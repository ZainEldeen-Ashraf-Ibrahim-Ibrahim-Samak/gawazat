#!/usr/bin/env node
/**
 * setup-native.mjs — prepare this machine to build the native Windows packages
 * and publish them with scripts/publish-release.mjs.
 *
 *   node scripts/setup-native.mjs           # check, and fix what is safe to fix
 *   node scripts/setup-native.mjs --check   # report only, change nothing
 *
 * It verifies, in order:
 *   1. Node/npm versions and that dependencies are installed
 *   2. electron + electron-builder are present (native packaging toolchain)
 *   3. renderer vendor files and downloaded assets (fonts, audio, icon)
 *   4. .env exists and carries the keys electron-builder.config.js reads
 *   5. no publishing token sits in .env — electron-builder bundles that file
 *      into the installer, so a GH_TOKEN there would ship to every user
 *   6. git remote + working tree state for the release tag
 *
 * Exits non-zero if anything blocking is wrong, so it can gate a release.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(APP_DIR)

const CHECK_ONLY = process.argv.includes('--check')
const MIN_NODE_MAJOR = 18

const problems = []
const warnings = []

const ok = (msg) => console.log(`  ✓ ${msg}`)
const warn = (msg) => {
  warnings.push(msg)
  console.log(`  ⚠ ${msg}`)
}
const fail = (msg, fix) => {
  problems.push({ msg, fix })
  console.log(`  ✗ ${msg}`)
}
const section = (title) => console.log(`\n${title}`)

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: APP_DIR, encoding: 'utf8', ...opts }).trim()

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'

// ── 1. runtime ────────────────────────────────────────────────────────────
section('Runtime')
const nodeMajor = Number(process.versions.node.split('.')[0])
if (nodeMajor < MIN_NODE_MAJOR) {
  fail(
    `Node ${process.versions.node} is too old (need >= ${MIN_NODE_MAJOR})`,
    `Install Node ${MIN_NODE_MAJOR} LTS or newer`
  )
} else {
  ok(`Node ${process.versions.node}`)
}

try {
  // npm is a .cmd shim on Windows, and Node >= 18.20 refuses to spawn those
  // without a shell (EINVAL). The arguments here are fixed, so this is safe.
  ok(
    `npm ${run(npmCmd, ['--version'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: process.platform === 'win32',
    })}`
  )
} catch {
  fail('npm is not on PATH', 'Reinstall Node.js, which ships npm')
}

if (process.platform !== 'win32') {
  warn(
    `Building the Windows installer on ${process.platform} needs Wine; ` +
      'run this on Windows or let the GitHub Actions workflow build it'
  )
}

// ── 2. dependencies ───────────────────────────────────────────────────────
section('Dependencies')
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const has = (name) => fs.existsSync(path.join(APP_DIR, 'node_modules', name))

if (!fs.existsSync(path.join(APP_DIR, 'node_modules'))) {
  fail('node_modules is missing', 'npm ci')
} else {
  ok('node_modules present')
  // Packaging toolchain. These are ABI-sensitive on Windows, so a missing or
  // half-installed copy shows up as a confusing electron-builder error later.
  for (const dep of ['electron', 'electron-builder']) {
    if (has(dep)) {
      let version = ''
      try {
        version = JSON.parse(
          fs.readFileSync(path.join(APP_DIR, 'node_modules', dep, 'package.json'), 'utf8')
        ).version
      } catch {
        /* version is cosmetic */
      }
      ok(`${dep}${version ? ` ${version}` : ''}`)
    } else {
      fail(`${dep} is not installed`, 'npm ci')
    }
  }
  for (const dep of Object.keys(pkg.dependencies || {})) {
    if (!has(dep)) fail(`runtime dependency ${dep} is not installed`, 'npm ci')
  }
  // Electron caches its prebuilt binary outside node_modules on first install.
  if (has('electron') && !fs.existsSync(path.join(APP_DIR, 'node_modules', 'electron', 'dist'))) {
    fail(
      'the Electron binary was not downloaded (node_modules/electron/dist missing)',
      'node node_modules/electron/install.js'
    )
  }
}

// ── 3. bundled assets ─────────────────────────────────────────────────────
section('Assets')
const assetTargets = [
  ['renderer/styles/vendor/bootstrap.min.css', 'copy-vendor'],
  ['renderer/styles/vendor/bootstrap.rtl.min.css', 'copy-vendor'],
  ['renderer/vendor/i18next.min.js', 'copy-vendor'],
  ['renderer/assets/icon.ico', 'download-assets'],
]
const missingAssets = assetTargets.filter(([file]) => !fs.existsSync(path.join(APP_DIR, file)))

if (!missingAssets.length) {
  ok('vendor files and app icon in place')
} else if (CHECK_ONLY) {
  for (const [file] of missingAssets) fail(`${file} is missing`, 'npm run postinstall')
} else {
  console.log(`  … regenerating ${missingAssets.length} missing asset(s)`)
  const needed = new Set(missingAssets.map(([, script]) => script))
  for (const script of needed) {
    try {
      run(process.execPath, [path.join('scripts', `${script}.js`)], { stdio: 'inherit' })
    } catch {
      fail(`scripts/${script}.js failed`, `node scripts/${script}.js`)
    }
  }
  for (const [file] of missingAssets) {
    if (!fs.existsSync(path.join(APP_DIR, file))) fail(`${file} is still missing`, 'npm run postinstall')
  }
  if (!problems.length) ok('assets regenerated')
}

// ── 4. build configuration ────────────────────────────────────────────────
section('Build configuration')
const envPath = path.join(APP_DIR, '.env')
const envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : null

if (envText === null) {
  fail('.env is missing — electron-builder.config.js reads the product name and appId from it', 'cp .env.example .env')
} else {
  ok('.env present')
  const value = (key) => {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, 'm').exec(envText)
    return m ? m[1].trim() : null
  }
  for (const key of ['APP_ID', 'APP_NAME_EN', 'APP_ICON']) {
    if (value(key)) ok(`${key}=${value(key)}`)
    else warn(`${key} is not set in .env — electron-builder will fall back to its default`)
  }
  const icon = value('APP_ICON') || 'renderer/assets/icon.ico'
  if (fs.existsSync(path.resolve(APP_DIR, icon))) ok(`icon found: ${icon}`)
  else fail(`APP_ICON points at ${icon}, which does not exist`, 'node scripts/download-assets.js')

  // electron-builder.config.js bundles .env (files + extraResources), so
  // anything in it ends up readable inside the shipped installer.
  if (/^\s*(GH_TOKEN|GITHUB_TOKEN)\s*=\s*\S/m.test(envText)) {
    fail(
      '.env contains GH_TOKEN and .env is bundled into the installer — that token would ship to users',
      'Move the GH_TOKEN line from .env to .env.release, then rebuild'
    )
  } else {
    ok('no publishing token in the bundled .env')
  }
  if (/^\s*GEMINI_API_KEY\s*=\s*\S/m.test(envText)) {
    warn(
      'GEMINI_API_KEY is in .env, which is bundled into the installer — expected for this app, ' +
        'but the key is readable by anyone who downloads it'
    )
  }
}

const releaseTokenPresent =
  process.env.GH_TOKEN ||
  process.env.GITHUB_TOKEN ||
  (fs.existsSync(path.join(APP_DIR, '.env.release')) &&
    /^\s*(GH_TOKEN|GITHUB_TOKEN)\s*=\s*\S/m.test(fs.readFileSync(path.join(APP_DIR, '.env.release'), 'utf8')))

if (releaseTokenPresent) {
  ok('publishing token available for scripts/publish-release.mjs')
} else if (envText && /^\s*(GH_TOKEN|GITHUB_TOKEN)\s*=\s*\S/m.test(envText)) {
  warn('the only GH_TOKEN found is in .env — move it to .env.release, where it is not bundled')
} else {
  warn('no GH_TOKEN found — set one in .env.release before publishing a release')
}

// ── 5. git / release state ────────────────────────────────────────────────
section('Release state')
const version = pkg.version
const tag = `v${version}`
try {
  const remote = run('git', ['remote', 'get-url', 'origin'])
  ok(`origin ${remote}`)

  const status = run('git', ['status', '--porcelain'])
  if (status) warn(`working tree has ${status.split('\n').length} uncommitted change(s) — the release tag will point at HEAD`)
  else ok('working tree clean')

  const tags = run('git', ['tag', '--list', tag])
  if (tags) warn(`tag ${tag} already exists locally — publish-release.mjs will reuse that release`)
  else ok(`tag ${tag} is free`)
} catch {
  warn('not a git repository, or git is not on PATH — publish-release.mjs will need --repo <owner>/<name>')
}

// ── summary ───────────────────────────────────────────────────────────────
console.log('')
if (problems.length) {
  console.log(`❌ ${problems.length} blocking problem(s):\n`)
  for (const { msg, fix } of problems) console.log(`   • ${msg}\n     → ${fix}`)
  console.log('')
  process.exit(1)
}

console.log(
  `✅ Ready to build ${pkg.name} ${version}` +
    (warnings.length ? ` (${warnings.length} warning(s) above)` : '') +
    '\n\n   npm run build-win     # writes dist/\n   npm run release       # publishes ' +
    tag +
    ' to GitHub\n'
)
