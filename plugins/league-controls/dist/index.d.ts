import type { QuartzTransformerPlugin } from "@quartz-community/types"

export interface LeagueControlsOptions {
  /** URL the button POSTs to (the Cloudflare Worker, /api/advance). Empty = not connected yet. */
  endpoint?: string
  /** Cloudflare Turnstile site key (public). When set, the button needs the Turnstile check. */
  turnstileSiteKey?: string
}

export declare const LeagueControls: QuartzTransformerPlugin<LeagueControlsOptions>
export default LeagueControls
