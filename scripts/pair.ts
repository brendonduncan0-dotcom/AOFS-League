/**
 * Close a league's current round and pair the next one (Swiss).
 *
 * Usage: npm run pair -- "League 2"          close the current round, create the next pairings
 *        npm run pair -- "League 2" --dry    show what would happen, write nothing
 *
 * League note properties used:
 *   rounds         total rounds in the league; leave blank before the league starts and it is
 *                  set when round 1 is drawn, from the players taking part (see swissRounds)
 *   current_round  0 before the league starts
 *   status         Upcoming -> Active on round 1; Active -> Completed after the final round
 *   winner         set when the league completes
 *
 * Steps:
 *   1. Close the current round: pairings without a result are reported and will be marked
 *      `status: unplayed` (a bye for both players); the script carries on.
 *   2. If that was the final round: set status Completed and the winner (position 1).
 *   3. Otherwise create a pairing note per game in Pairings/Round N/:
 *        round 1:    random order (a new draw every run)
 *        later:      standings order (position), each player with the closest-placed
 *                    opponent they haven't played; rematches only if unavoidable
 *        odd count:  bye to the lowest-placed player with the fewest byes; a late joiner is
 *                    never given the bye in their first round
 *        dropped:    players with `status: dropped` are not paired
 *        late:       players whose joined_round is after this round are not paired yet
 *   4. Recalculate standings and pairing statuses.
 */
import fs from "node:fs"
import path from "node:path"
import {
  LEAGUES_DIR,
  computeStandings,
  noteLink,
  pairKey,
  printStandings,
  readLeague,
  rel,
  shuffle,
  swissPair,
  swissRounds,
  syncPairings,
  toNumber,
  writeFrontmatter,
  writePairings,
  writeStandings,
} from "./lib/league.ts"

const args = process.argv.slice(2)
const DRY_RUN = args.includes("--dry")
const leagueName = args.find((a) => !a.startsWith("--"))
if (!leagueName) {
  console.error('Usage: npm run pair -- "<League name>" [--dry]')
  process.exit(1)
}

const league = readLeague(path.join(LEAGUES_DIR, leagueName))
const where = rel(league.noteFile)
if (league.completed) throw new Error(`${where}: league is already Completed`)
const current = league.currentRound
// rounds is blank until the league starts: round 1 sets it from the players taking part
const roundsBlank = league.data.rounds === undefined || league.data.rounds === null || league.data.rounds === ""
let totalRounds: number
if (roundsBlank && current === 0) {
  const starting = [...league.players.values()].filter((p) => !p.dropped && p.joinedRound <= 1).length
  totalRounds = swissRounds(starting)
  console.log(`\n${starting} players: setting rounds to ${totalRounds}.`)
} else {
  totalRounds = toNumber(league.data.rounds, `${where} rounds`)
}
if (!Number.isInteger(totalRounds) || totalRounds < 1) throw new Error(`${where}: rounds must be a whole number from 1`)
if (current > totalRounds) throw new Error(`${where}: current_round (${current}) is past rounds (${totalRounds})`)

const playerLink = (name: string) => noteLink(league.players.get(name)!.file)

// 1. Close the current round
if (current >= 1) {
  const reported = new Set(league.matches.filter((m) => m.round === current).map((m) => pairKey(m.a, m.b)))
  const unplayed = league.pairings
    .filter((p) => p.round === current && !reported.has(pairKey(p.a, p.b)))
    .map((p) => `${p.a} vs ${p.b}`)
  console.log(`\nClosing round ${current} of ${totalRounds}.`)
  if (unplayed.length) console.warn(`  ⚠ No result for: ${unplayed.join(", ")} (marked unplayed: a bye for both players)`)
  else console.log("  All pairings have results.")
}

// `pairings` and `bye` are no longer stored on the league note; remove them if present
const leagueUpdates: Record<string, number | string | null | undefined> = { pairings: undefined, bye: undefined }
const newNotes: { file: string; content: string }[] = []

