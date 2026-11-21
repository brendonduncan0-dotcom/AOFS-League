// League Registration: a Quartz transformer plugin.
//
// Replaces ```league-registration code blocks with a registration form, but only on pages
// whose frontmatter `status` is "Upcoming". On any other page the block is removed.
//
// Hand-written ESM (no build step): this file is the plugin's shipped output.
//
// Options:
//   endpoint          URL the form POSTs to as JSON { league, name, turnstileToken }, where
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
  const inputId = `league-registration-name-${league.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
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
          el("label", { htmlFor: inputId }, [text("Your name")]),
          el("div", { className: ["league-registration-row"] }, [
            el("input", {
              id: inputId,
              type: "text",
              name: "name",
              required: true,
              maxLength: 40,
              autoComplete: "name",
              placeholder: "e.g. Brendon",
            }),
            el("button", { type: "submit" }, [text("Register")]),
          ]),
          ...(siteKey ? [el("div", { className: ["league-registration-turnstile"], dataSitekey: siteKey })] : []),
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

  document.addEventListener("submit", async (event) => {
    const form = event.target.closest?.(".league-registration-form")
    if (!form) return
    event.preventDefault()

    const root = form.closest(".league-registration")
    const status = root.querySelector(".league-registration-status")
    const input = form.querySelector("input[name=name]")
    const button = form.querySelector("button")
    const name = input.value.trim().replace(/\\s+/g, " ")
    const say = (message, kind) => {
      status.textContent = message
      status.dataset.kind = kind
    }

    if (!name) return say("Please enter your name.", "error")
    if (!NAME.test(name)) {
      return say("Names can use letters, numbers, spaces, hyphens, apostrophes and full stops (max 40).", "error")
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
        body: JSON.stringify({ league: root.dataset.league, name, turnstileToken }),
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
.league-registration-row { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.league-registration-row input {
  flex: 1 1 14rem; min-width: 0; padding: 0.5rem 0.75rem; font: inherit;
  color: var(--dark); background: var(--light);
  border: 1px solid var(--lightgray); border-radius: 6px;
}
.league-registration-row input:focus { outline: 2px solid var(--secondary); outline-offset: 1px; }
.league-registration-row button {
  padding: 0.5rem 1.1rem; font: inherit; font-weight: 600; cursor: pointer;
  color: var(--light); background: var(--secondary); border: none; border-radius: 6px;
}
.league-registration-row button:hover { opacity: 0.9; }
.league-registration-row button:disabled { opacity: 0.6; cursor: progress; }
.league-registration-turnstile { margin-top: 0.75rem; min-height: 65px; }
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
