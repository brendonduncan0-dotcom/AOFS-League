import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import worker, {
  ARMY_LINK_ERRORS,
  SEASON_ERROR,
  seasonTaken,
  siteStatus,
  checkArmyLink,
  advanceLeague,
  createLeague,
  frontmatterValue,
  github,
  playerNote,
  register,
  turnstile,
  type Env,
  type GitHub,
} from "./index.ts"

const env: Env = {
  ASSETS: { fetch: async () => new Response("asset") },
  GITHUB_REPO: "owner/repo",
  GITHUB_BRANCH: "v5",
  GITHUB_TOKEN: "test-token",
  TURNSTILE_SECRET: "test-secret",
}

const template = readFileSync("content/templates/Player.md", "utf8")
const upcomingLeague = "---\ntitle: League 2\nstatus: Upcoming\nrounds: 3\ncurrent_round: 0\nregistration_open: true\n---\n"

/** In-memory GitHub: files on the deploy branch, branches, and what the Worker wrote. */
function fakeGitHub(
  files: Record<string, string>,
  branches: string[] = [],
  /** files on other branches: { branch: { path: content } } */
  branchFiles: Record<string, Record<string, string>> = {},
  failDispatch = false,
) {
  const written: { path: string; content: string; branch: string }[] = []
  const prs: { branch: string; title: string }[] = []
  const dispatches: { eventType: string; payload: Record<string, unknown> }[] = []
  const gh: GitHub = {
    async file(p, branch) {
      return (branch ? branchFiles[branch]?.[p] : files[p]) ?? null
    },
    async branches(prefix) {
      return branches.filter((b) => b.startsWith(prefix))
    },
    async list(dir) {
      return Object.keys(files)
        .filter((p) => p.startsWith(dir + "/") && !p.slice(dir.length + 1).includes("/"))
        .map((p) => p.slice(dir.length + 1))
    },
    async folders(dir) {
      const names = Object.keys(files)
        .filter((p) => p.startsWith(dir + "/") && p.slice(dir.length + 1).includes("/"))
        .map((p) => p.slice(dir.length + 1).split("/")[0])
      return [...new Set(names)]
    },
    async createBranch(b) {
      if (branches.includes(b)) return false
      branches.push(b)
      return true
    },
    async putFile(path, content, branch) {
      written.push({ path, content, branch })
    },
    async recentCommits() {
      return []
    },
    async checks() {
      return []
    },
    async deleteBranch(b) {
      const i = branches.indexOf(b)
      if (i >= 0) branches.splice(i, 1)
    },
    async dispatch(eventType, payload) {
      if (failDispatch) throw new Error("GitHub dispatch failed: 500")
      dispatches.push({ eventType, payload })
    },
    async openPullRequest(branch, title) {
      prs.push({ branch, title })
      return `https://github.com/owner/repo/pull/${prs.length}`
    },
  }
  return { gh, written, prs, branches, dispatches }
}

const baseFiles = () => ({
  "content/Leagues/League 2/League 2.md": upcomingLeague,
  "content/Leagues/League 2/Registered Players/Test Player 1.md": "---\ntitle: Test Player 1\n---\n",
  "content/templates/Player.md": template,
})

const post = (body: unknown) =>
  new Request("https://site.example/api/register", { method: "POST", body: JSON.stringify(body) })

/** Turnstile stand-in: only the token "ok" passes. */
const verifyOk = async (token: string) => token === "ok"

async function call(body: any, files = baseFiles(), branches: string[] = []) {
  const fake = fakeGitHub(files, branches)
  // fill in a valid token and army link unless the test sets them
  const withToken =
    body && typeof body === "object"
      ? { turnstileToken: "ok", armyLink: "https://army-forge.onepagerules.com/share?id=Default", ...body }
      : body
  const res = await register(post(withToken), env, fake.gh, verifyOk)
  return { status: res.status, body: (await res.json()) as Record<string, string>, ...fake }
}

