// Read-only smoke test. Spends no credits and changes nothing.
//   node src/smoke.mjs [projectId]

import { listProjects, getProjectData, listFiles, chatsOf, pickChat, closeSession } from './session.mjs'

const t0 = Date.now()
const step = (s) => console.log(`\n[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`)

try {
  step('list_projects')
  const projects = await listProjects()
  for (const p of projects) console.log(`  ${p.projectId}  ${p.name}`)
  if (!projects.length) throw new Error('no projects returned')

  const target = process.argv[2] || projects[0].projectId

  step(`getProjectData ${target}`)
  const data = await getProjectData(target)
  console.log(`  name: ${data.name}`)
  console.log(`  chats: ${chatsOf(data).length}, active: ${data.viewState?.activeChatId || 'none'}`)

  step('read the tail of the active chat')
  const chat = pickChat(data)
  const msgs = (chat?.messages || []).filter((m) => (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim())
  console.log(`  chat "${chat?.title}" (${chat?.id}), ${chat?.messages?.length} messages`)
  for (const m of msgs.slice(-3)) {
    console.log(`  --- ${m.role} ${m.timestamp}`)
    console.log(`      ${String(m.content).replace(/\n/g, ' ').slice(0, 160)}`)
  }

  step('listFiles')
  const files = await listFiles(target)
  console.log(`  ${files.length} entries, e.g. ${files.slice(0, 3).map((f) => f.path).join(', ')}`)
  console.log(`  entry keys: ${Object.keys(files[0] || {}).join(', ')}`)

  step('PASS')
} catch (e) {
  console.error(`\nFAIL: ${e.message}`)
  process.exitCode = 1
} finally {
  await closeSession()
}
