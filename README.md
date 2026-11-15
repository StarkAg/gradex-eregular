# GradeX E-Regular

Submit your SRM **e-Curricula ("e-regular")** worksheets and in-portal questions
from **your own laptop**.

SRM's e-Curricula portal blocks GradeX's servers by IP, so the website can only
submit from a phone on your own network. This little tool is the laptop version:
**your computer makes the SRM calls, GradeX does all the solving**. Your SRM
password and the 6-digit authenticator codes go straight to SRM for one call each
and are **never saved to disk or sent anywhere else**.

What it does, for each unit you pick:

1. signs you in to e-Curricula,
2. lists your enrolled subjects,
3. generates the solved worksheets on GradeX,
4. submits their answer links to the portal,
5. (optional) auto-completes the in-portal MCQ / skill questions.

---

## 1. Requirements

- **Node.js 18 or newer** — check with `node -v`. Install from <https://nodejs.org> if you don't have it.
- No `npm install` needed. The tool uses only built-in Node.

## 2. Get your GradeX account token

1. Open **https://gradex.bond** in a browser and sign in to GradeX as usual.
2. Open the browser **DevTools console** (F12 → *Console*).
3. Paste this and press Enter:
   ```js
   localStorage.getItem('gradex_access_token') || localStorage.getItem('gradex_token')
   ```
4. Copy the long string it prints (without the quotes). That's your token.

The token identifies your GradeX account. Keep it private; anyone with it can act
as you on GradeX.

## 3. Run it

From this folder:

```bash
node gradex-eregular.mjs
```

It will ask for, in order:

| Prompt | What to enter |
|---|---|
| **GradeX base URL** | Press Enter to accept `https://gradex.bond`. |
| **GradeX account token** | The token from step 2. |
| **SRM registration number** | e.g. `RA23...` |
| **Your full name** | Printed on the generated worksheets. |
| **SRM password** | Your e-Curricula / Academia password. Sent to SRM only. |
| **Authenticator code** | The current **6-digit** code from your SRM authenticator app, when asked. |

Then pick a subject, pick the unit(s) (`1`, or `1-3`, or `all`), and choose
whether to also auto-complete the in-portal MCQ / skill questions.

### About the 6-digit codes

Since SRM's November 2026 change, **every submission needs a fresh authenticator
code**. One code works for a few writes within its ~30-second window; when SRM
asks again the tool will prompt you — **wait for your authenticator to roll to the
next code**, then type it.

---

## 4. One-time setup by the GradeX owner (required)

The submit step needs the account to be a **Mark member** with E-Curricula units
unlocked. The owner grants this in one command (no deploy), replacing the RA and
the service key:

```bash
npx convex run --prod foundersGiftGrants:grant \
  '{"serviceKey":"<SERVICE_KEY>","registrationNumber":"RA23..."}'
```

That gives the full founder's gift: **every E-Curricula unit free + lifetime Mark
membership**, so generation and submission both work. Without it:

- worksheet **generation** works only for free units (1 and 2),
- **submission** returns `mark-required` and stops.

Remove later with `foundersGiftGrants:revoke` (same args minus the reason).

---

## What this does NOT do

- It never stores your SRM password or codes — they live only in memory for the
  single call that uses them.
- It only ever talks to `gradex.bond` and SRM's own hosts
  (`sp.srmist.edu.in`, `dld.srmist.edu.in`).
- It can only write to **your own** e-Curricula account (GradeX derives the reg
  number from your token server-side).

## Troubleshooting

| Message | Meaning / fix |
|---|---|
| `mark-required` | The owner hasn't granted founder's-gift for your RA yet (section 4). |
| `Unit N needs payment` | That unit is past the free allowance and the account isn't granted. |
| `srm-email-required` / "verify your email" | Open e-Curricula → **My Profile** and verify an email, then re-run. |
| `GradeX token rejected` | Your token expired — get a fresh one (section 2). |
| `code rejected` / keeps asking for a code | Wait for the **next** authenticator code and type that. |
| `Could not reach SRM` | Check your internet; make sure you're not on a network that blocks SRM. |
