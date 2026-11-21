import type { QuartzTransformerPlugin } from "@quartz-community/types"

export interface LeagueRegistrationOptions {
  /** URL the form POSTs registrations to (the Cloudflare Worker). Empty = not connected yet. */
  endpoint?: string
  /** URL the league creation form POSTs to (the Cloudflare Worker). Empty = not connected yet. */
  createEndpoint?: string
  /** Cloudflare Turnstile site key (public). When set, the form shows the Turnstile check. */
  turnstileSiteKey?: string
}

export declare const LeagueRegistration: QuartzTransformerPlugin<LeagueRegistrationOptions>
export default LeagueRegistration
