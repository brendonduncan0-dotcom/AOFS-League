/**
 * AOFS League Worker.
 *
 * Serves the static site (Quartz build in public/) and handles the site's API:
 *   POST /api/register   { league: "Leagues/League 2", name: "Alex", armyLink: "https://army-forge…",
 *                          turnstileToken: "…" }
 *     -> opens a GitHub pull request adding Leagues/League 2/Registered Players/Alex.md
 *   POST /api/leagues    { season: "2027 Summer", turnstileToken: "…" }
 *     -> opens a GitHub pull request adding Leagues/League N/League N.md (the next free number)
 *
 * Configuration (wrangler.jsonc):
 *   vars.GITHUB_REPO     "owner/repo"
 *   vars.GITHUB_BRANCH   branch the site deploys from (pull requests target it)
 *   secret GITHUB_TOKEN  fine-grained token for this repo: Contents + Pull requests read/write
 *   secret TURNSTILE_SECRET  Turnstile widget secret key; every request must carry a valid token
 */

export interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> }
  GITHUB_REPO: string
  GITHUB_BRANCH: string
  GITHUB_TOKEN: string
  TURNSTILE_SECRET: string
}

/** Same rule as the form: letters/numbers first, then letters, numbers, space ' - . (max 40). */
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} '\-.]{0,39}$/u
/** League folders live directly under Leagues/, e.g. "Leagues/League 2". */
/**
 * Army Forge share links only (required): https://army-forge.onepagerules.com/share?id=…
 * Other Army Forge pages (e.g. the builder) only work for the person who made the list.
 * Returns the cleaned URL, or a message explaining what's wrong.
 */
export const ARMY_LINK_ERRORS = {
  missing: "Please enter your army link.",
  site: "That isn't an Army Forge link.",
  builder: "That's your builder link, which only works for you.",
  view: "That's a viewer link, which others can't open.",
  other: "That's not the right Army Forge link.",
  id: "That link is incomplete.",
  long: "That link is too long.",
}
export function checkArmyLink(value: unknown): { url: string } | { error: string } {
  if (value === undefined || value === null) return { error: ARMY_LINK_ERRORS.missing }
  if (typeof value !== "string") return { error: ARMY_LINK_ERRORS.site }
  const raw = value.trim()
  if (raw === "") return { error: ARMY_LINK_ERRORS.missing }
  if (raw.length > 500) return { error: ARMY_LINK_ERRORS.long }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { error: ARMY_LINK_ERRORS.site }
  }
  if (url.protocol !== "https:" || url.hostname !== "army-forge.onepagerules.com") {
    return { error: ARMY_LINK_ERRORS.site }
  }
  const path = url.pathname.replace(/\/+$/, "")
  if (path !== "/share") {
    if (path === "/view" || path.startsWith("/view/")) return { error: ARMY_LINK_ERRORS.view }
    if (path.split("/").includes("build")) return { error: ARMY_LINK_ERRORS.builder }
    return { error: ARMY_LINK_ERRORS.other }
  }
  if (!url.searchParams.get("id")?.trim()) return { error: ARMY_LINK_ERRORS.id }
  return { url: url.toString() }
}

/** Season names: letters/numbers first, then letters, numbers, space and ' - . , & ( ) / (max 60). */
export const SEASON = /^[\p{L}\p{N}][\p{L}\p{N} '\-.,&()/]{0,59}$/u
export const SEASON_ERROR = "Season names can use letters, numbers, spaces and - ' . , & ( ) / (max 60)."

const LEAGUE = /^Leagues\/[\p{L}\p{N}][\p{L}\p{N} '\-.]{0,79}$/u

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/api/register") {
      if (request.method !== "POST") return json({ error: "Use POST" }, 405)
      return register(request, env)
    }
    if (url.pathname === "/api/leagues") {
      if (request.method !== "POST") return json({ error: "Use POST" }, 405)
      return createLeague(request, env)
    }
    if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404)
    return env.ASSETS.fetch(request)
  },
}

class UserError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