test("registers a new player: branch, player note from the template, pull request", async () => {
  const r = await call({ league: "Leagues/League 2", name: "  Alex   Smith " })
  assert.equal(r.status, 200)
  assert.equal(r.body.pullRequest, "https://github.com/owner/repo/pull/1")
  assert.deepEqual(r.branches, ["register/league-2/alex-smith"])
  assert.equal(r.written.length, 1)
  const note = r.written[0]
  assert.equal(note.path, "content/Leagues/League 2/Registered Players/Alex Smith.md")
  assert.equal(note.branch, "register/league-2/alex-smith")
  assert.equal(frontmatterValue(note.content, "title"), "Alex Smith")
  assert.equal(frontmatterValue(note.content, "league"), "[[League 2]]")
  assert.equal(frontmatterValue(note.content, "status"), "active")
  assert.match(note.content, /## Match history/) // body of the template kept
  assert.equal(r.prs[0].title, "Register Alex Smith for League 2")
})

test("rejects a name that is already registered (any case)", async () => {
  const r = await call({ league: "Leagues/League 2", name: "test player 1" })
  assert.equal(r.status, 409)
  assert.match(r.body.error, /already registered/)
  assert.equal(r.written.length, 0)
})

test("rejects a second registration while the first is waiting for approval", async () => {
  const r = await call({ league: "Leagues/League 2", name: "Alex" }, baseFiles(), ["register/league-2/alex"])
  assert.equal(r.status, 409)
  assert.match(r.body.error, /already waiting/)
  assert.equal(r.written.length, 0)
})

const withLeague = (note: string) => ({ ...baseFiles(), "content/Leagues/League 2/League 2.md": note })

test("rejects leagues whose registration is closed", async () => {
  const closed = [
    upcomingLeague.replace("registration_open: true", "registration_open: false"),
    upcomingLeague.replace("registration_open: true\n", ""),
    upcomingLeague.replace("Upcoming", "Completed"),
    // Active, but the final round is already paired
    upcomingLeague.replace("Upcoming", '"Active"').replace("current_round: 0", "current_round: 3"),
  ]
  for (const note of closed) {
    const r = await call({ league: "Leagues/League 2", name: "Alex" }, withLeague(note))
    assert.equal(r.status, 400, note)
    assert.match(r.body.error, /closed/)
    assert.equal(r.written.length, 0)
  }
})

test("late registration for an active league joins from the next round", async () => {
  const active = upcomingLeague.replace("Upcoming", '"Active"').replace("current_round: 0", "current_round: 1")
  const r = await call({ league: "Leagues/League 2", name: "Alex" }, withLeague(active))
  assert.equal(r.status, 200)
  assert.equal(frontmatterValue(r.written[0].content, "joined_round"), "2")
})

test("rejects unknown leagues and path tricks", async () => {
  for (const league of ["Leagues/Nope", "../secrets", "Leagues/../x", "content/Leagues/League 2", "", 42]) {
    const r = await call({ league, name: "Alex" })
    assert.equal(r.status, 400, String(league))
    assert.match(r.body.error, /Unknown league/)
  }
})

test("rejects invalid names", async () => {
  for (const name of ["", "   ", "<script>", "a/b", ".hidden", "x".repeat(41), null]) {
    const r = await call({ league: "Leagues/League 2", name })
    assert.equal(r.status, 400, String(name))
  }
})

test("rejects a malformed request body", async () => {
  const res = await register(
    new Request("https://site.example/api/register", { method: "POST", body: "not json" }),
    env,
    fakeGitHub(baseFiles()).gh,
    verifyOk,
  )
  assert.equal(res.status, 403) // no Turnstile token in a body that isn't JSON
})

test("requires a valid Turnstile token before contacting GitHub", async () => {
  const missing = await call({ league: "Leagues/League 2", name: "Alex", turnstileToken: "" })
  assert.equal(missing.status, 403)
  assert.match(missing.body.error, /verification/i)
  const bad = await call({ league: "Leagues/League 2", name: "Alex", turnstileToken: "forged" })
  assert.equal(bad.status, 403)
  assert.match(bad.body.error, /failed/)
  assert.equal(bad.branches.length + bad.written.length, 0)
})

test("fails closed when the Turnstile secret is not configured", async () => {
  const fake = fakeGitHub(baseFiles())
  const res = await register(
    post({ league: "Leagues/League 2", name: "Alex", turnstileToken: "ok" }),
    { ...env, TURNSTILE_SECRET: "" },
    fake.gh,
    verifyOk,
  )
  assert.equal(res.status, 500)
  assert.equal(fake.written.length, 0)
})

test("Turnstile verifier posts secret, token and IP to Cloudflare", async () => {
  let sent: FormData | undefined
  let url = ""
  const verify = turnstile(env, (async (u: string, init: RequestInit) => {
    url = u
    sent = init.body as FormData
    return new Response(JSON.stringify({ success: sent.get("response") === "good" }))
  }) as typeof fetch)
  assert.equal(await verify("good", "1.2.3.4"), true)
  assert.equal(url, "https://challenges.cloudflare.com/turnstile/v0/siteverify")
  assert.equal(sent!.get("secret"), "test-secret")
  assert.equal(sent!.get("remoteip"), "1.2.3.4")
  assert.equal(await verify("bad"), false)
})

test("routes: /api/register needs POST, other /api paths 404, everything else is the site", async () => {
  const get = await worker.fetch(new Request("https://site.example/api/register"), env)
  assert.equal(get.status, 405)
  const unknown = await worker.fetch(new Request("https://site.example/api/other"), env)
  assert.equal(unknown.status, 404)
  const page = await worker.fetch(new Request("https://site.example/leagues/league-2/"), env)
  assert.equal(await page.text(), "asset")
})

test("playerNote fills the template's frontmatter", () => {
  const note = playerNote(template, "O'Neil", "League 3")
  assert.equal(frontmatterValue(note, "title"), "O'Neil")
  assert.equal(frontmatterValue(note, "league"), "[[League 3]]")
  assert.equal(frontmatterValue(note, "joined_round"), "1")
})

test("GitHub client: sends authenticated requests and base64-encodes the new file", async () => {
  const calls: { method: string; url: string; body?: any; auth?: string }[] = []
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method: init.method!, url, body, auth: (init.headers as Record<string, string>).Authorization })
    if (url.includes("/git/ref/heads/v5")) return new Response(JSON.stringify({ object: { sha: "abc" } }))
    if (url.endsWith("/pulls")) return new Response(JSON.stringify({ html_url: "https://pr" }), { status: 201 })
    return new Response("{}", { status: 201 })
  }) as typeof fetch
  const gh = github(env, fakeFetch)
  assert.equal(await gh.createBranch("register/league-2/zoë"), true)
  await gh.putFile("content/Leagues/League 2/Registered Players/Zoë.md", "title: Zoë", "register/league-2/zoë", "msg")
  assert.equal(await gh.openPullRequest("register/league-2/zoë", "t", "b"), "https://pr")

  assert.ok(calls.every((c) => c.auth === "Bearer test-token"))
  assert.deepEqual(calls[1].body, { ref: "refs/heads/register/league-2/zoë", sha: "abc" })
  assert.equal(calls[2].method, "PUT")
  assert.equal(calls[2].url, "https://api.github.com/repos/owner/repo/contents/content/Leagues/League%202/Registered%20Players/Zo%C3%AB.md")
  assert.equal(Buffer.from(calls[2].body.content, "base64").toString("utf8"), "title: Zoë")
  assert.equal(calls[3].body.base, "v5")
})

