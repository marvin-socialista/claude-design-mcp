// Browser session + Omelette RPC client for claude.ai/design.
//
// Two transports, deliberately:
//
//   * Everything that is a plain request/response (list projects, read the chat
//     transcript, read files) goes over the Omelette Connect-RPC endpoints.
//     Cookie auth is enough, no extra headers.
//   * Sending a prompt goes through the real page, because that is where
//     Claude Design's agent loop lives. The server streams tool calls back and
//     the browser executes them (local_read, file writes, screenshots and the
//     rest). Driving the page means we get that harness for free instead of
//     reimplementing it.
//
// The browser is therefore always present, so we let the page issue the RPCs
// too. One auth mechanism, no cookie extraction, nothing to expire.

import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Portable: use whatever playwright the package resolves to. On Marvin's Mac a
// shared stealth setup already exists with evasions and persistent profiles, so
// prefer that when present; elsewhere plain playwright is fine.
const STEALTH_DIR = process.env.CLAUDE_DESIGN_STEALTH_DIR || join(homedir(), '.claude', 'playwright-stealth')
const hasStealth = existsSync(join(STEALTH_DIR, 'index.mjs'))

const stealth = hasStealth ? await import(pathToFileURL(join(STEALTH_DIR, 'index.mjs')).href).catch(() => null) : null

const { chromium } = await (async () => {
  try {
    return await import('playwright')
  } catch {
    if (hasStealth) return import(pathToFileURL(join(STEALTH_DIR, 'node_modules', 'playwright', 'index.mjs')).href)
    throw new Error('playwright is not installed. Run: npm install')
  }
})()

const launchStealth = stealth?.launchStealth ?? null
const STEALTH_SCRIPT = stealth?.STEALTH_SCRIPT ?? null
const PROFILES_DIR = stealth?.PROFILES_DIR ?? join(homedir(), '.claude-design-mcp', 'profiles')

export const ORIGIN = 'https://claude.ai'
export const RPC_BASE = `${ORIGIN}/design/anthropic.omelette.api.v1alpha.OmeletteService/`
export const PROFILE = process.env.CLAUDE_DESIGN_PROFILE || 'claude-design'

// Opt-in escape hatch: point at a Chrome profile that is already signed in
// (e.g. ~/.claude/playwright-profile, the MCP browser's) instead of keeping a
// second login. One Chrome per directory, so that browser must be closed.
export const USER_DATA_DIR = process.env.CLAUDE_DESIGN_USER_DATA_DIR || ''

// Records when each Chat stream finishes. Resource-timing entries are reported
// on completion, which the app itself relies on, so a new entry means a stream
// just ended. Observing is read-only: no fetch patching, nothing to break.
const PROBE = `(() => {
  if (window.__cdBridge) return
  const S = { chatEnds: [], installed: Date.now() }
  window.__cdBridge = S
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.name.endsWith('OmeletteService/Chat')) S.chatEnds.push(Date.now())
      }
    }).observe({ type: 'resource', buffered: true })
  } catch {}
})()`

let ctx = null
let page = null

// Cloudflare 403s headless Chrome on claude.ai even with a valid session and
// the stealth evasions loaded (verified: headless 403 + challenge redirect,
// headed 200). So we run headed and park the window offscreen instead, which
// keeps it out of the way without pretending to be headless.
const HEADLESS = process.env.CLAUDE_DESIGN_HEADLESS === '1'
const VISIBLE = process.env.CLAUDE_DESIGN_VISIBLE === '1'

function launchArgs () {
  const args = [
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
  ]
  if (!HEADLESS && !VISIBLE) args.push('--window-position=-2400,-2400', '--window-size=1400,900')
  return args
}

export { chromium, PROFILES_DIR }

