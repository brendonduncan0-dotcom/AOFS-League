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
  # same rule as the registration form: the flag is on and there are rounds left to join
  registration: if(registration_open == true && current_round < rounds, "Open", "Closed")
properties:
  formula.round_progress:
    displayName: Current round
  player_count:
    displayName: Players
  formula.registration:
    displayName: Registration
views:
  - type: cards
    name: Active
    order:
      - file.name
      - season
      - formula.round_progress
      - player_count
      - formula.registration
```

## Upcoming leagues

```base
filters:
  and:
    - file.hasTag("league")
    - file.inFolder("Leagues")
    - status == "Upcoming"
formulas:
  registration: if(registration_open == true, "Open", "Closed")
properties:
  player_count:
    displayName: Players
  formula.registration:
    displayName: Registration
views:
  - type: cards
    name: Upcoming
    order:
      - file.name
      - season
      - player_count
      - formula.registration
```

## Completed leagues

```base
filters:
  and:
    - file.hasTag("league")
    - file.inFolder("Leagues")
    - status == "Completed"
formulas:
  # completed leagues never take registrations
  registration: '"Closed"'
properties:
  player_count:
    displayName: Players
  formula.registration:
    displayName: Registration
views:
  - type: cards
    name: Completed
    order:
      - file.name
      - season
      - player_count
      - formula.registration
      - winner
```

## Create a new league

```league-creation
```
