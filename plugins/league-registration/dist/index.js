// League forms: a Quartz transformer plugin.
//
// ```league-registration  (league pages)  player registration form, shown only while the
//                          league's registration is open (see registrationRound); otherwise
//                          the block is removed.
// ```league-creation      (homepage)      form for creating a new league from a season name.
//
// Both forms share their markup, styles and client script. Hand-written ESM (no build step):
// this file is the plugin's shipped output.
//
// Options:
//   endpoint          Registration URL; receives JSON { league, name, armyLink, turnstileToken },
//                     where league is the league's folder (e.g. "Leagues/League 2").
//   createEndpoint    League creation URL; receives JSON { season, turnstileToken }.
//   turnstileSiteKey  Cloudflare Turnstile site key (public). When set, the forms show the
//                     Turnstile check and send its token; the Worker verifies it.
// An empty endpoint means "not connected yet": the form still checks its fields and says so.

const REGISTER_LANG = "league-registration"
const CREATE_LANG = "league-creation"

/**
 * The round a new player would join from, or undefined if registration is closed.
 * Same rule as the Worker (worker/index.ts): `registration_open: true`, and the league is
 * Upcoming (join from round 1) or Active with rounds still to pair (join from the next round).
 */
function registrationRound(fm) {
  if (String(fm.registration_open).toLowerCase() !== "true") return undefined
  const status = String(fm.status ?? "").toLowerCase()
  if (status === "upcoming") return 1
  if (status !== "active") return undefined
  const current = Number(fm.current_round)
  const rounds = Number(fm.rounds)
  if (!Number.isInteger(current) || !Number.isInteger(rounds) || current >= rounds) return undefined
  return current + 1
}

/** Replace (or remove) the forms' code blocks anywhere in the page's mdast tree. */
function remarkLeagueForms({ endpoint, createEndpoint, siteKey }) {
  return () => (tree, file) => {
    const fm = file.data?.frontmatter ?? {}
    const joinRound = registrationRound(fm)
    // the league's folder in content/, e.g. "Leagues/League 2" (the Worker uses this, not the title)
    const folder = String(file.data?.relativePath ?? "").split("/").slice(0, -1).join("/")
    const replacement = (node) => {
      if (node.type !== "code") return undefined
      if (node.lang === REGISTER_LANG) {
        return joinRound ? registrationForm(String(fm.title ?? ""), folder, endpoint, siteKey, joinRound) : null
      }
      if (node.lang === CREATE_LANG) return creationForm(createEndpoint, siteKey)
      return undefined
    }
    const visit = (parent) => {
      if (!parent.children) return
      for (let i = parent.children.length - 1; i >= 0; i--) {
        const node = parent.children[i]
        const next = replacement(node)
        if (next === undefined) visit(node)
        else if (next === null) parent.children.splice(i, 1)
        else parent.children[i] = next
      }
    }
    visit(tree)
  }
}

// --- Markup (hast via mdast data.hName/hChildren) ---------------------------------------------

const el = (tagName, properties = {}, children = []) => ({ type: "element", tagName, properties, children })
const text = (value) => ({ type: "text", value })
const checkLine = (id) => el("p", { id, className: ["league-registration-check"], ariaLive: "polite" })

/** A labelled input with its check line (live messages) and optional help text under it. */
function field({ id, label, help, ...input }) {
  const describedBy = [`${id}-check`, help && `${id}-help`].filter(Boolean).join(" ")
  return el("div", { className: ["league-registration-field"] }, [
    el("label", { htmlFor: id }, [text(label)]),
    el("input", { id, type: "text", required: true, autoComplete: "off", ariaDescribedby: describedBy, ...input }),
    checkLine(`${id}-check`),
    ...(help ? [el("p", { id: `${id}-help`, className: ["league-registration-help"] }, help)] : []),
  ])
}

