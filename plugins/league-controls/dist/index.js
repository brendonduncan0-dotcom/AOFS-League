// League Controls: a Quartz transformer plugin.
//
// Replaces ```league-controls code blocks (the bottom of each league page) with controls for
// running the league: one button for the league's next step. Anyone can press it: it asks to
// confirm, passes the (hidden) Turnstile check, and POSTs { league, turnstileToken } to the endpoint
// (the Worker, POST /api/advance), which re-checks the same rules and starts the GitHub
// workflow that runs the pairing script.
//
//   Upcoming             "Start league"       disabled until at least 2 players have registered
//   Active, rounds left  "Draw round N"       disabled while the current round has pairings
//   Active, final round  "Finish league"      without a result (status: scheduled)
//   Completed            (block removed, so the "League controls" heading is hidden too)
//
// The state comes from the league's notes when the site is built (the site rebuilds on every
// change, so it's current). Hand-written ESM (no build step): this file is the plugin's output.
//
// Options:
//   endpoint          URL to POST to. Empty = not connected yet (the button explains that).
//   turnstileSiteKey  Cloudflare Turnstile site key (public). The check runs hidden in the
//                     background while the button is enabled, and only shows itself if
//                     Cloudflare needs the visitor to interact.

import fs from "node:fs"
import path from "node:path"

const LANG = "league-controls"

const notesIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".md")) : [])

