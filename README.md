# PNG-01 NETMON // RX-09 INDUSTRIAL HUD

Desktop internet speed test + connection monitor with a reactive robot mascot.
Electron · Windows-first · no admin rights needed.

## RUN

```bat
cd png01-netmon
npm install
npm start
```

## BUILD A PORTABLE .EXE

```bat
npm run dist          :: dist\PNG-01 NetMon 0.1.0.exe  (portable, no install)
npm run dist:setup    :: NSIS installer instead
```

> Corporate proxy? If `npm install` stalls while downloading Electron:
> `npm config set proxy http://PROXY:PORT` and `npm config set https-proxy http://PROXY:PORT`.

## MODULES

| //  | VIEW          | WHAT IT DOES |
|-----|---------------|--------------|
| 01  | DASH          | Speed test (download / upload / ping / jitter), live gauge, mascot mood, link status, live RX/TX |
| 02  | MONITOR       | Probes WAN target + gateway every N s, latency trace, 24 h outage timeline, outage log |
| 03  | SERVERS       | Watchlist: ICMP ping or TCP port probe every 30 s, uptime %, sparkline, down/up alerts |
| 04  | CONNECTIONS   | Established TCP connections grouped by process (`Get-NetTCPConnection`) |
| 05  | LOG           | Test history chart + table, baseline, CSV export |
| 06  | CONFIG        | Target, probe port, interval, auto-test, thresholds, alerts, close-to-tray |

## MASCOT STATES

| STATE    | TRIGGER |
|----------|---------|
| FAST     | Last test > 110% of baseline |
| NOMINAL  | Normal range |
| SLOW     | Last test < SLOW % of baseline (default 30%), or avg latency > 150 ms |
| UNSTABLE | Loss > 10% or jitter > 30 ms over last 20 probes |
| OFFLINE  | 3 failed probes in a row |
| TESTING  | Speed test running |

Baseline = median of the last 10 tests (needs 3+).

## FAULT DIAGNOSIS (DASH → DIAG)

- Gateway answers, internet doesn't → `UPSTREAM FAULT` (ISP / VPN side)
- Gateway also silent → `LOCAL LINK FAULT` (Wi-Fi / cable)
- Pings fail but a speed test just worked → `ICMP MAY BE BLOCKED` → set **PROBE PORT = 443** in CONFIG

## NOTES

- Speed test uses `speed.cloudflare.com` through Chromium's network stack, so the Windows/corporate proxy is honoured.
  If that host is blocked, the test fails with a CAUTION toast; monitoring still works.
- Speed results include VPN overhead when the VPN is up. Each record is tagged `VPN [X]` so you can compare.
- Internal servers (10.x) only respond while the VPN is connected.
- CPU-light: link info refreshes every 20 s and RX/TX every 2 s **only while the window is visible**.
- Per-app *bandwidth* is not included (needs ETW tracing + admin). The connections view shows per-app connection counts.
- Data: `%APPDATA%\png01-netmon\` → `settings.json`, `history.json`, `events.json`.

---
BRAND: RX-09 / MODEL: PNG-01 · BUILT TO WIN, BORN TO PING.
