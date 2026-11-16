# IQ Option experimental connector (read-only)

This is a **working implementation of a local connection probe**, not a verified working connection to IQ Option. It has not been tested against your account or live servers. The community library is unofficial and may be broken or prohibited by the broker. The original project warns against real-account use: https://github.com/iqoptionapi/iqoptionapi .

## Setup (run on your own computer or private VPS, never in a public website)

1. Install Python 3.10+ and create a virtual environment.
2. Review the community library source before installing it. If you accept the risks, install from its repository (installation instructions in its README).
3. Run `python connector/iqoption_probe.py --environment PRACTICE --candles` from the project root. Enter credentials **only into your own local terminal**; don't share them in chat, commit them, or paste them into the web UI.
4. If the login fails or asks for 2FA, stop. Do not disable 2FA or bypass account protections.

Real-account **read-only** inspection is locked unless the environment variable `NOVATRADE_ALLOW_REAL_READONLY=YES` is set. This does **not** enable real-money trading. No buy/sell function is present in this probe.

## What's still required

- Test compatibility and broker permission, including jurisdiction eligibility.
- Use secure delegated authentication if broker offers it; avoid handling credentials in hosted UI.
- Validate data timestamps, asset availability, reconnects, errors and order acknowledgements.
- Only then implement separate trade execution with explicit user consent, per-trade and daily caps, and emergency stop. Never assume profitable or error-free trades.
