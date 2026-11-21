---
title: Round 5
pairings:
  - Austin vs Chad
  - Brendon vs Simon
  - AJ vs Mira
  - Grae vs Jarrett
---

```base
filters:
  and:
    - file.inFolder(this.file.folder)
    - file.hasTag("match")
views:
  - type: table
    name: Round 5
    order:
      - player_a
      - vp_a
      - vp_b
      - player_b
```
