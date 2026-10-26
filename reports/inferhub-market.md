# InferHub market snapshot

Generated 2026-10-26T06:18:49.991Z from a live read of `/api/catalog`, `/api/market` and `/api/status`.

- Model rows in catalog: **270**
- With at least one live provider: **226**
- Usable (live + routable + priced): **199**
- Usable with a reported success rate: **92**
- Hidden by default: **71**
- Upstream families: **21**
- Platform pricing: max ask 0.5% of official, fee 0.2%, publisher share 80%

Prices are USD per million tokens. "Sustainable" is the cheapest tier with at
least 2 providers behind it — the absolute cheapest ask is often a single
provider.

The same underlying model is priced differently per upstream, so every row is
scoped to the upstream in its id. `deepseek-v4.1-flash` ranges from $0.0001 on
`cb` to $0.0563 on `ocg`, a ~375x spread, which is why a single global
"cheapest" figure is not meaningful.

## 1. Cheapest first

Top 50 by input price.

| Model | Input | Output | Sustainable | Discount | Live |
| --- | --- | --- | --- | --- | --- |
| `cb/deepseek-v4.1-flash` | $0.0001 | $0.0006 | $0.0001 | −99.9% | 9957 |
| `mm/MiniMax-M3.1-Flash` | $0.0001 | $0.0006 | $0.0001 | −99.9% | 5 |
| `mm/MiniMax-M3.1-Flash-Preview` | $0.0001 | $0.0006 | $0.0001 | −99.9% | 5 |
| `ali/deepseek-v4.1-flash` | $0.0001 | $0.0006 | $0.0001 | −99.9% | 1561 |
| `ali/deepseek-v4.1-flash-1017` | $0.0001 | $0.0006 | $0.0001 | −99.9% | 5837 |
| `ali/qwen3.8-flash` | $0.0001 | $0.0005 | $0.0001 | −99.9% | 1514 |
| `ali/qwen3.8-omni-flash` | $0.0001 | $0.0005 | $0.0001 | −99.9% | 8840 |
| `alicn/deepseek-v4.1-flash` | $0.0001 | $0.0006 | $0.0001 | −99.9% | 3 |
| `alicn/deepseek-v4.1-flash-1017` | $0.0001 | $0.0006 | $0.0001 | −99.9% | 3 |
| `alicn/qwen3.8-flash` | $0.0001 | $0.0005 | $0.0001 | −99.9% | 3 |
| `alicn/qwen3.8-omni-flash` | $0.0001 | $0.0005 | $0.0001 | −99.9% | 3 |
| `zai/glm-5.3-flash` | $0.0001 | $0.0005 | $0.0001 | −99.9% | 75 |
| `ali/deepseek-v4-flash-0731` | $0.0002 | $0.0007 | $0.0002 | −99.9% | 1000 |
| `alicn/deepseek-v4-flash-0731` | $0.0002 | $0.0007 | $0.0002 | −99.9% | 3 |
| `mm/MiniMax-M2` | $0.0003 | $0.0012 | $0.0003 | −99.9% | 5 |
| `mm/MiniMax-M2.1` | $0.0003 | $0.0012 | $0.0003 | −99.9% | 5 |
| `mm/MiniMax-M2.5` | $0.0003 | $0.0012 | $0.0003 | −99.9% | 5 |
| `mm/MiniMax-M2.7` | $0.0003 | $0.0012 | $0.0003 | −99.9% | 5 |
| `mm/MiniMax-M3` | $0.0003 | $0.0012 | $0.0003 | −99.9% | 5 |
| `zai/glm-4.6v` | $0.0003 | $0.0009 | $0.0003 | −99.9% | 81 |
| `ali/qwen3.8-27b` | $0.0005 | $0.0030 | $0.0005 | −99.9% | 12339 |
| `mm/MiniMax-M2.1-highspeed` | $0.0006 | $0.0024 | $0.0006 | −99.9% | 5 |
| `mm/MiniMax-M2.5-highspeed` | $0.0006 | $0.0024 | $0.0006 | −99.9% | 5 |
| `mm/MiniMax-M2.7-highspeed` | $0.0006 | $0.0024 | $0.0006 | −99.9% | 5 |
| `ali/deepseek-v4-pro-0813` | $0.0007 | $0.0020 | $0.0007 | −99.9% | 2360 |
| `alicn/deepseek-v4-pro-0813` | $0.0007 | $0.0020 | $0.0007 | −99.9% | 3 |
| `ali/kimi-k2.7-code` | $0.0009 | $0.0040 | $0.0009 | −99.9% | 1406 |
| `alicn/kimi-k2.6` | $0.0009 | $0.0040 | $0.0009 | −99.9% | 3 |
| `alicn/kimi-k2.7-code` | $0.0009 | $0.0040 | $0.0009 | −99.9% | 3 |
| `cb/hy3` | $0.0011 | $0.0046 | $0.0011 | −99.2% | 16195 |
| `cb/glm-5.3-flash` | $0.0012 | $0.0040 | $0.0012 | −99.2% | 6740 |
| `cb/minimax-m3.1-flash` | $0.0012 | $0.0048 | $0.0012 | −99.2% | 16208 |
| `ali/glm-5.2` | $0.0014 | $0.0044 | $0.0014 | −99.9% | 1406 |
| `ali/glm-5.3` | $0.0014 | $0.0044 | $0.0014 | −99.9% | 9104 |
| `alicn/glm-5.2` | $0.0014 | $0.0044 | $0.0014 | −99.9% | 3 |
| `alicn/glm-5.3` | $0.0014 | $0.0044 | $0.0014 | −99.9% | 3 |
| `zai/glm-5.3` | $0.0014 | $0.0044 | $0.0014 | −99.9% | 75 |
| `mai/muse-spark-1.2-contributor` | $0.0020 | $0.0040 | $0.0020 | −98% | 135 |
| `mai/muse-spark-1.3-contributor` | $0.0020 | $0.0040 | $0.0020 | −98% | 135 |
| `ali/qwen3.8-2.4t-a95b` | $0.0020 | $0.0060 | $0.0020 | −99.9% | 20087 |
| `ali/qwen3.8-max` | $0.0020 | $0.0060 | $0.0020 | −99.9% | 6697 |
| `ali/qwen3.8-max-0902` | $0.0020 | $0.0060 | $0.0020 | −99.9% | 8840 |
| `alicn/qwen3.8-max` | $0.0020 | $0.0060 | $0.0020 | −99.9% | 3 |
| `alicn/qwen3.8-max-0902` | $0.0020 | $0.0060 | $0.0020 | −99.9% | 3 |
| `cb/gemini-2.5-flash-image` | $0.0024 | $0.2400 | $0.0024 | −99.2% | 6740 |
| `cb/minimax-m3` | $0.0024 | $0.0096 | $0.0024 | −99.2% | 16208 |
| `ag/claude-sonnet-4-6` | $0.0030 | $0.0150 | $0.0030 | −99.9% | 1396 |
| `ali/kimi-k3` | $0.0030 | $0.0150 | $0.0030 | −99.9% | 5287 |
| `alicn/kimi-k3` | $0.0030 | $0.0150 | $0.0030 | −99.9% | 3 |
| `cbcn/hy3` | $0.0036 | $0.0151 | $0.0036 | −97.4% | 669 |

