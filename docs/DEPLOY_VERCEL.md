# Deploy the web app to Vercel

The UI in `web/` is a Next.js 15 app (create a sale, bid, demand curve, sniper board, claim, verify panel). It has no server secrets: everything is `NEXT_PUBLIC_*` and is inlined at build time. It talks to NEAR testnet from the browser through a wallet.

You can deploy two ways:

- **Live testnet UI:** reads the real factory on testnet (default).
- **Offline demo UI:** `NEXT_PUBLIC_MOCK=1`, an in-memory fake chain that runs the real `clearing-js`. No chain, no wallet. Good for a public demo link.

## The one thing that breaks a default deploy

`web/` imports `sealedlaunch-clearing` through `"link:../clearing-js"`, and `clearing-js` has its own dependencies (`@noble/hashes`, `eciesjs`). A plain `pnpm install` inside `web/` does not install those, and `next build` fails with webpack "module not found" errors in `clearing-js/src/*`.

The fix is two settings, both in the steps below:

1. **Root Directory = `web`**, and keep **"Include source files outside of the Root Directory in the Build Step"** enabled (it is on by default). `clearing-js/` and `deployments.json` live outside `web/` and must be present at build time.
2. **Install Command** that installs `clearing-js` first.

I verified this on a clean checkout of the repo: install in `web/` alone fails the build; installing `clearing-js/` and then `web/` builds all four routes (`/`, `/create`, `/sale/[id]`, `/_not-found`).

## Prerequisites

- The repo pushed to GitHub: `github.com/0xdeathstalker/sealed-launch`.
- A Vercel account with access to that repo.
- Node 20 or newer (Vercel's default of 22 is fine) and pnpm. Vercel picks pnpm from `web/pnpm-lock.yaml`.

## Option A: Vercel dashboard (recommended)

1. **Add New → Project**, import `0xdeathstalker/sealed-launch`.
2. **Framework Preset:** Next.js (auto-detected once the root directory is set).
3. **Root Directory:** click Edit, choose `web`.
4. Open **Build and Output Settings** and override:

   | Setting | Value |
   |---|---|
   | Install Command | `cd ../clearing-js && pnpm install --frozen-lockfile && cd ../web && pnpm install --frozen-lockfile` |
   | Build Command | `pnpm build` (default) |
   | Output Directory | leave default |

5. Add **Environment Variables** (see the table below). For the offline demo, set `NEXT_PUBLIC_MOCK` = `1`.
6. Click **Deploy**.
7. Settings → Build and Deployment: confirm **Include source files outside of the Root Directory** is enabled.

## Option B: Vercel CLI

```bash
npm i -g vercel
cd /path/to/sealed-launch
vercel link            # create or pick the project
```

Then set the Root Directory and Install Command once in the dashboard (steps 3 and 4 above), because the CLI uses the project settings. Deploy from the repo root:

```bash
vercel                 # preview deployment
vercel --prod          # production deployment
```

Add an env var from the CLI (you will be prompted for the value and environments):

```bash
vercel env add NEXT_PUBLIC_MOCK production
```

## Environment variables

All are optional. `web/next.config.mjs` also reads `../deployments.json` at build time, so with the file present the defaults already point at the real testnet deployment. An explicit env var always wins over the file.

| Variable | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_FACTORY` | `sealedlaunch.deathstalker-sl.testnet` | Factory account that creates keyless sales |
| `NEXT_PUBLIC_RPC_URL` | `https://test.rpc.fastnear.com` | NEAR testnet RPC |
| `NEXT_PUBLIC_EXPLORER_URL` | `https://testnet.nearblocks.io` | Explorer links in the UI |
| `NEXT_PUBLIC_OUTLAYER_PROJECT` | `deathstalker-sl.testnet/sealedlaunch` | OutLayer project (`owner/project`) |
| `NEXT_PUBLIC_CODE_HASH` | recorded hash in `web/lib/config.ts` | sha256 of the OutLayer wasm build (64 hex) |
| `NEXT_PUBLIC_MOCK` | unset | `1` = run the whole UI on in-memory data, no chain, no wallet |
| `NEXT_PUBLIC_INTENTS` | unset | `1` = show the experimental cross-chain section as enabled (it only displays the documented flow) |

Notes:

- `NEXT_PUBLIC_*` values are baked into the JavaScript at build time. **Changing one needs a redeploy** (Deployments → ⋯ → Redeploy), not just a restart.
- Everything here is public by design. Never put a private key, seed phrase or API secret in a `NEXT_PUBLIC_*` variable.
- If `NEXT_PUBLIC_MOCK` is unset and `deployments.json` is missing from the build, the home page shows "No `deployments.json` found at build time; using the default factory ...". That is the sign that "include source files outside the Root Directory" is off.

## Check the deployment

1. Open the Vercel URL. With the mock flag you should see the demo flow work without a wallet.
2. Without the mock flag, the home page should list the sales created by the testnet factory, with no "No `deployments.json` found" notice. Open one (for example `/sale/sale-gamma.sealedlaunch.deathstalker-sl.testnet`) to check the sale page loads.
3. Wallet sign-in uses MyNearWallet on testnet. Try it once on the deployed URL, since I did not test the wallet flow from a Vercel origin.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Build fails: webpack errors in `lib/mock.ts`, `lib/wallet.tsx`, or `clearing-js/src/*` ("Module not found: @noble/hashes" or `eciesjs`) | `clearing-js` dependencies were not installed | Set the Install Command from step 4 |
| Install or build fails because `../clearing-js` or `sealedlaunch-clearing` is missing | Root Directory is `web` but files outside it are excluded | Enable "Include source files outside of the Root Directory in the Build Step" |
| Home page says no deployment found | `deployments.json` not in the build | Same toggle as above, or set `NEXT_PUBLIC_FACTORY` explicitly |
| `ERR_PNPM_OUTDATED_LOCKFILE` | Lockfile out of sync with `package.json` | Run `pnpm install` in the failing directory locally, commit the lockfile, redeploy |
| UI still shows old values after changing env vars | Values are inlined at build time | Redeploy |

## Optional: commit the settings as `web/vercel.json`

Instead of clicking through the dashboard, you can keep the install command in the repo:

```json
{
  "installCommand": "cd ../clearing-js && pnpm install --frozen-lockfile && cd ../web && pnpm install --frozen-lockfile"
}
```

Save it as `web/vercel.json`. You still set the Root Directory to `web` in the dashboard.
