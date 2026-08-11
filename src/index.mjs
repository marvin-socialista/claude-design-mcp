#!/usr/bin/env node
// MCP server: drive claude.ai/design from Claude Code.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  listProjects, getProjectData, listFiles, filePaths, getFile,
  chatsOf, pickChat, submitPrompt, waitForReply, closeSession,
  ensureProjectOpen, switchChat, openScreen, setWindowVisible,
  screenshotScreen, searchFiles, isTextual, listTemplates, createProject,
  createProjectRpc, setProjectDesignSystems, writeFiles, stripInjected,
  chooseRepository, uploadFig,
  DESIGN_SYSTEM, PLAIN_PROJECT,
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
    description: 'List every claude.ai/design project you can open, with its projectId and whether it is a design system. Start here to pick the right project.',
    inputSchema: {
      kind: z.enum(['all', 'projects', 'design_systems']).default('all').describe('Filter by project type'),
    },
  },
  async ({ kind }) => {
    let items = await listProjects()
    if (kind === 'projects') items = items.filter((p) => p.type === PLAIN_PROJECT)
    if (kind === 'design_systems') items = items.filter((p) => p.type === DESIGN_SYSTEM)
    if (!items.length) return text('No projects found.')
    const rows = items.map((p) =>
      `- ${p.name}${p.type === DESIGN_SYSTEM ? '  [design system]' : ''}\n  id: ${p.projectId}\n  last viewed: ${p.viewedAt || 'unknown'}`)
    return text(`${items.length} project(s):\n\n${rows.join('\n')}`)
  }
)

server.registerTool(
  'list_templates',
  {
    title: 'List project templates',
    description: 'The template tiles on the Claude Design home screen (Blank, Mobile app design, Slides, Wireframe, Diagram and the rest). Use before create_project to pick one by name.',
    inputSchema: {},
  },
  async () => {
    const t = await listTemplates()
    if (!t.length) return text('No template tiles found on the home screen.')
    return text(t.map((x) => `- ${x.label}${x.selected ? '  [default]' : ''}`).join('\n'))
  }
)

server.registerTool(
  'create_project',
  {
    title: 'Create a new Claude Design project',
    description:
      'Start a brand new project from the home screen: pick a template, describe what to create, and it begins building. ' +
      'Returns the new projectId. Claude Design names the project from your prompt. ' +
      'Attach local images (screenshots, references) with `attachments` to design from them.',
    inputSchema: {
      prompt: z.string().min(1).describe('What to create. This is the "What should we create?" box.'),
      template: z.string().optional().describe('Template name or fragment, e.g. "Mobile app" or "Slides". Omit for Blank.'),
      attachments: z.array(z.string()).optional().describe('Local file paths to attach, e.g. screenshots from this repo'),
      visible: z.boolean().default(true).describe('Show the window so the user can watch'),
      wait: z.boolean().default(true).describe('Wait for the first build to finish'),
      idleSeconds: z.number().int().min(2).max(300).default(20),
      timeoutSeconds: z.number().int().min(30).max(3600).default(1500),
      maxChars: z.number().int().min(200).max(50000).default(4000),
    },
  },
  async ({ prompt, template, attachments, visible, wait, idleSeconds, timeoutSeconds, maxChars }) => {
    const { projectId, template: picked, before } = await createProject(prompt, { template, visible, attachments })
    const head = `Created project ${projectId}${picked ? ` from template "${picked}"` : ''}.\n`

    if (!wait) return text(`${head}Not waiting. Use read_chat to follow along.`)

    const r = await waitForReply({
      projectId,
      sinceCount: 0,
      before,
      idleMs: idleSeconds * 1000,
      timeoutMs: timeoutSeconds * 1000,
    })
    const replied = r.fresh.some((m) => m.role === 'assistant' && String(m.content ?? '').trim())
    return text(
      `${head}Project name: "${r.data?.name}"\n${r.streams} model turn(s)\n` +
      (r.timedOut && !replied ? 'TIMED OUT: still building. Do not close the browser; check read_chat.\n' : '') +
      `\n${renderMessages(r.fresh, { maxChars, includeAll: false })}`
    )
  }
)

