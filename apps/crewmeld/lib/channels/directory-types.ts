/**
 * [IM-DIRECTORY · MERGE→dev0.0.1] Channel-side user-directory types.
 *
 * This file, together with the `getFeishuUserDetail` / `getDingtalkUserDetail` /
 * `getWecomUserDetail` fetchers, is the standalone "fetch a person's info from
 * IM" capability. It has NO dependency on the ontology identity-resolution
 * system, so it is intended to be merged into `dev0.0.1`. The ontology parts
 * (query executor, identity binding, datasource directory, resolver wiring)
 * stay specific to the `dev0.0.1-LightRAG` branch and are NOT merged.
 */

/** Strong keys + name + dept resolved from a channel directory for one user. */
export interface ChannelUserDetail {
  name?: string
  email?: string
  mobile?: string
  employeeNo?: string
  /**
   * Employment type label when the channel exposes it (e.g. Feishu employee_type).
   * This is a NORMALIZED string label; channels that expose a numeric code (e.g. DingTalk
   * `employee_type` int enum) MUST String()-convert when mapping to this field.
   */
  employeeType?: string
  deptNames?: string[]
  /** Job titles / positions resolved from the channel directory. */
  positions?: string[]
  /** Org-unit (department) ids resolved from the channel directory — the id space used for matching. */
  orgUnitIds?: string[]
  /**
   * Tenant custom department ids (e.g. Feishu `beijing`) recorded for display/audit.
   * NOT used for SOP permission matching — that stays on {@link orgUnitIds}.
   */
  orgUnitCustomIds?: string[]
  /** Direct leader's channel-native id, in the same id space as `userId`. Undefined when the channel does not expose it. */
  leaderId?: string
  /**
   * Channel-declared custom directory fields, passed through verbatim for policy
   * rowFilters to reference via `raw.attributes.<field>`. Only fields named in the
   * binding's `channelAttributePassthrough` are included; undeclared fields are omitted.
   */
  attributes?: Record<string, unknown>
}
