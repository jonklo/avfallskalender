# minrenovasjon-ical
Norkart's Min Renovasjon as an iCalendar feed

Runs as a Cloudflare Worker. Uses the unofficial API behind the Min Renovasjon app, which can change without notice. Not affiliated with Norkart.

## Usage

Open `https://<your-worker>.workers.dev/` to look up your address and subscribe, or use the feed URL directly:

```
https://<your-worker>.workers.dev/feed?address=Storgata%201&municipality=Oslo
```

| Parameter | Description |
|---|---|
| `address` | Street name and house number. |
| `municipality` | Name or four-digit number. |
| `key` | Required when the `FEED_KEY` secret is set. |

Each collection day is an all-day event with a reminder at 19:00 the evening before.
