# ◆ truddy

**Your trading buddy. Lives in your terminal, watches your coins, and yells when something smells like a rug.**

```
$ truddy moondog                                  (example output, fictional token)

╭────────────────────────────────────────────────────────────────╮
│  $MOONDOG  Moon Dog  ·  Solana  ·  raydium   RISK 78 █████████░░ │
│  $0.0₄4120    ▼ 38.2% 1h   ▼ 61.0% 24h                ● DANGER  │
╰────────────────────────────────────────────────────────────────╯
  DANGER  —  Severe red flags, consistent with a rug or honeypot.
    ✗ Freeze authority is LIVE — your tokens can be frozen
    ✗ X account @moondog_sol not found — deleted, suspended or renamed
    ! Heavy selling: 412 sells vs 61 buys in the last hour
    ! Young token: only 3h 12m old
```

Zero dependencies. No API keys. No accounts. Works in Windows Terminal, PowerShell, iTerm, VS Code, tmux, anything.

## Install

```bash
npm i -g github:Radardotfun/truddy
```

or run it once without installing:

```bash
npx github:Radardotfun/truddy bonk
```

Needs Node.js 18.17+.

## What it does

| | |
|---|---|
| **Safety scan** | `truddy <ticker \| name \| contract>` checks mint/freeze authority, honeypot, taxes, hidden owners, proxies, LP lock, holder concentration and RugCheck risks, then scores the coin from 0 to 100. |
| **Copycat guard** | Tickers resolve to the CoinGecko-listed contract when one exists, so a fake `$PEPE` with the same ticker doesn't fool you. truddy also tells you how many copycats exist. |
| **X account watch** | Is the project's X account still alive? How old is it? Are the latest posts saying "hacked", "migration" or "new CA"? A deleted or suspended account fires a critical alert. |
| **Live alerts** | `truddy watch` pages you on liquidity pulls, sudden dumps, sell walls, contract changes, scary posts, new headlines and dead websites. |
| **News** | Coin-specific headlines, with red-flag words highlighted and paid "price prediction" fluff pushed to the bottom. |
| **Lives in your prompt** | `truddy init` puts your watchlist in every shell prompt, refreshed in the background. A red `!` means something critical happened in the last 30 minutes. |

## Commands

```
truddy <coin>                 full safety scan
truddy watch [coins…]         live dashboard + alerts (defaults to watchlist)
truddy watch <coin> --tail    log-style alerts for small panes / tmux
truddy x <coin|@handle>       is the X account alive? latest posts
truddy news [coin]            headlines for a coin, or the whole market
truddy add <coin>             add to watchlist
truddy rm <coin>              remove from watchlist
truddy list                   watchlist at a glance
truddy init [shell]           put truddy in your shell prompt
```

Flags: `--chain <id>` · `--interval <sec>` · `--notify` (desktop notification on critical alerts) · `--json` · `--no-color`

### In the dashboard

`←/→` switch coin · `r` refresh now · `s` save coin to watchlist · `q` quit

On critical alerts truddy rings the terminal bell, turns the Windows Terminal tab red, and (with `--notify`) sends a native desktop notification on Windows, macOS or Linux.

## Shell prompt

```bash
# bash  (~/.bashrc)
eval "$(truddy init bash)"

# zsh   (~/.zshrc)
eval "$(truddy init zsh)"

# fish  (~/.config/fish/config.fish)
truddy init fish | source
```

```powershell
# PowerShell ($PROFILE)
(& truddy init powershell) -join "`n" | Invoke-Expression
```

Starship users:

```toml
[custom.truddy]
command = "truddy prompt --shell plain"
when = true
```

## Data sources

All free and public: [DexScreener](https://dexscreener.com) (pools, liquidity, flow), [CoinGecko](https://coingecko.com) (listings, majors), [RugCheck](https://rugcheck.xyz) + [GoPlus](https://gopluslabs.io) (contract security, Solana + 14 EVM chains), [FxTwitter](https://github.com/FxEmbed/FxEmbed) (X profiles and posts) and Google News RSS.

truddy stores your watchlist in `~/.truddy` (override with `TRUDDY_HOME`). Nothing else is collected or sent anywhere.

## Disclaimer

truddy shows signals, not financial advice. A clean scan can't rule out a rug, and a scary one doesn't prove one. Do your own research.

MIT © Radardotfun
