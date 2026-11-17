Today's token usage in the sidebar, a panel with daily, per-session and per-model breakdowns, DeepSeek / OpenCode Go / Z.ai quota monitoring, and per-session model speed readings in the composer.

## What it shows

- **One entry point**: today's usage and input / output / cache ratio bar in the sidebar footer, collapsing to compact chips when the sidebar is collapsed to the rail.
- **Overview**: today and all-time totals, a 26-week daily heatmap, and three quota cards for DeepSeek, OpenCode Go and Z.ai.
- **Three views**: Dates, Sessions and Models each get a page; Dates and Models have a switchable range from 7 days to all time (365 days by default); subagents fold into their main session.
- **Two read-outs**: average TTFT and ATPS for the current session in the composer status line, and a one-click session ID badge next to the session title.

Full feature list: [README](https://github.com/xfqz86/dsh-usage-stats).

## Using it

1. Click today's usage at the bottom of the sidebar to open the panel.
2. Switch tabs: Overview / Dates / Sessions / Models / Settings / About.
3. Settings holds quota monitoring and fetch intervals, the session ID and model speed switches, model statistics redirect, config string export / import, and ledger clear or rebuild.
4. About checks for updates, explains data and privacy, and upgrades in place.

## Quota monitoring

Configure the keys in DSH's credential center:

- DeepSeek: `DEEPSEEK_API_KEY`
- OpenCode Go: `OPENCODE_GO_API_KEY`
- Z.ai: `ZAI_CODING_CN_API_KEY`

Full alias names and priority order: [`docs/API.md` section 3](https://github.com/xfqz86/dsh-usage-stats/blob/main/docs/API.md).

Turning a source off stops requests to that provider. Quota requests carry only the matching credential and go straight to the official endpoint.

## Data and privacy

- Everything stays on this machine: stats are aggregated locally, and no usage, session content or account data is uploaded; there is no telemetry.
- Update checks only look up the latest version and never upload usage.

## Install and update

- Install `@xfqz86/dsh-usage-stats` from the DSH plugin page, or run `dsh plugin --profile web add @xfqz86/dsh-usage-stats`.
- When About finds a newer version, upgrade in place and restart DSH once.
- Uninstall with `dsh plugin --profile web remove @xfqz86/dsh-usage-stats`.

Full install options and developer docs: [GitHub repository](https://github.com/xfqz86/dsh-usage-stats).
