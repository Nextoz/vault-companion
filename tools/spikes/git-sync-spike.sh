#!/usr/bin/env bash
# Phase 0 reality spike: real Git behaviour relevant to the app adapter and desktop sync.
# Synthetic content only. Everything lives under $ROOT and is disposable.
set -u
ROOT="${SPIKE_ROOT:-$(mktemp -d)}/work"
rm -rf "$ROOT"; mkdir -p "$ROOT"; cd "$ROOT"
export GIT_AUTHOR_NAME=spike GIT_AUTHOR_EMAIL=spike@example.invalid GIT_COMMITTER_NAME=spike GIT_COMMITTER_EMAIL=spike@example.invalid
g() { git -c core.autocrlf=false "$@"; }
say() { printf '\n### %s\n' "$*"; }

say "S0 blob sha == Contents API sha"
printf 'Hello World!\n' | git hash-object --stdin   # expect 980a0d5f19a64b4b30a87d4206aade58726b60e3

say "S1 seed bare remote with vault-like .gitattributes and synthetic To-Do"
g init -q --bare -b main remote.git
g clone -q remote.git seed 2>/dev/null; cd seed
printf '* text=auto\n\n*.md   text eol=lf\n' > .gitattributes
mkdir -p Tasks Inbox
cat > Tasks/To-Do\ List.md <<'MD'
---
title: To-Do List
---

# To-Do List

## Open

- [ ] Alpha task #todo ➕ 2026-09-10
- [ ] Beta task #todo ⏫ 📅 2026-09-30 ➕ 2026-09-11
- [ ] Gamma task #todo ➕ 2026-09-12


## Done

_Completed and cancelled items move here, newest first._

- [x] Old task #todo ✅ 2026-09-01
MD
printf 'other\n' > Inbox/other.md
g add -A && g commit -qm seed && g push -q origin main; cd ..

say "S2 desktop clone; write CRLF into working tree (as observed in snapshot); status + what gets committed"
g clone -q remote.git desktop; cd desktop
sed -i 's/$/\r/' "Tasks/To-Do List.md"
file "Tasks/To-Do List.md"
g status --short; g ls-files --eol "Tasks/To-Do List.md"
g diff --stat
cd ..

say "S3 app clone performs completion commit (move Gamma to Done) and pushes; desktop edit is CRLF-only (no content change)"
g clone -q remote.git app; cd app
python - <<'PY'
p='Tasks/To-Do List.md'; s=open(p,encoding='utf-8',newline='').read()
s=s.replace('- [ ] Gamma task #todo ➕ 2026-09-12\n','')
s=s.replace('newest first._\n\n','newest first._\n\n- [x] Gamma task #todo ➕ 2026-09-12 ✅ 2026-09-24\n')
open(p,'w',encoding='utf-8',newline='').write(s)
PY
g commit -qam "Complete task

Vault-Companion-Op: op-0001" && g push -q origin main && g log --format='%H %s' -1
cd ..

say "S4 snapshot worker algorithm on desktop with CRLF-only 'dirty' file: fetch; rev-list; merge --ff-only"
cd desktop
g fetch -q origin main; g rev-list --left-right --count origin/main...HEAD
g merge --ff-only origin/main; echo "merge exit=$?"; file "Tasks/To-Do List.md"; g status --short
cd ..

say "S5 desktop has REAL uncommitted edit to To-Do (QuickAdd-style append to end of Open); app appends too"
cd desktop; g reset -q --hard origin/main
python - <<'PY'
p='Tasks/To-Do List.md'; s=open(p,encoding='utf-8',newline='').read()
s=s.replace('- [ ] Beta task #todo ⏫ 📅 2026-09-30 ➕ 2026-09-11\n','- [ ] Beta task #todo ⏫ 📅 2026-09-30 ➕ 2026-09-11\n- [ ] Desktop capture #todo ➕ 2026-09-24\n')
open(p,'w',encoding='utf-8',newline='').write(s)
PY
cd ../app; g pull -q
python - <<'PY'
p='Tasks/To-Do List.md'; s=open(p,encoding='utf-8',newline='').read()
s=s.replace('- [ ] Beta task #todo ⏫ 📅 2026-09-30 ➕ 2026-09-11\n','- [ ] Beta task #todo ⏫ 📅 2026-09-30 ➕ 2026-09-11\n- [ ] Phone capture #todo ➕ 2026-09-24\n')
open(p,'w',encoding='utf-8',newline='').write(s)
PY
g commit -qam "Capture task

Vault-Companion-Op: op-0002" && g push -q origin main
cd ../desktop
g fetch -q origin main; g rev-list --left-right --count origin/main...HEAD
g merge --ff-only origin/main; echo "S5 ff-merge with dirty same file exit=$?"
say "S5b old worker never reaches commit; what would a local commit + 3-way merge do (append/append at same anchor)?"
g commit -qam "Sync vault notes (desktop)"; g rev-list --left-right --count origin/main...HEAD
g merge --no-edit origin/main >/dev/null 2>&1; echo "S5b 3-way merge exit=$?"; g diff --name-only --diff-filter=U
g merge --abort 2>/dev/null
cd ..

say "S6 desktop edits a DIFFERENT task line (not adjacent) while app completes another task"
cd desktop; g reset -q --hard origin/main
python - <<'PY'
p='Tasks/To-Do List.md'; s=open(p,encoding='utf-8',newline='').read()
s=s.replace('- [ ] Alpha task #todo','- [ ] Alpha task edited on desktop #todo'); open(p,'w',encoding='utf-8',newline='').write(s)
PY
g commit -qam "desktop edit alpha"
cd ../app; g pull -q
python - <<'PY'
p='Tasks/To-Do List.md'; s=open(p,encoding='utf-8',newline='').read()
s=s.replace('- [ ] Phone capture #todo ➕ 2026-09-24\n','')
s=s.replace('newest first._\n\n','newest first._\n\n- [x] Phone capture #todo ➕ 2026-09-24 ✅ 2026-09-24\n')
open(p,'w',encoding='utf-8',newline='').write(s)
PY
g commit -qam "Complete phone capture

Vault-Companion-Op: op-0003" && g push -q origin main
cd ../desktop; g fetch -q origin main
g merge --no-edit origin/main >/dev/null 2>&1; echo "S6 3-way merge exit=$?"; g diff --name-only --diff-filter=U; g merge --abort 2>/dev/null; g reset -q --hard origin/main
cd ..

say "S7 compare-and-swap push semantics: stale app clone pushes (analogue of Contents API sha mismatch)"
g clone -q remote.git stale; cd stale; g reset -q --hard HEAD~1
printf 'x\n' >> Inbox/other.md; g commit -qam stale
g push origin main 2>&1 | tail -2; echo "stale push exit=${PIPESTATUS[0]}"
say "S7b explicit lease on expected ref"
g push --force-with-lease=main:$(g rev-parse HEAD~1) origin HEAD:main 2>&1 | tail -1
cd ..

say "S8 lost-response dedupe: find op trailer in history after base"
cd app; g pull -q; BASE=$(g rev-list --max-parents=0 HEAD)
g log --format='%H %(trailers:key=Vault-Companion-Op,valueonly,separator=%x2C)' "$BASE"..origin/main
cd ..

say "S9 UTF-8 bytes of task markers"
for m in ➕ ✅ ❌ 📅 ⏳ 🛫 🔁 🆔 ⛔ 🔺 ⏫ 🔼 🔽 ⏬; do printf '%s ' "$m"; printf '%s' "$m" | od -An -tx1 | tr -d '\n'; echo; done