server.registerTool(
  'create_design_system',
  {
    title: 'Create a design system',
    description:
      'Create an empty design-system project. A project type is fixed at creation and cannot be changed later, ' +
      'so a design system has to be made as one from the start. Push components into it with write_files, ' +
      'then attach it to projects with link_design_systems so their chats design against it.',
    inputSchema: { name: z.string().min(1).describe('Name for the design system') },
  },
  async ({ name }) => {
    const r = await createProjectRpc(name, { type: DESIGN_SYSTEM })
    return text(`Created design system "${r.name}"\nid: ${r.projectId}`)
  }
)

server.registerTool(
  'link_design_systems',
  {
    title: 'Attach design systems to a project',
    description:
      'Set which design systems a project designs against. Replaces the current set, so pass every one you want kept. ' +
      'Pass an empty list to detach all.',
    inputSchema: {
      projectId: z.string(),
      designSystemIds: z.array(z.string()).describe('Project ids of design systems. Empty array detaches all.'),
    },
  },
  async ({ projectId, designSystemIds }) => {
    const r = await setProjectDesignSystems(projectId, designSystemIds)
    const all = await listProjects()
    const name = (id) => all.find((p) => p.projectId === id)?.name || id
    return text(r.designSystems.length
      ? `${projectId} now designs against:\n${r.designSystems.map((id) => `- ${name(id)}  (${id})`).join('\n')}`
      : `Detached all design systems from ${projectId}.`)
  }
)

server.registerTool(
  'choose_repository',
  {
    title: 'Design against a GitHub repository',
    description:
      'Point a project at one of the connected GitHub repositories, so new designs start from the product that already exists. ' +
      'Requires GitHub to be connected on the account already; this will not perform an OAuth grant.',
    inputSchema: {
      projectId: z.string(),
      repo: z.string().describe('Repository name or fragment, e.g. claude-design-mcp'),
      visible: z.boolean().default(true),
    },
  },
  async ({ projectId, repo, visible }) => {
    const r = await chooseRepository(projectId, repo, { visible })
    return text(`${projectId} now designs against repository: ${r.repo}`)
  }
)

server.registerTool(
  'upload_fig',
  {
    title: 'Upload a .fig file',
    description: 'Push a Figma .fig file from disk into a project through the import menu.',
    inputSchema: {
      projectId: z.string(),
      path: z.string().describe('Local path to the .fig file'),
      visible: z.boolean().default(true),
    },
  },
  async ({ projectId, path, visible }) => {
    const r = await uploadFig(projectId, path, { visible })
    return text(`Uploaded ${r.uploaded}`)
  }
)

