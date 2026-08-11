# claude-design-mcp

Talk to [claude.ai/design](https://claude.ai/design) from Claude Code: pick a
project, send it instructions, read its replies, pull its files down.

There is no official API for this. What follows is what the web app actually
does, worked out from its own network traffic.

## How it works, and why it is built this way

claude.ai/design speaks a Connect-RPC service,
`anthropic.omelette.api.v1alpha.OmeletteService`. Plain cookie auth, no extra
headers needed. The useful methods:

| Method | Shape |
| --- | --- |
| `ListProjects`, `ListOrgProjects` | `{}` to `{items:[{projectId,name,viewedAt,...}]}` |
| `GetProjectData` | `{projectId}` to `{data}`, base64 JSON holding **every chat and message** |
| `ListFiles` | `{projectId, depth, offset}`. Shallow without `depth`; `limit` is capped at 200 server-side, so pages are walked with `offset` |
| `GetFile` | `{projectId, path}` to `{content}`, base64 |
| `Chat` | server-streaming, the generation endpoint |

**Reads go over the RPC. Sending a prompt goes through the real page.** That
split is the whole design, and it is not laziness:

`Chat` does not take a prompt string. It takes `messagesRequest`, a bytes field
holding the entire model request the client assembles, and it streams
`tool_delta` / `tool_block_complete` events back. **The browser executes those
tools.** The bundle contains the client-side executor (`case 'local_read': …`)
for roughly twenty tools: reading and writing project files, grep, screenshots,
`check_design_system`, `generate_image`, the Figma bridge. The agent loop lives
in the page.

So calling `Chat` directly would mean reimplementing Claude Design's harness:
its system prompt, every tool schema, every tool implementation, and the
turn/park lifecycle (`CancelChat`, `ReleaseTurn`). That is cloning the app.
Driving the page instead gets all of it for free, and costs one Chrome process.

Completion is detected with a `PerformanceObserver` on resource timings, which
is how the app itself tracks its stream. Resource entries are reported when a
response completes, so a new `…/Chat` entry means a stream just ended. One user
turn is several streams (model asks for a tool, browser runs it, next stream
carries the result), so "finished" means "no stream has ended for `idleSeconds`".
No fetch patching, nothing that can break the page.

## Install

As a Claude Code plugin, which brings the MCP server and the `claude-design`
skill together:

```sh
/plugin marketplace add marvinvisser/claude-design-mcp
/plugin install claude-design@claude-design
```

Then, once, in the installed plugin directory:

```sh
npm install     # playwright and the MCP SDK
npm run seed    # copy your claude.ai session into the tool's browser profile
npm run smoke   # read-only check, spends nothing
```

`npm install` is not optional and is not automatic: the server drives a real
browser, so Playwright has to be present.

`seed` copies **only** claude.ai cookies out of an existing Chrome profile
(`~/.claude/playwright-profile` by default, or pass another as an argument).
Nothing else from that profile is read or duplicated. If it is not signed in, or
the session later expires, `npm run login` opens a window to sign in by hand.

<details>
<summary>Without the plugin system, as a plain MCP server</summary>

```sh
git clone https://github.com/marvinvisser/claude-design-mcp
cd claude-design-mcp && npm install && npm run seed
claude mcp add claude-design --scope user -- node "$PWD/src/index.mjs"
```

</details>

## Tools

| Tool | What it does |
| --- | --- |
| `list_projects` | Every project you can open, with its `projectId` |
| `list_chats` | Chat threads in a project, marking the active one |
| `read_chat` | Tail of a transcript. This is how you read what Claude Design said |
| `send_prompt` | Send an instruction, wait for it to finish, return the reply and what changed |
| `open_screen` | Put the window on the user's display, on a given project, chat and page |
| `switch_chat` | Make a different thread active, since `send_prompt` posts into the active one |
| `list_files` | Recursive file listing |
| `read_file` | Read one text file |
| `pull_files` | Download files to a local directory, binaries included |
| `close_browser` | Shut the background Chrome and flush its profile |

### Watching it work

The window is parked offscreen during background reads. `open_screen` moves it
onto the display over CDP (`Browser.setWindowBounds`) rather than relaunching,
and `send_prompt` defaults to `visible: true`. Open the screen the work is about
before sending, so the user sees it change.

Page names in the switcher drop the extension: ask for `Prototype.dc.html` and
it matches the page listed as "Prototype".

## Browser behaviour

Chrome runs **headed but parked offscreen** at `-2400,-2400`. This is not
cosmetic: Cloudflare serves headless Chrome a 403 challenge on claude.ai even
with a valid session and the stealth evasions loaded. Verified both ways,
headless 403 and headed 200.

| Env var | Effect |
| --- | --- |
| `CLAUDE_DESIGN_VISIBLE=1` | Put the window back on screen, useful for debugging |
| `CLAUDE_DESIGN_HEADLESS=1` | Force headless. Expect Cloudflare to block it |
| `CLAUDE_DESIGN_PROFILE` | Profile name under `~/.claude/playwright-stealth/profiles` (default `claude-design`) |
| `CLAUDE_DESIGN_USER_DATA_DIR` | Reuse an existing Chrome profile directory instead. Only one Chrome per directory, so pointing this at `~/.claude/playwright-profile` means closing the Playwright MCP browser first |

The dedicated profile is the default precisely so this does not fight the
Playwright MCP browser over a profile lock.

## Limits worth knowing

- **This rides an internal, undocumented API.** It can change without notice and
  there is no support if it does. Everything here was derived by reading the
  shipped bundle.
- **It spends your normal Claude credits** and is subject to the usual rate
  limits.
- `send_prompt` writes into the project's **active chat**. Pass `chatId` to aim
  it, which clicks through the chat-history popover, since no URL selects a
  chat (`?chat=`, `/c/<id>` and `/chat/<id>` all load the project and leave the
  previous thread selected). Creating a new chat is not automated.
- File entries carry no version or mtime, so `send_prompt` reports files
  **added and removed** accurately but cannot detect an in-place edit. The
  reply text is what tells you those.
- Completion is a quiet-period heuristic. A long tool call with more than
  `idleSeconds` of silence inside it could read as finished early. Raise
  `idleSeconds` for big jobs.