const ARMY = "https://army-forge.onepagerules.com/share?id=AbC123&name=My%20List"

test("stores the Army Forge link in the army property", async () => {
  const r = await call({ league: "Leagues/League 2", name: "Alex", armyLink: `  ${ARMY}  ` })
  assert.equal(r.status, 200)
  assert.equal(frontmatterValue(r.written[0].content, "army"), ARMY)
})

test("army link is required", async () => {
  for (const armyLink of ["", "   ", undefined, null]) {
    const r = await call({ league: "Leagues/League 2", name: "Alex", armyLink })
    assert.equal(r.status, 400, String(armyLink))
    assert.equal(r.body.error, ARMY_LINK_ERRORS.missing)
    assert.equal(r.written.length, 0)
  }
})

test("army link must be an Army Forge share link, with a message for each mistake", async () => {
  const cases: [unknown, keyof typeof ARMY_LINK_ERRORS][] = [
    ["https://evil.example/?u=army-forge.onepagerules.com", "site"],
    ["https://army-forge.onepagerules.com.evil.example/share?id=x", "site"],
    ["http://army-forge.onepagerules.com/share?id=x", "site"],
    ["javascript:alert(1)", "site"],
    ["not a url", "site"],
    [42, "site"],
    // the builder / other Army Forge pages only work for the list's owner
    // a real builder URL (game system / build / list id)
    ["https://army-forge.onepagerules.com/list/age-of-fantasy-skirmish/build/SmegSIXvsgfX", "builder"],
    // the list viewer (shortened link) doesn't open the list for others either
    ["https://army-forge.onepagerules.com/view/age-of-fantasy-skirmish", "view"],
    ["https://army-forge.onepagerules.com/view/age-of-fantasy-skirmish/AbC123", "view"],
    ["https://army-forge.onepagerules.com/view?id=AbC123", "view"],
    // any other Army Forge page
    ["https://army-forge.onepagerules.com/listBuilder?listId=AbC123", "other"],
    ["https://army-forge.onepagerules.com/list?id=AbC123", "other"],
    ["https://army-forge.onepagerules.com/", "other"],
    ["https://army-forge.onepagerules.com/viewer", "other"],
    ["https://army-forge.onepagerules.com/share", "id"],
    ["https://army-forge.onepagerules.com/share?id=", "id"],
    ["https://army-forge.onepagerules.com/share?name=Test", "id"],
    ["https://army-forge.onepagerules.com/share?id=" + "x".repeat(600), "long"],
  ]
  for (const [armyLink, kind] of cases) {
    const r = await call({ league: "Leagues/League 2", name: "Alex", armyLink })
    assert.equal(r.status, 400, String(armyLink))
    assert.equal(r.body.error, ARMY_LINK_ERRORS[kind], String(armyLink))
    assert.equal(r.written.length, 0)
  }
})

