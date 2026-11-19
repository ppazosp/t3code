#!/usr/bin/env node
// A stand-in Slack for trying super-t3 without a Slack app. Start it, then run super-t3 with:
//   T3_SLACK_API_URL=http://127.0.0.1:<port>/api T3_SLACK_BOT_TOKEN=xoxb-mock
//   T3_SLACK_APP_TOKEN=xapp-mock T3_SLACK_TRUSTED_USER_ID=UME T3_SLACK_WATCHED_CHANNELS=CWATCH
// and open http://127.0.0.1:<port> to write as yourself and click the buttons.
// @effect-diagnostics globalConsole:off - A plain script that prints where the mock listens.
import { startMockSlack } from "../src/channels/slack/MockSlack.ts";

const port = Number(process.argv[2] ?? "18555");
const slack = await startMockSlack({ port });
console.log(`Mock Slack on ${slack.url}`);
