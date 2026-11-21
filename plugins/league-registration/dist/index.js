// League Registration: a Quartz transformer plugin.
//
// Replaces ```league-registration code blocks with a registration form, but only while the
// league's registration is open (see registrationRound). Otherwise the block is removed.
// Replaces ```league-creation code blocks (the homepage) with a form for creating a new league.
//
// Hand-written ESM (no build step): this file is the plugin's shipped output.
//
// Options:
//   endpoint          URL the form POSTs to as JSON { league, name, armyLink, turnstileToken }, where
//                     league is the league's folder (e.g. "Leagues/League 2"). Empty = not
//                     connected yet: the form validates the name and explains that.
//   createEndpoint    URL the league creation form POSTs to as JSON { season, turnstileToken }.
//                     Empty = not connected yet.
//   turnstileSiteKey  Cloudflare Turnstile site key (public). When set, the forms show the
//                     Turnstile check and send its token; the Worker verifies it.

const LANG = "league-registration"
const CREATE_LANG = "league-creation"

/**
 * The round a new player would join from, or undefined if registration is closed.
 * Same rule as the Worker (worker/index.ts): `registration_open: true`, and the league is
 * Upcoming (join from round 1) or Active with rounds still to pair (join from the next round).
 */
function registrationRound(fm) {
  const open = fm.registration_open === true || String(fm.registration_open).toLowerCase() === "true"
  if (!open) return undefined
  const status = String(fm.status ?? "").toLowerCase()
  if (status === "upcoming") return 1
  if (status !== "active") return undefined
  const current = Number(fm.current_round)
  const rounds = Number(fm.rounds)
  if (!Number.isInteger(current) || !Number.isInteger(rounds) || current >= rounds) return undefined
  return current + 1
}

/** Walk an mdast tree, replacing/removing `code` nodes in the registration language. */
function remarkLeagueRegistration(endpoint, createEndpoint, siteKey) {
  return () => (tree, file) => {
    const fm = file.data?.frontmatter ?? {}
    const joinRound = registrationRound(fm)
    const league = String(fm.title ?? "")
    // the league's folder in content/, e.g. "Leagues/League 2" (the Worker uses this, not the title)
    const folder = String(file.data?.relativePath ?? "").split("/").slice(0, -1).join("/")

    const visit = (parent) => {
      if (!parent.children) return
      for (let i = parent.children.length - 1; i >= 0; i--) {
        const node = parent.children[i]
        if (node.type === "code" && node.lang === LANG) {
          if (joinRound) parent.children[i] = formNode(league, folder, endpoint, siteKey, joinRound)
          else parent.children.splice(i, 1)
        } else if (node.type === "code" && node.lang === CREATE_LANG) {
          parent.children[i] = creationNode(createEndpoint, siteKey)
        } else {
          visit(node)
        }
      }
    }
    visit(tree)
  }
}

const el = (tagName, properties = {}, children = []) => ({ type: "element", tagName, properties, children })
const text = (value) => ({ type: "text", value })

/** An mdast node that mdast-util-to-hast turns into the form markup (via data.hName/hChildren). */
function formNode(league, folder, endpoint, siteKey, joinRound = 1) {
  const idBase = `league-registration-${league.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
  const inputId = `${idBase}-name`
  const armyId = `${idBase}-army`
  const helpId = `${idBase}-army-help`
  const checkId = `${idBase}-army-check`
  const nameCheckId = `${idBase}-name-check`
  return {
    type: "leagueRegistration",
    data: {
      hName: "div",
      hProperties: {
        className: ["league-registration"],
        dataLeague: folder,
        dataLeagueTitle: league,
        dataEndpoint: endpoint || undefined,
      },
      hChildren: [
        ...(joinRound > 1
          ? [
              el("p", { className: ["league-registration-intro"] }, [
                text(`This league has started, but you can still join. You'll be paired from round ${joinRound}.`),
              ]),
            ]
          : []),
        el("form", { className: ["league-registration-form"], noValidate: true }, [
          el("div", { className: ["league-registration-field"] }, [
            el("label", { htmlFor: inputId }, [text("Your name")]),
            el("input", {
              id: inputId,
              type: "text",
              name: "name",
              required: true,
              maxLength: 40,
              autoComplete: "name",
              placeholder: "e.g. Brendon",
              ariaDescribedby: nameCheckId,
            }),
            el("p", { id: nameCheckId, className: ["league-registration-check"], ariaLive: "polite" }),
          ]),
          el("div", { className: ["league-registration-field"] }, [
            el("label", { htmlFor: armyId }, [text("Army link")]),
            el("input", {
              id: armyId,
              type: "url",
              name: "armyLink",
              required: true,
              maxLength: 500,
              inputMode: "url",
              autoComplete: "off",
              placeholder: "https://army-forge.onepagerules.com/share?id=…",
              ariaDescribedby: `${checkId} ${helpId}`,
            }),
            // live result of checking the link, directly under the input (filled in by the client script)
            el("p", { id: checkId, className: ["league-registration-check"], ariaLive: "polite" }),
            el("p", { id: helpId, className: ["league-registration-help"] }, [
              text(
                "Once you've made your list, you can get the URL by clicking the three dots at the top right of the page, selecting ",
              ),
              el("strong", {}, [text("Share List")]),
              text(" and "),
              el("strong", {}, [text("Share as a Link")]),
              text("."),
            ]),
          ]),
          ...verifyNodes(siteKey, "register"),
          el("div", { className: ["league-registration-actions"] }, [
            el("button", { type: "submit" }, [text("Register")]),
          ]),
        ]),
        el("p", { className: ["league-registration-status"], role: "status", ariaLive: "polite" }),
      ],
    },
  }
}

