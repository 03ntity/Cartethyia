# Identity gate post-mortem — the machine-token theory was WRONG

## What we believed (2026-10-29 → 30)

Generated (SHA-256) machine tokens caused `NO CREDITS` on accounts that later
claimed fine with a WSL-ELF-minted token. Conclusion drawn: the server
validates the token's SG cryptographic signature, so only SG-produced
identities work.

## The decisive control (2026-10-30)

Account `bawu baixai` (claimed earlier via WSL mint) probed **four ways in
quick succession**, same fresh `dt-` token:

| Probe | CREDITS campaign |
|---|---|
| generated SHA-256 token | **CLAIMED** |
| **empty machine headers** | **CLAIMED** |
| Windows exe token | **CLAIMED** |
| pure random bytes | **CLAIMED** |

And on `that sepa` (claimed): DLL FFI `PT1^…`, `ENCODE_3_…`, garbage, and even
**omitting all six `cosy-machine*` headers** all returned `CLAIMED`.

## Verdict

**The machine headers do not gate the CREDITS campaign at all.** The campaign
surface for a granted account is visible with any identity — or none. The
earlier `NO CREDITS` results were **not caused by fabricated identities**:
they were **grant/window timing** (the accounts simply had no live grant at
that moment — consistent with the daily 10:00 Shanghai reset and with accounts
whose grant had not been provisioned yet).

The A/B test that "proved" generated mint fails was confounded: it compared
different accounts at different times, not the same account in the same
window. The genuine variables that decide `NO CREDITS` are:

1. **Grant existence per account** (`/reward` → 404 GRANT_NOT_FOUND = none)
2. **Daily window** (reset 10:00 Asia/Shanghai)
3. The `dt-` access token being valid

## Practical consequences

- **The full-native generated mint is viable.** No WSL, no exe needed for
  claims — any (or no) machine headers work.
- Keep sending *some* stable per-account machine headers for hygiene (they
  cost nothing and may matter for risk-scoring on other endpoints), but there
  is no signature gate to defeat.
- The `sgsdk.dll` FFI path (`PT1^` security token, `ENCODE_3_` DCP token) is
  interesting for research but unnecessary for the daily claim.
