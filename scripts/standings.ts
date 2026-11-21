/**
 * Recalculate league standings from result notes, and bring pairing notes up to date.
 * Rules and file layout: see scripts/lib/league.ts.
 *
 * For each league:
 *   - player notes get their totals, rank and position
 *   - pairing notes get status (scheduled | played | unplayed), VP and a link to their result
 *
 * Usage: npm run standings            (all leagues)
 *        npm run standings -- --dry   (print standings, check results, write nothing)
 */
import {
  computeStandings,
  leagueDirs,
  printStandings,
  readLeague,
  syncPairings,
  writePairings,
  writeStandings,
} from "./lib/league.ts"

const DRY_RUN = process.argv.includes("--dry")

for (const dir of leagueDirs()) {
  const league = readLeague(dir)
  const table = computeStandings(league)
  const pairings = syncPairings(league) // also validates every result has exactly one pairing
  printStandings(league.name, table)
  if (pairings.length) {
    const count = (s: string) => pairings.filter((p) => p.state.status === s).length
    console.log(
      `Pairings: ${count("played")} played, ${count("scheduled")} scheduled, ${count("unplayed")} unplayed`,
    )
  }
  if (!DRY_RUN) {
    writeStandings(table)
    writePairings(pairings)
  }
}