/** The Turnstile check and the line for its message (nothing without a site key). */
function verifyNodes(siteKey, action) {
  if (!siteKey) return []
  return [
    el("div", { className: ["league-registration-verify"] }, [
      el("div", { className: ["league-registration-turnstile"], dataSitekey: siteKey, dataAction: action }),
      el("p", { className: ["league-registration-check"], ariaLive: "polite" }),
    ]),
  ]
}

/** The homepage form for creating a league: a season name. The Worker picks the League number. */
function creationNode(endpoint, siteKey) {
  const seasonId = "league-creation-season"
  const seasonCheckId = `${seasonId}-check`
  const seasonHelpId = `${seasonId}-help`
  return {
    type: "leagueCreation",
    data: {
      hName: "div",
      hProperties: {
        // shares the registration form's styles and client script
        className: ["league-registration", "league-creation"],
        dataAction: "create",
        dataEndpoint: endpoint || undefined,
      },
      hChildren: [
        el("form", { className: ["league-registration-form"], noValidate: true }, [
          el("div", { className: ["league-registration-field"] }, [
            el("label", { htmlFor: seasonId }, [text("Season name")]),
            el("input", {
              id: seasonId,
              type: "text",
              name: "season",
              required: true,
              maxLength: 60,
              autoComplete: "off",
              placeholder: "e.g. 2027 Summer",
              ariaDescribedby: `${seasonCheckId} ${seasonHelpId}`,
            }),
            el("p", { id: seasonCheckId, className: ["league-registration-check"], ariaLive: "polite" }),
            el("p", { id: seasonHelpId, className: ["league-registration-help"] }, [
              text(
                "The league is named for you (the next League number). The number of rounds is set when the first round is drawn, based on how many players have registered.",
              ),
            ]),
          ]),
          ...verifyNodes(siteKey, "create_league"),
          el("div", { className: ["league-registration-actions"] }, [
            el("button", { type: "submit" }, [text("Create league")]),
          ]),
        ]),
        el("p", { className: ["league-registration-status"], role: "status", ariaLive: "polite" }),
      ],
    },
  }
}

