# ADR-0009 No persistent read index in the first release

Status: Accepted

The first release reads one ~16 KB file at HEAD per request; a projection would add staleness and a
rebuild path with no measured benefit. Triggers and invariants for adding D1: `docs/indexing.md`.
