---
title: AOFS League
---

## Active leagues

```base
filters:
  and:
    - file.hasTag("league")
    - file.inFolder("Leagues")
    - status == "Active"
formulas:
  round_progress: '"Round " + current_round + " of " + rounds'
properties:
  formula.round_progress:
    displayName: Current round
views:
  - type: cards
    name: Active
    order:
      - file.name
      - season
      - formula.round_progress
```

## Upcoming leagues

```base
filters:
  and:
    - file.hasTag("league")
    - file.inFolder("Leagues")
    - status == "Upcoming"
views:
  - type: cards
    name: Upcoming
    order:
      - file.name
      - season
```

## Completed leagues

```base
filters:
  and:
    - file.hasTag("league")
    - file.inFolder("Leagues")
    - status == "Completed"
views:
  - type: cards
    name: Completed
    order:
      - file.name
      - season
      - winner
```
