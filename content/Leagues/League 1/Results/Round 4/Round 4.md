---
title: Round 4
pairings:
  - Brendon vs Austin
  - Grae vs Chad
  - Simon vs AJ
  - Mira vs Jarrett
---

```base
filters:
  and:
    - file.inFolder(this.file.folder)
    - file.hasTag("match")
views:
  - type: table
    name: Round 4
    order:
      - player_a
      - vp_a
      - vp_b
      - player_b
```