server.registerTool(
  'write_files',
  {
    title: 'Write files into a project',
    description:
      'Write or overwrite files in a Claude Design project or design system. ' +
      'Use to push components, tokens or assets up from the repo. Overwrites without asking, so read first if unsure.',
    inputSchema: {
      projectId: z.string(),
      files: z.array(z.object({
        path: z.string().describe('Project-relative path'),
        content: z.string().describe('File contents'),
        encoding: z.enum(['utf8', 'base64']).default('utf8'),
      })).min(1).max(50),
    },
  },
  async ({ projectId, files }) => {
    await writeFiles(projectId, files)
    return text(`Wrote ${files.length} file(s) to ${projectId}:\n${files.map((f) => f.path).join('\n')}`)
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
      attachments: z.array(z.string()).optional().describe('Local file paths to attach, e.g. a screenshot from this repo to design from or compare against'),
      referenceProjectIds: z.array(z.string()).optional().describe('Other projects to pull context from. Their URLs are appended to the prompt, which is how Claude Design picks them up.'),
      visible: z.boolean().default(true).describe('Show the browser window so the user can watch it work'),
      wait: z.boolean().default(true).describe('Wait for it to finish. false returns as soon as the prompt is sent.'),
      idleSeconds: z.number().int().min(2).max(300).default(15).describe('Network-quiet period before checking for a reply. Raise it for jobs with long tool calls.'),
      timeoutSeconds: z.number().int().min(30).max(3600).default(900).describe('Give up waiting after this long'),
      maxChars: z.number().int().min(200).max(50000).default(6000).describe('Per-message clip length'),
    },
  },
  async ({ projectId, prompt, chatId, attachments, referenceProjectIds, visible, wait, idleSeconds, timeoutSeconds, maxChars }) => {
    // "Reference another project" is not a menu action: the app's own dialog
    // says to paste the project URL into the composer and it picks it up.
    if (referenceProjectIds?.length) {
      prompt += '\n\n' + referenceProjectIds.map((id) => `https://claude.ai/design/p/${id}`).join('\n')
    }
    // Aim at the right chat before measuring, so the transcript diff is taken
    // against the thread the reply will actually land in.
    await ensureProjectOpen(projectId, { chatId, visible })

    const pre = await getProjectData(projectId)
    const preChat = pickChat(pre, chatId)
    const preCount = preChat ? (preChat.messages || []).length : 0
    const preFiles = new Set(filePaths(await listFiles(projectId)))

    const { before } = await submitPrompt(projectId, prompt, { chatId, visible, attachments })

    if (!wait) {
      return text(`Sent to project ${projectId}. Not waiting.\nUse read_chat to see the reply once it lands.`)
    }

    const result = await waitForReply({
      projectId,
      chatId: preChat?.id,
      sinceCount: preCount,
      before,
      idleMs: idleSeconds * 1000,
      timeoutMs: timeoutSeconds * 1000,
    })

    if (result.neverStarted) {
      return text(
        'The prompt was typed but no Chat request ever started, so it probably did not send.\n' +
        'Run with CLAUDE_DESIGN_VISIBLE=1 to watch the window, and check the composer.'
      )
    }

    const post = result.data
    const postChat = result.chat
    const fresh = result.fresh

    // Entries carry no version or mtime, so only appearances and deletions are
    // detectable. Edits to an existing file do not show up here; the reply text
    // below is what tells you those.
    const postPaths = filePaths(await listFiles(projectId))
    const added = postPaths.filter((p) => !preFiles.has(p))
    const removed = [...preFiles].filter((p) => !postPaths.includes(p))
    const list = (label, xs) =>
      xs.length ? `${label} (${xs.length}): ${xs.slice(0, 40).join(', ')}${xs.length > 40 ? ' …' : ''}\n` : ''

    const replied = fresh.some((m) => m.role === 'assistant' && String(m.content ?? '').trim())
    const head =
      `Project "${post.name}" / chat ${postChat?.id}\n` +
      `${result.streams} model turn(s)\n` +
      (result.timedOut && !replied
        ? 'TIMED OUT: no assistant reply landed. It may still be running in the browser. ' +
          'Do not close it, and check again with read_chat.\n'
        : '') +
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
  'screenshot',
  {
    title: 'See the design',
    description:
      "Capture what a page in a Claude Design project actually looks like and return it as an image, so you can judge the work rather than taking the designer's word for it. " +
      "Use it after send_prompt to check the result, before sending a revision so your critique is specific, and whenever the user asks whether something looks right. " +
      "Captures the rendered design out of the viewer, without the app's own UI around it.",
    inputSchema: {
      projectId: z.string(),
      path: z.string().optional().describe('Page to capture, e.g. Components.dc.html. Omit for whatever is open.'),
      chatId: z.string().optional(),
      fullPage: z.boolean().default(false).describe('Capture the whole document instead of the visible area. Can be very tall.'),
      visible: z.boolean().default(true).describe('Show the window while capturing'),
      format: z.enum(['jpeg', 'png']).default('jpeg').describe('png for crisp type, jpeg for a smaller image'),
      quality: z.number().int().min(30).max(100).default(85).describe('jpeg only'),
      width: z.number().int().min(320).max(3000).optional().describe('Viewport width, e.g. 402 for an iPhone-class frame'),
      height: z.number().int().min(320).max(3000).optional(),
      savePath: z.string().optional().describe('Also write the image here. Use for full-page captures instead of returning them inline.'),
    },
  },
  async ({ projectId, path, chatId, fullPage, visible, format, quality, width, height, savePath }) => {
    const { buf, target } = await screenshotScreen(projectId, {
      path, chatId, fullPage, visible, format, quality, width, height,
    })

    const note = `Captured ${target}${path ? ` of ${path}` : ''} (${format}, ${Math.round(buf.length / 1024)} KB)`

    if (savePath) {
      const out = resolve(savePath)
      await mkdir(dirname(out), { recursive: true })
      await writeFile(out, buf)
      return text(`${note}\nSaved to ${out}`)
    }

    return {
      content: [
        { type: 'text', text: note },
        { type: 'image', data: buf.toString('base64'), mimeType: format === 'png' ? 'image/png' : 'image/jpeg' },
      ],
    }
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
    title: 'Read the built code',
    description:
      'Read a file straight out of a Claude Design project, no download needed. ' +
      'A .dc.html page runs to hundreds of KB, so use offset/limit to read a slice, ' +
      'and search_code first to find the line you want.',
    inputSchema: {
      projectId: z.string(),
      path: z.string().describe('Project-relative path, e.g. Prototype.dc.html'),
      offset: z.number().int().min(0).default(0).describe('First line to return, 0-based'),
      limit: z.number().int().min(1).max(5000).optional().describe('How many lines. Omit for the whole file, subject to maxChars.'),
      maxChars: z.number().int().min(500).max(400000).default(60000),
      raw: z.boolean().default(false).describe("Keep Claude Design's injected preview runtime instead of stripping it"),
    },
  },
  async ({ projectId, path, offset, limit, maxChars, raw }) => {
    const buf = await getFile(projectId, path)
    if (buf.includes(0)) return text(`${path} looks binary (${buf.length} bytes). Use pull_files to save it to disk.`)

    const src = buf.toString('utf8')
    const body = raw ? src : stripInjected(src)
    const lines = body.split('\n')
    const slice = lines.slice(offset, limit ? offset + limit : undefined)
    const head = `${path}: ${lines.length} lines, showing ${offset + 1}-${offset + slice.length}\n\n`
    return text(head + clip(slice.join('\n'), maxChars))
  }
)

