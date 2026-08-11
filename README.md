# claude-design-mcp

**Talk to [Claude Design](https://claude.ai/design) from Claude Code.** Send it
design instructions, read what it says back, pull the files it makes into your
repo, and put the right screen on your display so you can watch it work.

<a href="https://buymeacoffee.com/socialista"><img src="https://img.shields.io/badge/Buy%20me%20a%20coffee-%E2%98%95-yellow" alt="Buy me a coffee"></a>

---

Claude Design is a separate product from Claude Code. It has its own projects,
its own chats, and its own files, and no API. So the two never met.

This is the bridge. Claude Code can now ask the designer for a screen, watch it
being drawn, read the reasoning, and pull the result straight into the codebase.

```
you  →  Claude Code  →  claude.ai/design  →  a design
                     ←  its reply, its files  ←
```

## Install

```sh
/plugin marketplace add marvin-socialista/claude-design-mcp
/plugin install claude-design@claude-design
```

Then once, in the installed plugin directory:

```sh
npm install     # Playwright and the MCP SDK
npm run seed    # copy your claude.ai session into the tool's browser profile
npm run smoke   # read-only check, spends nothing
```

`npm install` is not optional and not automatic: this drives a real browser, so
Playwright has to be there.

`seed` copies **only** claude.ai cookies out of a Chrome profile you already use
(`~/.claude/playwright-profile` by default, or pass another path). Nothing else
from that profile is read or duplicated. If it is not signed in, or the session
later expires, `npm run login` opens a window so you can sign in by hand.

<details>
<summary>Plain MCP server, without the plugin system</summary>

```sh
git clone https://github.com/marvin-socialista/claude-design-mcp
cd claude-design-mcp && npm install && npm run seed
claude mcp add claude-design --scope user -- node "$PWD/src/index.mjs"
```

</details>

## Tools

**Start something**

| Tool | What it does |
| --- | --- |
| `list_templates` | The home-screen tiles: Blank, Mobile app design, Slides, Wireframe, Diagram and 9 more |
| `create_project` | The "What should we create?" box: a prompt, an optional template, and it starts building |
| `create_design_system` | An empty design-system project. Type is fixed at creation, so it cannot be converted later |
| `link_design_systems` | Attach design systems to a project so its chats design against them |
| `link_local_code` | Attach a local folder as the project's codebase, so it designs against your real code |
| `choose_repository` | Point a project at a connected GitHub repository |
| `upload_fig` | Push a Figma `.fig` file in from disk |

**Talk to it**

| Tool | What it does |
| --- | --- |
| `list_projects` | Every project, with its `projectId` and whether it is a design system |
| `list_chats` | Chat threads in a project, marking the active one |
| `switch_chat` | Make a different thread active, since `send_prompt` posts into the active one |
| `send_prompt` | Send an instruction, wait for the answer, return the reply and what changed. Takes local `attachments` |
| `read_chat` | Tail of a transcript. How you read what Claude Design said |

**See and read what it built**

| Tool | What it does |
| --- | --- |
| `screenshot` | The rendered page as an image, so Claude can actually judge the design |
| `open_screen` | Put the window on your display, on a given project, chat and page |
| `search_code` | Grep the project's files, with line numbers and context |
| `read_file` | Read a file, or a line range of one, without downloading it |
| `list_files` | Recursive file listing |

**Move work around**

| Tool | What it does |
| --- | --- |
| `pull_files` | Download files to a local directory, binaries included |
| `write_files` | Push files up, e.g. components into a design system |
| `close_browser` | Shut the background Chrome and flush its profile |

**Delete** (permanent, no trash, no undo)

| Tool | What it does |
| --- | --- |
| `delete_project` | Delete a project or design system. Requires `confirmName` to match its exact current name |
| `delete_files` | Delete files from a project, verifying they are gone |
| `delete_chat` | Delete one chat thread and its transcript |

`delete_project` is guarded the way GitHub guards repo deletion. A UUID is easy
for an agent to carry over from the wrong step; a name has to be looked up and
matched deliberately. Verified: it refuses `"Bridge test DS"` when the project
is actually called `"Bridge test DS (safe to delete)"`.

The plugin also ships a `claude-design` skill that teaches Claude when and how
to reach for these, so you can just say what you want.

### Attaching a local folder, without a native file dialog

"Link local code" has no file input. Its **browse…** calls
`window.showDirectoryPicker()`, a native OS dialog that no automation can drive,
which normally ends the story.

So the picker is replaced. `link_local_code` reads the folder in Node, then
injects a synthetic `FileSystemDirectoryHandle` implementing the parts the app
uses (`values`, `entries`, `getFileHandle`, `getDirectoryHandle`,
`queryPermission`) and overrides `showDirectoryPicker` to return it. The handle
is given the real prototype via `Object.setPrototypeOf`, so an `instanceof`
check still passes while our own methods shadow the native ones, which would
throw on a foreign object.

Verified end to end: after attaching `src/`, Claude Design listed all five
files and quoted the first line of `session.mjs` correctly.

Text files only, skipping `.git`, `node_modules` and build output, bounded by
file count and total bytes. Point it at a frontend or design-system folder
rather than a monorepo.

**The handle is synthetic and lives in the page.** A real one is persisted and
re-permissioned across sessions; this one is not, so re-attach if a later
session needs the files again.

### Seeing the work, not just hearing about it

`screenshot` returns the rendered page as an image, so Claude Code can judge
layout, spacing, type and colour instead of trusting the reply text. Use
`width: 402` for an iPhone-class frame, `format: "png"` to read fine type, and
`fullPage: true` with `savePath` for a long document.

`search_code` plus `read_file` covers the other half: read the markup Claude
Design actually wrote, without pulling anything to disk. A `.dc.html` page runs
to hundreds of KB, so grep first, then read the region.

### Watching it work

The browser sits parked offscreen while data is read, so nothing interrupts you.
`open_screen` moves it onto the display over CDP rather than relaunching, and
`send_prompt` defaults to `visible: true`.

Open the screen the work is about **before** sending the prompt, so you watch it
change instead of being shown the result afterwards. Page names in the switcher
drop the extension: ask for `Prototype.dc.html` and it matches the page listed
as "Prototype".

## How it works

There is no public API. What follows was worked out by reading the app's own
network traffic and shipped bundle.

claude.ai/design speaks a Connect-RPC service,
`anthropic.omelette.api.v1alpha.OmeletteService`. Plain cookie auth, no extra
headers. The useful methods:

| Method | Shape |
| --- | --- |
| `ListProjects`, `ListOrgProjects` | `{}` to `{items:[{projectId,name,viewedAt,…}]}` |
| `GetProjectData` | `{projectId}` to `{data}`, base64 JSON holding **every chat and message** |
| `ListFiles` | `{projectId, depth, offset}`. Shallow without `depth`; `limit` is capped at 200 server-side, so pages are walked with `offset` |
| `GetFile` | `{projectId, path}` to `{content}`, base64 |
| `Chat` | server-streaming, the generation endpoint |

**Reads go over the RPC. Sending a prompt goes through the real page.** That
split is the whole design, and it is not laziness.

`Chat` does not take a prompt string. It takes `messagesRequest`, a bytes field
holding the entire model request the client assembles, and it streams
`tool_delta` / `tool_block_complete` events back. **The browser executes those
tools.** The bundle contains the client-side executor (`case 'local_read': …`)
for roughly twenty of them: reading and writing project files, grep, screenshots,
`check_design_system`, `generate_image`, the Figma bridge. The agent loop lives
in the page.

Calling `Chat` directly would therefore mean reimplementing Claude Design's
harness: its system prompt, every tool schema, every tool implementation, and
the turn lifecycle (`CancelChat`, `ReleaseTurn`, the park-and-wake path). That is
cloning the app. Driving the page instead gets all of it for free, and costs one
Chrome process.

### Knowing when it has finished

Two signals, both required.

Network quiet is tracked with a `PerformanceObserver` on resource timings, which
is how the app itself watches its own stream: entries are reported on
completion, so a new `…/Chat` entry means a stream just ended. One user turn is
several streams (model asks for a tool, browser runs it, next stream carries the
result), so quiet means "no stream has ended for `idleSeconds`".

Quiet alone is a trap, though. **A long tool call is silent**, so a turn in
flight can look finished. The decisive signal is an assistant message with
content actually landing in the transcript. Only when both hold does
`send_prompt` return.

No fetch patching anywhere, so nothing here can break the page.

### Why the browser is visible

Chrome runs **headed but parked offscreen** at `-2400,-2400`. This is not
cosmetic: Cloudflare serves headless Chrome a 403 challenge on claude.ai even
with a valid session and stealth evasions loaded. Verified both ways, headless
403 and headed 200.

| Env var | Effect |
| --- | --- |
| `CLAUDE_DESIGN_VISIBLE=1` | Start with the window on screen |
| `CLAUDE_DESIGN_HEADLESS=1` | Force headless. Expect Cloudflare to block it |
| `CLAUDE_DESIGN_PROFILE` | Browser profile name (default `claude-design`) |
| `CLAUDE_DESIGN_USER_DATA_DIR` | Reuse an existing Chrome profile directory instead. One Chrome per directory, so that browser must be closed first |

## Limits worth knowing

- **This rides an internal, undocumented API.** It can change without notice and
  there is no support if it does.
- **It spends your normal Claude credits** and is subject to the usual rate
  limits.
- **Do not close the browser mid-turn.** The browser is the agent's tool
  executor, so killing it aborts the work in progress and no reply is saved.
- `send_prompt` posts into the project's **active chat**. Pass `chatId` to aim
  it, which clicks through the chat-history popover, since no URL selects a chat
  (`?chat=`, `/c/<id>` and `/chat/<id>` all load the project and leave the
  previous thread selected). Creating a new chat is not automated.
- File entries carry no version or mtime, so `send_prompt` reports files
  **added and removed** accurately but cannot see an in-place edit. The reply
  text is what tells you those.
- The page switcher lists pages, not every file. Use `pull_files` for the rest.
- HTML comes back with Claude Design's own preview runtime bolted to the front,
  a `data-omelette-injected` style and script pair worth about 15 KB.
  `read_file` strips it; pass `raw: true` to keep it.
- `WriteFiles` takes `mutations` with a `write` oneof, and its `data` is a plain
  string, not proto bytes. Both mistakes fail **silently**, returning 200 while
  storing an empty file or the literal base64. `write_files` therefore reads
  back what it wrote and raises if nothing landed.

## Support

If this saved you time, you can [**buy me a coffee ☕**](https://buymeacoffee.com/socialista).

## License

MIT
