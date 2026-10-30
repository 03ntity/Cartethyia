# Qoder UMID vendor directory

Native machine-identity material for the Qoder daily check-in campaign.
Everything here is extracted verbatim from the official `@qoder-ai/qodercli`
npm bundle — no recompilation, no patches.

## Layout

| Path | What |
|---|---|
| `umidpack/` | **The identity binaries, every supported OS/arch** (Linux x86-64 + arm64 ELF, macOS Intel + Apple Silicon Mach-O, Windows exe + sgsdk.dll). See `umidpack/README.md` for the per-platform playbook. This is what `src/providers/integrations/qoder/qoder-umid.ts` executes. |
| `qoder-umid-mini.tar.gz` | Linux x86-64 ELF + its eight glibc dependencies (~3.7 MB) — a WSL-importable / one-shot mini rootfs for hosts whose libraries do not match. See `MINI-BUNDLE.md`. |
| `README.md` | this file |

## Identity semantics (verified 2026-10-30)

- Identity is a deterministic function of the seed file
  `~/.config/.locale_cfg` (Linux/WSL/macOS): delete → fresh identity,
  restore → identical identity. One seed per account; the seed bytes live in
  `provider_accounts.native_identity.seed` and are replayed under a lock.
- The Windows exe ignores seed files — it is hardware-bound (one identity per
  machine). Still a genuine SG identity.
- `vmInfo` (isVm/brand) is local-only output; only the six `cosy-machine*`
  headers travel upstream, and the campaign gate keys on the token being
  SG-produced — not on the VM flag.

## Historical note

The generated-mint path (deterministic SHA-256 tokens shaped like the bridge
output) was retired on 2026-10-30: a live control proved it does not surface
the daily CREDITS grant on fresh accounts, while the genuine bridge does.
See `documentation/research/qoder-umid-reverse.md` and
`qoder-identity-gate-postmortem.md` for the full record.