/** A simple top-level `key: value` from a note's frontmatter (quotes removed, lower case). */
function frontmatterValue(file, key) {
  const fm = fs.readFileSync(file, "utf8").match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ""
  const value = fm.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"))?.[1]?.trim() ?? ""
  return value.replace(/^(["'])(.*)\1$/, "$2").toLowerCase()
}

/** What the button does next, and why it's disabled (if it is). */
function nextStep(fm, leagueDir) {
  const status = String(fm.status ?? "").toLowerCase()
  if (status === "completed") return null

  const current = Number(fm.current_round) || 0
  const rounds = Number(fm.rounds) || 0

  if (status !== "active" || current === 0) {
    const playersDir = path.join(leagueDir, "Registered Players")
    const players = notesIn(playersDir).filter(
      (f) => frontmatterValue(path.join(playersDir, f), "status") !== "dropped",
    ).length
    return {
      label: "Start league",
      confirm: "Start the league and draw round 1? Registered players will be paired at random.",
      blocked: players < 2 ? "At least 2 players need to register before the league can start." : "",
    }
  }

  const roundDir = path.join(leagueDir, "Pairings", `Round ${current}`)
  const outstanding = notesIn(roundDir)
    .filter((f) => ["", "scheduled"].includes(frontmatterValue(path.join(roundDir, f), "status")))
    .map((f) => f.replace(/\.md$/, ""))
  const waiting = outstanding.length
    ? `Waiting for ${outstanding.length === 1 ? "1 result" : `${outstanding.length} results`} from round ${current}: ${outstanding.join(", ")}.`
    : ""
  const finishing = rounds && current >= rounds
  return {
    label: finishing ? "Finish league" : `Draw round ${current + 1}`,
    confirm: finishing
      ? "Finish the league? The final standings and winner will be set."
      : `Draw round ${current + 1}? Players will be paired by their standings.`,
    blocked: waiting,
  }
}

const el = (tagName, properties = {}, children = []) => ({ type: "element", tagName, properties, children })
const text = (value) => ({ type: "text", value })

function controlsNode(step, league, folder, { endpoint, siteKey }) {
  const noteId = `league-controls-${league.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-note`
  const verify = !step.blocked && siteKey
  return {
    type: "leagueControls",
    data: {
      hName: "div",
      hProperties: {
        className: ["league-controls"],
        dataLeague: folder,
        dataEndpoint: endpoint || undefined,
        dataConfirm: step.confirm,
      },
      hChildren: [
        ...(verify
          ? [
              el("div", { className: ["league-controls-verify"] }, [
                el("div", { className: ["league-controls-turnstile"], dataSitekey: siteKey }),
                el("p", { className: ["league-controls-check"], ariaLive: "polite" }),
              ]),
            ]
          : []),
        el("div", { className: ["league-controls-actions"] }, [
          el(
            "button",
            {
              type: "button",
              className: ["league-controls-next"],
              disabled: Boolean(step.blocked),
              ariaDescribedby: step.blocked ? noteId : undefined,
            },
            [text(step.label)],
          ),
        ]),
        ...(step.blocked ? [el("p", { id: noteId, className: ["league-controls-note"] }, [text(step.blocked)])] : []),
        el("p", { className: ["league-controls-status"], role: "status", ariaLive: "polite" }),
      ],
    },
  }
}

function remarkLeagueControls(ctx, options) {
  return () => (tree, file) => {
    const fm = file.data?.frontmatter ?? {}
    const relativePath = String(file.data?.relativePath ?? "")
    const contentDir = ctx?.argv?.directory ?? "content"
    // the league's folder in content/, e.g. "Leagues/League 2" (sent to the Worker)
    const folder = path.dirname(relativePath).split(path.sep).join("/")
    const leagueDir = path.resolve(contentDir, folder)

    let step
    const visit = (parent) => {
      if (!parent.children) return
      for (let i = parent.children.length - 1; i >= 0; i--) {
        const node = parent.children[i]
        if (node.type === "code" && node.lang === LANG) {
          step ??= nextStep(fm, leagueDir)
          if (step) parent.children[i] = controlsNode(step, String(fm.title ?? ""), folder, options)
          else parent.children.splice(i, 1)
        } else {
          visit(node)
        }
      }
    }
    visit(tree)
  }
}

// Client script: event delegation on `document` (installed once), so it keeps working across
// Quartz's SPA navigations without re-binding.
const clientScript = `
(() => {
  if (window.__leagueControls) return
  window.__leagueControls = true
  const VERIFY = "Please complete the verification check."
  const VERIFY_BLOCKED = "The verification check couldn't load. Please allow challenges.cloudflare.com (e.g. in your ad blocker) or try another browser."
  const VERIFY_ERROR = "The verification check couldn't run. Please refresh the page and try again."

  const setLine = (line, message, kind) => {
    if (!line) return
    line.textContent = message || ""
    if (kind && message) line.dataset.kind = kind
    else delete line.dataset.kind
  }
  const verifyLine = (slot) => slot.closest(".league-controls-verify")?.querySelector(".league-controls-check")

  // --- Cloudflare Turnstile: hidden (appearance "interaction-only"), running in the background
  // from page load. Explicit rendering. The registration form may load the script too, so wait
  // for whichever script tag exists rather than relying on its onload callback.
  const waiting = new Map() // slot -> callbacks waiting for its next token
  const tokenArrived = (slot, token) => {
    for (const done of waiting.get(slot) ?? []) done(token)
    waiting.delete(slot)
  }
  /** The slot's token, waiting up to ms for the background check to finish. "" if none. */
  const getToken = (slot, ms = 8000) => {
    const id = slot.dataset.widgetId
    const now = window.turnstile && id ? window.turnstile.getResponse(id) : ""
    if (now) return Promise.resolve(now)
    if (slot.dataset.failed) return Promise.resolve("") // it already reported an error
    return new Promise((resolve) => {
      const done = (token) => {
        clearTimeout(timer)
        resolve(token || "")
      }
      const timer = setTimeout(() => {
        waiting.set(slot, (waiting.get(slot) ?? []).filter((d) => d !== done))
        resolve(window.turnstile && id ? window.turnstile.getResponse(id) || "" : "")
      }, ms)
      waiting.set(slot, [...(waiting.get(slot) ?? []), done])
    })
  }
  const renderWidgets = () => {
    const slots = document.querySelectorAll(".league-controls-turnstile:not([data-widget-id])")
    if (!slots.length) return
    if (!window.turnstile) {
      let script = document.querySelector('script[src^="https://challenges.cloudflare.com/turnstile/"]')
      if (!script) {
        script = document.createElement("script")
        script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
        script.async = true
        document.head.appendChild(script)
      }
      script.addEventListener("load", renderWidgets, { once: true })
      return
    }
    for (const slot of slots) {
      slot.dataset.widgetId = window.turnstile.render(slot, {
        sitekey: slot.dataset.sitekey,
        action: "advance_league",
        appearance: "interaction-only",
        "refresh-expired": "auto",
        callback: (token) => {
          delete slot.dataset.failed
          setLine(verifyLine(slot), "", null)
          tokenArrived(slot, token)
        },
        "error-callback": () => {
          slot.dataset.failed = "true"
          setLine(verifyLine(slot), VERIFY_ERROR, "error")
          tokenArrived(slot, "")
        },
      })
    }
  }
  document.addEventListener("nav", renderWidgets)
  renderWidgets()

  document.addEventListener("click", async (event) => {
    const button = event.target.closest?.(".league-controls-next")
    if (!button || button.disabled) return
    const root = button.closest(".league-controls")
    const status = root.querySelector(".league-controls-status")
    const say = (message, kind) => setLine(status, message, kind)

    if (!root.dataset.endpoint) return say("League controls aren't connected yet.", "info")
    if (root.dataset.confirm && !window.confirm(root.dataset.confirm)) return

    button.disabled = true
    say("Sending…", "info")
    // the hidden check has usually finished by now; if not, wait a few seconds for it
    const slot = root.querySelector(".league-controls-turnstile")
    const token = slot ? await getToken(slot) : ""
    if (slot && !token) {
      button.disabled = false
      say("", null)
      // if Cloudflare wants the visitor to interact, the check has now appeared above the button
      setLine(verifyLine(slot), !window.turnstile ? VERIFY_BLOCKED : slot.dataset.failed ? VERIFY_ERROR : VERIFY, "error")
      return
    }
    let done = false
    try {
      const res = await fetch(root.dataset.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ league: root.dataset.league, turnstileToken: token || undefined }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        const message = (data && data.error) || res.statusText || "unknown error"
        if (res.status === 403 && slot) {
          setLine(verifyLine(slot), message, "error")
          return say("", null)
        }
        throw new Error(message)
      }
      done = true
      say(data.message, "success")
      // the round is on its way: hide the check and leave the button disabled
      root.querySelector(".league-controls-verify")?.remove()
    } catch (err) {
      say("Sorry, that didn't work: " + (err && err.message ? err.message : "unknown error"), "error")
    } finally {
      if (!done) {
        button.disabled = false
        if (slot && window.turnstile && slot.dataset.widgetId) window.turnstile.reset(slot.dataset.widgetId)
      }
    }
  })
})()
`

const css = `
.league-controls { margin: 1rem 0 1.5rem; }
.league-controls-next {
  padding: 0.5rem 1.1rem; font: inherit; font-weight: 600; cursor: pointer;
  color: var(--light); background: var(--secondary); border: none; border-radius: 6px;
}
.league-controls-next:hover:not(:disabled) { opacity: 0.9; }
.league-controls-next:disabled { opacity: 0.45; cursor: not-allowed; }
.league-controls-note { margin: 0.5rem 0 0; font-size: 0.9rem; color: var(--darkgray); }
/* the check is hidden unless Cloudflare needs the visitor to interact */
.league-controls-verify { margin: 0 0 0.5rem; }
.league-controls-check { margin: 0.35rem 0 0; font-size: 0.9rem; }
.league-controls-check:empty, .league-controls-status:empty { display: none; }
.league-controls-check[data-kind="error"], .league-controls-status[data-kind="error"] { color: #c0392b; }
.league-controls-status { margin: 0.5rem 0 0; font-size: 0.95rem; }
.league-controls-status[data-kind="success"] { color: var(--tertiary); }
`

const option = (value) => (typeof value === "string" ? value.trim() : "")

export const LeagueControls = (opts = {}) => {
  const options = { endpoint: option(opts.endpoint), siteKey: option(opts.turnstileSiteKey) }
  return {
    name: "LeagueControls",
    markdownPlugins(ctx) {
      return [remarkLeagueControls(ctx, options)]
    },
    externalResources() {
      return {
        css: [{ content: css, inline: true }],
        js: [{ script: clientScript, loadTime: "afterDOMReady", contentType: "inline" }],
      }
    },
  }
}

export default LeagueControls