test("accepts share links, including a trailing slash and extra parameters", () => {
  for (const ok of [
    "https://army-forge.onepagerules.com/share?id=AbC123",
    "https://army-forge.onepagerules.com/share/?id=AbC123",
    "https://army-forge.onepagerules.com/share?id=AbC123&name=My%20List",
  ]) {
    assert.ok("url" in checkArmyLink(ok), ok)
  }
})

test("army link URLs with $ and quotes are written safely", () => {
  const checked = checkArmyLink("https://army-forge.onepagerules.com/share?id=a$&b='c\"d")
  assert.ok("url" in checked)
  const note = playerNote(template, "Alex", "League 2", checked.url)
  assert.equal(frontmatterValue(note, "army"), checked.url)
  assert.match(note, /^title: "Alex"$/m)
})

test("adds army before tags if the template doesn't have it", () => {
  const old = "---\ntitle:\nleague:\ntags:\n  - player\n---\n"
  const note = playerNote(old, "Alex", "League 2", ARMY)
  assert.match(note, /army: ".+"\ntags:/)
})

// --- Creating leagues ------------------------------------------------------------------------

const leagueTemplate = readFileSync("content/templates/League.md", "utf8")
const leagueFiles = (): Record<string, string> => ({
  ...baseFiles(),
  "content/Leagues/League 1/League 1.md": upcomingLeague,
  "content/Leagues/Test League/Test League.md": upcomingLeague,
  "content/templates/League.md": leagueTemplate,
})

async function create(
  body: any,
  files = leagueFiles(),
  branches: string[] = [],
  branchFiles: Record<string, Record<string, string>> = {},
) {
  const fake = fakeGitHub(files, branches, branchFiles)
  const withToken = body && typeof body === "object" ? { turnstileToken: "ok", ...body } : body
  const req = new Request("https://site.example/api/leagues", { method: "POST", body: JSON.stringify(withToken) })
  const res = await createLeague(req, env, fake.gh, verifyOk)
  return { status: res.status, body: (await res.json()) as Record<string, string>, ...fake }
}

