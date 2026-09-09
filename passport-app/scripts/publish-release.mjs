#!/usr/bin/env node
/**
 * publish-release.mjs — cut a GitHub Release for this app and upload the
 * Windows artifacts produced by electron-builder.
 *
 * Typical first release:
 *
 *   node scripts/setup-native.mjs      # verify the machine can build + publish
 *   npm run build-win                  # writes dist/*.exe
 *   npm run release                    # creates tag v1.0.0 + uploads dist/*
 *
 * The release tag is created by GitHub from the current commit, so no
 * `git tag` / `git push --tags` is needed (pass --no-create-tag to require a
 * tag that already exists on the remote).
 *
 * Options:
 *   --version <v>     override package.json version
 *   --tag <tag>       override tag name (default: v<version>)
 *   --dist <dir>      artifact directory (default: dist, per electron-builder.config.js)
 *   --repo <o/r>      override owner/repo
 *   --notes <file>    release body from a file (default: generated)
 *   --draft           publish as a draft
 *   --prerelease      mark as pre-release
 *   --dry-run         show what would happen, upload nothing
 *   --yes, -y         skip the confirmation prompt (implied when not a TTY)
 *   --allow-bundled-secrets   publish even if .env — which electron-builder
 *                             bundles into the installer — contains a GH_TOKEN
 *
 * Token: GH_TOKEN or GITHUB_TOKEN, from the environment, .env.release, or .env.
 */
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import dns from 'node:dns'
import readline from 'node:readline'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(APP_DIR)

// Some networks resolve api.github.com badly; a public resolver avoids that.
// Set RELEASE_DNS=off to keep the system resolver.
if (process.env.RELEASE_DNS !== 'off') {
  try {
    dns.setServers((process.env.RELEASE_DNS || '1.1.1.1,8.8.8.8').split(','))
  } catch {
    /* keep system DNS */
  }
}

// ── env ───────────────────────────────────────────────────────────────────
// .env.release is read first so the publishing token can live outside the .env
// that electron-builder bundles into the installer. dotenv never overwrites
// values already present in process.env, so CI secrets always win.
/** Minimal KEY=VALUE reader, used when dotenv is not installed (e.g. before
 *  `npm ci`). Like dotenv, it never overwrites an existing process.env value. */
function loadEnvFile(file) {
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/.exec(line)
    if (!m || line.trimStart().startsWith('#')) continue
    const key = m[1]
    if (key in process.env) continue
    process.env[key] = m[2].trim().replace(/^(['"])([\s\S]*)\1$/, '$2')
  }
}

let dotenvConfig = null
try {
  ;({ config: dotenvConfig } = await import('dotenv'))
} catch {
  /* dotenv optional; fall back to loadEnvFile */
}
for (const file of ['.env.release', '.env']) {
  if (!fs.existsSync(file)) continue
  if (dotenvConfig) dotenvConfig({ path: file })
  else loadEnvFile(file)
}

// ── args ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const opt = (name, fallback) => {
  const i = argv.indexOf(name)
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback
}

if (flag('--help') || flag('-h')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0])
  process.exit(0)
}

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const VERSION = opt('--version', pkg.version)
const TAG = opt('--tag', `v${VERSION}`)
const DIST_DIR = opt('--dist', 'dist')
const DRY_RUN = flag('--dry-run')
const DRAFT = flag('--draft')
const PRERELEASE = flag('--prerelease')
const CREATE_TAG = !flag('--no-create-tag')
const ASSUME_YES = flag('--yes') || flag('-y') || !process.stdin.isTTY

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
if (!TOKEN && !DRY_RUN) {
  console.error(
    '\n❌  No GitHub token. Set GH_TOKEN in the environment or in .env.release\n' +
      '    (a classic token with `repo` scope, or a fine-grained one with\n' +
      '    `contents: write` on this repository).\n'
  )
  process.exit(1)
}

