#!/usr/bin/env node
// MCP server: drive claude.ai/design from Claude Code.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  listProjects, getProjectData, listFiles, filePaths, getFile,
  chatsOf, pickChat, submitPrompt, waitForIdle, closeSession,
  ensureProjectOpen, switchChat, openScreen, setWindowVisible,
} from './session.mjs'

const NOISE_KINDS = new Set(['summary-placeholder', 'question-record'])

const text = (s) => ({ content: [{ type: 'text', text: s }] })

function clip (s, max) {
  s = String(s ?? '')
  return s.length <= max ? s : `${s.slice(0, max)}\n…[clipped, ${s.length} chars total]`
}

function renderMessages (msgs, { maxChars, includeAll }) {
  const keep = msgs.filter((m) => {
    if (includeAll) return true
    if (m.role !== 'user' && m.role !== 'assistant') return false
    if (NOISE_KINDS.has(m.kind)) return false
    return String(m.content ?? '').trim().length > 0
  })
  if (!keep.length) return '(no messages)'
  return keep
    .map((m) => {
      const kind = m.kind && m.kind !== 'chat' ? ` (${m.kind})` : ''
      return `### ${m.role}${kind}  ${m.timestamp || ''}\n${clip(m.content, maxChars)}`
    })
    .join('\n\n')
}

const server = new McpServer({ name: 'claude-design', version: '0.1.0' })

server.registerTool(
  'list_projects',
  {
    title: 'List Claude Design projects',
    description: 'List every claude.ai/design project you can open, with its projectId. Start here to pick the right project.',
    inputSchema: {},
  },
  async () => {
    const items = await listProjects()
    if (!items.length) return text('No projects found.')
    const rows = items.map((p) => `- ${p.name}\n  id: ${p.projectId}\n  last viewed: ${p.viewedAt || 'unknown'}`)
    return text(`${items.length} project(s):\n\n${rows.join('\n')}`)
  }
)

server.registerTool(
  'list_chats',
  {
    title: 'List chats in a project',
    description: 'List the chat threads inside one Claude Design project, newest first, marking which one is active.',
    inputSchema: { projectId: z.string().describe('Project UUID from list_projects') },
  },
  async ({ projectId }) => {
    const data = await getProjectData(projectId)
    const active = data.viewState?.activeChatId
    const chats = chatsOf(data)
    if (!chats.length) return text(`Project "${data.name}" has no chats yet.`)
    const rows = chats.map((c) => {
      const n = (c.messages || []).length
      return `- ${c.title || '(untitled)'}${c.id === active ? '  [ACTIVE]' : ''}\n  id: ${c.id}\n  ${n} messages, last opened ${c.lastOpened || 'unknown'}`
    })
    return text(`Project "${data.name}":\n\n${rows.join('\n')}`)
  }
)

server.registerTool(
  'read_chat',
  {
    title: 'Read a Claude Design chat',
    description:
      "Read what Claude Design has said. Returns the tail of the transcript for one chat. This is the read side of the conversation: use it after send_prompt, or on its own to catch up on what was discussed in the browser.",
    inputSchema: {
      projectId: z.string().describe('Project UUID'),
      chatId: z.string().optional().describe('Chat id. Defaults to the active chat.'),
      limit: z.number().int().min(1).max(200).default(12).describe('How many recent messages to return'),
      maxChars: z.number().int().min(200).max(50000).default(4000).describe('Per-message clip length'),
      includeAll: z.boolean().default(false).describe('Include system/bookkeeping messages too'),
    },
  },
  async ({ projectId, chatId, limit, maxChars, includeAll }) => {
    const data = await getProjectData(projectId)
    const chat = pickChat(data, chatId)
    if (!chat) return text('This project has no chats.')
    const all = chat.messages || []
    const tail = all.slice(-limit)
    return text(
      `Project "${data.name}" / chat "${chat.title || chat.id}" (${chat.id})\n` +
      `${all.length} messages total, showing last ${tail.length}\n\n` +
      renderMessages(tail, { maxChars, includeAll })
    )
  }
)

