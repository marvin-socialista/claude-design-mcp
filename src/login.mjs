// One-time sign-in for this tool's browser profile.
// Opens a real window, waits for you to log in, then flushes the profile.

import { getPage, setWindowVisible, closeSession, ORIGIN, PROFILE, USER_DATA_DIR } from './session.mjs'

const page = await getPage({ requireLogin: false })
await setWindowVisible(true)
await page.goto(`${ORIGIN}/design`, { waitUntil: 'domcontentloaded' }).catch(() => {})

console.log(`
Profile: ${USER_DATA_DIR || PROFILE}

Sign in to claude.ai in the window that just opened, then come back here and
press Enter. Do not close the window yourself: closing it from here is what
writes the session to disk.
`)

await new Promise((r) => process.stdin.once('data', r))

const url = page.url()
await closeSession()

console.log(url.includes('claude.ai/design') ? 'Saved. You can start the MCP server now.' : `Ended on ${url}. If that is not claude.ai/design, run it again.`)
process.exit(0)
