# AuthFill Browser Extension — Security Audit Report

**Date:** 2026-06-27
**Scope:** `apps/extension/` (source), `apps/proxy/` (proxy server), `packages/` (shared), root workspace
**Method:** Static review of all TypeScript source files, manifest config, package manifests, lockfile, and build pipeline.

---

## Executive Summary

**The extension is safe to build from source and use with a self-hosted proxy.** No telemetry, analytics, tracking, or credential exfiltration code was found. The extension has **no content scripts** at all (despite the task brief mentioning `<all_urls>` — the actual manifest requests no content scripts and no `<all_urls>` match). IMAP credentials are stored locally in `browser.storage.local` and are sent only to the configured proxy server (default or user-configured self-hosted) over WebSocket/HTTP. The proxy forwards them directly to the user's IMAP server.

There are a few medium/low-severity issues worth noting, but **no critical or high-severity exfiltration risks** were identified. With a self-hosted proxy, the user has full control over the data path.

### Key Conclusions

| Question                               | Answer                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------- |
| Safe to build from source?             | **Yes.** No obfuscated code, no postinstall scripts, no suspicious deps.                    |
| Safe to use with self-hosted proxy?    | **Yes.** Credentials only go to the configured proxy URL.                                   |
| Telemetry/analytics/tracking?          | **None found.** Zero calls to analytics/tracking/error-reporting domains.                   |
| Content scripts running on all URLs?   | **No content scripts exist.** The manifest defines none.                                    |
| Credential leakage to third parties?   | **No**, provided you use a self-hosted proxy (default sends to `proxy.authfill.com`).       |
| Code changes required before building? | **One recommended change** (tighten CSP `connect-src`), plus set env vars for self-hosting. |

---

## 1. Credential Handling

### Finding 1.1 — Credentials stored in plaintext in `browser.storage.local`

**File:** `apps/extension/src/utils/storage.ts`, `apps/extension/src/background/accounts/index.ts`
**Risk:** Medium

IMAP credentials (host, port, user, **password**, secure flag) are stored as plaintext in `browser.storage.local` under the `accounts` key. `browser.storage.local` is extension-scoped and not accessible to web pages, but it is **not encrypted at rest**. Anyone with physical/access to the browser profile (or a malicious extension with `storage` permission) could read passwords. This is a common pattern in browser extensions but should be noted. Consider encrypting with a key derived from a master password, or at minimum documenting this clearly to users.

**Credential flow (good):**

- `listAccounts()` in `accounts/index.ts:40-56` **redacts the password** (`password: undefined`) before returning account configs to the popup UI. ✅
- Credentials are only sent to the proxy during `authenticateCustom` (test connection) and `CustomAccount.connect()` (WebSocket). Both respect the user-configured proxy settings. ✅

### Finding 1.2 — Password sent to proxy over WebSocket for IMAP relay

**File:** `apps/extension/src/background/accounts/providers/custom.ts:60-78`
**Risk:** Medium (mitigated by self-hosting)