/** A form: optional intro, fields, the Turnstile check, the button, and the status line. */
function form({ type, action, endpoint, siteKey, data = {}, intro, fields, button }) {
  return {
    type,
    data: {
      hName: "div",
      hProperties: { className: ["league-registration"], dataAction: action, dataEndpoint: endpoint || undefined, ...data },
      hChildren: [
        ...(intro ? [el("p", { className: ["league-registration-intro"] }, [text(intro)])] : []),
        el("form", { className: ["league-registration-form"], noValidate: true }, [
          ...fields,
          ...(siteKey
            ? [
                el("div", { className: ["league-registration-verify"] }, [
                  el("div", { className: ["league-registration-turnstile"], dataSitekey: siteKey }),
                  checkLine(),
                ]),
              ]
            : []),
          el("div", { className: ["league-registration-actions"] }, [el("button", { type: "submit" }, [text(button)])]),
        ]),
        el("p", { className: ["league-registration-status"], role: "status", ariaLive: "polite" }),
      ],
    },
  }
}

function registrationForm(league, folder, endpoint, siteKey, joinRound) {
  const id = `league-registration-${league.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
  return form({
    type: "leagueRegistration",
    action: "register",
    endpoint,
    siteKey,
    data: { dataLeague: folder },
    intro: joinRound > 1 ? `This league has started, but you can still join. You'll be paired from round ${joinRound}.` : "",
    fields: [
      field({ id: `${id}-name`, label: "Your name", name: "name", maxLength: 40, autoComplete: "name", placeholder: "e.g. Brendon" }),
      field({
        id: `${id}-army`,
        label: "Army link",
        name: "armyLink",
        type: "url",
        inputMode: "url",
        maxLength: 500,
        placeholder: "https://army-forge.onepagerules.com/share?id=…",
        help: [
          text("Once you've made your list, you can get the URL by clicking the three dots at the top right of the page, selecting "),
          el("strong", {}, [text("Share List")]),
          text(" and "),
          el("strong", {}, [text("Share as a Link")]),
          text("."),
        ],
      }),
    ],
    button: "Register",
  })
}

function creationForm(endpoint, siteKey) {
  return form({
    type: "leagueCreation",
    action: "create",
    endpoint,
    siteKey,
    data: { className: ["league-registration", "league-creation"] },
    fields: [field({ id: "league-creation-season", label: "Season name", name: "season", maxLength: 60, placeholder: "e.g. 2027 Summer" })],
    button: "Create league",
  })
}

