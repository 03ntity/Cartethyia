# TuringShield SDK (vendor)

Proprietary native SDK extracted from the **WorkBuddy AI desktop app**
(5.8.4) — `resources/app.asar.unpacked/native/turing-sdk/build/Release/`.
Copyright/ownership: Tencent (T-Sec TuringShield). Redistribution is not
granted by this repository's license; these files are vendored for runtime
integration with the buddy providers and must not be redistributed separately.

Files:
- `build/Release/turing_sdk.node` — N-API addon (wrapper; loads the DLL via
  `createTSObject`).
- `build/Release/TuringShieldSDK.dll` — the TuringShield engine (JCE V3,
  XXTEA/AES/RSA, device fingerprint collection, WinHTTP transport).
- `build/Release/turing-sdk-variant.json` — `{"variant":"overseas"}`.

Runtime role: `src/providers/integrations/buddy/turing-device-token.ts` loads
this bundle by default (no env needed). `CARTETHYIA_TURING_SDK_PATH` can point
a different copy.
