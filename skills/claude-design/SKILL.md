---
name: claude-design
description: >-
  Work with claude.ai/design from Claude Code. Use when the user wants to send
  design instructions to Claude Design, ask it to draw or change a screen,
  read what it replied, pull designs or design files out of a Claude Design
  project into the repo, show a screen on their display so they can watch it
  work, or sync a design project with local code. Also use when the user
  mentions Claude Design, a design project, a .dc.html file, or asks "what did
  the designer say".
---

# Claude Design bridge

Claude Design (claude.ai/design) is a separate product with its own projects,
chats and files. This plugin drives it: you can send it work, read its answers,
take its output, and put a screen in front of the user.

It is a real browser under the hood, on the user's own logged-in session. Every
prompt spends the user's Claude credits and writes into a real project, so treat
`send_prompt` as an outward-facing action, not a scratch call.

## Always start by orienting

`projectId` is required by everything and is never guessable.

1. `list_projects` to find the project.
2. `list_chats` to see the threads and which one is **active**.

`send_prompt` posts into the active chat. A project usually has more than one
(for example an app-design thread and a social-media thread), and posting into
the wrong one gives Claude Design the wrong context. Pass `chatId` explicitly
whenever the project has more than one chat, or call `switch_chat` first.

## Let the user watch

The browser sits parked offscreen while you read data. Nothing is visible until
you ask for it.

- `open_screen` with `visible: true` brings the window up, and optionally opens
  a specific page in the viewer.
- `send_prompt` defaults to `visible: true` for the same reason.

Open the screen the work is about **before** sending the prompt, so the user
watches it change rather than being shown the result afterwards. Page names in
the switcher drop the extension: pass `Prototype.dc.html` and it matches the
page called "Prototype".

Pass `visible: false` when you are only reading data in the background.

## Sending work

`send_prompt` is a full agent turn on the other side: Claude Design reads
project files, edits them, takes screenshots, and can run for minutes. It
returns its reply text plus which files appeared or disappeared.

- Be specific and give constraints. It responds to design direction, not to
  one-word asks. Quote the tokens, sizes, and rules the project already uses.
- Raise `idleSeconds` (default 8) for big jobs. Completion is a quiet-period
  heuristic, so a long silent tool call can otherwise read as finished.
- Raise `timeoutSeconds` (default 900) for anything substantial.
- Use `wait: false` only when the user explicitly wants to fire and forget, then
  come back with `read_chat`.

**In-place edits to existing files are not reported.** The tool detects files
added and removed, but the API exposes no version or mtime, so a rewritten
`Prototype.dc.html` looks unchanged. The reply text is what tells you. Say so
rather than claiming nothing changed.

## Reading back

- `read_chat` returns the tail of a transcript. This is how you find out what
  Claude Design said, including work the user did in the browser without you.
- `list_files` and `read_file` for project contents.
- `pull_files` downloads into a local directory, binaries included. This is how
  a design lands in the repo.

Before pulling into a repo's design folder, diff against what is already there
and tell the user what is new, rather than overwriting silently.

## Setup, when a tool errors with "Not signed in"

The browser profile needs the user's claude.ai session once:

```sh
cd <plugin dir> && npm install && npm run seed
```

`seed` copies claude.ai cookies from an existing Chrome profile
(`~/.claude/playwright-profile` by default). If there is no such profile, or the
session expired, `npm run login` opens a window to sign in by hand.

Do not try to work around this by asking the user for credentials.

## What this rides on

There is no public API. The plugin speaks the app's own Connect-RPC service for
reads, and drives the real page for sending, because Claude Design's agent loop
(its tools for reading and writing project files) executes in the browser. It
can break when that app changes. If a selector-based tool starts failing, say
so plainly rather than retrying blindly.