// Client-side behaviour. Uses event delegation on `document` (installed once), so it keeps
// working across Quartz's SPA navigations without re-binding.
const clientScript = `
(() => {
  if (window.__leagueRegistration) return
  window.__leagueRegistration = true

  const NAME = /^[\\p{L}\\p{N}][\\p{L}\\p{N} '\\-.]{0,39}$/u
  // Same rule and message as the Worker (worker/index.ts SEASON)
  const SEASON = /^[\\p{L}\\p{N}][\\p{L}\\p{N} '\\-.,&()/]{0,59}$/u
  const SEASON_ERROR = "Season names can use letters, numbers, spaces and - ' . , & ( ) / (max 60)."
  // Same rules and messages as the Worker (worker/index.ts checkArmyLink)
  const ARMY_ERRORS = {
    missing: "Please enter your army link.",
    site: "That isn't an Army Forge link.",
    builder: "That's your builder link, which only works for you.",
    view: "That's a viewer link, which others can't open.",
    other: "That's not the right Army Forge link.",
    id: "That link is incomplete.",
    long: "That link is too long.",
  }
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

  // --- Cloudflare Turnstile (explicit rendering, so it works with Quartz's SPA navigation) ---
  const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__leagueRegistrationTurnstile"
  const renderWidgets = () => {
    const slots = document.querySelectorAll(".league-registration-turnstile:not([data-widget-id])")
    if (!slots.length) return
    if (!window.turnstile) {
      if (!document.querySelector('script[src^="https://challenges.cloudflare.com/turnstile/"]')) {
        const s = document.createElement("script")
        s.src = TURNSTILE_SRC
        s.async = true
        document.head.appendChild(s)
      }
      return // renderWidgets runs again from the onload callback
    }
    for (const slot of slots) {
      slot.dataset.widgetId = window.turnstile.render(slot, {
        sitekey: slot.dataset.sitekey,
        action: slot.dataset.action || "register",
        callback: () => showVerifyMessage(slot, ""),
        "expired-callback": () => showVerifyMessage(slot, "Please complete the verification check."),
      })
    }
  }
  /** Message under the Turnstile check ("" clears it). */
  const showVerifyMessage = (slot, message) => {
    const line = slot.closest(".league-registration-verify")?.querySelector(".league-registration-check")
    if (!line) return
    line.textContent = message
    if (message) line.dataset.kind = "error"
    else delete line.dataset.kind
    // solving the check after a failed Register also clears the "Please fix…" by the button
    const status = slot.closest(".league-registration")?.querySelector(".league-registration-status")
    if (!message && status?.dataset.kind === "error") {
      status.textContent = ""
      delete status.dataset.kind
    }
  }
  window.__leagueRegistrationTurnstile = renderWidgets
  document.addEventListener("nav", renderWidgets)
  renderWidgets()

  const registeredNames = () =>
    // the Registered Players table (Upcoming) or the Leaderboard (Active)
    [...document.querySelectorAll("h2#registered-players + .bases-page tbody a, h2#leaderboard + .bases-page tbody a")]
      .map((a) => a.textContent.trim().toLowerCase())

  // --- Field checks: each field shows its own message directly under its input ---
  const cleanName = (value) => value.trim().replace(/\\s+/g, " ")
  const fieldError = (input) => {
    const value = input.name === "armyLink" ? input.value.trim() : cleanName(input.value)
    if (input.name === "season") {
      if (!value) return "Please enter a season name."
      if (!SEASON.test(value)) return SEASON_ERROR
      return null
    }
    if (input.name === "name") {
      if (!value) return "Please enter your name."
      if (!NAME.test(value)) return "Names can use letters, numbers, spaces, hyphens, apostrophes and full stops (max 40)."
      if (registeredNames().includes(value.toLowerCase())) return value + " is already registered for this league."
      return null
    }
    return armyLinkError(value)
  }
  const checkLine = (input) => input.closest(".league-registration-field")?.querySelector(".league-registration-check")
  const showFieldMessage = (input, message, kind) => {
    const line = checkLine(input)
    if (kind === "error") input.setAttribute("aria-invalid", "true")
    else input.removeAttribute("aria-invalid")
    if (!line) return
    line.textContent = message || ""
    if (kind && message) line.dataset.kind = kind
    else delete line.dataset.kind
  }
  /** Check a field and show the result under it. Returns true if it's OK. */
  const checkField = (input) => {
    const error = fieldError(input)
    if (error) showFieldMessage(input, error, "error")
    else if (input.name === "armyLink" && input.value.trim()) showFieldMessage(input, "✓ Looks good.", "ok")
    else showFieldMessage(input, "", null)
    return !error
  }
  const fieldOf = (t) => (t?.matches?.(".league-registration-form input") ? t : null)
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
    if (checkLine(input)?.dataset.kind) checkField(input)
    // editing after a failed Register: clear the stale "Please fix…" under the button
    const status = input.closest(".league-registration")?.querySelector(".league-registration-status")
    if (status?.dataset.kind === "error") {
      status.textContent = ""
      delete status.dataset.kind
    }
  })

  document.addEventListener("submit", async (event) => {
    const form = event.target.closest?.(".league-registration-form")
    if (!form) return
    event.preventDefault()

    const root = form.closest(".league-registration")
    const status = root.querySelector(".league-registration-status")
    const button = form.querySelector("button")
    const creating = root.dataset.action === "create"
    const input = form.querySelector(creating ? "input[name=season]" : "input[name=name]")
    const value = cleanName(input.value)
    const armyLink = (form.querySelector("input[name=armyLink]")?.value ?? "").trim()
    const say = (message, kind) => {
      status.textContent = message
      if (kind) status.dataset.kind = kind
      else delete status.dataset.kind
    }

    const invalid = [...form.querySelectorAll("input")].filter((field) => !checkField(field))
    const slot = root.querySelector(".league-registration-turnstile")
    let turnstileToken
    if (slot) {
      turnstileToken = window.turnstile && slot.dataset.widgetId ? window.turnstile.getResponse(slot.dataset.widgetId) : ""
      showVerifyMessage(slot, turnstileToken ? "" : "Please complete the verification check.")
    }
    if (invalid.length || (slot && !turnstileToken)) {
      if (invalid.length) invalid[0].focus()
      else slot.scrollIntoView?.({ block: "nearest", behavior: "smooth" })
      return say("Please fix the errors above.", "error")
    }
    say("", null)

    const endpoint = root.dataset.endpoint
    if (!endpoint) {
      return say(
        creating
          ? "Creating leagues online isn't connected yet, so please ask the organiser to set it up."
          : "Thanks, " + value + "! Online registration isn't connected yet, so please let the organiser know you'd like to join.",
        "info",
      )
    }

    button.disabled = true
    say(creating ? "Creating league…" : "Registering…", "info")
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          creating
            ? { season: value, turnstileToken }
            : { league: root.dataset.league, name: value, armyLink, turnstileToken },
        ),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        const message = (data && data.error) || res.statusText || "unknown error"
        if (res.status === 403 && slot) {
          showVerifyMessage(slot, message)
          say("Please fix the errors above.", "error")
          return
        }
        // registration: the name is taken or already waiting; creation: a bad season name
        if ((!creating && res.status === 409) || (creating && res.status === 400)) {
          showFieldMessage(input, message, "error")
          input.focus()
          say("Please fix the errors above.", "error")
          return
        }
        throw new Error(message)
      }
      form.reset()
      if (creating) {
        say(data.league + " has been created! It will be on the site in a few minutes: ", "success")
        const link = document.createElement("a")
        link.href = data.url
        link.textContent = "go to " + data.league
        status.append(link, ".")
      } else {
        say("Thanks, " + value + "! Your registration has been sent and will appear once it's approved.", "success")
      }
    } catch (err) {
      say(
        (creating ? "Sorry, creating the league failed: " : "Sorry, registration failed: ") +
          (err && err.message ? err.message : "unknown error"),
        "error",
      )
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
.league-registration-form label { display: block; font-weight: 600; margin-bottom: 0.35rem; }
.league-registration-field { margin-bottom: 0.85rem; max-width: 36rem; }
.league-registration-field input {
  display: block; width: 100%; box-sizing: border-box; padding: 0.5rem 0.75rem; font: inherit;
  color: var(--dark); background: var(--light);
  border: 1px solid var(--lightgray); border-radius: 6px;
}
.league-registration-field input:focus { outline: 2px solid var(--secondary); outline-offset: 1px; }
.league-registration-intro { margin: 0 0 0.85rem; }
.league-registration-help { margin: 0.35rem 0 0; font-size: 0.85rem; color: var(--darkgray); }
.league-registration-check { margin: 0.35rem 0 0; font-size: 0.9rem; }
.league-registration-check:empty { display: none; }
.league-registration-check[data-kind="error"] { color: #c0392b; }
.league-registration-check[data-kind="ok"] { color: var(--tertiary); }
.league-registration-field input[aria-invalid="true"] { border-color: #c0392b; }
.league-registration-field input[aria-invalid="true"]:focus { outline-color: #c0392b; }
.league-registration-actions button {
  padding: 0.5rem 1.1rem; font: inherit; font-weight: 600; cursor: pointer;
  color: var(--light); background: var(--secondary); border: none; border-radius: 6px;
}
.league-registration-actions button:hover { opacity: 0.9; }
.league-registration-actions button:disabled { opacity: 0.6; cursor: progress; }
.league-registration-verify { margin: 0 0 0.85rem; }
.league-registration-turnstile { min-height: 65px; }
.league-registration-status { margin: 0.5rem 0 0; min-height: 1.4em; font-size: 0.95rem; }
.league-registration-status[data-kind="error"] { color: #c0392b; }
.league-registration-status[data-kind="success"] { color: var(--tertiary); }
`

export const LeagueRegistration = (opts = {}) => {
  const endpoint = typeof opts.endpoint === "string" ? opts.endpoint.trim() : ""
  const createEndpoint = typeof opts.createEndpoint === "string" ? opts.createEndpoint.trim() : ""
  const siteKey = typeof opts.turnstileSiteKey === "string" ? opts.turnstileSiteKey.trim() : ""
  return {
    name: "LeagueRegistration",
    markdownPlugins() {
      return [remarkLeagueRegistration(endpoint, createEndpoint, siteKey)]
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
