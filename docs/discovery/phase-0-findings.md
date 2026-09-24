# Phase 0 discovery findings — 2026-09-24

Evidence gathered by the Lead during Phase 0. Structure only: no private vault
content is reproduced here. Reference snapshot: `C:\Dev\vault-companion-vault-reference`
at commit `77b45d6` (2026-09-24 14:04 +02:00), inspected read-only.

## Environment

| Check | Result |
|---|---|
| Herdr | `HERDR_ENV=1`, herdr 0.9.0, pane `w3:p1` |
| Claude Code / model | 2.1.281, `claude-opus-5-5` |
| Toolchain | Node 24.18, pnpm (installed), git 2.55 (Windows), gh (authenticated) |
| App repo | two docs-only commits, no remote; `Nextoz/vault-companion` does not exist on GitHub |
| Vault remote | `Nextoz/knowledge-vault-private` exists, private, default branch `main` (metadata read only) |

## Snapshot freshness (recorded discrepancies)

| Expected by bootstrap | In snapshot | Consequence |
|---|---|---|
| `Projects/Vault Companion/Vault Companion - Build Contract.md` | **absent** | Bootstrap §3 is the operative contract. |
| `Tools/backup/VaultGitSync.psm1`, `Test-VaultGitSync.ps1`, `README.md` | **absent** | Recovered "17 real-Git cases passing" evidence is **inherited and unverified** here. |
| `Tools/backup/Sync-ObsidianVaultToGitHub.ps1` | present, **Sep 19 version** (pre-Codex) | Analysed below as the *old* worker only. |

The START HERE hub and the historical ChatGPT prompt describe a much larger V1
(Journal, Upcoming, Waiting/Someday, Areas, Quick Find, D1 index, webhooks).
The bootstrap deliberately narrows the first release; the narrower scope wins
per the source hierarchy. Not a contradiction that needs the owner.

## Tasks

- Obsidian Tasks **8.0.0** (`.obsidian/plugins/obsidian-tasks-plugin`), **no `data.json`**
  tracked or present ⇒ plugin defaults. Confirmed from the shipped bundle:
  `globalFilter: ""`, `taskFormat: tasksPluginEmoji`, `setDoneDate: true`,
  `setCancelledDate: true`, `setCreatedDate: false`, `recurrenceOnNextLine: false`
  (next occurrence is inserted **above** the completed line), `removeScheduledDateOnRecurrence: false`.
- Task line regex (bundle): indentation `^([\s\t>]*)`, marker `([-*+]|[0-9]+[.)])`, ` +`, checkbox `\[(.)\]`, rest.
- Fields are extracted **from the end of the line only**, in a loop, each as
  `<emoji>\uFE0F? *<value>$`. Text after a field makes every earlier field invisible to Tasks.
- `🆔` value charset `[a-zA-Z0-9-_]+`; `⛔` depends-on; `🏁` on-completion exist in 8.0.0.
- `#todo` tasks exist **only** in `Tasks/To-Do List.md`. 394 Markdown files contain checkboxes
  (project plans, archives, work notes) — those are not current actionable tasks.
- Vault-wide **zero** live uses of `🔁`, `🆔`, `⏳`, `🛫`, `⛔`, `[/]`, `[-]`, `#waiting`, `#someday`
  (only documentation/examples mention them).
- `Tasks/Active Work Now.md` has **no checkbox lines**: headings, tables and prose only.

### `Tasks/To-Do List.md` shape

- YAML frontmatter; a free prose paragraph before `## Short answer`; a fenced ```` ```tasks ```` query block;
  instruction sections; `## Open`; `## Done`; trailing reference sections (`## Format reference`, …).
- Line shape (documented and QuickAdd-enforced): `- [ ] <text> #todo [priority] [📅 due] ➕ <added>`.
- QuickAdd choice "Add to To-Do List": format `- [ ] {{VALUE}} #todo ➕ {{DATE:YYYY-MM-DD}}`,
  insert after `## Open`, `insertAtEnd: true`, `considerSubsections: false`, `blankLineAfterMatchMode: auto`.
- `## Open` contains blank-line-separated groups **and some already-completed `[x] … ✅` lines** —
  section is not a reliable status signal; the checkbox is.
- `## Done` starts with an italic note line (`_Completed and cancelled items move here, newest first. Trim to ~20._`),
  then items **newest first**, with blank lines between some groups.