// --- Client script ---------------------------------------------------------------------------
// Event delegation on `document` (installed once), so it keeps working across Quartz's SPA
// navigations without re-binding.
const clientScript = `
(() => {
  if (window.__leagueForms) return
  window.__leagueForms = true

  // Same rules and messages as the Worker (worker/index.ts NAME, SEASON, checkArmyLink)
  const NAME = /^[\\p{L}\\p{N}][\\p{L}\\p{N} '\\-.]{0,39}$/u
  const SEASON = /^[\\p{L}\\p{N}][\\p{L}\\p{N} '\\-.,&()/]{0,59}$/u
  const ARMY_ERRORS = {
    missing: "Please enter your army link.",
    site: "That isn't an Army Forge link.",
    builder: "That's your builder link, which only works for you.",
    view: "That's a viewer link, which others can't open.",
    other: "That's not the right Army Forge link.",
    id: "That link is incomplete.",
    long: "That link is too long.",
  }
  const VERIFY = "Please complete the verification check."
  const FIX = "Please fix the errors above."

  const clean = (value) => value.trim().replace(/\\s+/g, " ")
  const armyLinkError = (value) => {
    if (!value) return ARMY_ERRORS.missing
    if (value.length > 500) return ARMY_ERRORS.long
    let url
    try {
      url = new URL(value)
    } catch {
      return ARMY_ERRORS.site
    }
    if (url.protocol !== "https:" || url.hostname !== "army-forge.onepagerules.com") return ARMY_ERRORS.site
    const path = url.pathname.replace(/\\/+$/, "")
    if (path !== "/share") {
      if (path === "/view" || path.startsWith("/view/")) return ARMY_ERRORS.view
      if (path.split("/").includes("build")) return ARMY_ERRORS.builder
      return ARMY_ERRORS.other
    }
    if (!(url.searchParams.get("id") || "").trim()) return ARMY_ERRORS.id
    return null
  }
  // the Registered Players table (Upcoming) or the Leaderboard (Active)
  const registeredNames = () =>
    [...document.querySelectorAll("h2#registered-players + .bases-page tbody a, h2#leaderboard + .bases-page tbody a")]
      .map((a) => a.textContent.trim().toLowerCase())

  // seasons of the leagues on the homepage cards (the Worker also checks leagues awaiting approval)
  const seasonsInUse = () =>
    [...document.querySelectorAll('.bases-card-row[data-property="season"] .bases-card-value')]
      .map((v) => clean(v.textContent).toLowerCase())

  /** Each field's check: an error message, or null if it's OK. */
  const CHECKS = {
    name: (value) => {
      value = clean(value)
      if (!value) return "Please enter your name."
      if (!NAME.test(value)) return "Names can use letters, numbers, spaces, hyphens, apostrophes and full stops (max 40)."
      if (registeredNames().includes(value.toLowerCase())) return value + " is already registered for this league."
      return null
    },
    armyLink: (value) => armyLinkError(value.trim()),
    season: (value) => {
      value = clean(value)
      if (!value) return "Please enter a season name."
      if (!SEASON.test(value)) return "Season names can use letters, numbers, spaces and - ' . , & ( ) / (max 60)."
      // same wording as the Worker (worker/index.ts seasonTaken)
      if (seasonsInUse().includes(value.toLowerCase())) return "There's already a league for the " + value + " season."
      return null
    },
  }

  /** What each form sends and says. \`input\` is the field a 4xx from the Worker is shown under. */
  const FORMS = {
    register: {
      input: "name",
      fieldErrorStatus: [409], // name taken, or already waiting for approval
      body: (v, root) => ({ league: root.dataset.league, name: clean(v.name), armyLink: v.armyLink.trim() }),
      notConnected: (v) => "Thanks, " + clean(v.name) + "! Online registration isn't connected yet, so please let the organiser know you'd like to join.",
      sending: "Registering…",
      failed: "Sorry, registration failed: ",
      done: (v, data, status) => (status.textContent = "Thanks, " + clean(v.name) + "! Your registration has been sent and will appear once it's approved."),
    },
    create: {
      input: "season",
      fieldErrorStatus: [400, 409], // season name rejected, or already used
      body: (v) => ({ season: clean(v.season) }),
      notConnected: () => "Creating leagues online isn't connected yet, so please ask the organiser to set it up.",
      sending: "Creating league…",
      failed: "Sorry, creating the league failed: ",
      done: (v, data, status) => {
        const link = document.createElement("a")
        link.href = data.url
        link.textContent = "go to " + data.league
        status.replaceChildren(data.league + " has been created! It will be on the site in a few minutes: ", link, ".")
      },
    },
  }

  // --- Messages ---
  const setMessage = (line, message, kind) => {
    if (!line) return
    line.textContent = message || ""
    if (kind && message) line.dataset.kind = kind
    else delete line.dataset.kind
  }
  const statusOf = (el) => el.closest(".league-registration")?.querySelector(".league-registration-status")
  /** Once something is fixed, the "Please fix…" by the button is stale. */
  const clearStatusError = (el) => {
    const status = statusOf(el)
    if (status?.dataset.kind === "error") setMessage(status, "", null)
  }
  const fieldLine = (input) => input.closest(".league-registration-field")?.querySelector(".league-registration-check")
  const showFieldMessage = (input, message, kind) => {
    if (kind === "error") input.setAttribute("aria-invalid", "true")
    else input.removeAttribute("aria-invalid")
    setMessage(fieldLine(input), message, kind)
  }
  const showVerifyMessage = (slot, message) => {
    setMessage(slot.closest(".league-registration-verify")?.querySelector(".league-registration-check"), message, "error")
    if (!message) clearStatusError(slot)
  }

  /** Check a field and show the result under it. Returns true if it's OK. */
  const checkField = (input) => {
    const error = CHECKS[input.name]?.(input.value) ?? null
    if (error) showFieldMessage(input, error, "error")
    else if (input.name === "armyLink" && input.value.trim()) showFieldMessage(input, "✓ Looks good.", "ok")
    else showFieldMessage(input, "", null)
    return !error
  }

  // --- Cloudflare Turnstile (explicit rendering, so it works with Quartz's SPA navigation) ---
  const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
  const renderWidgets = () => {
    const slots = document.querySelectorAll(".league-registration-turnstile:not([data-widget-id])")
    if (!slots.length) return
    if (!window.turnstile) {
      // the league controls may have added the script already: wait for whichever tag exists
      let script = document.querySelector('script[src^="https://challenges.cloudflare.com/turnstile/"]')
      if (!script) {
        script = document.createElement("script")
        script.src = TURNSTILE_SRC
        script.async = true
        document.head.appendChild(script)
      }
      script.addEventListener("load", renderWidgets, { once: true })
      return
    }
    for (const slot of slots) {
      slot.dataset.widgetId = window.turnstile.render(slot, {
        sitekey: slot.dataset.sitekey,
        action: slot.closest(".league-registration")?.dataset.action === "create" ? "create_league" : "register",
        callback: () => showVerifyMessage(slot, ""),
        "expired-callback": () => showVerifyMessage(slot, VERIFY),
      })
    }
  }
  document.addEventListener("nav", renderWidgets)
  renderWidgets()

  // --- Live checks ---
  // only the form's own fields: Turnstile also puts a hidden input (cf-turnstile-response) in the form
  const FIELDS = ".league-registration-field input"
  const fieldOf = (t) => (t?.matches?.(".league-registration-form " + FIELDS) ? t : null)
  // leaving a field (fires when its value changed)
  document.addEventListener("change", (e) => fieldOf(e.target) && checkField(e.target))
  // pasting a link: check once the pasted text is in the field
  document.addEventListener("paste", (e) => {
    if (fieldOf(e.target)?.name === "armyLink") setTimeout(() => checkField(e.target), 0)
  })
  // typing: only re-check once a message is showing, so it updates/clears while they fix it
  document.addEventListener("input", (e) => {
    const input = fieldOf(e.target)
    if (!input) return
    if (fieldLine(input)?.dataset.kind) checkField(input)
    clearStatusError(input)
  })

  // --- Submit ---
  document.addEventListener("submit", async (event) => {
    const form = event.target.closest?.(".league-registration-form")
    if (!form) return
    event.preventDefault()

    const root = form.closest(".league-registration")
    const config = FORMS[root.dataset.action]
    if (!config) return
    const status = root.querySelector(".league-registration-status")
    const button = form.querySelector("button")
    const fields = [...form.querySelectorAll(FIELDS)]
    const values = Object.fromEntries(fields.map((f) => [f.name, f.value]))
    const say = (message, kind) => setMessage(status, message, kind)

    const invalid = fields.filter((f) => !checkField(f))
    const slot = root.querySelector(".league-registration-turnstile")
    const turnstileToken = slot && window.turnstile && slot.dataset.widgetId ? window.turnstile.getResponse(slot.dataset.widgetId) : ""
    if (slot) showVerifyMessage(slot, turnstileToken ? "" : VERIFY)
    if (invalid.length || (slot && !turnstileToken)) {
      if (invalid.length) invalid[0].focus()
      else slot.scrollIntoView?.({ block: "nearest", behavior: "smooth" })
      return say(FIX, "error")
    }

    if (!root.dataset.endpoint) return say(config.notConnected(values), "info")

    button.disabled = true
    say(config.sending, "info")
    try {
      const res = await fetch(root.dataset.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...config.body(values, root), turnstileToken: turnstileToken || undefined }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        const message = (data && data.error) || res.statusText || "unknown error"
        if (res.status === 403 && slot) {
          showVerifyMessage(slot, message)
          return say(FIX, "error")
        }
        if (config.fieldErrorStatus.includes(res.status)) {
          const input = form.querySelector("input[name=" + config.input + "]")
          showFieldMessage(input, message, "error")
          input.focus()
          return say(FIX, "error")
        }
        throw new Error(message)
      }
      form.reset()
      say("", null)
      status.dataset.kind = "success"
      config.done(values, data, status)
    } catch (err) {
      say(config.failed + (err && err.message ? err.message : "unknown error"), "error")
    } finally {
      button.disabled = false
      // tokens are single-use: get a fresh one for any further attempt
      if (slot && window.turnstile && slot.dataset.widgetId) window.turnstile.reset(slot.dataset.widgetId)
    }
  })
})()
`