// ── owner/repo ────────────────────────────────────────────────────────────
function repoFromGitRemote() {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: APP_DIR,
      encoding: 'utf8',
    }).trim()
    const m = /github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/.exec(url)
    return m ? { owner: m[1], repo: m[2] } : null
  } catch {
    return null
  }
}

function resolveRepo() {
  const override = opt('--repo', null)
  if (override) {
    const [owner, repo] = override.split('/')
    if (!owner || !repo) throw new Error(`--repo expects <owner>/<name>, got "${override}"`)
    return { owner, repo }
  }
  if (process.env.GITHUB_OWNER && process.env.GITHUB_REPO) {
    return { owner: process.env.GITHUB_OWNER, repo: process.env.GITHUB_REPO }
  }
  const fromGit = repoFromGitRemote()
  if (fromGit) return fromGit
  throw new Error('Cannot determine the GitHub repo — pass --repo <owner>/<name>')
}

const { owner: OWNER, repo: REPO } = resolveRepo()

// ── http ──────────────────────────────────────────────────────────────────
const apiHeaders = () => ({
  Authorization: `Bearer ${TOKEN}`,
  'User-Agent': `${pkg.name}-publish-release`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
})

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) })
        } catch {
          resolve({ status: res.statusCode, body: data })
        }
      })
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

const api = (method, apiPath, body) =>
  request(
    {
      hostname: 'api.github.com',
      path: apiPath,
      method,
      headers: body ? { ...apiHeaders(), 'Content-Type': 'application/json' } : apiHeaders(),
    },
    body ? JSON.stringify(body) : undefined
  )

const errText = (res) =>
  typeof res.body === 'object' && res.body
    ? res.body.message || JSON.stringify(res.body)
    : String(res.body).slice(0, 300)

// ── artifacts ─────────────────────────────────────────────────────────────
const SKIP = /^(builder-debug\.yml|builder-effective-config\.yaml)$/i

/** Every publishable file electron-builder left in dist/: installer, portable,
 *  blockmaps, and update metadata when an update feed is configured. */
function collectArtifacts() {
  if (!fs.existsSync(DIST_DIR)) {
    throw new Error(`No ${DIST_DIR}/ directory — run \`npm run build-win\` first.`)
  }
  const files = fs
    .readdirSync(DIST_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && !SKIP.test(e.name) && !/^\.env/i.test(e.name))
    .map((e) => e.name)
    .filter((name) => /\.(exe|blockmap|msi|zip|yml)$/i.test(name))
    .sort()

  if (!files.some((f) => /\.exe$/i.test(f))) {
    throw new Error(`No installer found in ${DIST_DIR}/ — run \`npm run build-win\` first.`)
  }
  const stale = files.filter((f) => /\.exe$/i.test(f) && !f.includes(VERSION))
  if (stale.length) {
    console.warn(`  ⚠  ${stale.join(', ')} does not carry version ${VERSION} — stale build?`)
  }
  return files
}

/** The installer embeds .env (electron-builder.config.js → extraResources), so a
 *  publishing token left there would ship to everyone who downloads the app. */
function checkBundledSecrets() {
  if (!fs.existsSync('.env')) return
  const env = fs.readFileSync('.env', 'utf8')
  if (!/^\s*(GH_TOKEN|GITHUB_TOKEN)\s*=\s*\S/m.test(env)) return

  const msg =
    '\n❌  .env contains GH_TOKEN, and electron-builder bundles .env into the\n' +
    '    installer — publishing it would hand that token to every user.\n\n' +
    '    Fix: move the line to .env.release (git-ignored, never bundled),\n' +
    '    rebuild, then publish. Override with --allow-bundled-secrets.\n'

  if (flag('--allow-bundled-secrets')) {
    console.warn(msg.replace('❌', '⚠ '))
    return
  }
  console.error(msg)
  process.exit(1)
}

