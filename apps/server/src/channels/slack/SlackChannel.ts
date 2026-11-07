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
  settings: Config.all({
    botToken: Config.option(Config.String("T3_SLACK_BOT_TOKEN")),
    appToken: Config.option(Config.String("T3_SLACK_APP_TOKEN")),
    trustedUserId: Config.option(Config.String("T3_SLACK_TRUSTED_USER_ID")),
    watchedChannels: Config.option(Config.String("T3_SLACK_WATCHED_CHANNELS")),
    apiUrl: Config.option(Config.String("T3_SLACK_API_URL")),
  }).pipe(Config.map(readSlackSettings)),
  make: SlackAdapter.make,
};
