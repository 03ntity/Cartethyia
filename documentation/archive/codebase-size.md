> # ARCHIVED — UNTRUSTED
>
> This file was archived on 2026-10-23. It is a **point-in-time record**, not a
> description of current behavior: every `file:line`, symbol, path, and
> measurement below was true when it was written and has not been kept in sync.
> Do not read it to answer a question about the current codebase, and never cite
> it as evidence. Do not read it as current behavior or cite it as evidence.

# Codebase size

Snapshot of tracked application source on 2026-10-18, at commit `b51cbbdf`.
The backend is `src/`; the frontend is `dashboard/src/`, matching the ownership
boundary in [Architecture](../reference/architecture.md).

| Area | Files | Source lines | Nonblank lines |
| --- | ---: | ---: | ---: |
| Backend | 480 | 119,272 | 112,968 |
| Frontend | 147 | 37,995 | 36,134 |
| **Total** | **627** | **157,267** | **149,102** |

Source lines count physical lines in tracked `.ts/.tsx/.js/.jsx` files under
those directories, matching the script below. Nonblank lines omit
empty or whitespace-only lines but still include comments. Tests, generated
assets, dependencies, scripts, migrations outside `src/`, and documentation
are not included. These are repository-size estimates, not language-aware
logical LOC; rerun the count after source changes for an updated snapshot.

To reproduce:

```sh
for area in src dashboard/src; do
  files=$(git ls-files "$area" | grep -E '\.(ts|tsx|js|jsx|css|scss|html|sql)$')
  echo "$area files=$(echo "$files" | wc -l)" \
       "lines=$(echo "$files" | xargs wc -l | tail -1 | awk '{print $1}')" \
       "nonblank=$(echo "$files" | xargs grep -cvE '^\s*$' | awk -F: '{s+=$2} END {print s}')"
done
```
