/**
 * Recalculate league standings from match notes and write the totals onto each player note.
 *
 * Layout per league (content/Leagues/<League>/):
 *   <League>.md                       league note: `status` and `current_round`
 *   Registered Players/<Name>.md      player notes (totals are written here)
 *   Results/.../<match>.md            match notes (tag `match`, `round` property): one per
 *                                     game actually played; any folder layout under Results/
 *
 * Rules:
 *   - Winner is whoever scored more VP. Draws are impossible (play continues until one
 *     side leads), so equal VP is rejected as a data error.
 *   - A closed round with no match note for a player counts as a bye: 0 VP and not a game
 *     played. Closed rounds are 1..current_round when the league's status is "Completed",
 *     otherwise 1..current_round-1 (the current round is still open for results).
 *   - rank: dense rank by average VP per game. Players on the same average share a rank
 *     and the next player takes the next number (e.g. 4, 4, 5, 6, 6).
 *   - rank_label: rank for display, with " - tied" when shared (e.g. "4 - tied").
 *   - position: the full listing order (1..n). Within a shared rank, ties are broken by
 *     head-to-head (wins minus losses among the tied players), then opponents' average VP.
 *
 * Usage: npm run standings            (all leagues)
 *        npm run standings -- --dry   (print standings, write nothing)
 */
import fs from "node:fs"
import path from "node:path"
import matter from "gray-matter"

const LEAGUES_DIR = path.join(process.cwd(), "content", "Leagues")
const DRY_RUN = process.argv.includes("--dry")

type Match = { round: number; a: string; b: string; vpA: number; vpB: number }

type Stats = {
  name: string
  file: string
  games: number
  vpTotal: number
  wins: number
  losses: number
  byes: number
  avg: number
  oppAvg: number
  rank: number
  position: number
  rankLabel: string
}

const listDirs = (dir: string) =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith("."))
        .map((d) => d.name)
    : []

const listNotes = (dir: string) =>
  fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".md")) : []

/** All .md files under dir, at any depth (paths relative to dir). */
const listNotesDeep = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { recursive: true, encoding: "utf8" })
        .filter((f) => f.endsWith(".md") && !f.split(path.sep).some((part) => part.startsWith(".")))
    : []

/** The league note: <League>/<League>.md, the folder note for the league. */
function readLeagueNote(leagueDir: string) {
  const file = path.join(leagueDir, `${path.basename(leagueDir)}.md`)
  if (!fs.existsSync(file)) throw new Error(`${path.relative(process.cwd(), file)}: league note not found`)
  return { file, data: matter(fs.readFileSync(file, "utf8")).data }
}

/** "[[Leagues/League 1/Registered Players/Brendon|Brendon]]" -> "Brendon" */
function playerName(link: unknown): string | undefined {
  if (typeof link !== "string") return undefined
  const m = link.match(/^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]$/)
  const target = (m ? m[1] : link).trim()
  return path.basename(target, ".md") || undefined
}

function toNumber(value: unknown, where: string): number {
  const n = typeof value === "number" ? value : Number(value)
  if (value === null || value === undefined || value === "" || Number.isNaN(n)) {
    throw new Error(`${where}: missing or non-numeric VP (${JSON.stringify(value)})`)
  }
  return n
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** Replace or insert top-level scalar keys in a note's frontmatter, leaving everything else untouched. */
function writeFrontmatter(file: string, values: Record<string, number | string>) {
  const src = fs.readFileSync(file, "utf8")
  const m = src.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!m) throw new Error(`${file}: no frontmatter`)
  const lines = m[1].split("\n")
  for (const [key, value] of Object.entries(values)) {
    const idx = lines.findIndex((l) => l.startsWith(`${key}:`))
    const line = `${key}: ${typeof value === "string" ? JSON.stringify(value) : value}`
    if (idx >= 0) {
      lines[idx] = line
    } else {
      const tagsIdx = lines.findIndex((l) => l.startsWith("tags:"))
      lines.splice(tagsIdx >= 0 ? tagsIdx : lines.length, 0, line)
    }
  }
  const out = `---\n${lines.join("\n")}\n---\n` + src.slice(m[0].length)
  if (out !== src) fs.writeFileSync(file, out)
}