## 2. Most available first

Top 50 by live provider count. Tiers is how many distinct prices are on
offer, so a model served by many providers at many prices ranks highly.

| Model | Live providers | Tiers | State | 24h | 7d | Input |
| --- | --- | --- | --- | --- | --- | --- |
| `ali/qwen3.8-2.4t-a95b` | 20087 | 10 | operational | 99.97% | 99.69% | $0.0020 |
| `cb/kimi-k2.5` | 16306 | 32 | operational | 99.76% | 99.84% | $0.0048 |
| `cb/kimi-k2.6` | 16209 | 30 | operational | 99.76% | 99.84% | $0.0076 |
| `cb/kimi-k2.7` | 16209 | 30 | operational | 99.76% | 99.84% | $0.0076 |
| `cb/kimi-k2.8-preview` | 16209 | 30 | operational | 99.76% | 99.84% | $0.0076 |
| `cb/minimax-m3` | 16208 | 32 | operational | 99.76% | 99.84% | $0.0024 |
| `cb/minimax-m3.1-flash` | 16208 | 32 | operational | 99.76% | 99.84% | $0.0012 |
| `cb/hy3` | 16195 | 30 | operational | 99.76% | 99.84% | $0.0011 |
| `cb/hy4-preview` | 16195 | 30 | operational | 99.76% | 99.84% | $0.0067 |
| `cb/kimi-k3` | 14640 | 30 | operational | 99.76% | 99.84% | $0.0240 |
| `cb/kimi-k3.1-pro` | 14640 | 30 | operational | 99.76% | 99.84% | $0.0160 |
| `ali/qwen3.8-27b` | 12339 | 11 | operational | 99.97% | 99.69% | $0.0005 |
| `cb/deepseek-v4.1-flash` | 9957 | 30 | operational | 99.76% | 99.84% | $0.0001 |
| `ali/glm-5.3` | 9104 | 11 | operational | 99.97% | 99.69% | $0.0014 |
| `ali/qwen3.8-max-0902` | 8840 | 13 | operational | 99.97% | 99.69% | $0.0020 |
| `ali/qwen3.8-omni-flash` | 8840 | 11 | operational | 99.97% | 99.69% | $0.0001 |
| `cb/claude-opus-4.6` | 6740 | 32 | operational | 99.76% | 99.84% | $0.0400 |
| `cb/claude-opus-4.7-1m` | 6740 | 31 | operational | 99.76% | 99.84% | $0.0400 |
| `cb/gemini-2.5-flash-image` | 6740 | 31 | operational | 99.76% | 99.84% | $0.0024 |
| `cb/gemini-3.1-pro` | 6740 | 31 | operational | 99.76% | 99.84% | $0.0160 |
| `cb/glm-5.2` | 6740 | 31 | operational | 99.76% | 99.84% | $0.0112 |
| `cb/glm-5.3` | 6740 | 31 | operational | 99.76% | 99.84% | $0.0112 |
| `cb/glm-5.3-flash` | 6740 | 31 | operational | 99.76% | 99.84% | $0.0012 |
| `cb/gpt-5.3-codex` | 6740 | 31 | operational | 99.76% | 99.84% | $0.0140 |
| `ali/qwen3.8-max` | 6697 | 10 | operational | 99.97% | 99.69% | $0.0020 |
| `ali/deepseek-v4.1-flash-1017` | 5837 | 5 | operational | 99.97% | 99.69% | $0.0001 |
| `ali/kimi-k3` | 5287 | 9 | operational | 99.97% | 99.69% | $0.0030 |
| `ali/deepseek-v4-pro-0813` | 2360 | 10 | operational | 99.97% | 99.69% | $0.0007 |
| `ali/deepseek-v4.1-flash` | 1561 | 8 | operational | 99.97% | 99.69% | $0.0001 |
| `ali/qwen3.8-flash` | 1514 | 6 | operational | 99.97% | 99.69% | $0.0001 |
| `ali/glm-5.2` | 1406 | 8 | operational | 99.97% | 99.69% | $0.0014 |
| `ali/kimi-k2.7-code` | 1406 | 7 | operational | 99.97% | 99.69% | $0.0009 |
| `ag/claude-sonnet-4-6` | 1396 | 27 | operational | 99.74% | 92.2% | $0.0030 |
| `ag/claude-opus-4-6-thinking` | 1388 | 26 | operational | 99.74% | 92.2% | $0.0050 |
| `ag/gemini-3.8-flash-high` | 1293 | 36 | operational | 99.74% | 92.2% | $0.0053 |
| `cbcn/minimax-m3.1-flash` | 1237 | 12 | operational | 99.98% | 99.98% | $0.0039 |
| `cbcn/kimi-k3.1-pro` | 1234 | 15 | operational | 99.98% | 99.98% | $0.0520 |
| `cbcn/deepseek-v4-flash` | 1226 | 15 | operational | 99.98% | 99.98% | $0.0057 |
| `cbcn/deepseek-v4-pro` | 1226 | 15 | operational | 99.98% | 99.98% | $0.0172 |
| `cbcn/glm-5.2` | 1226 | 15 | operational | 99.98% | 99.98% | $0.0364 |
| `cbcn/glm-5.3-flash` | 1226 | 14 | operational | 99.98% | 99.98% | $0.0039 |
| `cbcn/kimi-k3` | 1226 | 15 | operational | 99.98% | 99.98% | $0.0780 |
| `cbcn/minimax-m3` | 1226 | 13 | operational | 99.98% | 99.98% | $0.0078 |
| `cbcn/glm-5.3` | 1225 | 15 | operational | 99.98% | 99.98% | $0.0364 |
| `cbcn/deepseek-v4.1-flash` | 1205 | 15 | operational | 99.98% | 99.98% | $0.0039 |
| `ali/deepseek-v4-flash-0731` | 1000 | 3 | operational | 99.97% | 99.69% | $0.0002 |
| `cbcn/kimi-k2.6` | 680 | 13 | operational | 99.98% | 99.98% | $0.0247 |
| `cbcn/kimi-k2.7` | 680 | 13 | operational | 99.98% | 99.98% | $0.0247 |
| `cbcn/minimax-m2.7` | 680 | 12 | operational | 99.98% | 99.98% | $0.0078 |
| `cbcn/glm-5.1` | 669 | 15 | operational | 99.98% | 99.98% | $0.0364 |

