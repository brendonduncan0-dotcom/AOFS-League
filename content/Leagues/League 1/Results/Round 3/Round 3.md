---
title: Round 3
pairings:
  - Brendon vs Grae
  - Austin vs Mira
  - AJ vs Chad
  - Simon vs Jarrett
---

```base
filters:
  and:
    - file.inFolder(this.file.folder)
    - file.hasTag("match")
views:
  - type: table
    name: Round 3
    order:
      - player_a
      - vp_a
      - vp_b
      - player_b
```
