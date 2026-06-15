/**
 * Channel plugin entry point — registers all built-in channel plugins.
 *
 * This is a side-effect import: `import '@/lib/channels/plugins'`.
 *
 * Without this file calling registerPlugin(), `getPlugin('feishu')` (and
 * every other IM channel) returns undefined, and notification-dispatcher
 * falls back to its dry-run branch — SOP approval cards get logged but
 * never actually delivered.
 */

import { registerPlugin } from '../plugin-registry'
import { dingtalkPlugin } from './dingtalk'
import { discordPlugin } from './discord'
import { feishuPlugin } from './feishu'
import { telegramPlugin } from './telegram'
import { wecomPlugin } from './wecom'
import { wxoaPlugin } from './wxoa'

registerPlugin(feishuPlugin)
registerPlugin(wecomPlugin)
registerPlugin(dingtalkPlugin)
registerPlugin(discordPlugin)
registerPlugin(telegramPlugin)
registerPlugin(wxoaPlugin)
