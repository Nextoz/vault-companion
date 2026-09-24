# ADR-0004 Markdown mutation strategy

Status: Accepted

**Decision.** Parse for understanding, locate the exact line span, splice the smallest span; never
re-serialise a document. EOL detected per file (LF/CRLF; mixed ⇒ refuse); BOM preserved; no Unicode
normalisation; trailing-field parsing mirrors Tasks 8.0.0. Unsupported structure ⇒ typed refusal.
Hand-written line scanner rather than a Markdown AST library (remark etc.): ASTs lose byte positions of
list items reliably only with extra plugins and the task grammar is line-oriented anyway.

**Consequences.** Golden tests assert exact bytes. Scanner must know fenced code blocks and frontmatter
to avoid treating their contents as tasks/headings.
