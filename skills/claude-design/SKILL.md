---
name: claude-design
description: >-
  Work with claude.ai/design from Claude Code. Use when the user wants to start
  a new design project or a design system, send design instructions to Claude
  Design, ask it to draw or change a screen, see or judge what it built, read
  the code it wrote, read what it replied, pull designs into the repo, push
  components up to a design system, or show a screen on their display so they
  can watch it work. Also use when the user mentions Claude Design, a design
  project, a design system, a .dc.html file, or asks "what did the designer
  say" or "does that look right".
---

# Claude Design bridge

Claude Design (claude.ai/design) is a separate product with its own projects,
chats and files. This plugin drives it: start projects, send work, see the
result, read the code, and take the output.

It runs a real browser on the user's own logged-in session. Every prompt spends
their Claude credits and writes into a real project, so treat `send_prompt` and
`create_project` as outward-facing actions, not scratch calls.

## Orient first

`projectId` is required by almost everything and is never guessable.

1. `list_projects` to find the project. `kind: "design_systems"` filters to
   design systems.
2. `list_chats` to see the threads and which one is **active**.

`send_prompt` posts into the active chat. A project usually has more than one
(an app-design thread, a social thread), and the wrong one gives Claude Design
the wrong context. Pass `chatId` explicitly whenever there is more than one, or
call `switch_chat` first.

## Starting something new

- `list_templates` shows the tiles on the home screen (Blank, Mobile app design,
  Slides, Wireframe, Diagram and the rest).
- `create_project` is the home screen's "What should we create?" box: a prompt,
  an optional template, and it starts building. It returns the new `projectId`.
  Claude Design names the project from the prompt.
- `create_design_system` makes an empty design-system project. **A project's
  type is fixed at creation**, so a design system must be created as one; you
  cannot convert a project later.
- `link_design_systems` attaches design systems to a project. It replaces the
  set, so pass everything you want to keep.

## Close the loop: look at the work

Do not take the designer's word for it. After `send_prompt`:

- `screenshot` returns the rendered page as an image, so you can actually judge
  layout, spacing, type and colour. Use `width: 402` for an iPhone-class frame,
  `format: "png"` when you need to read fine type, `fullPage: true` plus
  `savePath` for a long document.
- `search_code` greps the project's own files and returns matches with line
  numbers, then `read_file` with `offset`/`limit` reads just that region. A
  `.dc.html` page runs to hundreds of KB, so never read one whole and never
  pull it to disk just to look at it.

Judge against the project's real constraints (its tokens, its stroke weights,
its palette) and say specifically what is off. Then send a revision.

## Let the user watch

The browser sits parked offscreen while you read data. Nothing is visible until
you ask for it.

- `open_screen` with `visible: true` brings the window up and opens a page.
- `send_prompt` and `create_project` default to `visible: true`.

Open the screen the work is about **before** sending, so the user watches it
change rather than being shown the result afterwards. Page names in the switcher
drop the extension: pass `Prototype.dc.html` and it matches the page called
"Prototype".

Pass `visible: false` when you are only reading data in the background.

## Sending work

`send_prompt` is a full agent turn on the other side: Claude Design reads
project files, edits them, takes screenshots, and can run for minutes. It
returns its reply plus which files appeared or disappeared.

- Be specific and give constraints. It responds to design direction, not
  one-word asks. Quote the tokens, sizes and rules the project already uses.
- `attachments` takes local file paths, so you can send screenshots or
  references straight from the repo to design from or compare against.
- Raise `idleSeconds` for jobs with long silent tool calls, and
  `timeoutSeconds` for anything substantial.
- Use `wait: false` only when the user wants to fire and forget, then come back
  with `read_chat`.

**Never close the browser mid-turn.** The browser is the agent's tool executor,
so `close_browser` (or killing the process) while a turn is running aborts the
work and no reply is saved.

**In-place edits to existing files are not reported.** The tool detects files
added and removed, but the API exposes no version or mtime, so a rewritten
`Prototype.dc.html` looks unchanged. The reply text and `search_code` are what
tell you. Say so rather than claiming nothing changed.

## Moving work between the repo and the project

- `pull_files` downloads into a local directory, binaries included.
- `write_files` pushes up, overwriting without asking. Read first if unsure.

Before pulling into a repo's design folder, diff against what is there and tell
the user what is new, rather than overwriting silently.

## Setup, when a tool errors with "Not signed in"

The browser profile needs the user's claude.ai session once:

```sh
cd <plugin dir> && npm install && npm run seed
```

`seed` copies claude.ai cookies from an existing Chrome profile
(`~/.claude/playwright-profile` by default). If there is none, or the session
expired, `npm run login` opens a window to sign in by hand. Never ask the user
for credentials.

## What this rides on

There is no public API. Reads go over the app's own Connect-RPC service; sending
drives the real page, because Claude Design's agent loop executes in the
browser. It can break when that app changes. If a selector-based tool starts
failing, say so plainly rather than retrying blindly.