function standingsFor(leagueDir: string): Stats[] {
  const playersDir = path.join(leagueDir, "Registered Players")
  const resultsDir = path.join(leagueDir, "Results")

  const players = new Map<string, Stats>()
  for (const f of listNotes(playersDir)) {
    const name = path.basename(f, ".md")
    players.set(name, {
      name,
      file: path.join(playersDir, f),
      games: 0,
      vpTotal: 0,
      wins: 0,
      losses: 0,
      byes: 0,
      avg: 0,
      oppAvg: 0,
      rank: 0,
      position: 0,
      rankLabel: "",
    })
  }

  const league = readLeagueNote(leagueDir)
  const leagueWhere = path.relative(process.cwd(), league.file)
  const currentRound = toNumber(league.data.current_round, `${leagueWhere} current_round`)
  const completed = String(league.data.status ?? "").toLowerCase() === "completed"
  const closedRounds = completed ? currentRound : currentRound - 1

  const matches: Match[] = []
  {
    for (const f of listNotesDeep(resultsDir)) {
      const { data } = matter(fs.readFileSync(path.join(resultsDir, f), "utf8"))
      const tags: unknown[] = Array.isArray(data.tags) ? data.tags : []
      if (data.type !== "match" && !tags.includes("match")) continue
      const where = path.relative(process.cwd(), path.join(resultsDir, f))
      const round = toNumber(data.round, `${where} round`)
      if (!Number.isInteger(round) || round < 1) throw new Error(`${where}: round must be a whole number from 1`)
      if (round > currentRound) {
        throw new Error(`${where}: round ${round} is after the league's current_round (${currentRound})`)
      }
      const a = playerName(data.player_a)
      const b = playerName(data.player_b)
      if (!a || !b) throw new Error(`${where}: player_a and player_b are both required`)
      for (const p of [a, b]) {
        if (!players.has(p)) throw new Error(`${where}: "${p}" is not a registered player`)
      }
      const vpA = toNumber(data.vp_a, where)
      const vpB = toNumber(data.vp_b, where)
      if (vpA === vpB) throw new Error(`${where}: VP is tied ${vpA}-${vpB}, but draws are not possible`)
      matches.push({ round, a, b, vpA, vpB })
    }
  }

  // Totals
  const played = new Map<string, Set<number>>() // player -> rounds with a match
  const opponents = new Map<string, string[]>()
  for (const m of matches) {
    for (const [me, them, mine, theirs] of [
      [m.a, m.b, m.vpA, m.vpB],
      [m.b, m.a, m.vpB, m.vpA],
    ] as const) {
      const s = players.get(me)!
      s.games++
      s.vpTotal += mine
      if (mine > theirs) s.wins++
      else s.losses++
      if (!played.has(me)) played.set(me, new Set())
      played.get(me)!.add(m.round)
      opponents.set(me, [...(opponents.get(me) ?? []), them])
    }
  }
  for (const s of players.values()) {
    const playedRounds = played.get(s.name) ?? new Set<number>()
    s.byes = 0
    for (let r = 1; r <= closedRounds; r++) if (!playedRounds.has(r)) s.byes++
    s.avg = s.games > 0 ? s.vpTotal / s.games : 0
  }
  for (const s of players.values()) {
    const opps = opponents.get(s.name) ?? []
    s.oppAvg = opps.length ? opps.reduce((t, o) => t + players.get(o)!.avg, 0) / opps.length : 0
  }

  // Ranking: average VP, then head-to-head among the tied group, then opponents' average VP
  const sorted = [...players.values()].sort((x, y) => y.avg - x.avg)
  const groups: Stats[][] = []
  for (const s of sorted) {
    const last = groups[groups.length - 1]
    if (last && Math.abs(last[0].avg - s.avg) < 1e-9) last.push(s)
    else groups.push([s])
  }
  const h2h = (s: Stats, group: Stats[]) => {
    const names = new Set(group.map((g) => g.name).filter((n) => n !== s.name))
    let score = 0
    for (const m of matches) {
      const mine = m.a === s.name ? m.vpA : m.b === s.name ? m.vpB : undefined
      const them = m.a === s.name ? m.b : m.b === s.name ? m.a : undefined
      if (mine === undefined || !them || !names.has(them)) continue
      const theirs = m.a === s.name ? m.vpB : m.vpA
      score += Math.sign(mine - theirs)
    }
    return score
  }
  const ranked: Stats[] = []
  groups.forEach((group, groupIndex) => {
    const keyed = group.map((s) => ({ s, h: h2h(s, group), o: round2(s.oppAvg) }))
    keyed.sort((x, y) => y.h - x.h || y.o - x.o || x.s.name.localeCompare(y.s.name))
    for (const k of keyed) {
      k.s.rank = groupIndex + 1
      k.s.position = ranked.length + 1
      ranked.push(k.s)
    }
  })
  const sharing = new Map<number, number>()
  for (const s of ranked) sharing.set(s.rank, (sharing.get(s.rank) ?? 0) + 1)
  for (const s of ranked) s.rankLabel = sharing.get(s.rank)! > 1 ? `${s.rank} - tied` : `${s.rank}`
  return ranked
}

for (const league of listDirs(LEAGUES_DIR)) {
  const leagueDir = path.join(LEAGUES_DIR, league)
  if (!fs.existsSync(path.join(leagueDir, `${league}.md`))) continue // not a league folder
  const table = standingsFor(leagueDir)
  console.log(`\n${league}`)
  console.table(
    table.map((s) => ({
      rank: s.rankLabel,
      position: s.position,
      player: s.name,
      avg_vp: round2(s.avg),
      games: s.games,
      vp_total: s.vpTotal,
      "W-L": `${s.wins}-${s.losses}`,
      byes: s.byes,
      opp_avg_vp: round2(s.oppAvg),
    })),
  )
  if (DRY_RUN) continue
  for (const s of table) {
    writeFrontmatter(s.file, {
      rank: s.rank,
      rank_label: s.rankLabel,
      position: s.position,
      avg_vp: round2(s.avg),
      games: s.games,
      vp_total: s.vpTotal,
      wins: s.wins,
      losses: s.losses,
      byes: s.byes,
      opp_avg_vp: round2(s.oppAvg),
    })
  }
}