const css = `
.league-registration { margin: 1rem 0 1.5rem; }
.league-registration-intro { margin: 0 0 0.85rem; }
.league-registration-form label { display: block; font-weight: 600; margin-bottom: 0.35rem; }
.league-registration-field { margin-bottom: 0.85rem; max-width: 36rem; }
.league-registration-field input {
  display: block; width: 100%; box-sizing: border-box; padding: 0.5rem 0.75rem; font: inherit;
  color: var(--dark); background: var(--light);
  border: 1px solid var(--lightgray); border-radius: 6px;
}
.league-registration-field input:focus { outline: 2px solid var(--secondary); outline-offset: 1px; }
.league-registration-field input[aria-invalid="true"] { border-color: #c0392b; }
.league-registration-field input[aria-invalid="true"]:focus { outline-color: #c0392b; }
.league-registration-help { margin: 0.35rem 0 0; font-size: 0.85rem; color: var(--darkgray); }
.league-registration-check { margin: 0.35rem 0 0; font-size: 0.9rem; }
.league-registration-check:empty { display: none; }
.league-registration-check[data-kind="error"] { color: #c0392b; }
.league-registration-check[data-kind="ok"] { color: var(--tertiary); }
.league-registration-verify { margin: 0 0 0.85rem; }
.league-registration-turnstile { min-height: 65px; }
.league-registration-actions button {
  padding: 0.5rem 1.1rem; font: inherit; font-weight: 600; cursor: pointer;
  color: var(--light); background: var(--secondary); border: none; border-radius: 6px;
}
.league-registration-actions button:hover { opacity: 0.9; }
.league-registration-actions button:disabled { opacity: 0.6; cursor: progress; }
.league-registration-status { margin: 0.5rem 0 0; min-height: 1.4em; font-size: 0.95rem; }
.league-registration-status[data-kind="error"] { color: #c0392b; }
.league-registration-status[data-kind="success"] { color: var(--tertiary); }
`

const option = (value) => (typeof value === "string" ? value.trim() : "")

export const LeagueRegistration = (opts = {}) => {
  const options = {
    endpoint: option(opts.endpoint),
    createEndpoint: option(opts.createEndpoint),
    siteKey: option(opts.turnstileSiteKey),
  }
  return {
    name: "LeagueRegistration",
    markdownPlugins() {
      return [remarkLeagueForms(options)]
    },
    externalResources() {
      return {
        css: [{ content: css, inline: true }],
        js: [{ script: clientScript, loadTime: "afterDOMReady", contentType: "inline" }],
      }
    },
  }
}

export default LeagueRegistration
