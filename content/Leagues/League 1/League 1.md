---
title: League 1
description:
status: Completed
season: 2026 Monthly (June - October)
rounds: 5
current_round: 5
registration_open: false
winner: "[[Austin]]"
player_count: 8
tags:
  - league
---

## Current round

```base
filters:
  and:
    - file.inFolder(this.file.folder + "/Pairings")
    - file.hasTag("pairing")
    - round == this.current_round
    - this.status != "Completed"
properties:
  status:
    displayName: Status
  vp_a:
    displayName: VP (first)
  vp_b:
    displayName: VP (second)
views:
  - type: cards
    name: Current round
    order:
      - file.name
      - status
      - vp_a
      - vp_b
```

## Registration

```league-registration
```

## Registered Players

```base
filters:
  and:
    - file.inFolder(this.file.folder + "/Registered Players")
    - file.hasTag("player")
    - status != "dropped"
    - this.status == "Upcoming"
formulas:
  army_link: if(army, link(army, "View list"), "")
properties:
  formula.army_link:
    displayName: Army link
views:
  - type: table
    name: Registered Players
    order:
      - file.name
      - formula.army_link
    sort:
      - property: file.name
        direction: ASC
```

## Leaderboard

```base
filters:
  and:
    - file.inFolder(this.file.folder + "/Registered Players")
    - file.hasTag("player")
    - this.status != "Upcoming"
properties:
  rank_label:
    displayName: "#"
  avg_vp:
    displayName: Avg VP
  games:
    displayName: Games
  vp_total:
    displayName: Total VP
  wins:
    displayName: W
  losses:
    displayName: L
  byes:
    displayName: Byes
views:
  - type: table
    name: Leaderboard
    order:
      - rank_label
      - file.name
      - avg_vp
      - games
      - vp_total
      - wins
      - losses
      - byes
    sort:
      - property: position
        direction: ASC
      - property: byes
        direction: DESC
    columnSize: {}

```

## Results

```base
filters:
  and:
    - file.inFolder(this.file.folder + "/Pairings")
    - file.hasTag("pairing")
    - this.status != "Upcoming"
properties:
  player_a:
    displayName: Player
  vp_a:
    displayName: VP
  vp_b:
    displayName: VP
  player_b:
    displayName: Opponent
  status:
    displayName: Status
views:
  - type: table
    name: Results
    groupBy:
      property: round
      direction: ASC
    order:
      - player_a
      - vp_a
      - vp_b
      - player_b
      - status
```
