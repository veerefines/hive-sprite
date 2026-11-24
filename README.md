# ⬢ Hive on a Sprite

**Your personal trip agent, living on a Fly.io Sprite.** Tell it where you're going; it researches real places, plans every meal, sight and the stay, checks the plan against the forecast and fixes it, works out how to get between stops and what it'll cost, then lets you refine the trip by chat.

**Live:** https://hive-b6t5u.sprites.app · Built for [Fly.io Hacksgiving 2026](https://fly.io/hacksgiving/)

## What Hive does

1. **Researches real places.** Geocodes the destination, then searches OpenStreetMap (Photon) for hotels, restaurants matched to your tastes, cafés, bakeries, sights, viewpoints, museums and parks.
2. **Plans the whole trip.** A stay, breakfast/lunch/dinner every day, sights that fit your interests, each with *why it fits you* and a local tip, plus trip-wide tips.
3. **Gets torn apart by the Plan Doctor, on repeat.** Deterministic checks (no LLM) send the draft back until it's clean:
   - overlapping stops, travel too tight to make, starts before you're awake, too many stops for your pace
   - outdoor stops on rainy days, budget overruns
   - **any place Hive didn't actually find** (no invented restaurants; coordinates always come from the search result, never the model)
   - a missing meal, dinner at 17:00, the same place twice, your "at sunset" request not landing before that day's sunset
4. **Fills in everything around it.** Best way between every pair of stops (walk / transit / taxi with time, cost and the trade-off) on real street routes, a whole-trip cost estimate in local *and* home currency at live rates (flights from your home city included), how much cash to carry, rainy-day backups and extra ideas from its research.
5. **Lets you refine it by chat.** "Make day 2 cheaper", "dinner is too early", "fit in that market". Hive researches, redrafts, re-runs the Plan Doctor, and comes back with a **suggestion and a diff** you accept or reject. It never edits your plan on its own.
6. **Remembers you.** Tell it you're vegetarian or live in LA and it saves that to your profile on the Sprite's disk; every later trip uses it.
7. **Takes it with you.** Add to calendar (.ics), print, share link, Slack.

## Why a Sprite

| Sprites feature | What Hive uses it for |
| --- | --- |
| **Connectors** | Every model call goes through the **Sprites OpenRouter connector** (`openai/gpt-4.1-mini` by default). No API key lives on the Sprite: requests carry no `Authorization` header; the gateway attaches the credential. Slack sharing uses the Slack connector. |
| **Services** | Hive runs as a `sprite-env` service on `--http-port 8080`: a request to a cold Sprite wakes it, starts Hive and serves the page. Nothing runs (or costs) while idle. |
| **Persistent disk** | Trips, chat history and your traveller profile are plain JSON in `~/hive/data`, surviving sleep and cold boots. This is what makes it a *personal* agent. |
| **Checkpoints** | The Sprite was checkpointed before each model/prompt change, so a bad change rolls back in seconds. |

```
browser ──HTTPS──▶ Sprite URL ──▶ hive service (:8080, Node 24, zero runtime deps)
                                    ├─▶ api.sprites.dev/v1/gateway/openrouter/…   LLM (key held by Fly)
                                    ├─▶ api.sprites.dev/v1/gateway/slack_bot/…    share (optional)
                                    ├─▶ Photon / Nominatim (OpenStreetMap)        places, geocoding
                                    ├─▶ OSRM (routing.openstreetmap.de)           street routes
                                    └─▶ Open-Meteo · Frankfurter                  forecast, sunset · FX
```

## Run it on your own Sprite

```bash
sprite create hive
sprite console -s hive
# inside the Sprite:
export HIVE_LLM_GATEWAY="https://api.sprites.dev/v1/gateway/openrouter/<connection_id>/v1"
curl -fsSL https://raw.githubusercontent.com/veerefines/hive-sprite/main/sprite/setup.sh | bash
```

In the Fly dashboard: **Sprites → Connectors → Add connector → OpenRouter**, then give the `hive` Sprite access with a name-prefix rule. `sprite url update --auth public` shares the page. A public URL is capped at 40 plans and 150 chats a day (`HIVE_DAILY_LIMIT`, `HIVE_DAILY_CHAT_LIMIT`).

Locally: `npm install && npm test` (12 tests, no network: scripted model, fake places, fake router), then `HIVE_LLM_GATEWAY=… npm start`.

## Where the code came from

Everything Hive-on-a-Sprite was written during Hacksgiving week: the agent loop and prompts, place grounding and Hive's own checks, chat proposals, profile memory, enrichment, server, UI and tests. These pure modules are reused, unchanged apart from import paths, from my earlier project [TripHive](https://github.com/veerefines/triphive), a group trip planner on Cloudflare Workers built just before the hackathon:

- `src/lib/planCheck.ts` (Plan Doctor) and `src/lib/geo.ts`
- `src/lib/legs.ts` (best way between stops), `src/lib/routing.ts` (OSRM)
- `src/lib/budget.ts` and `src/lib/money.ts` (cost estimate, currencies)

## Layout

```
src/agent.ts        plan + revise loops, place grounding, Hive's checks, proposals
src/enrich.ts       legs + routes, money + FX, budget, ideas, rainy backups, .ics
src/connectors.ts   OpenRouter + Slack through the Sprites gateway
src/world.ts        Photon places, Nominatim geocoding, Open-Meteo forecast + sunset
src/server.ts       HTTP API, NDJSON progress streams, storage, profile, quotas
src/lib/            reused TripHive modules (see above)
public/             the app (plain JS + Leaflet, no build step)
sprite/             setup.sh (install as a service), run.sh (service entry)
test/               agent, enrichment and full HTTP flow tests
```

MIT licensed.