if (current === totalRounds) {
  // 2. Final round closed: finish the league
  const table = computeStandings(league, current)
  const champion = table[0]
  leagueUpdates.status = "Completed"
  leagueUpdates.winner = playerLink(champion.name)
  printStandings(`${league.name}: final standings`, table)
  console.log(`\n🏆 League complete. Winner: ${champion.name}`)
} else {
  // 3. Pair the next round
  const next = current + 1
  const table = computeStandings(league, current)
  const active = table.filter((s) => {
    const p = league.players.get(s.name)!
    return !p.dropped && p.joinedRound <= next
  })
  if (active.length < 2) throw new Error(`${where}: need at least 2 active players to pair`)

  const order = next === 1 ? shuffle(active.map((s) => s.name)) : active.map((s) => s.name)
  const meetings = new Map<string, number>()
  for (const m of league.matches) meetings.set(pairKey(m.a, m.b), (meetings.get(pairKey(m.a, m.b)) ?? 0) + 1)
  const byes = new Map(table.map((s) => [s.name, s.byes]))
  // Late joiners (joined after round 1) can't get the bye in their first round
  const noBye = new Set(
    active.filter((s) => next > 1 && league.players.get(s.name)!.joinedRound === next).map((s) => s.name),
  )
  const result = swissPair({ order, meetings, byes, noBye })

  const roundDir = path.join(league.dir, "Pairings", `Round ${next}`)
  for (const [a, b] of result.pairs) {
    const file = path.join(roundDir, `${a} vs ${b}.md`)
    if (fs.existsSync(file)) throw new Error(`${rel(file)} already exists`)
    newNotes.push({
      file,
      content: [
        "---",
        "type: pairing",
        `league: ${JSON.stringify(`[[${league.name}]]`)}`,
        `round: ${next}`,
        `player_a: ${JSON.stringify(playerLink(a))}`,
        `player_b: ${JSON.stringify(playerLink(b))}`,
        "status: scheduled",
        "vp_a:",
        "vp_b:",
        "result:",
        "tags:",
        "  - pairing",
        "---",
        "",
        "```game-tracker",
        "```",
        "",
      ].join("\n"),
    })
  }
  leagueUpdates.current_round = next
  if (current === 0) {
    leagueUpdates.status = "Active"
    leagueUpdates.rounds = totalRounds
  }

  console.log(`\nRound ${next} of ${totalRounds} pairings${next === 1 ? " (random draw)" : ""}:`)
  for (const [a, b] of result.pairs) console.log(`  ${a} vs ${b}`)
  if (result.bye) console.log(`  Bye: ${result.bye}`)
  if (result.rematches) console.warn(`  ⚠ ${result.rematches} rematch(es): no rematch-free pairing was possible`)
  const dropped = table.filter((s) => league.players.get(s.name)!.dropped).map((s) => s.name)
  if (dropped.length) console.log(`  Not paired (dropped): ${dropped.join(", ")}`)
  const notYet = table.filter((s) => league.players.get(s.name)!.joinedRound > next).map((s) => s.name)
  if (notYet.length) console.log(`  Not paired yet (joining later): ${notYet.join(", ")}`)
}

if (DRY_RUN) {
  console.log("\n--dry: nothing written.")
} else {
  for (const n of newNotes) {
    fs.mkdirSync(path.dirname(n.file), { recursive: true })
    fs.writeFileSync(n.file, n.content)
  }
  writeFrontmatter(league.noteFile, leagueUpdates)
  // 4. Recalculate with the updated league note: standings, and pairing statuses (closed round)
  const updated = readLeague(league.dir)
  writeStandings(computeStandings(updated))
  writePairings(syncPairings(updated))
  console.log(`\nUpdated ${where}${newNotes.length ? `, created ${newNotes.length} pairing notes` : ""}, standings.`)
}
