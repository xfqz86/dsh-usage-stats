Today's token usage in the sidebar, a panel with daily, per-session and per-model breakdowns, DeepSeek / OpenCode Go / Z.ai quota monitoring, and per-session model speed readings in the composer.

## What it shows

- **Today in the sidebar**: today's tokens, call count and an input / output / cache ratio bar; collapses to compact chips when the sidebar is narrow.
- **Overview**: today and all-time totals, a 26-week daily heatmap, and three quota cards.
- **Dates**: one stacked bar per day (input / output / cache) with a cache hit-rate line; a sortable, paged table below.
- **Sessions**: per-session totals with subagents folded into their main session and expandable; sortable by last active, usage and more.
- **Models**: a per-model and per-provider table with a pie chart and stacked bars; group models by provider or by model name.
- **Drill-downs**: every row on the Date, Model and Session pages has a Details action showing that day, model or session broken down.
- **Quotas**: DeepSeek balance, OpenCode Go (rolling 5 hours / week / month), Z.ai (rolling 5 hours / week plus monthly web searches); each source can be switched on or off with its own fetch interval and sidebar visibility.
- **Model speed**: average TTFT and ATPS for the current session in the composer status line, with a per-call chart and average / last / min / max on click.
- **Session ID badge**: a short ID next to the session title, one click to copy.

## Using it

1. Click today's usage at the bottom of the sidebar to open the panel.
2. Switch tabs: Overview / Dates / Sessions / Models / Settings / About.
3. Settings holds quota monitoring and fetch intervals, the session ID and model speed switches, model redirect rules, settings export / import, and ledger clear or rebuild.
4. About checks for updates, explains data and privacy, and upgrades in place.

## Quota credentials

Configure the keys in DSH's credential center; the first configured alias wins:

- DeepSeek: `DEEPSEEK_API_KEY` (also `DEEPSEEK_APIKEY`, `DEEPSEEK_API_TOKEN`, `DEEPSEEK_TOKEN`)
- OpenCode Go: `OPENCODE_GO_API_KEY`
- Z.ai: `ZAI_CODING_CN_API_KEY` or `ZAI_API_KEY` (the former wins)

Turning a source off stops requests to that provider. Quota requests carry only the matching credential and go straight to the official endpoint.

## Data and privacy

- Usage comes from local session logs; the ledger lives at `$DSH_HOME/storages/dsh-usage-stats/ledger.sqlite` (default `~/.dsh/storages/...`).
- The first start scans existing sessions and imports them, then updates incrementally from session events.
- Everything is aggregated locally: no usage, session content or account data is uploaded, and there is no telemetry.
- Update checks only read the npm registry and GitHub Releases.

## Install and update

- Install `@xfqz86/dsh-usage-stats` from the DSH plugin page, or run `dsh plugin --profile web add @xfqz86/dsh-usage-stats`.
- When About finds a newer version, upgrade in place and restart DSH once.
- Uninstall with `dsh plugin --profile web remove @xfqz86/dsh-usage-stats`.

Full install options and developer docs: [GitHub repository](https://github.com/xfqz86/dsh-usage-stats).
