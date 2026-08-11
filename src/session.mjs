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
import { join } from 'node:path'
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
}

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
export async function submitPrompt (projectId, prompt, { chatId, visible } = {}) {
  const p = await ensureProjectOpen(projectId, { chatId, visible })
  const box = p.locator(SEL.composer).first()

  await box.click()
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