server.registerTool(
  'search_code',
  {
    title: 'Search the built code',
    description:
      "Grep the project's own files for a regex and get back matches with line numbers and context. " +
      'This is how you find what Claude Design actually built without downloading anything: ' +
      'locate the markup or token, then read_file that region.',
    inputSchema: {
      projectId: z.string(),
      pattern: z.string().describe('JavaScript regex source, e.g. shelf-builder|line-tab-feed'),
      flags: z.string().default('i').describe('Regex flags'),
      prefix: z.string().optional().describe('Only search paths starting with this'),
      contextLines: z.number().int().min(0).max(10).default(2),
      maxMatches: z.number().int().min(1).max(200).default(40),
    },
  },
  async ({ projectId, pattern, flags, prefix, contextLines, maxMatches }) => {
    const paths = filePaths(await listFiles(projectId))
      .filter(isTextual)
      .filter((p) => !prefix || p.startsWith(prefix))
    if (!paths.length) return text('No text files matched that prefix.')

    const r = await searchFiles(projectId, paths, { pattern, flags, contextLines, maxMatches })
    if (r.error) return text(r.error)
    if (!r.matches.length) return text(`No matches for /${pattern}/${flags} across ${paths.length} file(s).`)

    const body = r.matches.map((m) => `--- ${m.path}:${m.line}\n${m.text}`).join('\n\n')
    return text(
      `${r.matches.length} match(es) across ${r.scanned} file(s)${r.truncated ? ', truncated' : ''}\n\n${body}`
    )
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
