# Eksperimente të vjetra — transport "sound" dhe dekodues i huaj optik

**Nuk përdoren nga aplikacioni. Asnjë skedar këtu nuk importohet nga `src/`.**

Janë arkivuar më 2026-09-28 gjatë pastrimit pas integrimit të ura optike
Drita → LTDecoder. Janë lënë këtu (jo fshirë) sepse ishin të palanduar në git.

Arsyet e arkivimit:

| Skedar | Arsyeja |
|---|---|
| `SoundTransferService.ts` | Përdor Web Audio API (`AudioContext`, `createBuffer`) — nuk ekziston në React Native. |
| `soundProtocol.ts` | Protokoll akustik FSK, i varur nga service-i i më sipërm. |
| `SoundScreen.tsx` | Ekran i paplot: i ndërprea te `saveReceivedFile` (pa JSX/`export default`). Me Web Audio. |
| `OpticalFrameReceiver.ts` | Kontrollues hibrid i vjetër optik; përdor `localStorage`/`Blob`/`document` (web-only). Zëvendësohet nga `src/services/OpticalTransferService.ts` + `OpticalBridge.ts`. |

Rruga aktive për të arritur ekzaminime është:

- **Optik (QR)** → `LightScanActivity` → `OpticalBridge.drainAndDecodeOpticalFrames` → `ingestOpticalFrame`
- **Optik (kodim LX)** → `DecimenSenderActivity`
- **TCP/WiFi nga P50** → `TcpConnectionService` + `framing.ts` (ende i pakonfirmuar me byte-capture reale)

Nëse ndonjë ditë doni t'i riktheni: kopjojeni prapa në `src/` dhe hiqni
`"experiments"` nga `exclude` te `tsconfig.json`.
