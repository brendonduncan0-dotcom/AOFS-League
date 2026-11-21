// League Registration: a Quartz transformer plugin.
//
// Replaces ```league-registration code blocks with a registration form, but only on pages
// whose frontmatter `status` is "Upcoming". On any other page the block is removed.
//
// Hand-written ESM (no build step): this file is the plugin's shipped output.
//
// Options:
//   endpoint          URL the form POSTs to as JSON { league, name, armyLink, turnstileToken }, where
//                     league is the league's folder (e.g. "Leagues/League 2"). Empty = not
//                     connected yet: the form validates the name and explains that.
//   turnstileSiteKey  Cloudflare Turnstile site key (public). When set, the form shows the
//                     Turnstile check and sends its token; the Worker verifies it.

const LANG = "league-registration"

/** Walk an mdast tree, replacing/removing `code` nodes in the registration language. */
function remarkLeagueRegistration(endpoint, siteKey) {
  return () => (tree, file) => {
    const fm = file.data?.frontmatter ?? {}
    const upcoming = String(fm.status ?? "").toLowerCase() === "upcoming"
    const league = String(fm.title ?? "")
    // the league's folder in content/, e.g. "Leagues/League 2" (the Worker uses this, not the title)
    const folder = String(file.data?.relativePath ?? "").split("/").slice(0, -1).join("/")

    const visit = (parent) => {
      if (!parent.children) return
      for (let i = parent.children.length - 1; i >= 0; i--) {
        const node = parent.children[i]
        if (node.type === "code" && node.lang === LANG) {
          if (upcoming) parent.children[i] = formNode(league, folder, endpoint, siteKey)
          else parent.children.splice(i, 1)
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
function formNode(league, folder, endpoint, siteKey) {
  const idBase = `league-registration-${league.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
  const inputId = `${idBase}-name`
  const armyId = `${idBase}-army`
  const helpId = `${idBase}-army-help`
  const checkId = `${idBase}-army-check`
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
            }),
          ]),
          el("div", { className: ["league-registration-field"] }, [
            el("label", { htmlFor: armyId }, [
              text("Army link "),
              el("span", { className: ["league-registration-optional"] }, [text("(optional)")]),
            ]),
            el("input", {
              id: armyId,
              type: "url",
              name: "armyLink",
              maxLength: 500,
              inputMode: "url",
              autoComplete: "off",
              placeholder: "https://army-forge.onepagerules.com/share?id=…",
              ariaDescribedby: `${checkId} ${helpId}`,
            }),
            el("p", { id: helpId, className: ["league-registration-help"] }, [
              text(
                "Once you've made your list, you can get the URL by clicking the three dots at the top right of the page, selecting ",
              ),
              el("strong", {}, [text("Share List")]),
              text(" and "),
              el("strong", {}, [text("Share as a Link")]),
              text("."),
            ]),
            // live result of checking the link (filled in by the client script)
            el("p", { id: checkId, className: ["league-registration-check"], ariaLive: "polite" }),
          ]),
          ...(siteKey ? [el("div", { className: ["league-registration-turnstile"], dataSitekey: siteKey })] : []),
          el("div", { className: ["league-registration-actions"] }, [
            el("button", { type: "submit" }, [text("Register")]),
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
  // Same rules and messages as the Worker (worker/index.ts checkArmyLink)
  const ARMY_ERRORS = {
    site: "That isn't an Army Forge link.",
    builder: "That's your builder link, which only works for you.",
    view: "That's a viewer link, which others can't open.",
    other: "That's not the right Army Forge link.",
    id: "That link is incomplete.",
    long: "That link is too long.",
  }
  const armyLinkError = (value) => {
    if (!value) return null
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
      slot.dataset.widgetId = window.turnstile.render(slot, { sitekey: slot.dataset.sitekey, action: "register" })
    }
  }
  window.__leagueRegistrationTurnstile = renderWidgets
  document.addEventListener("nav", renderWidgets)
  renderWidgets()

  const registeredNames = () =>
    [...document.querySelectorAll("h2#registered-players + .bases-page tbody a")]
      .map((a) => a.textContent.trim().toLowerCase())

  // --- Live check of the army link: on paste / leaving the field, then as they type to fix it ---
  const showArmyCheck = (input) => {
    const check = input.closest(".league-registration-field")?.querySelector(".league-registration-check")
    if (!check) return true
    const value = input.value.trim()
    const error = armyLinkError(value)
    if (!value) {
      input.removeAttribute("aria-invalid")
      check.textContent = ""
      delete check.dataset.kind
    } else if (error) {
      input.setAttribute("aria-invalid", "true")
      check.textContent = error
      check.dataset.kind = "error"
    } else {
      input.removeAttribute("aria-invalid")
      check.textContent = "\u2713 Looks good."
      check.dataset.kind = "ok"
    }
    return !error
  }
  const isArmyInput = (t) => t?.matches?.(".league-registration-form input[name=armyLink]")
  // leaving the field (fires when the value changed)
  document.addEventListener("change", (e) => isArmyInput(e.target) && showArmyCheck(e.target))
  // pasting: check once the pasted text is in the field
  document.addEventListener("paste", (e) => isArmyInput(e.target) && setTimeout(() => showArmyCheck(e.target), 0))
  // typing: only re-check once a result is showing, so it updates/clears while they fix it
  document.addEventListener("input", (e) => {
    if (!isArmyInput(e.target)) return
    const check = e.target.closest(".league-registration-field")?.querySelector(".league-registration-check")
    if (check?.dataset.kind) showArmyCheck(e.target)
  })

  document.addEventListener("submit", async (event) => {
    const form = event.target.closest?.(".league-registration-form")
    if (!form) return
    event.preventDefault()

    const root = form.closest(".league-registration")
    const status = root.querySelector(".league-registration-status")
    const input = form.querySelector("input[name=name]")
    const button = form.querySelector("button")
    const name = input.value.trim().replace(/\\s+/g, " ")
    const armyLink = (form.querySelector("input[name=armyLink]")?.value ?? "").trim()
    const say = (message, kind) => {
      status.textContent = message
      status.dataset.kind = kind
    }

    if (!name) return say("Please enter your name.", "error")
    if (!NAME.test(name)) {
      return say("Names can use letters, numbers, spaces, hyphens, apostrophes and full stops (max 40).", "error")
    }
    const armyInput = form.querySelector("input[name=armyLink]")
    if (armyInput && !showArmyCheck(armyInput)) {
      armyInput.focus()
      return say("Please fix the army link above.", "error")
    }
    if (registeredNames().includes(name.toLowerCase())) {
      return say(name + " is already registered for this league.", "error")
    }

    const slot = root.querySelector(".league-registration-turnstile")
    let turnstileToken
    if (slot) {
      turnstileToken = window.turnstile && slot.dataset.widgetId ? window.turnstile.getResponse(slot.dataset.widgetId) : ""
      if (!turnstileToken) return say("Please complete the verification check.", "error")
    }

    const endpoint = root.dataset.endpoint
    if (!endpoint) {
      return say(
        "Thanks, " + name + "! Online registration isn't connected yet, so please let the organiser know you'd like to join.",
        "info",
      )
    }

    button.disabled = true
    say("Registering…", "info")
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ league: root.dataset.league, name, armyLink, turnstileToken }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        throw new Error((data && data.error) || res.statusText || "unknown error")
      }
      form.reset()
      say("Thanks, " + name + "! Your registration has been sent and will appear once it's approved.", "success")
    } catch (err) {
      say("Sorry, registration failed: " + (err && err.message ? err.message : "unknown error"), "error")
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
.league-registration-optional { font-weight: 400; color: var(--gray); }
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
.league-registration-turnstile { margin: 0 0 0.85rem; min-height: 65px; }
.league-registration-status { margin: 0.5rem 0 0; min-height: 1.4em; font-size: 0.95rem; }
.league-registration-status[data-kind="error"] { color: #c0392b; }
.league-registration-status[data-kind="success"] { color: var(--tertiary); }
`

export const LeagueRegistration = (opts = {}) => {
  const endpoint = typeof opts.endpoint === "string" ? opts.endpoint.trim() : ""
  const siteKey = typeof opts.turnstileSiteKey === "string" ? opts.turnstileSiteKey.trim() : ""
  return {
    name: "LeagueRegistration",
    markdownPlugins() {
      return [remarkLeagueRegistration(endpoint, siteKey)]
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
