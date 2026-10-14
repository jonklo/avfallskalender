# avfallskalender
Norwegian waste collection dates as an iCalendar feed

A non-commercial hobby project, live at [avfallskalender.no](https://avfallskalender.no/). Runs as a Cloudflare Worker with request logging turned off. Uses the unofficial API behind Norkart's Min Renovasjon app, which can change without notice. Addresses are looked up with Kartverket's address search. Not affiliated with Norkart, Oslo kommune or Kartverket.

Oslo doesn't use Min Renovasjon, so Oslo addresses use Oslo kommune's own lookup instead. It only returns the next or most recent collection per waste type, so later dates are projected from the collection frequency for about three months ahead and marked as estimates. Holiday changes show up once Oslo kommune's lookup reflects them.

## Usage

Open [avfallskalender.no](https://avfallskalender.no/) to look up your address and subscribe. The page is in Norwegian, with a button to switch to English; link to `/?lang=en` to open it in English. Or use the feed URL directly:

```
https://avfallskalender.no/feed?address=Storgata%201&municipality=Oslo
```

| Parameter | Description |
|---|---|
| `address` | Street name and house number. |
| `municipality` | Name or four-digit number. |
| `key` | Required when the `FEED_KEY` secret is set. |

Each collection day is an all-day event with a reminder at 7 PM the evening before.