// ── release notes ─────────────────────────────────────────────────────────
function previousTag() {
  try {
    const tags = execFileSync('git', ['tag', '--list', 'v*', '--sort=-v:refname'], {
      cwd: APP_DIR,
      encoding: 'utf8',
    })
      .split('\n')
      .map((t) => t.trim())
      .filter((t) => t && t !== TAG)
    return tags[0] || null
  } catch {
    return null
  }
}

function buildNotes(artifacts) {
  const notesFile = opt('--notes', null)
  if (notesFile) return fs.readFileSync(notesFile, 'utf8')

  const productName =
    process.env.APP_NAME_EN || process.env.APP_NAME || pkg.description || pkg.name
  const installer = artifacts.find((f) => /setup.*\.exe$/i.test(f))
  const portable = artifacts.find((f) => /\.exe$/i.test(f) && f !== installer)

  const downloads = ['| File | Description |', '|------|-------------|']
  if (installer) {
    downloads.push(`| \`${installer}\` | Windows installer — wizard, shortcut, uninstaller |`)
  }
  if (portable) {
    downloads.push(`| \`${portable}\` | Portable — run directly, no installation |`)
  }

  const prev = previousTag()
  let changes = ''
  if (prev) {
    try {
      const log = execFileSync(
        'git',
        ['log', '--no-merges', '--pretty=format:- %s', `${prev}..HEAD`],
        { cwd: APP_DIR, encoding: 'utf8' }
      ).trim()
      if (log) changes = `\n### Changes since ${prev}\n\n${log}\n`
    } catch {
      /* no usable log; skip the section */
    }
  } else {
    changes =
      '\n### Highlights\n\n' +
      '- First release.\n' +
      '- Passport scanning with MRZ parsing, Arabic and English interface.\n' +
      '- Passenger records, duplicate detection, Excel and PDF reporting.\n'
  }

  return (
    `## ${productName} ${TAG}\n` +
    `${changes}\n` +
    `### Downloads\n\n${downloads.join('\n')}\n\n` +
    `### Requirements\n\n- Windows 10 / 11 (x64)\n`
  )
}

// ── release + upload ──────────────────────────────────────────────────────
function headSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: APP_DIR, encoding: 'utf8' }).trim()
  } catch {
    return undefined
  }
}

async function getOrCreateRelease(notes) {
  const get = await api('GET', `/repos/${OWNER}/${REPO}/releases/tags/${encodeURIComponent(TAG)}`)
  if (get.status === 200) {
    console.log(`✓ Reusing existing release ${TAG} (id ${get.body.id})`)
    return get.body
  }
  if (get.status !== 404) throw new Error(`GitHub API error ${get.status}: ${errText(get)}`)

  console.log(`Creating release ${TAG}...`)
  const payload = {
    tag_name: TAG,
    name: `${process.env.APP_NAME_EN || pkg.name} ${TAG}`,
    body: notes,
    draft: DRAFT,
    prerelease: PRERELEASE,
  }
  if (CREATE_TAG) payload.target_commitish = headSha()

  const create = await api('POST', `/repos/${OWNER}/${REPO}/releases`, payload)
  if (create.status !== 201) {
    throw new Error(`Failed to create release (${create.status}): ${errText(create)}`)
  }
  console.log(`✓ Created release ${TAG} (id ${create.body.id})`)
  await new Promise((r) => setTimeout(r, 2000)) // let the new tag settle before uploads
  return create.body
}

async function deleteExistingAsset(releaseId, name) {
  const list = await api('GET', `/repos/${OWNER}/${REPO}/releases/${releaseId}/assets?per_page=100`)
  if (list.status !== 200 || !Array.isArray(list.body)) return
  const existing = list.body.find((a) => a.name === name)
  if (!existing) return
  await api('DELETE', `/repos/${OWNER}/${REPO}/releases/assets/${existing.id}`)
  console.log(`  Replaced existing ${name}`)
}

