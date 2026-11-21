---
title:
league:
status: active
joined_round: 1
army:
rank:
rank_label:
position:
avg_vp:
games:
vp_total:
wins:
losses:
byes:
opp_avg_vp:
tags:
  - player
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
