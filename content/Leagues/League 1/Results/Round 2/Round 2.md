---
title: Round 2
pairings:
  - Brendon vs AJ
  - Mira vs Grae
  - Austin vs Jarrett
  - Simon vs Chad
---

```base
filters:
  and:
    - file.inFolder(this.file.folder)
    - file.hasTag("match")
views:
  - type: table
    name: Round 2
    order:
      - player_a
      - vp_a
      - vp_b
      - player_b
```
