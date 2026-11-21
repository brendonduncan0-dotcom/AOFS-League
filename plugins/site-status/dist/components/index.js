// Site Status: a Quartz component (left sidebar, between the search toolbar and the explorer).
//
// Shows a small tag: "Site is updating" while the latest change on the deploy branch is still
// going through GitHub Actions / the Cloudflare build, "Site is up-to-date" once it's done, or
// "Site update failed". The state comes from the Worker (GET /api/status, worker/index.ts).
// Hidden until the first answer, and whenever the status is unavailable (e.g. `quartz serve`
// locally, where there's no Worker).
//
// The site's forms and league controls dispatch a "site-status:refresh" event on `document`
// after a request that will change the site. The tag then says "updating" straight away and
// keeps saying so until GitHub reports a newer change that has finished (or 5 minutes pass):
// e.g. a registration waits for its pull request to auto-merge before it reaches the branch.
//
// Hand-written ESM (no build step): this file is the plugin's shipped output.

import { jsx } from "preact/jsx-runtime"

const ENDPOINT = "/api/status"

const css = `
.site-status {
  display: inline-flex; align-items: center; gap: 0.4rem; width: fit-content;
  margin: 0.25rem 0 0.5rem; padding: 0.15rem 0.65rem; border-radius: 999px;
  font-size: 0.8rem; line-height: 1.4; white-space: nowrap;
  color: var(--darkgray); border: 1px solid var(--lightgray); background: var(--light);
}
.site-status[hidden] { display: none; }
.site-status[data-state="up-to-date"] { color: #1a7f37; border-color: #1a7f3755; background: #1a7f3712; }
.site-status[data-state="updating"] { color: #b45309; border-color: #d9770666; background: #d9770614; }
.site-status[data-state="failed"] { color: #c0392b; border-color: #c0392b55; background: #c0392b12; }
.site-status[data-state="updating"] .site-status-text::after {
  content: ""; display: inline-block; width: 1.2em; text-align: left;
  animation: site-status-dots 1.4s steps(4, end) infinite;
}
@keyframes site-status-dots {
  0% { content: ""; } 25% { content: "."; } 50% { content: ".."; } 75% { content: "..."; }
}
@media (prefers-reduced-motion: reduce) {
  .site-status[data-state="updating"] .site-status-text::after { animation: none; content: "…"; }
}
`

// Client script (runs once; Quartz's SPA navigation re-renders the sidebar, so re-apply on "nav")
const script = `
(() => {
  if (window.__siteStatus) return
  window.__siteStatus = true
  const TEXT = { "updating": "Site is updating", "up-to-date": "Site is up-to-date", "failed": "Site update failed" }
  const TIP = { "updating": "Working on: ", "up-to-date": "Latest change: ", "failed": "Failed: " }
  let last = null
  let timer
  // set by "site-status:refresh": waiting for a change that's on its way
  let expecting = null // { since, commit }
  const EXPECT_MS = 5 * 60 * 1000

  /** What to show: the Worker's answer, or "updating" while an expected change hasn't arrived. */
  const shown = () => {
    if (!expecting) return last
    const arrived = last && last.state !== "updating" && last.commit && last.commit !== expecting.commit
    if (arrived || Date.now() - expecting.since > EXPECT_MS) {
      expecting = null
      return last
    }
    if (last && last.state === "updating") return last
    return { state: "updating", message: "your change" }
  }

  const apply = () => {
    const now = shown()
    for (const el of document.querySelectorAll(".site-status")) {
      const state = now && TEXT[now.state] ? now.state : null
      el.hidden = !state
      if (!state) continue
      el.dataset.state = state
      el.querySelector(".site-status-text").textContent = TEXT[state]
      el.title = now.message ? TIP[state] + now.message : ""
    }
  }

  const poll = async () => {
    clearTimeout(timer)
    const el = document.querySelector(".site-status")
    if (el && !document.hidden) {
      try {
        const res = await fetch(el.dataset.endpoint)
        last = res.ok ? await res.json() : null
      } catch {
        last = null
      }
      apply()
    }
    // check more often while something is going through
    const busy = expecting || (last && last.state === "updating")
    timer = setTimeout(poll, busy ? 10000 : 30000)
  }

  document.addEventListener("site-status:refresh", () => {
    expecting = { since: Date.now(), commit: last && last.commit }
    apply()
    // the Worker's answer is shared for ~20s, so give the change a moment before asking
    clearTimeout(timer)
    timer = setTimeout(poll, 5000)
  })

  document.addEventListener("nav", apply)
  // coming back to the tab: check straight away
  document.addEventListener("visibilitychange", () => { if (!document.hidden) poll() })
  poll()
})()
`

export const SiteStatus = () => {
  const Component = ({ displayClass }) =>
    jsx("div", {
      class: ["site-status", displayClass].filter(Boolean).join(" "),
      "data-endpoint": ENDPOINT,
      "data-state": "unknown",
      role: "status",
      "aria-live": "polite",
      hidden: true,
      children: jsx("span", { class: "site-status-text", children: "" }),
    })
  Component.css = css
  Component.afterDOMLoaded = script
  return Component
}

export default SiteStatus