test("creates the next numbered league from the template", async () => {
  const r = await create({ season: "  2027   Summer " })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.league, "League 3")
  assert.equal(r.body.url, "/leagues/league-3/")
  assert.deepEqual(r.branches, ["create-league/league-3"])
  assert.equal(r.written.length, 1)
  const { path, content, branch } = r.written[0]
  assert.equal(path, "content/Leagues/League 3/League 3.md")
  assert.equal(branch, "create-league/league-3")
  assert.equal(frontmatterValue(content, "title"), "League 3")
  assert.equal(frontmatterValue(content, "season"), "2027 Summer")
  assert.equal(frontmatterValue(content, "status"), "Upcoming")
  assert.equal(frontmatterValue(content, "rounds"), "")
  assert.equal(frontmatterValue(content, "current_round"), "0")
  assert.equal(frontmatterValue(content, "registration_open"), "true")
  assert.match(content, /```league-registration/) // the template's page body comes along
  assert.equal(r.prs[0].title, "Create League 3 (2027 Summer)")
})

test("steps past league numbers already waiting for approval", async () => {
  const r = await create({ season: "Winter" }, leagueFiles(), ["create-league/league-3", "create-league/league-4"])
  assert.equal(r.status, 200)
  assert.equal(r.body.league, "League 5")
})

test("first league is League 1", async () => {
  const files = { "content/templates/League.md": leagueTemplate }
  const r = await create({ season: "Opening" }, files)
  assert.equal(r.body.league, "League 1")
})

test("rejects missing or invalid season names", async () => {
  for (const season of ["", "   ", undefined, 42, "<script>", "x".repeat(61), "-dash first"]) {
    const r = await create({ season })
    assert.equal(r.status, 400, String(season))
    assert.equal(r.written.length, 0)
  }
  const r = await create({ season: "<b>" })
  assert.equal(r.body.error, SEASON_ERROR)
})

test("league creation needs a valid Turnstile token", async () => {
  const r = await create({ season: "Winter", turnstileToken: "bad" })
  assert.equal(r.status, 403)
  assert.equal(r.branches.length, 0)
})

test("routes POST /api/leagues", async () => {
  const res = await worker.fetch(new Request("https://site.example/api/leagues"), env)
  assert.equal(res.status, 405)
})

test("rejects a season name that's already used, ignoring case and spaces", async () => {
  const files = {
    ...leagueFiles(),
    "content/Leagues/League 1/League 1.md": upcomingLeague.replace("title: League 2", 'title: League 1\nseason: "2026 Christmas"'),
  }
  for (const season of ["2026 Christmas", "  2026   christmas "]) {
    const r = await create({ season }, files)
    assert.equal(r.status, 409, season)
    assert.equal(r.body.error, seasonTaken(season.trim().replace(/\s+/g, " ")))
    assert.equal(r.branches.length, 0)
  }
  const ok = await create({ season: "2026 Christmas Cup" }, files)
  assert.equal(ok.status, 200)
})

test("rejects a season used by a league still waiting for approval", async () => {
  const pending = "create-league/league-3"
  const branchFiles = { [pending]: { "content/Leagues/League 3/League 3.md": '---\ntitle: League 3\nseason: "Winter"\n---\n' } }
  const r = await create({ season: "WINTER" }, leagueFiles(), [pending], branchFiles)
  assert.equal(r.status, 409)
  assert.deepEqual(r.branches, [pending]) // no new branch
})

// --- League controls: advancing a league -----------------------------------------------------

const leagueAt = (status: string, current: number, rounds = 3) =>
  `---\ntitle: League 2\nstatus: ${status}\nrounds: ${rounds}\ncurrent_round: ${current}\n---\n`
const player = (status = "active") => `---\nstatus: ${status}\n---\n`
const pairing = (status: string) => `---\nround: 1\nstatus: "${status}"\n---\n`
const P = "content/Leagues/League 2"

async function advance(body: any, files: Record<string, string>, branches: string[] = [], failDispatch = false) {
  const fake = fakeGitHub(files, branches, {}, failDispatch)
  const withToken = body && typeof body === "object" ? { turnstileToken: "ok", ...body } : body
  const req = new Request("https://site.example/api/advance", { method: "POST", body: JSON.stringify(withToken) })
  const res = await advanceLeague(req, env, fake.gh, verifyOk)
  return { status: res.status, body: (await res.json()) as Record<string, string>, ...fake }
}

test("advance: starts an upcoming league with 2+ players", async () => {
  const r = await advance({ league: "Leagues/League 2" }, {
    [`${P}/League 2.md`]: leagueAt("Upcoming", 0, 0),
    [`${P}/Registered Players/A.md`]: player(),
    [`${P}/Registered Players/B.md`]: player(),
  })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.step, "start")
  assert.deepEqual(r.dispatches, [
    { eventType: "advance-league", payload: { league: "League 2", round: "0", lock: "advance/league-2/round-1" } },
  ])
  assert.deepEqual(r.branches, ["advance/league-2/round-1"])
})

test("advance: won't start with fewer than 2 players (dropped don't count)", async () => {
  const r = await advance({ league: "Leagues/League 2" }, {
    [`${P}/League 2.md`]: leagueAt("Upcoming", 0, 0),
    [`${P}/Registered Players/A.md`]: player(),
    [`${P}/Registered Players/B.md`]: player("dropped"),
  })
  assert.equal(r.status, 409)
  assert.match(r.body.error, /At least 2 players/)
  assert.equal(r.dispatches.length, 0)
})

test("advance: waits for every result in the current round", async () => {
  const r = await advance({ league: "Leagues/League 2" }, {
    [`${P}/League 2.md`]: leagueAt('"Active"', 1),
    [`${P}/Pairings/Round 1/A vs B.md`]: pairing("played"),
    [`${P}/Pairings/Round 1/C vs D.md`]: pairing("scheduled"),
  })
  assert.equal(r.status, 409)
  assert.equal(r.body.error, "Waiting for 1 result from round 1: C vs D.")
  assert.equal(r.dispatches.length, 0)
})

test("advance: draws the next round once results are in", async () => {
  const r = await advance({ league: "Leagues/League 2" }, {
    [`${P}/League 2.md`]: leagueAt('"Active"', 1),
    [`${P}/Pairings/Round 1/A vs B.md`]: pairing("played"),
    [`${P}/Pairings/Round 1/C vs D.md`]: pairing("unplayed"),
  })
  assert.equal(r.status, 200)
  assert.equal(r.body.step, "draw")
  assert.match(r.body.message, /Round 2 is being drawn/)
  assert.deepEqual(r.dispatches[0].payload, { league: "League 2", round: "1", lock: "advance/league-2/round-2" })
})

test("advance: finishes after the final round, and refuses a completed league", async () => {
  const files = { [`${P}/League 2.md`]: leagueAt('"Active"', 3), [`${P}/Pairings/Round 3/A vs B.md`]: pairing("played") }
  const r = await advance({ league: "Leagues/League 2" }, files)
  assert.equal(r.body.step, "finish")
  assert.equal(r.dispatches[0].payload.lock, "advance/league-2/finish")
  const done = await advance({ league: "Leagues/League 2" }, { [`${P}/League 2.md`]: leagueAt("Completed", 3) })
  assert.equal(done.status, 409)
  assert.equal(done.dispatches.length, 0)
})

test("advance: needs Turnstile and a real league", async () => {
  const files = { [`${P}/League 2.md`]: leagueAt("Upcoming", 0, 0) }
  assert.equal((await advance({ league: "Leagues/League 2", turnstileToken: "bad" }, files)).status, 403)
  for (const league of ["Leagues/Nope", "../x", "Leagues/../x", 7]) {
    const r = await advance({ league }, files)
    assert.equal(r.status, 400, String(league))
    assert.equal(r.dispatches.length, 0)
  }
})

test("github.dispatch sends a repository_dispatch event", async () => {
  const seen: { url: string; body: string }[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, body: String(init.body) })
    return new Response(null, { status: 204 })
  }) as unknown as typeof fetch
  await github(env, fetchImpl).dispatch("advance-league", { league: "League 2", round: 1 })
  assert.equal(seen[0].url, "https://api.github.com/repos/owner/repo/dispatches")
  assert.deepEqual(JSON.parse(seen[0].body), { event_type: "advance-league", client_payload: { league: "League 2", round: 1 } })
})

test("advance: a second press for the same step doesn't start another run", async () => {
  const files = {
    [`${P}/League 2.md`]: leagueAt('"Active"', 1),
    [`${P}/Pairings/Round 1/A vs B.md`]: pairing("played"),
  }
  const branches: string[] = []
  const first = await advance({ league: "Leagues/League 2" }, files, branches)
  const second = await advance({ league: "Leagues/League 2" }, files, branches)
  assert.equal(first.dispatches.length, 1)
  assert.equal(second.status, 200)
  assert.equal(second.body.alreadyRunning, true)
  assert.equal(second.body.message, "Round 2 is already being drawn. It will appear here in a few minutes.")
  assert.equal(second.dispatches.length, 0)
})

test("advance: if GitHub won't start the run, the lock is removed so it can be pressed again", async () => {
  const files = { [`${P}/League 2.md`]: leagueAt('"Active"', 1), [`${P}/Pairings/Round 1/A vs B.md`]: pairing("played") }
  const branches: string[] = []
  const r = await advance({ league: "Leagues/League 2" }, files, branches, true)
  assert.equal(r.status, 500)
  assert.deepEqual(branches, [])
  const retry = await advance({ league: "Leagues/League 2" }, files, branches)
  assert.equal(retry.status, 200)
  assert.equal(retry.dispatches.length, 1)
})

// --- Site status -----------------------------------------------------------------------------

type Check = { name: string; status: string; conclusion: string | null; url?: string }
function statusGitHub(commits: { sha: string; message: string; date: string; checks: Check[] }[]): GitHub {
  return {
    ...fakeGitHub({}).gh,
    async recentCommits(n) {
      return commits.slice(0, n)
    },
    async checks(sha) {
      return commits.find((c) => c.sha === sha)?.checks ?? []
    },
  }
}
const NOW = Date.parse("2026-11-21T10:00:00Z")
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()
const done = (name: string, conclusion = "success"): Check => ({ name, status: "completed", conclusion })
const running = (name: string): Check => ({ name, status: "in_progress", conclusion: null, url: "https://run" })

test("site status: up to date when every check has finished", async () => {
  const gh = statusGitHub([
    { sha: "b", message: "Register Alex for League 2 (#11)", date: ago(10), checks: [done("Workers Builds"), done("Update standings")] },
    { sha: "a", message: "older", date: ago(30), checks: [done("Workers Builds")] },
  ])
  assert.deepEqual(await siteStatus(gh, NOW), { state: "up-to-date", message: "Register Alex for League 2 (#11)", commit: "b" })
})

test("site status: updating while a check is queued or running", async () => {
  const gh = statusGitHub([
    { sha: "b", message: "Draw round 2 for League 2\n\nbody", date: ago(1), checks: [done("Draw next round"), running("Workers Builds")] },
  ])
  const s = await siteStatus(gh, NOW)
  assert.equal(s.state, "updating")
  assert.equal(s.message, "Draw round 2 for League 2")
})

test("site status: a [skip ci] commit on top of a commit still building is updating", async () => {
  const gh = statusGitHub([
    { sha: "c", message: "Update standings [skip ci]", date: ago(0), checks: [] },
    { sha: "b", message: "Register Alex for League 2 (#11)", date: ago(1), checks: [running("Workers Builds")] },
  ])
  assert.equal((await siteStatus(gh, NOW)).state, "updating")
})

test("site status: a just-pushed commit with no checks yet is updating; an old one isn't", async () => {
  const fresh = statusGitHub([{ sha: "c", message: "Edit", date: ago(0.5), checks: [] }, { sha: "b", message: "x", date: ago(20), checks: [done("Workers Builds")] }])
  assert.equal((await siteStatus(fresh, NOW)).state, "updating")
  const stale = statusGitHub([{ sha: "c", message: "Edit", date: ago(10), checks: [] }, { sha: "b", message: "x", date: ago(20), checks: [done("Workers Builds")] }])
  assert.equal((await siteStatus(stale, NOW)).state, "up-to-date")
})

test("site status: failed when the latest checked commit failed; cancelled doesn't count", async () => {
  const failed = statusGitHub([{ sha: "b", message: "Edit", date: ago(5), checks: [done("Workers Builds", "failure")] }])
  assert.equal((await siteStatus(failed, NOW)).state, "failed")
  const cancelled = statusGitHub([{ sha: "b", message: "Edit", date: ago(5), checks: [done("Update standings", "cancelled"), done("Workers Builds")] }])
  assert.equal((await siteStatus(cancelled, NOW)).state, "up-to-date")
  const fixed = statusGitHub([
    { sha: "c", message: "Fix", date: ago(2), checks: [done("Workers Builds")] },
    { sha: "b", message: "Edit", date: ago(5), checks: [done("Workers Builds", "failure")] },
  ])
  assert.equal((await siteStatus(fixed, NOW)).state, "up-to-date")
})

test("GET /api/status answers unknown (not an error) when GitHub can't be reached", async () => {
  const res = await worker.fetch(new Request("https://site.example/api/status"), { ...env, GITHUB_TOKEN: "" })
  assert.equal(res.status, 200)
  assert.equal(((await res.json()) as { state: string }).state, "unknown")
})
