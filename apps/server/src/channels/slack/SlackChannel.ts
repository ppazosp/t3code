import * as Config from "effect/Config";

import type { ChannelDefinition } from "../Channel.ts";
import { readSlackSettings, type SlackSettings } from "./parse.ts";
import * as SlackAdapter from "./SlackAdapter.ts";

/**
 * Slack, configured by environment variables so the settings schema stays upstream's. It is on
 * when the bot token, the app token and the user's Slack ID are set.
 */
export const slackChannel: ChannelDefinition<SlackSettings> = {
  name: "slack",
  instructions: `Slack shows Markdown: bold, italics, lists, code and links. Headings show as bold text. People read your messages in a thread, so keep them short.

To notify one person, write their tag, which messages show after their name, such as <@U0123ABC>. Tag only someone who needs to act or decide. @here, @channel and group mentions show as text and notify no one.

To draw a chart, write a fenced code block with the language \`chart\`, holding one JSON object. Slack draws at most 2 per message.
- Pie: {"kind":"pie","title":"Orders by state","segments":[{"label":"Shipped","value":12},{"label":"Late","value":3}]}
- Bar, line or area: {"kind":"bar","title":"Requests per day","categories":["Mon","Tue"],"series":[{"name":"Requests","values":[4,7]}],"yLabel":"req/s"}
Titles take up to 50 characters; labels, categories and series names up to 20. Up to 12 segments or series, and 20 categories. A chart that does not fit shows as code.`,
  settings: Config.all({
    botToken: Config.option(Config.String("T3_SLACK_BOT_TOKEN")),
    appToken: Config.option(Config.String("T3_SLACK_APP_TOKEN")),
    trustedUserId: Config.option(Config.String("T3_SLACK_TRUSTED_USER_ID")),
    watchedChannels: Config.option(Config.String("T3_SLACK_WATCHED_CHANNELS")),
    apiUrl: Config.option(Config.String("T3_SLACK_API_URL")),
  }).pipe(Config.map(readSlackSettings)),
  make: SlackAdapter.make,
};
