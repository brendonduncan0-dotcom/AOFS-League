---
title: AOFS League
---

## Active leagues

```base
filters:
  and:
    - file.hasTag("league")
    - status == "Active"
views:
  - type: cards
    name: Active
    order:
      - file.name
      - season
```

## Upcoming leagues

```base
filters:
  and:
    - file.hasTag("league")
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
    - status == "Completed"
views:
  - type: cards
    name: Completed
    order:
      - file.name
      - season
      - winner
```