export async function getPage ({ requireLogin = true } = {}) {
  if (page && !page.isClosed()) return page

  const opts = {
    channel: 'chrome',
    headless: HEADLESS,
    viewport: null,
    locale: 'nl-NL',
    timezoneId: 'Europe/Amsterdam',
    args: launchArgs(),
  }

  if (USER_DATA_DIR) {
    ctx = await chromium.launchPersistentContext(USER_DATA_DIR, opts)
    if (STEALTH_SCRIPT) await ctx.addInitScript({ path: STEALTH_SCRIPT })
  } else if (launchStealth) {
    ctx = await launchStealth({ profile: PROFILE, ...opts })
  } else {
    const dir = join(PROFILES_DIR, PROFILE)
    mkdirSync(dir, { recursive: true })
    ctx = await chromium.launchPersistentContext(dir, opts)
  }
  await ctx.addInitScript(PROBE)
  page = await ctx.newPage()
  for (const p of ctx.pages()) {
    if (p !== page && p.url() === 'about:blank') await p.close().catch(() => {})
  }
  await page.goto(`${ORIGIN}/design`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  if (requireLogin) await assertLoggedIn()
  return page
}

export async function closeSession () {
  if (ctx) await ctx.close().catch(() => {})
  ctx = null
  page = null
}

class NotLoggedIn extends Error {
  constructor () {
    super(
      `Not signed in to claude.ai on ${USER_DATA_DIR ? `profile dir ${USER_DATA_DIR}` : `the "${PROFILE}" browser profile`}.\n` +
      `claude.ai/design redirects signed-out visitors to the claude.com marketing page.\n\n` +
      `Sign in once:\n  cd ~/Documents/Github/claude-design-mcp && npm run login\n`
    )
    this.name = 'NotLoggedIn'
  }
}

/**
 * Signed out, claude.ai/design redirects to the claude.com marketing page, so
 * the giveaway is the landing URL, not the presence of a login form. Checking
 * the origin also protects `rpc`, which can only reach the API same-origin.
 */
function onAppOrigin (url) {
  try {
    const u = new URL(url)
    return u.origin === ORIGIN && u.pathname.startsWith('/design')
  } catch {
    return false
  }
}

async function assertLoggedIn () {
  if (!onAppOrigin(page.url())) throw new NotLoggedIn()
  const ok = await page
    .locator('button[aria-label="Account menu"], [data-testid="account-menu"]')
    .first()
    .waitFor({ state: 'attached', timeout: 30000 })
    .then(() => true)
    .catch(() => false)
  if (!ok || !onAppOrigin(page.url())) throw new NotLoggedIn()
}

/**
 * Call an Omelette unary RPC from inside the page, so the session cookie and
 * origin come along automatically.
 */
export async function rpc (method, body = {}) {
  const p = await getPage()
  // Same-origin only: a drift to claude.com turns every call into "Failed to fetch".
  if (!onAppOrigin(p.url())) {
    await p.goto(`${ORIGIN}/design`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    if (!onAppOrigin(p.url())) throw new NotLoggedIn()
  }
  const res = await p.evaluate(
    async ([base, m, payload]) => {
      const r = await fetch(base + m, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      return { status: r.status, text: await r.text() }
    },
    [RPC_BASE, method, body]
  )
  if (res.status === 401 || res.status === 403) throw new NotLoggedIn()
  if (res.status !== 200) {
    throw new Error(`${method} failed: HTTP ${res.status} ${res.text.slice(0, 400)}`)
  }
  try {
    return JSON.parse(res.text)
  } catch {
    throw new Error(`${method} returned non-JSON: ${res.text.slice(0, 200)}`)
  }
}

const b64 = (s) => Buffer.from(s, 'base64')

export async function listProjects () {
  // Let a failing ListProjects surface: swallowing it reads as "no projects"
  // and sends you hunting in the wrong place. Org projects are a bonus.
  const own = await rpc('ListProjects', {})
  const org = await rpc('ListOrgProjects', {}).catch(() => ({ items: [] }))
  const seen = new Map()
  for (const it of [...(own.items || []), ...(org.items || [])]) {
    if (it?.projectId && !seen.has(it.projectId)) seen.set(it.projectId, it)
  }
  return [...seen.values()]
}

/** Full project state, including every chat and message. Roughly 1-2 MB. */
export async function getProjectData (projectId) {
  const r = await rpc('GetProjectData', { projectId })
  if (!r?.data) throw new Error('GetProjectData returned no data')
  return JSON.parse(b64(r.data).toString('utf8'))
}

/**
 * Every file in the project, recursively.
 *
 * ListFiles is shallow unless you pass `depth`, and the server caps `limit` at
 * 200 whatever you ask for, so pages have to be walked with `offset`.
 * Entries carry only { name, path, type }: no size, mtime or version.
 */
export async function listFiles (projectId, { depth = 20 } = {}) {
  const out = []
  for (let offset = 0; ; offset += 200) {
    const r = await rpc('ListFiles', { projectId, depth, offset })
    const batch = r.entries || []
    out.push(...batch)
    const total = Number(r.total ?? out.length)
    if (!batch.length || out.length >= total) break
    if (offset > 20000) break // guard against a server that ignores offset
  }
  return out
}

export const filePaths = (entries) => entries.filter((e) => e.type !== 'directory').map((e) => e.path)

export async function getFile (projectId, path) {
  const r = await rpc('GetFile', { projectId, path })
  return b64(r.content || '')
}

/**
 * Drop Claude Design's own runtime preamble.
 *
 * HTML can come back with a `data-omelette-injected` style and script pair
 * bolted to the front: the preview harness (storage shim, console bridge, Babel
 * plugins) and about 15 KB of minified noise that is not the author's content.
 * The attribute is unambiguous, so removing those two tags is safe.
 */
export function stripInjected (src) {
  return src.replace(/<(style|script)\b[^>]*\bdata-omelette-injected\b[^>]*>[\s\S]*?<\/\1>\s*/gi, '')
}

/**
 * Capture what the design actually looks like.
 *
 * The rendered design lives inside the viewer iframe, so shooting that element
 * gives the artwork without the app's own chrome around it. `fullPage` reaches
 * into the frame and shoots its body instead, which captures the whole document
 * rather than the visible box, and can be very tall.
 */
export async function screenshotScreen (projectId, {
  path, chatId, fullPage = false, visible = true, format = 'jpeg', quality = 85, width, height,
} = {}) {
  const p = await ensureProjectOpen(projectId, { chatId, visible })
  if (path) await openScreen(projectId, path, { visible })
  if (width && height) await p.setViewportSize({ width, height }).catch(() => {})

  await p.locator(SEL.viewer).first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {})
  await p.waitForTimeout(1200) // let fonts settle before capturing type

  const opts = format === 'png' ? { type: 'png' } : { type: 'jpeg', quality }

  if (fullPage) {
    const body = p.frameLocator(SEL.viewer).locator('body').first()
    if (await body.count().catch(() => 0)) return { buf: await body.screenshot(opts), target: 'frame body' }
  }

  const el = p.locator(SEL.viewer).first()
  if (await el.count().catch(() => 0)) return { buf: await el.screenshot(opts), target: 'viewer' }

  return { buf: await p.screenshot({ ...opts, fullPage }), target: 'whole page' }
}

const TEXTUAL = /\.(html?|css|js|jsx|ts|tsx|mjs|cjs|json|md|txt|svg|xml|yml|yaml)$/i
export const isTextual = (p) => TEXTUAL.test(p)

/**
 * Grep the project's own files without downloading them.
 *
 * The whole search runs inside the page in one round trip: a `.dc.html` runs to
 * hundreds of KB, and pulling 190 files over one RPC each (each a separate
 * page.evaluate, which serialises) would be far slower than letting the browser
 * fetch them in parallel and match there.
 */
export async function searchFiles (projectId, paths, { pattern, flags = 'i', contextLines = 2, maxMatches = 60 }) {
  const p = await getPage()
  return p.evaluate(
    async ([base, pid, list, src, fl, ctx, cap]) => {
      let re
      try {
        re = new RegExp(src, fl.includes('g') ? fl : fl + 'g')
      } catch (e) {
        return { error: `bad regex: ${e.message}` }
      }
      const out = []
      let scanned = 0
      let truncated = false

      const fetchOne = async (path) => {
        const r = await fetch(base + 'GetFile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId: pid, path }),
        })
        if (!r.ok) return null
        const j = await r.json()
        try {
          return new TextDecoder().decode(Uint8Array.from(atob(j.content || ''), (c) => c.charCodeAt(0)))
        } catch {
          return null
        }
      }

      // Modest pool: enough to overlap latency, not enough to trip rate limits.
      const queue = [...list]
      const worker = async () => {
        for (;;) {
          const path = queue.shift()
          if (path === undefined || out.length >= cap) return
          const body = await fetchOne(path).catch(() => null)
          if (body === null) continue
          scanned++
          const lines = body.split('\n')
          for (let i = 0; i < lines.length; i++) {
            re.lastIndex = 0
            if (!re.test(lines[i])) continue
            out.push({
              path,
              line: i + 1,
              text: lines.slice(Math.max(0, i - ctx), i + ctx + 1).join('\n').slice(0, 1200),
            })
            if (out.length >= cap) { truncated = true; return }
          }
        }
      }
      await Promise.all(Array.from({ length: 6 }, worker))
      return { matches: out, scanned, truncated }
    },
    [RPC_BASE, projectId, paths, pattern, flags, contextLines, maxMatches]
  )
}

async function goHome (visible) {
  const p = await getPage()
  if (visible !== undefined) await setWindowVisible(visible)
  if (!/^\/design\/?$/.test(new URL(p.url()).pathname)) {
    await p.goto(`${ORIGIN}/design`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  }
  await p.locator(SEL.homeComposer).first().waitFor({ state: 'visible', timeout: 60000 })
  return p
}

/**
 * Create a design system, or a plain project, straight over the RPC.
 *
 * Unlike createProject() this makes an empty one with no first prompt, which is
 * what you want for a design system: you then push components into it. The type
 * is fixed at creation and cannot be changed afterwards.
 */
export async function createProjectRpc (name, { type = DESIGN_SYSTEM } = {}) {
  const r = await rpc('CreateProject', { name, type })
  if (!r?.projectId) throw new Error(`CreateProject returned no projectId: ${JSON.stringify(r).slice(0, 300)}`)
  return { projectId: r.projectId, name, type }
}

export const getProject = (projectId) => rpc('GetProject', { projectId })

/** Which design systems a project currently designs against. */
export async function getProjectDesignSystems (projectId) {
  const r = await getProject(projectId)
  return (r.designSystems || []).map((d) => d.dsProjectId)
}

/**
 * Attach design systems to a project. Replaces the set, so pass everything you
 * want kept. New projects come with the account's default already attached.
 *
 * Read back rather than trusting the 200: this API has a habit of accepting a
 * malformed write and doing nothing.
 */
export async function setProjectDesignSystems (projectId, dsProjectIds) {
  await rpc('UpdateProjectDesignSystems', {
    projectId,
    designSystems: dsProjectIds.map((dsProjectId) => ({ dsProjectId, syncedAtVersion: '0' })),
  })
  const now = await getProjectDesignSystems(projectId)
  const missing = dsProjectIds.filter((id) => !now.includes(id))
  if (missing.length) throw new Error(`UpdateProjectDesignSystems reported success but did not attach: ${missing.join(', ')}`)
  return { projectId, designSystems: now }
}

/**
 * Write files into a project, e.g. components into a design system.
 *
 * The request is `mutations`, each carrying a `write` oneof, not a plain
 * `files` list. Getting that wrong is silent: the server returns 200, ignores
 * the unknown field, and the file ends up empty. So the write is verified by
 * reading back what landed.
 */
export async function writeFiles (projectId, files) {
  const resp = await rpc('WriteFiles', {
    projectId,
    mutations: files.map((f) => ({
      path: f.path,
      // `data` is a plain string, not proto bytes: text goes up as-is and only
      // binary is base64, flagged by `encoding`. Base64-encoding text stores
      // the base64 itself as the file contents.
      write: {
        data: f.content,
        encoding: f.encoding === 'base64' ? 'base64' : '',
      },
    })),
  })

  const written = []
  const empty = []
  for (const f of files) {
    const back = stripInjected((await getFile(projectId, f.path)).toString('utf8'))
    ;(back.trim() ? written : empty).push(f.path)
  }
  if (empty.length) throw new Error(`WriteFiles reported success but these came back empty: ${empty.join(', ')}`)
  return { resp, written }
}

/** The template tiles on the "What should we create?" screen. */
export async function listTemplates () {
  const p = await goHome()
  const tiles = p.locator(SEL.templateTile)
  await tiles.first().waitFor({ state: 'attached', timeout: 30000 }).catch(() => {})
  return p.evaluate(
    (sel) => [...document.querySelectorAll(sel)].map((b) => ({
      label: (b.getAttribute('aria-label') || b.innerText || '').replace(/\s+/g, ' ').trim(),
      selected: b.getAttribute('aria-pressed') === 'true',
    })),
    SEL.templateTile
  )
}

/**
 * Start a new project the way a person does: pick a template on the home
 * screen, describe what you want, send.
 *
 * The RPC (`CreateProject`) takes `{name, skills, type, designSystems}` where a
 * template is a "skills" payload, so calling it directly would mean hardcoding
 * each template's prompt and introductory message. Clicking the tile keeps
 * whatever the app currently ships, and starts the first generation in one go.
 * The project is named by Claude Design from the prompt.
 */
export async function createProject (prompt, { template, visible = true, attachments } = {}) {
  const p = await goHome(visible)

  let picked = null
  if (template) {
    const esc = template.replace(/["\\]/g, '\\$&')
    const tile = p.locator(`${SEL.templateTile}[aria-label*="${esc}" i]`).first()
    if (!(await tile.count().catch(() => 0))) {
      const all = await listTemplates()
      throw new Error(`No template matching "${template}". Available: ${all.map((t) => t.label).join(' | ')}`)
    }
    picked = await tile.getAttribute('aria-label')
    await tile.click({ timeout: 15000 })
    await p.waitForTimeout(500)
  }

  await p.locator(SEL.homeComposer).first().click()
  if (attachments?.length) await attachFiles(p, attachments)
  await p.keyboard.insertText(prompt)

  const before = await chatStreamCount()
  const send = p.locator(SEL.homeSend).first()
  if (!(await send.click({ timeout: 8000 }).then(() => true).catch(() => false))) {
    await p.keyboard.press('Enter')
  }

  await p.waitForURL(PROJECT_URL, { timeout: 180000 })
  const projectId = p.url().match(PROJECT_URL)[1]
  return { projectId, template: picked, before }
}

/** Chats newest-activity first, with the transcript attached. */
export function chatsOf (data) {
  const chats = Object.values(data.chats || {})
  chats.sort((a, b) => String(b.lastOpened || '').localeCompare(String(a.lastOpened || '')))
  return chats
}

export function pickChat (data, chatId) {
  const chats = chatsOf(data)
  if (chatId) {
    const hit = chats.find((c) => c.id === chatId)
    if (!hit) throw new Error(`No chat ${chatId} in this project. Known: ${chats.map((c) => c.id).join(', ') || '(none)'}`)
    return hit
  }
  const active = data.viewState?.activeChatId
  return chats.find((c) => c.id === active) || chats[0] || null
}

// Stable hooks the app ships, rather than guessed structural selectors.
const SEL = {
  composer: '[data-testid="chat-composer-input"]',
  send: '[data-testid="chat-send-button"]',
  chatHistory: '[data-testid="nav-chat-history"]',
  filesSwitcher: '[data-testid="files-switcher-trigger"]',
  fileRow: '[data-testid="files-switcher-row"]',
  menuRow: 'button.om-menu-item-btn',
  viewer: '[data-testid="html-viewer-iframe"]',
  title: '[data-testid="project-title"]',
  templateTile: '.om-grid button.om-grid-tile',
  // The home screen has its own composer, not the project one.
  homeComposer: '[data-testid="home-composer-input"]',
  homeSend: '[data-testid="home-composer-send"]',
  dsPicker: '[data-testid="composer-ds-picker-trigger"]',
  importButton: '[data-testid="composer-import-button"]',
}

export const DESIGN_SYSTEM = 'PROJECT_TYPE_DESIGN_SYSTEM'
export const PLAIN_PROJECT = 'PROJECT_TYPE_PROJECT'

const PROJECT_URL = /\/design\/p\/([0-9a-f-]{36})/i

/** "Prototype.dc.html" is listed in the page switcher as just "Prototype". */
const pageLabel = (path) => path.split('/').pop().replace(/\.dc\.html$/i, '')

/**
 * Bring the offscreen window onto the display (or push it back). Chrome is
 * launched headed because Cloudflare blocks headless, and parked offscreen so
 * it does not get in the way, so "show the user what is happening" is a window
 * move rather than a relaunch.
 */
export async function setWindowVisible (visible) {
  const p = await getPage()
  try {
    const cdp = await p.context().newCDPSession(p)
    const { windowId } = await cdp.send('Browser.getWindowForTarget')
    await cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: visible
        ? { left: 60, top: 60, width: 1400, height: 900, windowState: 'normal' }
        : { left: -2400, top: -2400, width: 1400, height: 900, windowState: 'normal' },
    })
    if (visible) await p.bringToFront()
    await cdp.detach().catch(() => {})
    return true
  } catch {
    return false
  }
}

export async function ensureProjectOpen (projectId, { chatId, visible } = {}) {
  const p = await getPage()
  if (visible !== undefined) await setWindowVisible(visible)

  const want = `/design/p/${projectId}`
  if (!p.url().includes(want)) {
    await p.goto(`${ORIGIN}${want}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  }
  // The composer only mounts once the project has loaded.
  await p.locator(SEL.composer).first().waitFor({ state: 'visible', timeout: 60000 })

  if (chatId) await switchChat(projectId, chatId)
  return p
}

/**
 * Switch the active chat.
 *
 * There is no URL for a chat: /design/p/<id>?chat=, /c/<id> and /chat/<id> all
 * load the project and leave the previously active chat selected (checked).
 * So it goes through the chat-history panel, and the RPC confirms it landed.
 */
export async function switchChat (projectId, chatId) {
  const p = await getPage()
  const data = await getProjectData(projectId)
  if (data.viewState?.activeChatId === chatId) return { switched: false, alreadyActive: true }

  const target = chatsOf(data).find((c) => c.id === chatId)
  if (!target) throw new Error(`No chat ${chatId} in this project.`)

  const title = (target.title || '').trim()
  await pickFromPopover(p, SEL.chatHistory, SEL.menuRow, [title])

  for (let i = 0; i < 15; i++) {
    await p.waitForTimeout(700)
    const now = await getProjectData(projectId)
    if (now.viewState?.activeChatId === chatId) return { switched: true }
  }
  throw new Error(`Clicked "${title}" but the active chat did not change to ${chatId}.`)
}

/**
 * Open one of the app's popovers and click a row in it.
 *
 * The two popovers differ: chat history is `button.om-menu-item-btn` inside a
 * `[role="menu"]`, the page switcher is `[data-testid="files-switcher-row"]`
 * in a plain panel. Both are matched by row selector rather than by container.
 *
 * Filtering by `:visible` matters twice over. Several menus are mounted at
 * once, so DOM order picks the wrong one, and a bare text match can land on
 * the page underneath, where the full-screen `[data-popover-backdrop]` then
 * swallows the click.
 */
async function pickFromPopover (p, triggerSel, rowSel, labels) {
  const rows = p.locator(`${rowSel}:visible`)

  await p.locator(triggerSel).first().click({ timeout: 15000 })
  let open = await rows.first().waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false)
  if (!open) {
    // A stale open popover swallows the first click; dismiss and retry once.
    await p.keyboard.press('Escape').catch(() => {})
    await p.waitForTimeout(400)
    await p.locator(triggerSel).first().click({ timeout: 15000 })
    open = await rows.first().waitFor({ state: 'visible', timeout: 12000 }).then(() => true).catch(() => false)
  }
  if (!open) throw new Error(`Clicking ${triggerSel} did not open a list of ${rowSel}.`)

  for (const label of labels.filter(Boolean)) {
    const hit = rows.filter({ hasText: label }).first()
    if (await hit.count().catch(() => 0)) {
      await hit.click({ timeout: 10000 })
      return true
    }
  }

  const available = await rows.allInnerTexts().catch(() => [])
  await p.keyboard.press('Escape').catch(() => {})
  throw new Error(
    `None of [${labels.join(', ')}] is in that list. Available: ` +
    available.map((s) => s.replace(/\s+/g, ' ').trim()).slice(0, 25).join(' | ')
  )
}

/**
 * Open a file in the project viewer, so the user can watch the right screen.
 * Matches on the path shown in the files switcher.
 */
export async function openScreen (projectId, path, { visible = true } = {}) {
  const p = await ensureProjectOpen(projectId, { visible })
  await pickFromPopover(p, SEL.filesSwitcher, SEL.fileRow, [pageLabel(path), path.split('/').pop(), path])
  await p.waitForTimeout(1500)
  return { opened: path }
}

/**
 * Type a prompt into the composer and send it.
 * Returns once the message is accepted, not once the answer is finished.
 */
/**
 * Attach local files (screenshots, references) to the composer.
 *
 * Prefers the hidden file input, which needs no menu navigation. Falls back to
 * driving the import button through a native file chooser.
 */
export async function attachFiles (p, files) {
  if (!files?.length) return null

  // No file input is mounted up front, and the import button opens a menu
  // (Attach file / Reference another project / Choose a repository / ...)
  // rather than a picker, so the chooser only appears after that row is hit.
  const input = p.locator('input[type="file"]').first()
  if (await input.count().catch(() => 0)) {
    await input.setInputFiles(files)
  } else {
    await p.locator(SEL.importButton).first().click({ timeout: 15000 })
    const row = p
      .locator('[role="menu"] button:visible, .om-menu-item-btn:visible')
      .filter({ hasText: /attach file/i })
      .first()
    await row.waitFor({ state: 'visible', timeout: 15000 })

    const [chooser] = await Promise.all([
      p.waitForEvent('filechooser', { timeout: 20000 }),
      row.click({ timeout: 10000 }),
    ])
    await chooser.setFiles(files)
  }

  // Uploads must finish before the send button will take them.
  await p.waitForTimeout(2500)
  return files.length
}

/** Open the composer's import menu and click one of its rows. */
async function openImportItem (p, label) {
  await p.keyboard.press('Escape').catch(() => {})
  await p.waitForTimeout(300)
  await p.locator(SEL.importButton).first().click({ timeout: 15000 })
  const row = p
    .locator('[role="menu"] button:visible, .om-menu-item-btn:visible')
    .filter({ hasText: new RegExp(label, 'i') })
    .first()
  await row.waitFor({ state: 'visible', timeout: 15000 })
  await row.click({ timeout: 10000 })
  await p.waitForTimeout(1500)
}

/**
 * Point a project at a GitHub repository, so designs start from real code.
 *
 * The connector is already authorised at the account level (the dialog shows
 * "Connected as ..."), so this only picks a repo. It does not grant access, and
 * it will not try to: if GitHub is not connected, it says so and stops.
 */
export async function chooseRepository (projectId, repo, { visible = true } = {}) {
  const p = await ensureProjectOpen(projectId, { visible })
  await openImportItem(p, 'Choose a repository')

  const dlg = p.locator('[role="dialog"]').last()
  await dlg.waitFor({ state: 'visible', timeout: 15000 })

  const body = await dlg.innerText().catch(() => '')
  if (!/connected as/i.test(body)) {
    await p.keyboard.press('Escape').catch(() => {})
    throw new Error('GitHub does not look connected. Connect it once in the browser; this tool will not drive an OAuth grant.')
  }

  // The search box carries no `type` attribute, so `input[type="text"]` misses
  // it even though the DOM property reports "text". Match the placeholder.
  const search = dlg.locator('input[placeholder*="epositor" i]').first()
  await search.fill(repo, { timeout: 15000 })
  await p.waitForTimeout(2000)

  // This is a Base UI radio group: the real control is a <span role="radio">
  // and the <input type="radio"> beside it is an aria-hidden proxy that never
  // becomes checked. The input is a *sibling*, not an ancestor, so clicking it
  // or its closest() parent silently does nothing. Drive the span.
  const row = dlg.locator('[role="radio"]').filter({ hasText: repo }).first()
  if (!(await row.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false))) {
    const available = await dlg
      .locator('input[type="radio"]')
      .evaluateAll((els) => els.map((e) => e.value))
      .catch(() => [])
    await p.keyboard.press('Escape').catch(() => {})
    throw new Error(`No repository matched "${repo}". Visible: ${available.slice(0, 15).join(', ') || 'none'}`)
  }

  // Name comes from the proxy input's value ("owner/repo"); the span's own text
  // starts with an icon node and reads blank.
  const chosen = await dlg
    .locator('input[type="radio"]')
    .evaluateAll((els, want) => {
      const hit = els.find((e) => (e.value || '').toLowerCase().includes(want.toLowerCase()))
      return hit ? hit.value : want
    }, repo)
  await row.click({ timeout: 10000 })

  if ((await row.getAttribute('aria-checked')) !== 'true') {
    await row.press('Space').catch(() => {}) // radio groups take the spacebar
    await p.waitForTimeout(600)
    if ((await row.getAttribute('aria-checked')) !== 'true') {
      await p.keyboard.press('Escape').catch(() => {})
      throw new Error(`Clicked "${chosen}" but the row did not select.`)
    }
  }
  await p.waitForTimeout(600)

  await dlg.getByRole('button', { name: /continue/i }).first().click({ timeout: 10000 })
  await p.waitForTimeout(2500)
  return { repo: chosen }
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.cache', 'coverage', '.venv', '__pycache__'])

/** Read a directory into a nested {dirs, files} tree, bounded so a big repo cannot blow up the page. */
async function readTree (root, { maxFiles = 1200, maxBytes = 6 * 1024 * 1024 } = {}) {
  const { readdir, readFile, stat } = await import('node:fs/promises')
  let files = 0
  let bytes = 0
  const skipped = []

  const walk = async (dir) => {
    const node = { dirs: {}, files: {} }
    let entries = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return node
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.gitignore') continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) { skipped.push(`${e.name}/`); continue }
        node.dirs[e.name] = await walk(full)
      } else if (e.isFile()) {
        if (files >= maxFiles || bytes >= maxBytes) { skipped.push(e.name); continue }
        const s = await stat(full).catch(() => null)
        if (!s || s.size > 512 * 1024) { skipped.push(e.name); continue }
        if (!isTextual(e.name)) { skipped.push(e.name); continue }
        node.files[e.name] = await readFile(full, 'utf8').catch(() => '')
        files++
        bytes += s.size
      }
    }
    return node
  }

  return { tree: await walk(root), files, bytes, skipped }
}

/**
 * Attach a local folder as the project's codebase.
 *
 * The dialog's "browse…" calls `window.showDirectoryPicker()`, a native OS
 * dialog no automation can drive, and there is no file input to fall back on.
 * So the picker is replaced with one that resolves to a synthetic
 * FileSystemDirectoryHandle built from a tree read here in Node.
 *
 * The handle is given the real prototype so any `instanceof` check still
 * passes, while our own methods shadow the native ones (which would throw on a
 * foreign object). Only text files are sent, bounded by count and total bytes.
 */
export async function linkLocalCode (projectId, dir, { visible = true, maxFiles, maxBytes } = {}) {
  const root = resolve(dir)
  const { tree, files, bytes, skipped } = await readTree(root, { maxFiles, maxBytes })
  if (!files) throw new Error(`No text files found under ${root}`)

  const p = await ensureProjectOpen(projectId, { visible })
  await openImportItem(p, 'Link local code')

  const dlg = p.locator('[role="dialog"]').last()
  await dlg.waitFor({ state: 'visible', timeout: 15000 })

  await p.evaluate(
    ([name, node]) => {
      const mkFile = (fname, content) => {
        const h = {
          kind: 'file',
          name: fname,
          isSameEntry: async (o) => o === h,
          queryPermission: async () => 'granted',
          requestPermission: async () => 'granted',
          getFile: async () => new File([content], fname, { lastModified: 0 }),
        }
        if (window.FileSystemFileHandle) Object.setPrototypeOf(h, window.FileSystemFileHandle.prototype)
        return h
      }
      const mkDir = (dname, n) => {
        const h = {
          kind: 'directory',
          name: dname,
          isSameEntry: async (o) => o === h,
          queryPermission: async () => 'granted',
          requestPermission: async () => 'granted',
          resolve: async () => null,
          getFileHandle: async (k) => {
            if (k in n.files) return mkFile(k, n.files[k])
            throw new DOMException(`${k} not found`, 'NotFoundError')
          },
          getDirectoryHandle: async (k) => {
            if (k in n.dirs) return mkDir(k, n.dirs[k])
            throw new DOMException(`${k} not found`, 'NotFoundError')
          },
          async * entries () {
            for (const k of Object.keys(n.files)) yield [k, mkFile(k, n.files[k])]
            for (const k of Object.keys(n.dirs)) yield [k, mkDir(k, n.dirs[k])]
          },
          async * keys () { for await (const [k] of h.entries()) yield k },
          async * values () { for await (const [, v] of h.entries()) yield v },
          [Symbol.asyncIterator] () { return h.entries() },
        }
        if (window.FileSystemDirectoryHandle) Object.setPrototypeOf(h, window.FileSystemDirectoryHandle.prototype)
        return h
      }
      window.__cdHandle = mkDir(name, node)
      window.showDirectoryPicker = async () => window.__cdHandle
    },
    [root.split('/').pop() || 'project', tree]
  )

  await dlg.locator('button, [role="button"]').filter({ hasText: /browse/i }).first().click({ timeout: 10000 })
  await p.waitForTimeout(3000)

  const attach = dlg.locator('button').filter({ hasText: /^attach$/i }).first()
  if (await attach.count().catch(() => 0)) {
    await attach.click({ timeout: 15000 }).catch(() => {})
    await p.waitForTimeout(3000)
  }

  return { root, files, bytes, skipped: [...new Set(skipped)].slice(0, 20) }
}

/** Push a .fig file in through the import menu. */
export async function uploadFig (projectId, file, { visible = true } = {}) {
  const p = await ensureProjectOpen(projectId, { visible })
  const chooserPromise = p.waitForEvent('filechooser', { timeout: 20000 })
  await openImportItem(p, 'Upload .fig')
  const chooser = await chooserPromise.catch(() => null)
  if (!chooser) {
    await p.keyboard.press('Escape').catch(() => {})
    throw new Error('"Upload .fig file" did not open a file chooser. It may be a documentation link rather than an upload in this build.')
  }
  await chooser.setFiles([file])
  await p.waitForTimeout(3000)
  return { uploaded: file }
}

export async function submitPrompt (projectId, prompt, { chatId, visible, attachments } = {}) {
  const p = await ensureProjectOpen(projectId, { chatId, visible })
  const box = p.locator(SEL.composer).first()

  await box.click()
  if (attachments?.length) await attachFiles(p, attachments)
  await p.keyboard.insertText(prompt)

  const before = await chatStreamCount()

  // Prefer the real send button; fall back to Enter if it is not enabled yet.
  const send = p.locator(SEL.send).first()
  const clicked = await send.click({ timeout: 5000 }).then(() => true).catch(() => false)
  if (!clicked) await p.keyboard.press('Enter')

  const cleared = await p
    .waitForFunction(
      (sel) => {
        const el = document.querySelector(sel)
        return !!el && el.innerText.trim().length === 0
      },
      SEL.composer,
      { timeout: 8000 }
    )
    .then(() => true)
    .catch(() => false)

  if (!cleared) throw new Error('The composer still holds the text, so the prompt did not send.')
  return { before }
}

export async function chatStreamCount () {
  const p = await getPage()
  return p.evaluate(() => window.__cdBridge?.chatEnds.length ?? 0)
}

/**
 * Wait until Claude Design stops working.
 *
 * A single user turn is several Chat streams: the model asks for a tool, the
 * browser runs it, the next stream carries the result. So completion is not
 * "a stream ended" but "no stream has ended for a while".
 */
/**
 * Wait for a real answer, not just for the network to go quiet.
 *
 * Stream-quiet alone is not enough: a long tool call is silent, so a turn can
 * look finished mid-flight. The decisive signal is an assistant message with
 * content landing in the transcript, so both are required. The transcript RPC
 * is heavy, so it is only polled once things have already gone quiet.
 */
export async function waitForReply ({ projectId, chatId, sinceCount, before = 0, idleMs = 10000, timeoutMs = 900000 }) {
  const p = await getPage()
  const started = Date.now()
  let sawStream = false
  let streams = 0
  let lastEnd = 0
  let lastPoll = 0

  const snapshot = async () => {
    const data = await getProjectData(projectId)
    const chat = pickChat(data, chatId)
    const fresh = (chat?.messages || []).slice(sinceCount)
    return { data, chat, fresh }
  }

  for (;;) {
    const s = await p.evaluate(() => {
      const e = window.__cdBridge?.chatEnds ?? []
      return { count: e.length, last: e.length ? e[e.length - 1] : 0 }
    })
    if (s.count > before) {
      sawStream = true
      streams = s.count - before
      lastEnd = s.last
    }

    const quiet = sawStream && lastEnd && Date.now() - lastEnd >= idleMs
    if (quiet && Date.now() - lastPoll > 5000) {
      lastPoll = Date.now()
      const snap = await snapshot()
      if (snap.fresh.some((m) => m.role === 'assistant' && String(m.content ?? '').trim())) {
        return { ...snap, streams, timedOut: false }
      }
    }

    if (!sawStream && Date.now() - started > 45000) {
      return { ...(await snapshot()), streams: 0, timedOut: true, neverStarted: true }
    }
    if (Date.now() - started > timeoutMs) {
      return { ...(await snapshot()), streams, timedOut: true }
    }
    await p.waitForTimeout(2000)
  }
}

export async function waitForIdle ({ before = 0, idleMs = 6000, timeoutMs = 600000 } = {}) {
  const p = await getPage()
  const started = Date.now()
  let sawAny = false

  for (;;) {
    const { count, last } = await p.evaluate(() => {
      const s = window.__cdBridge
      const ends = s?.chatEnds ?? []
      return { count: ends.length, last: ends.length ? ends[ends.length - 1] : 0 }
    })

    if (count > before) sawAny = true

    if (sawAny && last && Date.now() - last >= idleMs) {
      return { streams: count - before, timedOut: false }
    }
    if (Date.now() - started > timeoutMs) {
      return { streams: Math.max(0, count - before), timedOut: true }
    }
    // Nothing ever started: the send probably did not land.
    if (!sawAny && Date.now() - started > 45000) {
      return { streams: 0, timedOut: true, neverStarted: true }
    }
    await p.waitForTimeout(1000)
  }
}