const mb = (b) => (b / 1024 / 1024).toFixed(1)

function drawProgress(uploaded, total) {
  if (!process.stdout.isTTY) return
  const BAR = 32
  const pct = total > 0 ? uploaded / total : 0
  const filled = Math.round(pct * BAR)
  const bar = '█'.repeat(filled) + '░'.repeat(BAR - filled)
  process.stdout.write(
    `\r  [${bar}] ${String(Math.round(pct * 100)).padStart(3)}%  ${mb(uploaded)}/${mb(total)} MB `
  )
}

function uploadAsset(releaseId, name, filePath) {
  return new Promise((resolve, reject) => {
    const size = fs.statSync(filePath).size
    console.log(`  ↑ ${name} (${mb(size)} MB)`)
    let uploaded = 0
    const req = https.request(
      {
        hostname: 'uploads.github.com',
        path: `/repos/${OWNER}/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
        method: 'POST',
        headers: {
          ...apiHeaders(),
          'Content-Type': 'application/octet-stream',
          'Content-Length': size,
        },
      },
      (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => {
          if (process.stdout.isTTY) process.stdout.write('\n')
          if (res.statusCode === 201) {
            console.log(`  ✓ ${name}`)
            resolve()
          } else {
            reject(new Error(`Upload of ${name} failed (${res.statusCode}): ${body.slice(0, 300)}`))
          }
        })
      }
    )
    req.on('error', reject)
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => {
      uploaded += chunk.length
      drawProgress(uploaded, size)
      if (!req.write(chunk)) stream.pause()
    })
    req.on('drain', () => stream.resume())
    stream.on('end', () => req.end())
    stream.on('error', reject)
  })
}

async function uploadWithRetry(releaseId, name, filePath, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      await deleteExistingAsset(releaseId, name)
      await uploadAsset(releaseId, name, filePath)
      return
    } catch (err) {
      if (attempt >= attempts) throw err
      console.warn(`  ⚠  ${err.message}\n     retrying (${attempt}/${attempts - 1})...`)
      await new Promise((r) => setTimeout(r, 3000 * attempt))
    }
  }
}

function confirm(question) {
  if (ASSUME_YES) return Promise.resolve(true)
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close()
      resolve(/^y(es)?$/i.test(answer.trim()))
    })
  )
}

// ── main ──────────────────────────────────────────────────────────────────
async function main() {
  checkBundledSecrets()
  const artifacts = collectArtifacts()
  const notes = buildNotes(artifacts)
  const sizeOf = (f) => fs.statSync(path.join(DIST_DIR, f)).size
  const total = artifacts.reduce((sum, f) => sum + sizeOf(f), 0)

  console.log(`\nRelease  ${TAG}${DRAFT ? '  (draft)' : ''}${PRERELEASE ? '  (pre-release)' : ''}`)
  console.log(`Repo     https://github.com/${OWNER}/${REPO}`)
  console.log(`Source   ${DIST_DIR}/ — ${artifacts.length} file(s), ${mb(total)} MB total`)
  for (const f of artifacts) console.log(`         • ${f}  (${mb(sizeOf(f))} MB)`)

  if (DRY_RUN) {
    console.log(`\n--- release notes (dry run) ---\n${notes}`)
    console.log('Dry run: nothing was published.\n')
    return
  }

  if (!(await confirm('\nPublish this release to GitHub? [y/N] '))) {
    console.log('Aborted; nothing was published.\n')
    process.exit(1)
  }

  const release = await getOrCreateRelease(notes)
  for (const name of artifacts) {
    await uploadWithRetry(release.id, name, path.join(DIST_DIR, name))
  }

  const url = release.html_url || `https://github.com/${OWNER}/${REPO}/releases/tag/${TAG}`
  console.log(`\n✅ Published: ${url}\n`)
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}\n`)
  process.exit(1)
})
