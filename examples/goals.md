# Goal ideas

Paste any of these into the dashboard, or use `motes add`.

| Mote | Schedule | Goal |
|------|----------|------|
| Tide | `daily 07:00` | Read my unread email. Leave me a summary of what needs a reply, and draft replies into ~/drafts/ (don't send). |
| Ember | `manual` + webhook | When this is triggered with a CI failure, clone the repo, reproduce the failure, find the cause and open a PR with the fix. |
| Luna | `every 15m` | Check https://mysite.example.com/health. If it's down twice in a row, restart the service and notify me. |
| Nimbus | `cron 0 8 * * 1` | Every Monday, research the week's news about open-source LLMs and write a one-page brief to ~/briefs/. |
| Pebble | `daily 21:00` | Read ~/finance/transactions.csv, categorize today's spending, and warn me if I'm on track to exceed my monthly budget. |
| Mochi | `once` | Plan a 3-day trip to Lisbon in November: flights, a quiet hotel near Alfama and a day-by-day plan. Don't book anything. |
| Pip | `cron 0 18 * * 5` | Every Friday, tidy ~/Downloads: sort files into folders by type and list anything older than 90 days I might delete. |
| Byte | `daily 03:00` | Back up ~/projects to /mnt/backup with rsync and tell me only if something failed. |

## Triggering from other apps (webhooks)

Every goal has a webhook. Anything that can send an HTTP POST (GitHub Actions,
Slack workflows, IFTTT, Home Assistant, cron on another machine) can wake a mote:

```bash
curl -X POST http://localhost:7777/api/hooks/<goal-id> \
     -H "x-motes-token: $MOTES_TOKEN" \
     -d '{"job": "tests", "status": "failed", "url": "https://github.com/me/app/actions/runs/123"}'
```

The body is passed to the mote as data for that run.