server.registerTool(
  'send_prompt',
  {
    title: 'Send instructions to Claude Design',
    description:
      "Give Claude Design an instruction in one project and wait for it to finish, then return what it said and which files it touched. " +
      "It runs its own agent loop (reading and writing project files, taking screenshots), so a single prompt can take minutes. " +
      "Sends into the project's active chat.",
    inputSchema: {
      projectId: z.string().describe('Project UUID from list_projects'),
      prompt: z.string().min(1).describe('What Claude Design should do'),
      chatId: z.string().optional().describe('Chat to post into. Defaults to whichever is already active.'),
      visible: z.boolean().default(true).describe('Show the browser window so the user can watch it work'),
      wait: z.boolean().default(true).describe('Wait for it to finish. false returns as soon as the prompt is sent.'),
      idleSeconds: z.number().int().min(2).max(120).default(8).describe('Quiet period that counts as finished'),
      timeoutSeconds: z.number().int().min(30).max(3600).default(900).describe('Give up waiting after this long'),
      maxChars: z.number().int().min(200).max(50000).default(6000).describe('Per-message clip length'),
    },
  },
  async ({ projectId, prompt, chatId, visible, wait, idleSeconds, timeoutSeconds, maxChars }) => {
    // Aim at the right chat before measuring, so the transcript diff is taken
    // against the thread the reply will actually land in.
    await ensureProjectOpen(projectId, { chatId, visible })

    const pre = await getProjectData(projectId)
    const preChat = pickChat(pre, chatId)
    const preCount = preChat ? (preChat.messages || []).length : 0
    const preFiles = new Set(filePaths(await listFiles(projectId)))

    const { before } = await submitPrompt(projectId, prompt, { chatId, visible })

    if (!wait) {
      return text(`Sent to project ${projectId}. Not waiting.\nUse read_chat to see the reply once it lands.`)
    }

    const result = await waitForIdle({
      before,
      idleMs: idleSeconds * 1000,
      timeoutMs: timeoutSeconds * 1000,
    })

    if (result.neverStarted) {
      return text(
        'The prompt was typed but no Chat request ever started, so it probably did not send.\n' +
        'Run with CLAUDE_DESIGN_HEADED=1 to watch the window, and check the composer.'
      )
    }

    const post = await getProjectData(projectId)
    const postChat = pickChat(post, preChat?.id)
    const fresh = (postChat?.messages || []).slice(preCount)

    // Entries carry no version or mtime, so only appearances and deletions are
    // detectable. Edits to an existing file do not show up here; the reply text
    // below is what tells you those.
    const postPaths = filePaths(await listFiles(projectId))
    const added = postPaths.filter((p) => !preFiles.has(p))
    const removed = [...preFiles].filter((p) => !postPaths.includes(p))
    const list = (label, xs) =>
      xs.length ? `${label} (${xs.length}): ${xs.slice(0, 40).join(', ')}${xs.length > 40 ? ' …' : ''}\n` : ''

    const head =
      `Project "${post.name}" / chat ${postChat?.id}\n` +
      `${result.streams} model turn(s)${result.timedOut ? ', TIMED OUT waiting for idle' : ''}\n` +
      list('Files added', added) +
      list('Files removed', removed) +
      (added.length || removed.length ? '' : 'No files added or removed (in-place edits are not detectable).\n')

    return text(`${head}\n${renderMessages(fresh, { maxChars, includeAll: false })}`)
  }
)

server.registerTool(
  'open_screen',
  {
    title: 'Show a screen on the user\'s display',
    description:
      "Bring the Claude Design window on screen and open a project, optionally a specific chat and a specific file, so the user can watch. " +
      "Use this before send_prompt when the user should see the work happen, and to show them a finished screen. " +
      "The browser normally sits parked offscreen, so nothing is visible until this is called.",
    inputSchema: {
      projectId: z.string(),
      path: z.string().optional().describe('File to open in the viewer, e.g. Prototype.dc.html'),
      chatId: z.string().optional().describe('Chat to make active first'),
      visible: z.boolean().default(true).describe('false parks the window back offscreen'),
    },
  },
  async ({ projectId, path, chatId, visible }) => {
    if (!visible) {
      await setWindowVisible(false)
      return text('Window parked offscreen.')
    }
    await ensureProjectOpen(projectId, { chatId, visible: true })
    if (!path) return text(`Opened project ${projectId}${chatId ? ` on chat ${chatId}` : ''} on screen.`)
    const r = await openScreen(projectId, path, { visible: true })
    return text(`Showing ${r.opened} on screen.`)
  }
)

