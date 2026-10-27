# Codebase size

Working-tree snapshot on 2026-10-27 (includes source files created by the
de-bloat refactor, tracked or not). The backend is `src/`; the frontend is
`dashboard/src/`, matching the ownership boundary in [Architecture](architecture.md).

| Area | Files | Source lines | Nonblank lines |
| --- | ---: | ---: | ---: |
| Backend | 552 | 146,840 | 139,201 |
| Frontend | 170 | 43,378 | 41,316 |
| **Total** | **722** | **190,218** | **180,517** |

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
