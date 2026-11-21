import type { QuartzTransformerPlugin } from "@quartz-community/types"

export interface LeagueRegistrationOptions {
  /** URL the form POSTs registrations to (the Cloudflare Worker). Empty = not connected yet. */
  endpoint?: string
}

export declare const LeagueRegistration: QuartzTransformerPlugin<LeagueRegistrationOptions>
export default LeagueRegistration
