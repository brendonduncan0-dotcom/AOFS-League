---
title: Test Player 4
league: "[[League 2]]"
status: active
army:
rank: 1
rank_label: "1 - tied"
position: 5
avg_vp: 0
games: 0
vp_total: 0
wins: 0
losses: 0
byes: 0
opp_avg_vp: 0
tags:
  - player
  - temporary
---

## Match history

```base
filters:
  and:
    - file.hasTag("match")
    - file.hasLink(this.file)
formulas:
  is_a: player_a.asFile().basename == this.file.basename
  opponent: if(formula.is_a, player_b, player_a)
  vp_for: if(formula.is_a, vp_a, vp_b)
  vp_against: if(formula.is_a, vp_b, vp_a)
  result: if(formula.vp_for > formula.vp_against, "Win", "Loss")
properties:
  formula.opponent:
    displayName: Opponent
  formula.result:
    displayName: Result
  formula.vp_for:
    displayName: VP For
  formula.vp_against:
    displayName: VP Against
views:
  - type: table
    name: Match history
    order:
      - round
      - formula.opponent
      - formula.result
      - formula.vp_for
      - formula.vp_against
    sort:
      - property: round
        direction: ASC
```
