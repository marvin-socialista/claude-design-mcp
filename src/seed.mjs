// Copy an existing claude.ai session into this tool's own browser profile, so
// you do not have to sign in a second time.
//
//   node src/seed.mjs [sourceUserDataDir]
//
// Only cookies scoped to claude.ai / claude.com are copied. Nothing else from
// the source profile is touched or duplicated. The source browser must be closed.

import { join } from 'node:path'
import { homedir } from 'node:os'
import { chromium, getPage, closeSession, ORIGIN, PROFILE } from './session.mjs'

const source = process.argv[2] || join(homedir(), '.claude', 'playwright-profile')
console.log(`source: ${source}\ntarget profile: ${PROFILE}\n`)

const src = await chromium.launchPersistentContext(source, { channel: 'chrome', headless: true })
const cookies = (await src.cookies()).filter((c) => /(^|\.)claude\.(ai|com)$/.test(c.domain.replace(/^\./, '')))
await src.close()

if (!cookies.length) {
  console.error('No claude.ai cookies in the source profile. Sign in there first, or use: npm run login')
  process.exit(1)
}
console.log(`copying ${cookies.length} cookie(s): ${cookies.map((c) => c.name).join(', ')}`)

const page = await getPage({ requireLogin: false })
await page.context().addCookies(cookies)
await page.goto(`${ORIGIN}/design`, { waitUntil: 'domcontentloaded', timeout: 60000 })
const ok = new URL(page.url()).origin === ORIGIN
console.log(`\nlanded on: ${page.url()}`)
await closeSession() // closing is what flushes the profile to disk

console.log(ok ? '\nSeeded. The MCP server will work now.' : '\nStill redirected. Run: npm run login')
process.exit(ok ? 0 : 1)