/** Both secrets must be set, and the request must carry a valid Turnstile token. */
async function requireHuman(request: Request, env: Env, verify: Verifier, body: { turnstileToken?: unknown } | null) {
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN secret is not set")
  if (!env.TURNSTILE_SECRET) throw new Error("TURNSTILE_SECRET secret is not set")
  const token = typeof body?.turnstileToken === "string" ? body.turnstileToken : ""
  if (!token) throw new UserError("Please complete the verification check.", 403)
  const ip = request.headers.get("CF-Connecting-IP") ?? undefined
  if (!(await verify(token, ip))) throw new UserError("Verification failed, please try again.", 403)
}

const failed = (err: unknown, what: string) => {
  if (err instanceof UserError) return json({ error: err.message }, err.status)
  console.error(`${what} failed:`, err)
  return json({ error: "Something went wrong on our side." }, 500)
}

/** The highest N among folders named "League N" (0 if none). Other folder names are ignored. */
const highestLeagueNumber = (folders: string[]) =>
  Math.max(0, ...folders.map((f) => Number(f.match(/^League ([1-9]\d{0,5})$/)?.[1] ?? 0)))

/** How many numbers past the highest existing league to try when others are waiting for approval. */
const LEAGUE_NUMBER_TRIES = 10

export async function createLeague(
  request: Request,
  env: Env,
  gh = github(env),
  verify: Verifier = turnstile(env),
): Promise<Response> {
  try {
    const body = (await request.json().catch(() => null)) as { season?: unknown; turnstileToken?: unknown } | null
    await requireHuman(request, env, verify, body)

    const season = typeof body?.season === "string" ? body.season.trim().replace(/\s+/g, " ") : ""
    if (!season) throw new UserError("Please enter a season name.")
    if (!SEASON.test(season)) throw new UserError(SEASON_ERROR)

    const template = await gh.file("content/templates/League.md")
    if (template === null) throw new Error("content/templates/League.md is missing")

    // The next number after the highest League N. Leagues still waiting for approval already
    // have their branch, so step past those.
    const first = highestLeagueNumber(await gh.folders("content/Leagues")) + 1
    let number: number | undefined
    for (let n = first; n < first + LEAGUE_NUMBER_TRIES; n++) {
      if (await gh.createBranch(`create-league/league-${n}`)) {
        number = n
        break
      }
    }
    if (number === undefined) throw new UserError("Too many new leagues are waiting for approval. Please try again later.", 409)

    const name = `League ${number}`
    const branch = `create-league/league-${number}`
    const path = `content/Leagues/${name}/${name}.md`
    await gh.putFile(path, leagueNote(template, name, season), branch, `Create ${name} (${season})`)
    const pr = await gh.openPullRequest(
      branch,
      `Create ${name} (${season})`,
      [`**${name}** (season: ${season}) was created through the website.`, "", `Adds \`${path}\`.`].join("\n"),
    )
    return json({ ok: true, league: name, url: `/leagues/league-${number}/`, pullRequest: pr })
  } catch (err) {
    return failed(err, "create league")
  }
}

/** Fill the League template's frontmatter for a new league (rounds stay blank until round 1). */
export function leagueNote(template: string, name: string, season: string): string {
  let out = template
  out = setFrontmatter(out, "title", name)
  out = setFrontmatter(out, "season", JSON.stringify(season))
  out = setFrontmatter(out, "status", "Upcoming")
  out = setFrontmatter(out, "rounds", "")
  out = setFrontmatter(out, "current_round", "0")
  out = setFrontmatter(out, "registration_open", "true")
  out = setFrontmatter(out, "player_count", "0")
  out = setFrontmatter(out, "winner", "")
  return out
}

/**
 * Set `key: value` in a note's frontmatter, or add it before `tags:` if missing.
 * An empty value writes `key:`. Function replacements, so `$` in values is never a pattern.
 */
export function setFrontmatter(src: string, key: string, value: string): string {
  const line = value === "" ? `${key}:` : `${key}: ${value}`
  const existing = new RegExp(`^${key}:.*$`, "m")
  if (existing.test(src)) return src.replace(existing, () => line)
  return src.replace(/^tags:/m, () => `${line}\ntags:`)
}

