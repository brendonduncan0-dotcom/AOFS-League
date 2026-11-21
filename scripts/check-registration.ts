/**
 * Re-check a registration just before it's merged (used by the auto-merge job in
 * .github/workflows/standings.yaml).
 *
 * The Worker sets the new player's joined_round when they register, but the league can move
 * on while the pull request waits to merge (e.g. someone presses "Start league"). Then the
 * player would arrive in a round that was already paired without them. This sets joined_round
 * to the round they can actually join now.
 *
 * Usage: tsx scripts/check-registration.ts <player note> <league note>
 *   player note  the PR's new file, e.g. "content/Leagues/League 2/Registered Players/Alex.md"
 *   league note  the league note as it is on the deploy branch now (may be a copy elsewhere)
 *
 * Exit codes: 0 OK (joined_round corrected if needed), 2 registration is now closed (leave the
 * pull request for review), 1 anything else.
 */
import fs from "node:fs"
import matter from "gray-matter"
import { registrationRound, writeFrontmatter } from "./lib/league.ts"

const [playerFile, leagueFile] = process.argv.slice(2)
if (!playerFile || !leagueFile) {
  console.error("Usage: tsx scripts/check-registration.ts <player note> <league note>")
  process.exit(1)
}

const league = matter(fs.readFileSync(leagueFile, "utf8")).data as Record<string, unknown>
const player = matter(fs.readFileSync(playerFile, "utf8")).data as Record<string, unknown>
const round = registrationRound(league)
if (round === undefined) {
  console.log(`Registration for this league is now closed (status: ${league.status}). Leaving it for review.`)
  process.exit(2)
}
const joined = Number(player.joined_round)
if (joined === round) {
  console.log(`joined_round ${joined} is still right.`)
} else {
  writeFrontmatter(playerFile, { joined_round: round })
  console.log(`The league moved on since they registered: joined_round ${player.joined_round} -> ${round}.`)
}
