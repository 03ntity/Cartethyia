# Qoder UMID reverse — session findings (2026-10-30)

Follow-up to `documentation/research/qoder-daily-credit-campaign.md`. This
documents the deep-dive into the identity binaries and settles which native
paths are viable.

## Components identified

| Binary | Role | Identity source |
|---|---|---|
| `runtime-info.exe` (Windows PE, Rust host) | thin host: loads `sgsdk.dll`, calls `initUMID` → `getSecurityToken` (+ `setActiveAccount`), does VM scoring locally, prints JSON | **hardware-derived, one per machine, stateless** |
| `sgsdk.dll` (7.3 MB, **signed ALIBABA CHINA NETWORK TECHNOLOGY**) | Alibaba SecurityGuard SDK: the actual UMID/SG engine; dynamic API resolution, encrypted state | machine-bound |
| `runtime-info` (Linux ELF, same Rust host) | same host pattern for Linux; collector reads `/sys`, `/proc`, `dmidecode`, `hdparm`, `lshw` | **seed file** (`~/.config/.locale_cfg`) |

Key strings recovered from the ELF:
- Cookie/seed keys **hardcoded** in the binary (obfuscated table, `.` delimited):
  `yooVto7srhDgkOv6`, `FAvgcHncgkVhZ4vC`, timestamp key `bdb13dc551d3db53`.
- Endpoints: `https://umid.daily.alibaba.net/repPc.json` (+ pre-prod/alt hosts),
  query `%s?e=%d&pn=%s&os=%d&sv=%s&pv=%s&pt=%d`, version `1.5.0`.
- Collectors: `/sys/class/dmi/id/*` (board/bios/product/sys vendor),
  `/proc/cpuinfo` flags, `/sys/class/net/*/address` (MAC),
  `dmidecode -t 4` (CPU ID), `-t baseboard` (Serial No),
  `hdparm -i` (disk serial), `lshw -class disk`,
  `/proc/sys/kernel/random/uuid`, `/dev/zero`, `xxh64`.
- VM detection (ELF, host-side): DMI vendors, cgroup (`docker/lxc/containerd`),
  `/proc/cpuinfo` hypervisor flag, vboxguest/vmci/vmbus modules,
  `/sys/hypervisor/type` — with a *scored* verdict ("weak indicators",
  "strong single indicator").

## Experimental results

1. **Seed → token is deterministic and offline.** Same seed ⇒ same token
   (T1==T2==T4). One-byte seed change ⇒ different token (T3). Timestamp field
   does not affect the token (T5).
2. **Fresh random seeds produce valid-shaped tokens.** A brand-new seed with
   random keys and random base64-ish values yields a `P1gA`-prefixed,
   88-char token (A/B tests). Seed farming offline works.
3. **The Windows exe ignores `~/.config/.locale_cfg`** (leaves it untouched).
4. **The Windows exe is stateless on disk** — no state file appears anywhere
   (scanned user dirs, ProgramData, Public, registry HKCU/HKLM). Token is a
   pure function of the machine's hardware.
5. **`--account-stdin`/`setActiveAccount` does NOT derive per-account tokens**
   on Windows: the token stayed constant across accounts (after a one-time
   re-derivation on first account feed, it locked).
6. **The ELF equally ignores the account argument** — token follows the seed,
   not the account.

## Server-side verdicts (live probes)

- **A fabricated (SHA-256) token is rejected** — campaign CREDITS entry does
  not appear for accounts that have a grant. Shape-mimicking is not enough;
  the token must be SG-produced.
- **The Windows machine token IS accepted by the server.** Probing with the
  exe's `P1gAl67j…`/`P1gAmKAP…` token showed the CREDITS campaign for an
  account that holds a grant. `vmInfo.isVm` is local-only output — the
  server never sees it. The earlier "VM tokens are rejected" assumption was
  wrong; the *real* rejection reason for SHA-256 tokens was fabrication.

## Architecture conclusion

- **Per-machine native identity:** fully solved on Windows via
  `runtime-info.exe` (or FFI into `sgsdk.dll`).
- **Per-account identities:** only the **ELF + seed file** mechanism provides
  them. One seed = one device identity; seeds can be farmed offline and
  replayed deterministically. This requires a Linux userspace for the ELF
  (WSL today).
- Reimplementing seed→token in pure JS would require breaking the SG crypto
  (out of scope); running the ELF without WSL would require a bundled Linux
  runtime.

## Practical recipe (final)

1. Mint per-account seeds (fresh `rm seed → ELF 3`) — one per account, store
   the seed bytes with the account.
2. Replay a stored seed to re-derive its token at claim time.
3. Claim with the six `cosy-machine*` headers carrying that token.
4. Ignore `vmInfo` entirely — it is not sent and does not affect acceptance.