export async function register(
  request: Request,
  env: Env,
  gh = github(env),
  verify: Verifier = turnstile(env),
): Promise<Response> {
  try {
    const body = (await request.json().catch(() => null)) as
      | { league?: unknown; name?: unknown; armyLink?: unknown; turnstileToken?: unknown }
      | null
    // Human check first, before touching GitHub
    await requireHuman(request, env, verify, body)

    const league = typeof body?.league === "string" ? body.league.trim() : ""
    const name = typeof body?.name === "string" ? body.name.trim().replace(/\s+/g, " ") : ""

    if (!LEAGUE.test(league) || league.includes("..")) throw new UserError("Unknown league.")
    if (!NAME.test(name)) {
      throw new UserError("Names can use letters, numbers, spaces, hyphens, apostrophes and full stops (max 40).")
    }
    const army = checkArmyLink(body?.armyLink)
    if ("error" in army) throw new UserError(army.error)
    const armyLink = army.url

    const leagueName = league.split("/").pop()!
    const leagueNote = await gh.file(`content/${league}/${leagueName}.md`)
    if (leagueNote === null) throw new UserError("Unknown league.")
    const joinedRound = registrationRound(leagueNote)
    if (joinedRound === undefined) throw new UserError("Registration for this league is closed.")

    const playersDir = `content/${league}/Registered Players`
    const existing = await gh.list(playersDir)
    if (existing.some((f) => f.toLowerCase() === `${name.toLowerCase()}.md`)) {
      throw new UserError(`${name} is already registered for this league.`, 409)
    }

    const branch = `register/${slug(leagueName)}/${slug(name)}`
    const created = await gh.createBranch(branch)
    if (!created) throw new UserError(`A registration for ${name} is already waiting for approval.`, 409)

    const template = await gh.file("content/templates/Player.md")
    if (template === null) throw new Error("content/templates/Player.md is missing")
    const note = playerNote(template, name, leagueName, armyLink, joinedRound)
    const path = `${playersDir}/${name}.md`
    await gh.putFile(path, note, branch, `Register ${name} for ${leagueName}`)
    const pr = await gh.openPullRequest(
      branch,
      `Register ${name} for ${leagueName}`,
      [
        `**${name}** registered for **${leagueName}** through the website.`,
        "",
        `Adds \`${path}\`. Merge to approve, or close to decline.`,
      ].join("\n"),
    )
    return json({ ok: true, pullRequest: pr })
  } catch (err) {
    return failed(err, "register")
  }
}

/** Fill the Player template's frontmatter for a new registration. */
export function playerNote(
  template: string,
  name: string,
  leagueName: string,
  armyLink = "",
  joinedRound = 1,
): string {
  const set = setFrontmatter
  let out = template
  out = set(out, "title", JSON.stringify(name))
  out = set(out, "league", JSON.stringify(`[[${leagueName}]]`))
  out = set(out, "status", "active")
  out = set(out, "joined_round", String(joinedRound))
  if (armyLink) out = set(out, "army", JSON.stringify(armyLink))
  return out
}

/**
 * The round a new player joins from, or undefined if registration is closed.
 * Same rule as the registration form (plugins/league-registration): `registration_open: true`,
 * and the league is Upcoming (round 1) or Active with rounds still to pair (the next round;
 * the current round is already paired).
 */
export function registrationRound(leagueNote: string): number | undefined {
  if (frontmatterValue(leagueNote, "registration_open")?.toLowerCase() !== "true") return undefined
  const status = frontmatterValue(leagueNote, "status")?.toLowerCase()
  if (status === "upcoming") return 1
  if (status !== "active") return undefined
  const current = Number(frontmatterValue(leagueNote, "current_round"))
  const rounds = Number(frontmatterValue(leagueNote, "rounds"))
  if (!Number.isInteger(current) || !Number.isInteger(rounds) || current >= rounds) return undefined
  return current + 1
}

