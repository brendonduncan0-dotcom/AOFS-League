/**
 * AOFS League Worker.
 *
 * Serves the static site (Quartz build in public/) and handles the site's API:
 *   POST /api/register   { league: "Leagues/League 2", name: "Alex" }
 *     -> opens a GitHub pull request adding Leagues/League 2/Registered Players/Alex.md
 *
 * Configuration (wrangler.jsonc):
 *   vars.GITHUB_REPO     "owner/repo"
 *   vars.GITHUB_BRANCH   branch the site deploys from (pull requests target it)
 *   secret GITHUB_TOKEN  fine-grained token for this repo: Contents + Pull requests read/write
 */

export interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> }
  GITHUB_REPO: string
  GITHUB_BRANCH: string
  GITHUB_TOKEN: string
}

/** Same rule as the form: letters/numbers first, then letters, numbers, space ' - . (max 40). */
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} '\-.]{0,39}$/u
/** League folders live directly under Leagues/, e.g. "Leagues/League 2". */
const LEAGUE = /^Leagues\/[\p{L}\p{N}][\p{L}\p{N} '\-.]{0,79}$/u

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/api/register") {
      if (request.method !== "POST") return json({ error: "Use POST" }, 405)
      return register(request, env)
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

export async function register(request: Request, env: Env, gh = github(env)): Promise<Response> {
  try {
    if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN secret is not set")
    const body = (await request.json().catch(() => null)) as { league?: unknown; name?: unknown } | null
    const league = typeof body?.league === "string" ? body.league.trim() : ""
    const name = typeof body?.name === "string" ? body.name.trim().replace(/\s+/g, " ") : ""

    if (!LEAGUE.test(league) || league.includes("..")) throw new UserError("Unknown league.")
    if (!NAME.test(name)) {
      throw new UserError("Names can use letters, numbers, spaces, hyphens, apostrophes and full stops (max 40).")
    }

    const leagueName = league.split("/").pop()!
    const leagueNote = await gh.file(`content/${league}/${leagueName}.md`)
    if (leagueNote === null) throw new UserError("Unknown league.")
    const status = frontmatterValue(leagueNote, "status")
    if (status?.toLowerCase() !== "upcoming") throw new UserError("Registration for this league is closed.")

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
    const note = playerNote(template, name, leagueName)
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
    if (err instanceof UserError) return json({ error: err.message }, err.status)
    console.error("register failed:", err)
    return json({ error: "Something went wrong on our side." }, 500)
  }
}

/** Fill the Player template's frontmatter for a new registration. */
export function playerNote(template: string, name: string, leagueName: string): string {
  const set = (src: string, key: string, value: string) =>
    new RegExp(`^${key}:.*$`, "m").test(src)
      ? src.replace(new RegExp(`^${key}:.*$`, "m"), `${key}: ${value}`)
      : src
  let out = template
  out = set(out, "title", JSON.stringify(name))
  out = set(out, "league", JSON.stringify(`[[${leagueName}]]`))
  out = set(out, "status", "active")
  out = set(out, "joined_round", "1")
  return out
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

// --- GitHub REST API -------------------------------------------------------------------------

export type GitHub = {
  /** File contents on the deploy branch, or null if it doesn't exist. */
  file(path: string): Promise<string | null>
  /** File names in a folder on the deploy branch ([] if the folder doesn't exist). */
  list(path: string): Promise<string[]>
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

  return {
    async file(path) {
      const res = await api("GET", `/contents/${encodePath(path)}?${ref}`)
      if (res.status === 404) return null
      if (!res.ok) await fail(`read ${path}`, res)
      const data = (await res.json()) as { content?: string }
      return b64decode(data.content ?? "")
    },
    async list(path) {
      const res = await api("GET", `/contents/${encodePath(path)}?${ref}`)
      if (res.status === 404) return []
      if (!res.ok) await fail(`list ${path}`, res)
      const data = (await res.json()) as { name: string; type: string }[]
      return data.filter((e) => e.type === "file").map((e) => e.name)
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
