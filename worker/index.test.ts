import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import worker, { ARMY_LINK_ERRORS, checkArmyLink, frontmatterValue, github, playerNote, register, turnstile, type Env, type GitHub } from "./index.ts"

const env: Env = {
  ASSETS: { fetch: async () => new Response("asset") },
  GITHUB_REPO: "owner/repo",
  GITHUB_BRANCH: "v5",
  GITHUB_TOKEN: "test-token",
  TURNSTILE_SECRET: "test-secret",
}

const template = readFileSync("content/templates/Player.md", "utf8")
const upcomingLeague = "---\ntitle: League 2\nstatus: Upcoming\nrounds: 3\ncurrent_round: 0\n---\n"

/** In-memory GitHub: files on the deploy branch, branches, and what the Worker wrote. */
function fakeGitHub(files: Record<string, string>, branches: string[] = []) {
  const written: { path: string; content: string; branch: string }[] = []
  const prs: { branch: string; title: string }[] = []
  const gh: GitHub = {
    async file(p) {
      return files[p] ?? null
    },
    async list(dir) {
      return Object.keys(files)
        .filter((p) => p.startsWith(dir + "/") && !p.slice(dir.length + 1).includes("/"))
        .map((p) => p.slice(dir.length + 1))
    },
    async createBranch(b) {
      if (branches.includes(b)) return false
      branches.push(b)
      return true
    },
    async putFile(path, content, branch) {
      written.push({ path, content, branch })
    },
    async openPullRequest(branch, title) {
      prs.push({ branch, title })
      return `https://github.com/owner/repo/pull/${prs.length}`
    },
  }
  return { gh, written, prs, branches }
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

test("rejects leagues that are not upcoming", async () => {
  const files = { ...baseFiles(), "content/Leagues/League 2/League 2.md": upcomingLeague.replace("Upcoming", '"Active"') }
  const r = await call({ league: "Leagues/League 2", name: "Alex" }, files)
  assert.equal(r.status, 400)
  assert.match(r.body.error, /closed/)
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
