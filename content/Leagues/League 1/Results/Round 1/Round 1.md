---
title: Round 1
pairings:
  - Brendon vs Chad
  - Simon vs Mira
  - AJ vs Jarrett
  - Grae vs Austin
---

```base
filters:
  and:
    - file.inFolder(this.file.folder)
    - file.hasTag("match")
views:
  - type: table
    name: Round 1
    order:
      - player_a
      - vp_a
      - vp_b
      - player_b
```
