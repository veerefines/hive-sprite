# ⬢ Hive on a Sprite

**A trip-planning agent that lives on a Fly.io Sprite, argues with a strict plan checker, and posts the result to your Slack.**

Built for [Fly.io Hacksgiving 2026](https://fly.io/hacksgiving/).

Tell Hive where you're going and how you like to travel. It:

1. **Researches real places.** Geocodes the destination and pulls named restaurants, viewpoints, parks and museums from OpenStreetMap, plus the 16-day forecast.
2. **Drafts a day-by-day plan** with times, coordinates and costs.
3. **Gets torn apart by the Plan Doctor.** A deterministic checker (no LLM) flags overlapping stops, travel too tight to make, missing meals, outdoor stops on rainy days, budget overruns and starts before you're awake.
4. **Fixes it and resubmits** until there are no errors left, then writes a short summary.
5. **Shares it to Slack**, if you ask.

You watch every step stream in live on the Sprite's URL, and every trip is saved on the Sprite's own disk.

## Why a Sprite

| Sprites feature | What Hive uses it for |
| --- | --- |
| **Connectors** | Every LLM call goes through the **OpenRouter connector** and Slack posts go through the **Slack connector**. No API key is stored on the Sprite: requests carry no `Authorization` header, and the Sprites gateway attaches the credential. |
| **Services** | Hive runs as a `sprite-env` service with `--http-port 8080`, so a request to a cold Sprite wakes it, starts Hive and serves the page. It costs nothing while idle. |
| **Persistent disk** | Trips are plain JSON files in `~/hive/data/trips`, which survive sleep and cold boots. |
| **Checkpoints** | Snapshot the Sprite before trying a new model or prompt, and roll back if it gets worse. |

```
browser ──HTTPS──▶ Sprite URL ──▶ hive service (:8080, Node, zero runtime deps)
                                    │
                                    ├─▶ api.sprites.dev/v1/gateway/openrouter/…  (LLM, key held by Fly)
                                    ├─▶ api.sprites.dev/v1/gateway/slack_bot/…   (share, key held by Fly)
                                    └─▶ OpenStreetMap + Open-Meteo                (public, keyless)
```

## Run it on your own Sprite

```bash
sprite create hive
sprite console -s hive
# inside the Sprite:
export HIVE_LLM_GATEWAY="https://api.sprites.dev/v1/gateway/openrouter/<connection_id>/api/v1"
export HIVE_SLACK_GATEWAY="https://api.sprites.dev/v1/gateway/slack_bot/<connection_id>"   # optional
curl -fsSL https://raw.githubusercontent.com/veerefines/hive-sprite/main/sprite/setup.sh | bash
```

In the Fly dashboard, open **Connectors**, enable the OpenRouter connector (and Slack if you want sharing), and give the `hive` Sprite access with a name-prefix rule. Then run `sprite url update --auth public` to share the page.

Locally: `npm install && npm test`, then `HIVE_LLM_GATEWAY=… npm start`.

## Where the code came from

Hive's agent, server, connector layer, UI and tests were written during Hacksgiving week. The **Plan Doctor** (`src/lib/planCheck.ts`) and the distance helpers (`src/lib/geo.ts`) are reused, unchanged apart from one import path, from my earlier project [TripHive](https://github.com/veerefines/triphive), a group trip planner on Cloudflare Workers built just before the hackathon. Everything Sprites-specific is new.

## Project layout

```
src/agent.ts        the tool loop: geocode, find_places, propose_plan → Plan Doctor → revise
src/connectors.ts   OpenRouter + Slack through the Sprites gateway
src/world.ts        OpenStreetMap places, geocoding, Open-Meteo forecast
src/server.ts       HTTP API + NDJSON progress stream + trip storage
src/lib/            Plan Doctor and geo helpers (from TripHive)
public/             the page
sprite/setup.sh     installs Hive as a Sprite service
test/               agent loop, connector and validation tests (scripted fake model)
```

MIT licensed.