When connecting an account, the full IMAP credentials (including password) are JSON-serialized and sent over a WebSocket to the proxy server. This is **architecturally required** — the proxy opens the IMAP connection on behalf of the extension (browsers can't speak IMAP directly). The risk depends entirely on **where** the proxy runs:

- **Self-hosted proxy:** Credentials go only to your server. ✅ Safe.
- **Default proxy (`proxy.authfill.com`):** Credentials transit the AuthFill-operated Cloudflare Worker. The proxy code (`apps/proxy/src/controller/imap/websocket.ts`, `test.ts`) does **not** log or persist credentials — it passes them directly to `CFImap`. However, you are trusting the operator. The README and terms acknowledge this and recommend self-hosting.

No credentials are sent to any domain other than the configured proxy. ✅

### Finding 1.3 — Test connection also sends full credentials via HTTP POST

**File:** `apps/extension/src/background/auth/custom.ts:31-51`
**Risk:** Low

`authenticateCustom` POSTs `{host, port, user, password, secure}` to `${proxyUrl}/imap/test` before saving the account. The proxy handler (`apps/proxy/src/controller/imap/test.ts`) uses them only to attempt an IMAP login, then logs out. No persistence. With a self-hosted proxy over HTTPS/WSS this is fine.

---

## 2. Content Script Behavior

### Finding 2.1 — No content scripts exist

**File:** `apps/extension/manifest.config.ts`
**Risk:** Info (the task brief's premise was incorrect)

The manifest **does not declare any `content_scripts`**, and does **not** match `<all_urls>`. The only host_permissions are a dev-mode-only localhost URL (`process.env.PUBLIC_EXTENSION_URL` in development; empty array in production). The extension **cannot read or modify page content** on any website. It operates entirely via:

- The popup UI (React app in `index.html`)
- The background service worker
- `browser.notifications` and `browser.tabs.query` (metadata only, no content access)

**This is the single most important finding for the "can it exfiltrate page data" question: no, because it has no content-script access to pages at all.** ✅

---

## 3. Background Script / Service Worker

### Finding 3.1 — Network requests are limited to proxy + Thunderbird autoconfig

**Files:** `background/listeners/message.ts`, `background/auth/custom.ts`, `background/accounts/providers/custom.ts`, `routes/setup/index.tsx`
**Risk:** Low

All outbound network calls from the extension:

1. `axios.get(${httpUrl}/health)` — proxy health check (user-configured URL). ✅
2. `axios.post(${proxyUrl}/imap/test)` — IMAP test via proxy. ✅
3. `new WebSocket(${wssUrl}/imap)` — IMAP relay via proxy. ✅
4. `axios.get(https://autoconfig.thunderbird.net/v1.1/${host})` — **in the popup setup route**, fetches ISPDB autoconfig to pre-fill IMAP host/port. This is a Mozilla-operated public DB. Only the email **domain** (not the full address or password) is sent. ✅

**No telemetry, analytics, Sentry, Google Analytics, Amplitude, Mixpanel, Segment, PostHog, or any error-reporting calls exist.** Verified by searching for `fetch`, `XMLHttpRequest`, `sendBeacon`, `Image().src`, and common analytics domains across all of `apps/extension/src/`. Zero hits. ✅

### Finding 3.2 — `console.info`/`console.error` logging in background

**Files:** various background utils
**Risk:** Low

The background script logs connection events to the console (e.g., "Account connected", WebSocket errors). These are visible in the extension's service-worker DevTools console. They log account IDs (nanoids), not passwords or email contents. Low risk, but production builds ideally suppress verbose logging.

---

## 4. Proxy Configuration & Auto-Update Risk

### Finding 4.1 — Custom proxy is a per-installation local setting; no remote override path

**Files:** `utils/storage.ts` (`ProxySettings`), `background/accounts/providers/custom.ts:16-22`, `background/auth/custom.ts:7-13`, `routes/settings/index.tsx`
**Risk:** Info

The proxy URL resolution logic (`getProxyWssUrl`, `getProxyHttpUrl`):

```ts
const settings = await getStorage("proxySettings");
if (settings?.enabled && settings.baseUrl) {
  return getProxyUrls(settings.baseUrl).wssUrl; // or httpUrl
}
return import.meta.env.PUBLIC_WSS_URL; // fallback: build-time env var
```

**The user's custom proxy setting (stored in `browser.storage.local`) always wins** over the compiled-in default. There is **no remote config fetch**, no "managed storage" policy, and no code path that silently resets `proxySettings`. An auto-update would re-bundle the extension (potentially changing `PUBLIC_WSS_URL`), but **cannot override a stored user setting** — the `if (settings?.enabled && settings.baseUrl)` check runs at every connection. ✅

**Caveat:** If a user has _not_ configured a custom proxy (`enabled: false` or empty `baseUrl`), the extension falls back to `import.meta.env.PUBLIC_WSS_URL` / `PUBLIC_PROXY_URL`, which are baked in at build time. For a self-hosted build, **you must set these env vars** (see §8) or the fallback will point at `proxy.authfill.com`.

### Finding 4.2 — No update_url / enterprise policy in manifest

**Risk:** Info

The manifest has no `update_url` (Chrome) beyond the Web Store default, and no `storage.managed_schema`. There's no mechanism for the extension author to remotely push new proxy settings to existing installs.

---

## 5. Data Exfiltration Risk

### Finding 5.1 — No external-domain calls beyond Thunderbird autoconfig

**Risk:** Info (clean)

Comprehensive search for outbound network calls and known analytics/tracking patterns returned nothing suspicious. The only third-party domain contacted is `autoconfig.thunderbird.net` (ISPDB), which receives only the email domain and is a well-known Mozilla service. No data leaves the extension except to the configured proxy.

### Finding 5.2 — Email content rendered via `react-letter` (sanitized)

**File:** `routes/emails/$id.tsx:52`
**Risk:** Low

Email HTML is rendered using `<Letter html={email.html} text={email.text} />`. `react-letter@0.4.0` depends on `lettersanitizer@1.0.7`, which sanitizes HTML (strips scripts, event handlers, etc.) before rendering. This is the correct approach. The rendered email content is displayed only inside the extension's own popup page (extension origin), not injected into web pages. Low XSS risk; the sanitizer is maintained and the integration is standard.

### Finding 5.3 — `window.open(email.link)` for magic-link emails

**File:** `components/emails/list.tsx:55, 93`
**Risk:** Low

When a detected "magic link" email arrives, the extension auto-opens the link via `window.open(email.link)`. The link comes from email content parsed by `extractAuthCandidates`. This is the intended behavior (one-click verification), but a malicious email could push a link to the user's active browser. The detection logic scores links and the popup UI shows them. This is inherent to the product's design and documented. Users should be aware auto-open happens for new emails matching the current site domain (see `getEmailsForPort` — emails are filtered to the active tab's registrable domain, or `alwaysShow`/demo emails).

---

## 6. Permissions Audit

### Finding 6.1 — Permissions are minimal and justified

**File:** `apps/extension/manifest.config.ts:23-28`
**Risk:** Info (good)

```ts
permissions: [
  "storage",
  "tabs",
  "notifications",
  ...(firefox ? ["clipboardWrite"] : []),
];
host_permissions: env.mode == "development"
  ? [`${PUBLIC_EXTENSION_URL}/*`]
  : [];
```

| Permission                 | Justified?       | Notes                                                                                                                                            |
| -------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `storage`                  | ✅ Yes           | Stores accounts + proxy settings locally.                                                                                                        |
| `tabs`                     | ✅ Yes           | `getActiveTab()` used to filter emails by current site domain. Does **not** request `tabCapture` or content access. Only reads tab URL/metadata. |
| `notifications`            | ✅ Yes           | "Code copied" notifications.                                                                                                                     |
| `clipboardWrite` (Firefox) | ✅ Yes           | OTP copy fallback. Chrome allows clipboard via the page API without this.                                                                        |
| `host_permissions`         | ✅ Empty in prod | Dev-only localhost. No broad host access.                                                                                                        |

**No `<all_urls>`, no `activeTab` abuse, no `webRequest`, no `declarativeNetRequest`, no `nativeMessaging`, no `downloads`, no `history`, no `cookies`.** This is a tight permission set. ✅

### Finding 6.2 — CSP `connect-src 'self' *` is overly permissive

**File:** `apps/extension/manifest.config.ts:36`
**Risk:** Medium

```ts
content_security_policy: {
  extension_pages: `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self' *`,
}
```

`connect-src 'self' *` allows the extension's own pages to make network connections (fetch/WebSocket/XHR) to **any origin**. This is presumably to allow connecting to arbitrary user-configured proxy URLs and the Thunderbird autoconfig without re-declaring hosts. While the code only connects to the proxy + autoconfig, the CSP doesn't enforce that — a compromised/future version could call out anywhere.

**Recommended change for a self-hosted build:** restrict `connect-src` to your proxy origin and `autoconfig.thunderbird.net`:

```
connect-src 'self' https://your-proxy.example.com wss://your-proxy.example.com https://autoconfig.thunderbird.net
```

This is the **one code change recommended before building** (see §8).

---

## 7. Supply Chain Risk

### Finding 7.1 — No postinstall/preinstall/prepare scripts anywhere

**Files:** root `package.json`, `apps/extension/package.json`, `apps/proxy/package.json`, `packages/*/package.json`, `pnpm-lock.yaml`
**Risk:** Info (clean)

Searched all package.json files and the lockfile for `postinstall`, `preinstall`, `prepare`, `install` scripts. **None found.** No lifecycle scripts execute arbitrary code during `pnpm install`. ✅

### Finding 7.2 — No obfuscated or minified-at-source dependencies

**Risk:** Info (clean)

All dependencies resolve to `registry.npmjs.org` with integrity hashes. No non-registry tarballs, no `git+https` direct deps in the extension's runtime tree. The `@authfill/*` workspace packages are local `link:` references to `packages/`. The shared `packages/eslint`, `packages/ui`, `packages/hooks` were reviewed — standard ESLint config, Radix UI wrappers, React hooks. Nothing suspicious.

### Finding 7.3 — Notable dependencies

| Package                            | Version       | Notes                                                                                                       |
| ---------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------- |
| `cf-imap`                          | ^0.0.12       | Proxy-only. Low-download npm package; used for IMAP in CF Workers. Review if concerned, but no obfuscation. |
| `react-letter` + `lettersanitizer` | 0.4.0 / 1.0.7 | Sanitizes email HTML. Standard, maintained.                                                                 |
| `html-to-text`                     | ^9.0.5        | Used in `detection.ts` to convert email HTML→text for OTP extraction. No network.                           |
| `xml-js`                           | ^1.6.11       | Parses Thunderbird ISPDB XML. No network.                                                                   |
| `axios`                            | ^1.9.0        | HTTP client. Used only for proxy + autoconfig.                                                              |
| `webextension-polyfill`            | ^0.12.0       | Standard cross-browser API shim.                                                                            |
| `nanoid`                           | ^5.1.5        | ID generation.                                                                                              |
| `zod`                              | ^3.25.46      | Schema validation.                                                                                          |

A few **dev** dependencies are marked `deprecated` in the lockfile (old `glob`, `eslint` v8 modules, `rimraf` <4) — these are transitive dev-only deps of build tooling and pose no runtime risk to the extension.

### Finding 7.4 — `@crxjs/vite-plugin` beta

**Risk:** Low

The extension is built with `@crxjs/vite-plugin@2.0.0-beta.33`. Beta build tooling can have bugs, but it's a well-known Chrome extension Vite plugin and not a runtime dependency. The built artifact's correctness should be verified after build (check the generated `manifest.json` in `dist/` for unexpected permissions/scripts).

---

## 8. Build Recommendations for Self-Hosted Use

To build a safe self-hosted extension:

1. **Set env vars in `.env`** before building:

   ```
   PUBLIC_WSS_URL=wss://your-proxy.example.com
   PUBLIC_PROXY_URL=https://your-proxy.example.com
   PUBLIC_WEB_URL=https://your-landing.example.com   # or keep authfill.com
   PUBLIC_EXTENSION_URL=http://localhost:3001        # dev only
   ```

   These are injected at build time via Vite's `envPrefix: ["PUBLIC_"]`. If you leave them as the `.env.example` localhost defaults, the **fallback** proxy (used when the user hasn't enabled custom proxy) will be localhost — fine for self-hosting but means the "default" path is dead until the user configures the custom proxy in Settings.

2. **Tighten the CSP** in `apps/extension/manifest.config.ts:36` — change `connect-src 'self' *` to enumerate your allowed origins (your proxy + thunderbird autoconfig). This is the only code edit recommended.

3. **Build & verify:**

   ```
   pnpm install --frozen-lockfile
   pnpm --filter extension build:chrome
   ```

   Then inspect `apps/extension/dist/manifest.json` to confirm: no `content_scripts`, no unexpected `host_permissions`, permissions match the source.

4. **Deploy your own proxy** from `apps/proxy/` (Cloudflare Worker or any Hono-compatible runtime). The proxy code is clean: it only relays IMAP connections and does not persist credentials or email contents. Note `app.use("*", cors({ origin: "*" }))` in `apps/proxy/src/index.ts:16` allows any origin to hit the proxy — for a personal proxy you may want to restrict CORS or add auth, but the WebSocket/IMAP endpoints don't require browser CORS in the same way.

---

## File-by-File Findings Summary

| File                                      | Finding                                                                                  | Risk         |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- | ------------ |
| `manifest.config.ts`                      | No content scripts; minimal permissions; CSP `connect-src *` too broad                   | Medium (CSP) |
| `manifest.config.ts`                      | No `<all_urls>`; host_permissions empty in prod                                          | Info (good)  |
| `utils/storage.ts`                        | Credentials in plaintext `storage.local`; proxy URL resolution logic is sound            | Medium       |
| `background/accounts/providers/custom.ts` | Sends full credentials to proxy via WebSocket (by design); respects custom proxy setting | Medium       |
| `background/auth/custom.ts`               | POSTs credentials to proxy `/imap/test`; respects custom proxy                           | Low          |
| `background/accounts/index.ts`            | `listAccounts` redacts password before returning to UI                                   | Info (good)  |
| `background/listeners/message.ts`         | Only proxy health/test calls; no telemetry                                               | Info (good)  |
| `background/utils/email.ts`               | Email filtering by active-tab domain; no exfiltration                                    | Info (good)  |
| `background/utils/tab.ts`                 | Only reads tab metadata (URL); no content access                                         | Info (good)  |
| `routes/setup/index.tsx`                  | Calls `autoconfig.thunderbird.net` with email domain only                                | Low          |
| `routes/settings/index.tsx`               | Custom proxy config UI; tests before saving                                              | Info (good)  |
| `routes/emails/$id.tsx`                   | Renders email HTML via `react-letter` (sanitized)                                        | Low          |
| `components/emails/list.tsx`              | Auto-opens magic-link emails via `window.open`                                           | Low          |
| `apps/proxy/src/*`                        | No credential/email persistence; CORS `*`; passes creds to IMAP only                     | Low          |
| `pnpm-lock.yaml`                          | No postinstall scripts; no non-registry deps; a few deprecated dev deps                  | Info (clean) |

---

## Final Verdict

**The AuthFill extension is safe to build from source and use with a self-hosted proxy.** The codebase is unusually clean for a browser extension: no content scripts, no analytics, no tracking, minimal permissions, and a proxy-fallback architecture that correctly defers to user-configured settings. The only recommended pre-build change is tightening the CSP `connect-src` directive. With a self-hosted proxy, no credential or email data leaves your infrastructure.

No malicious, obfuscated, or exfiltration-related code was found in any reviewed file.
