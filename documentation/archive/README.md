# Archive — UNTRUSTED, do not read automatically

> **STOP. Agents and contributors: do not read this directory as background.**
>
> Nothing under `documentation/archive/` describes the current codebase. It is
> kept only as a historical record of investigations that were open at the time.

## Why this is untrusted

Each file here is a snapshot taken at a point in time. It cites `file:line`
references, symbols, file paths, and measurements that were true when it was
written and have not been kept in sync since. The code moved; these pages did
not.

Reading one as if it were current is worse than reading nothing, because it
looks authoritative and it is not. A stale `file:line` here will point at a
different function, or at nothing. A measured number here has no relationship
to what the code does today.

## Rules

- **Do not read this directory to answer a question about current behavior.**
  Use `documentation/`, `.skills/`, or the code itself.
- **Do not cite a file here as evidence** in a change, a review, a report, or a
  fix. Cite current source.
- **Do not "refresh" a file here.** It is a record, not a living document. If
  the investigation is still relevant, write a fresh page outside the archive.
- A link from current documentation into this directory is acceptable only when
  it is explicitly labelled as historical — for example "the original
  investigation (archived, may be stale)".
- A read is permitted only when a person explicitly asks for the historical
  record by name, and even then treat every claim as unverified.

## What is here

| Path | What it was |
| --- | --- |
| `research/` | Point-in-time investigations: OpenCode free tier and egress fingerprinting, GitHub Copilot Chat and context probing, Trae agent vs chat surface, and an iomemory request-path census with a caching proposal. Each states "no code changed" or is a comparison against an external checkout. |
| `codebase-size.md` | A source-line count from 2026-10-18. A count of this kind is stale the moment a file changes; rerun the command rather than trust the number. |

## Removing something

If a page here turns out to matter again, the fix is not to restore it. Write
the current behavior into the page that owns it today, under `documentation/`
or `.skills/`, and leave the archive alone.