- Cancelled items use `[x]` + `❌ date`, sometimes followed by a free-text reason
  (`❌ 2026-09-22 afløst`) or with `❌` mid-line. Some done items have text after `✅ date`.
  Those lines are **not** parsed as done/cancelled by Tasks (trailing-field rule).
- No child/indented lines exist today; the contract still requires block moves to carry them.
- The instruction "Keep `## Done` to roughly the last 20 lines; older completed items can be deleted"
  is **superseded** by bootstrap §3.3/§9 (retain completed tasks). The app will not trim; the
  vault note text is owner-editable and is not changed by the app.

## Bytes, encodings, line endings

- `.gitattributes`: `* text=auto`, `*.md text eol=lf`. `core.autocrlf=false`.
- Git index / GitHub blobs of `.md` are **LF**. The desktop working copy of the task files is **CRLF**
  (`i/lf w/crlf`), clean at stat level. After the desktop pulls an app change, Git writes LF.
- UTF-8, no BOM. Marker bytes (spike S9): `➕ e2 9e 95`, `✅ e2 9c 85`, `❌ e2 9d 8c`,
  `📅 f0 9f 93 85`, `⏳ e2 8f b3`, `🔁 f0 9f 94 81`, `🆔 f0 9f 86 94`, priorities `🔺 ⏫ 🔼 🔽 ⏬`.
  Mixed 3- and 4-byte code points ⇒ UTF-16 offsets ≠ byte offsets ≠ code-point offsets.
- Python on this machine writes stdout as cp1252 (reproduced) — any tooling must force UTF-8.

## Inbox / journal conventions

- `Inbox/` holds human-titled notes `"<Title> - YYYY-MM-DD.md"` with frontmatter
  `date`, `updated`, `type`, `status`, `tags`.
- Daily notes: `Journal/Daily/YYYY-MM-DD.md`, template `Templates/Daily Journal Template.md`
  (Obsidian `{{date:…}}` placeholders, rich structured frontmatter). Journal is **not** first-release scope.

## GitHub API reality (read-only probes + official OpenAPI description)

- `GET /repos/{o}/{r}/contents/{path}` → `sha` is the **Git blob SHA** (equals `git hash-object`, spike S0)
  and equals the `ETag`; `content` is base64 **with embedded `\n` every 60 chars**; `encoding: base64`.
  Files > 1 MB return empty `content` unless the raw media type is used.
- `PUT …/contents/{path}`: required `message`, `content`; optional `sha`, `branch`, `committer`, `author`.
  Responses 200, 201, 404, **409 Conflict**, **422 Validation failed**. `sha` is required to update.
- `compare/{base...head}`, `commits` and `git/refs` endpoints exist with documented error codes.
- **Not yet probed live**: actual 409/422 bodies on sha mismatch / create-over-existing, and ref-race
  behaviour. Requires a disposable private GitHub repository ⇒ external account action ⇒ approval gate.

## Real-Git spike (`tools/spikes/git-sync-spike.sh`, output in `git-sync-spike-output-2026-09-24.txt`)

| Case | Result | Meaning |
|---|---|---|
| S4 desktop file edited after last `git add` + remote change to same file, old worker order (fetch → `merge --ff-only`) | **fails**: "local changes would be overwritten" | Old worker blocks until manual repair whenever phone and desktop touch the same file between runs. |
| S5b local commit (append at end of `## Open`) + remote commit (append at end of `## Open`) → 3-way merge | **conflict** | Concurrent captures at the same anchor are textual conflicts even though semantically compatible. |
| S6 desktop edits a non-adjacent task line; remote moves another task Open → Done | **clean merge** | Line-distant edits are compatible. |
| S7 stale push / lease on expected ref | rejected | CAS semantics available locally for the disposable adapter. |
| S8 `Vault-Companion-Op:` commit trailer | recoverable via `git log --format=%(trailers…)` over `base..head` | Git history can be the durable dedupe evidence (no D1). |

## Consequences carried into the contracts

1. First-release task source = `#todo` task lines in `## Open` / `## Done` of `Tasks/To-Do List.md` only.
2. Parser mirrors Tasks' trailing-field rule; non-trailing markers are displayed but not interpreted.
3. No recurrence exists in real data ⇒ recurring completion is refused (read-only) in the first release.
4. No IDs exist in real data ⇒ first release does not write `🆔` (see ADR-0003).
5. Idempotency evidence = commit trailers in Git, looked up from the command's base revision.
6. Same-anchor append conflicts and the old worker's ordering are **desktop-sync risks** that the
   updated worker must handle; they are canary pre-conditions, not app-side fixes.
