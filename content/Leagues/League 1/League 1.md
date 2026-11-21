---
title: League 1
description:
status: Completed
season: 2026 Monthly (June - Ocober)
current_round: 5
winner: "[[Austin]]"
tags:
  - league
---

## Overview

## Leaderboard

```base
filters:
  and:
    - file.inFolder(this.file.folder + "/Registered Players")
    - file.hasTag("player")
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