server.registerTool(
  'switch_chat',
  {
    title: 'Switch the active chat',
    description:
      'Make a different chat thread active in a project. send_prompt always posts into the active chat, so use this to aim it at the right conversation.',
    inputSchema: { projectId: z.string(), chatId: z.string() },
  },
  async ({ projectId, chatId }) => {
    await ensureProjectOpen(projectId)
    const r = await switchChat(projectId, chatId)
    return text(r.alreadyActive ? `Chat ${chatId} was already active.` : `Switched to chat ${chatId}.`)
  }
)

server.registerTool(
  'list_files',
  {
    title: 'List project files',
    description: 'List the files in a Claude Design project.',
    inputSchema: {
      projectId: z.string(),
      prefix: z.string().optional().describe('Only paths starting with this'),
    },
  },
  async ({ projectId, prefix }) => {
    let paths = filePaths(await listFiles(projectId))
    if (prefix) paths = paths.filter((p) => p.startsWith(prefix))
    if (!paths.length) return text('No matching files.')
    return text(`${paths.length} file(s):\n${paths.sort().join('\n')}`)
  }
)

server.registerTool(
  'read_file',
  {
    title: 'Read a project file',
    description: 'Read one text file out of a Claude Design project.',
    inputSchema: {
      projectId: z.string(),
      path: z.string().describe('Project-relative path, e.g. Prototype.dc.html'),
      maxChars: z.number().int().min(500).max(400000).default(60000),
    },
  },
  async ({ projectId, path, maxChars }) => {
    const buf = await getFile(projectId, path)
    if (buf.includes(0)) return text(`${path} looks binary (${buf.length} bytes). Use pull_files to save it to disk.`)
    return text(clip(buf.toString('utf8'), maxChars))
  }
)

server.registerTool(
  'pull_files',
  {
    title: 'Pull project files to disk',
    description: 'Download files from a Claude Design project into a local directory, preserving paths. Handles binaries.',
    inputSchema: {
      projectId: z.string(),
      dest: z.string().describe('Local directory to write into'),
      prefix: z.string().optional().describe('Only paths starting with this'),
      paths: z.array(z.string()).optional().describe('Explicit list of paths, overrides prefix'),
    },
  },
  async ({ projectId, dest, prefix, paths }) => {
    const root = resolve(dest)
    let wanted = paths
    if (!wanted) {
      wanted = filePaths(await listFiles(projectId)).filter((p) => !prefix || p.startsWith(prefix))
    }
    if (!wanted.length) return text('Nothing matched.')

    const written = []
    const failed = []
    for (const p of wanted) {
      try {
        const buf = await getFile(projectId, p)
        const out = join(root, p)
        await mkdir(dirname(out), { recursive: true })
        await writeFile(out, buf)
        written.push(`${p} (${buf.length}b)`)
      } catch (e) {
        failed.push(`${p}: ${e.message}`)
      }
    }
    return text(
      `Wrote ${written.length} file(s) to ${root}\n${written.join('\n')}` +
      (failed.length ? `\n\nFailed ${failed.length}:\n${failed.join('\n')}` : '')
    )
  }
)

server.registerTool(
  'close_browser',
  {
    title: 'Close the Claude Design browser',
    description: 'Shut the background Chrome down and flush its profile. Call this when you are done for a while.',
    inputSchema: {},
  },
  async () => {
    await closeSession()
    return text('Closed.')
  }
)

const shutdown = async () => {
  await closeSession().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

await server.connect(new StdioServerTransport())