/** Read a simple top-level `key: value` from a note's frontmatter (quotes removed). */
export function frontmatterValue(note: string, key: string): string | undefined {
  const fm = note.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ""
  const line = fm.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"))?.[1]?.trim()
  return line?.replace(/^(["'])(.*)\1$/, "$2")
}

const slug = (s: string) =>
  s
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "x"

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } })

// --- Cloudflare Turnstile --------------------------------------------------------------------

export type Verifier = (token: string, ip?: string) => Promise<boolean>

/** Checks a Turnstile token with Cloudflare (single use; expires after 5 minutes). */
export function turnstile(env: Env, fetchImpl: typeof fetch = fetch): Verifier {
  return async (token, ip) => {
    const form = new FormData()
    form.append("secret", env.TURNSTILE_SECRET)
    form.append("response", token)
    if (ip) form.append("remoteip", ip)
    const res = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
    })
    if (!res.ok) throw new Error(`Turnstile siteverify failed: ${res.status}`)
    const data = (await res.json()) as { success?: boolean; "error-codes"?: string[] }
    if (!data.success) console.warn("Turnstile rejected token:", data["error-codes"])
    return data.success === true
  }
}

// --- GitHub REST API -------------------------------------------------------------------------

export type GitHub = {
  /** File contents on the deploy branch, or null if it doesn't exist. */
  file(path: string): Promise<string | null>
  /** File names in a folder on the deploy branch ([] if the folder doesn't exist). */
  list(path: string): Promise<string[]>
  /** Subfolder names in a folder on the deploy branch ([] if the folder doesn't exist). */
  folders(path: string): Promise<string[]>
  /** Create a branch from the deploy branch. false if it already exists. */
  createBranch(branch: string): Promise<boolean>
  putFile(path: string, content: string, branch: string, message: string): Promise<void>
  /** Open a pull request into the deploy branch; returns its URL. */
  openPullRequest(branch: string, title: string, body: string): Promise<string>
}

const b64encode = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)))
const b64decode = (s: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, "")), (c) => c.charCodeAt(0)))
const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/")

export function github(env: Env, fetchImpl: typeof fetch = fetch): GitHub {
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetchImpl(`https://api.github.com/repos/${env.GITHUB_REPO}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "aofs-league-worker",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    return res
  }
  const fail = async (what: string, res: Response) => {
    throw new Error(`GitHub ${what} failed: ${res.status} ${await res.text()}`)
  }
  const ref = `ref=${encodeURIComponent(env.GITHUB_BRANCH)}`
  const entries = async (path: string) => {
    const res = await api("GET", `/contents/${encodePath(path)}?${ref}`)
    if (res.status === 404) return []
    if (!res.ok) await fail(`list ${path}`, res)
    return (await res.json()) as { name: string; type: string }[]
  }

  return {
    async file(path) {
      const res = await api("GET", `/contents/${encodePath(path)}?${ref}`)
      if (res.status === 404) return null
      if (!res.ok) await fail(`read ${path}`, res)
      const data = (await res.json()) as { content?: string }
      return b64decode(data.content ?? "")
    },
    async list(path) {
      return (await entries(path)).filter((e) => e.type === "file").map((e) => e.name)
    },
    async folders(path) {
      return (await entries(path)).filter((e) => e.type === "dir").map((e) => e.name)
    },
    async createBranch(branch) {
      const head = await api("GET", `/git/ref/heads/${encodePath(env.GITHUB_BRANCH)}`)
      if (!head.ok) await fail("read deploy branch", head)
      const sha = ((await head.json()) as { object: { sha: string } }).object.sha
      const res = await api("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha })
      if (res.status === 422) return false // already exists
      if (!res.ok) await fail(`create branch ${branch}`, res)
      return true
    },
    async putFile(path, content, branch, message) {
      const res = await api("PUT", `/contents/${encodePath(path)}`, {
        message,
        content: b64encode(content),
        branch,
      })
      if (!res.ok) await fail(`write ${path}`, res)
    },
    async openPullRequest(branch, title, body) {
      const res = await api("POST", "/pulls", { title, head: branch, base: env.GITHUB_BRANCH, body })
      if (!res.ok) await fail("open pull request", res)
      return ((await res.json()) as { html_url: string }).html_url
    },
  }
}