## 3. Highest quality first

Top 50 by success rate, then fastest time-to-first-token.

Only 92 of 199 usable models have a reported rate: InferHub publishes per-model
health above its own volume floors (10 requests, 3 perf
samples in a 30-minute window). A blank figure is **unverified**,
not failing — nulls sort last.

| Model | Success | Ttft | TPS | Live | Input |
| --- | --- | --- | --- | --- | --- |
| `ag/claude-opus-4-6-thinking` | 100% | 4253ms | 26.9 | 1388 | $0.0050 |
| `ag/gemini-4-argon` | 100% | 19335ms | 36.7 | 5 | $0.1800 |
| `cc/claude-fable-5-1` | 100% | 3645ms | 46.7 | 35 | $0.8900 |
| `cc/claude-haiku-4-5` | 100% | 3626ms | 48.2 | 6 | $0.2400 |
| `cc/claude-haiku-5-5` | 100% | 5275ms | 142.5 | 38 | $0.0098 |
| `cc/claude-opus-4-5` | 100% | 2841ms | 23.8 | 38 | $0.4500 |
| `cc/claude-opus-5` | 100% | 2895ms | 18.1 | 38 | $0.4500 |
| `cc/claude-sonnet-5` | 100% | 2923ms | 57.4 | 38 | $0.2000 |
| `cc/claude-sonnet-5-5` | 100% | 5506ms | 37.3 | 38 | $0.1940 |
| `cbcn/deepseek-v4-flash` | 100% | 5444ms | 72.2 | 1226 | $0.0057 |
| `cbcn/deepseek-v4-pro` | 100% | 9529ms | 33.8 | 1226 | $0.0172 |
| `cbcn/deepseek-v4.1-flash` | 100% | 5455ms | 84.9 | 1205 | $0.0039 |
| `cbcn/glm-5.3-flash` | 100% | 7482ms | 26.4 | 1226 | $0.0039 |
| `cbcn/hy4-preview` | 100% | 2839ms | 0.6 | 669 | $0.0217 |
| `cbcn/kimi-k2.6` | 100% | 3500ms | 17.8 | 680 | $0.0247 |
| `cbcn/kimi-k2.8-preview` | 100% | 8627ms | 29.5 | 669 | $0.0247 |
| `cbcn/kimi-k3.1-pro` | 100% | 23121ms | 16.2 | 1234 | $0.0520 |
| `cbcn/minimax-m3` | 100% | 5881ms | 25.2 | 1226 | $0.0078 |
| `cbcn/minimax-m3.1-flash` | 100% | 5436ms | 45.8 | 1237 | $0.0039 |
| `cmc/deepseek/deepseek-v4-pro` | 100% | 20732ms | 41.4 | 7 | $0.2640 |
| `cmc/gpt-6-luna` | 100% | 8552ms | 30 | 7 | $0.0400 |
| `cmc/moonshotai/Kimi-K3.1-Pro` | 100% | 30449ms | 22.6 | 7 | $0.8000 |
| `grok/grok-4.5` | 100% | 3268ms | 25.4 | 9 | $0.0160 |
| `grok/grok-4.7` | 100% | 3680ms | 32.6 | 9 | $0.0160 |
| `kiro/gpt-5.6-luna` | 100% | 23029ms | 47.5 | 16 | $0.0298 |
| `mai/muse-spark-1.2` | 100% | 2725ms | 23 | 135 | $0.0125 |
| `mai/muse-spark-1.3-contributor` | 100% | 16413ms | 77.8 | 135 | $0.0020 |
| `mai/muse-wonder-1.0` | 100% | 4705ms | 62 | 135 | $0.0400 |
| `mm/MiniMax-M2.5` | 100% | 3706ms | 80.9 | 5 | $0.0003 |
| `mm/MiniMax-M3` | 100% | 3854ms | 59.4 | 5 | $0.0003 |
| `mm/MiniMax-M3.1-Flash` | 100% | 4300ms | 64 | 5 | $0.0001 |
| `mm/MiniMax-M3.1-Flash-Preview` | 100% | 5218ms | 56.5 | 5 | $0.0001 |
| `cx/gpt-5.6-terra` | 100% | 2249ms | 11.2 | 3 | $0.2400 |
| `cx/gpt-6-astra` | 100% | 10095ms | 12.5 | 3 | $1.9500 |
| `ocg/deepseek-v4-flash` | 100% | 6222ms | 81.8 | 4 | $0.0876 |
| `ocg/deepseek-v4.1-flash` | 100% | 3019ms | 62.1 | 4 | $0.0563 |
| `ocg/glm-5.3-flash` | 100% | 2795ms | 43.9 | 4 | $0.0597 |
| `ali/deepseek-v4-pro-0813` | 100% | 7039ms | 31.6 | 2360 | $0.0007 |
| `ali/deepseek-v4.1-flash` | 100% | 7733ms | 56.2 | 1561 | $0.0001 |
| `ali/deepseek-v4.1-flash-1017` | 100% | 3820ms | 71 | 5837 | $0.0001 |
| `ali/glm-5.2` | 100% | 19409ms | 30.8 | 1406 | $0.0014 |
| `ali/glm-5.3` | 100% | 4332ms | 37.9 | 9104 | $0.0014 |
| `ali/kimi-k2.7-code` | 100% | 2103ms | 37.5 | 1406 | $0.0009 |
| `ali/kimi-k3` | 100% | 5114ms | 27.1 | 5287 | $0.0030 |
| `ali/qwen3.8-27b` | 100% | 6676ms | 37.7 | 12339 | $0.0005 |
| `ali/qwen3.8-flash` | 100% | 4138ms | 47.7 | 1514 | $0.0001 |
| `ali/qwen3.8-max` | 100% | 6109ms | 26.3 | 6697 | $0.0020 |
| `ali/qwen3.8-omni-flash` | 100% | 9410ms | 65 | 8840 | $0.0001 |
| `alicn/deepseek-v4-pro-0813` | 100% | 53344ms | 7 | 3 | $0.0007 |
| `alicn/deepseek-v4.1-flash` | 100% | 70341ms | 18.5 | 3 | $0.0001 |
