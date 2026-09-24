# ADR-0002 First-release task source

Status: Accepted (Lead, Phase 0; owner may widen)

**Context.** 394 vault files contain checkboxes (plans, archives, work items). `#todo` tasks exist only
in `Tasks/To-Do List.md`. `Tasks/Active Work Now.md` has no task lines (tables/prose).

**Decision.** Indexed tasks = top-level task lines tagged `#todo` inside `## Open`/`## Done` of
`Tasks/To-Do List.md`. Active Work Now is displayed read-only as context. No other file is a task source.

**Consequences.** Historical checkboxes never appear as actionable. Adding a source later requires
explicit location rules (Open/Done semantics are not generalised).
