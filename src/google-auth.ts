// c93cd200 item 10 (W1, Day 227): the Google OAuth code-exchange + Supabase session mint,
// factored out of index.ts (0c7abc2e) so popup.ts's admin sign-in reuses the SAME verified flow
// rather than a second, divergent copy -- Cloud's explicit instruction ("factor it, do not copy
// it"). Callers own: the allowlist decision (isAllowedEmail vs isDarren), the success
// destination, and how a refusal is styled -- everything CALLER-SPECIFIC. This module owns only
// the part that must never diverge: exchanging the code, verifying the token is really ours, and
// minting a Supabase session for it.
//
// THE LEAK THIS FIXES (Silver's census, 06d29161/92704225 style finding, W1's two of five):
// index.ts used to write `<!-- ${body.slice(0, 300)} -->` -- the upstream error body -- into
// served HTML on BOTH failure paths below. stripServedComments only runs once at MODULE LOAD on
// static template-literal strings; a comment built at REQUEST TIME from a runtime value is
// invisible to it and reaches the browser verbatim. Fixed here by NEVER putting the upstream
// body into the returned failure reason at all -- it is logged (console.error, reaches
// `wrangler tail` / the Cloudflare dashboard) and discarded, never returned to a caller that
// might render it.

export type GoogleAuthEnv = {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
};

export type GoogleAuthResult =
  | { ok: true; email: string; access_token: string; refresh_token: string }
  | { ok: false; reason: "cancelled" | "missing_code" | "exchange_failed" | "no_id_token" | "verify_failed" | "audience_mismatch" | "email_unverified" | "session_failed" };

export function googleLoginUrl(origin: string, callbackPath: string, env: GoogleAuthEnv): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${origin}${callbackPath}`,
    response_type: "code",
    scope: "openid email",
    // ⛔ prompt=select_account, not the bare default: without it a browser already signed into
    // one Google account silently reuses it, which is the wrong UX for a REFUSAL test (you
    // cannot pick a different, non-allowlisted address to prove the gate) and arguably the wrong
    // UX for the real flow too (a shared machine, a work+personal account mix-up).
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

// Runs steps 1-4 of the callback (exchange, verify, audience check, email-verified check, mint
// session) but NEVER decides who is allowed in -- that is the caller's allowlist, checked against
// the returned `email` before the caller does anything with the tokens.
export async function exchangeGoogleCallback(url: URL, callbackPath: string, env: GoogleAuthEnv): Promise<GoogleAuthResult> {
  const err = url.searchParams.get("error");
  if (err) return { ok: false, reason: "cancelled" };
  const code = url.searchParams.get("code");
  if (!code) return { ok: false, reason: "missing_code" };

  // 1. Exchange the code for an ID token. NEVER trust query-string claims -- only what Google's
  // own token endpoint returns for THIS code, using OUR client secret.
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${url.origin}${callbackPath}`,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    console.error("google-auth: code exchange failed", tokenRes.status, await tokenRes.text());
    return { ok: false, reason: "exchange_failed" };
  }
  const tokenData = (await tokenRes.json()) as { id_token?: string };
  if (!tokenData.id_token) return { ok: false, reason: "no_id_token" };

  // 2. Verify the ID token. Google's tokeninfo endpoint, not a hand-rolled JWKS/JWT verification
  // -- it re-validates the signature and expiry itself; we only need to check WHICH client it
  // was issued for (aud) and whether Google vouches for the email (email_verified).
  const infoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tokenData.id_token)}`);
  if (!infoRes.ok) {
    console.error("google-auth: tokeninfo failed", infoRes.status, await infoRes.text());
    return { ok: false, reason: "verify_failed" };
  }
  const info = (await infoRes.json()) as { aud?: string; email?: string; email_verified?: string };
  if (info.aud !== env.GOOGLE_CLIENT_ID) {
    // ⛔ THE SINGLE MOST IMPORTANT CHECK IN THIS MODULE. Without it, an ID token issued to a
    // DIFFERENT Google client would be accepted, because Google signs tokens for every client
    // with the same keys -- aud is the only thing that says this token was meant for US.
    return { ok: false, reason: "audience_mismatch" };
  }
  if (info.email_verified !== "true" || !info.email) return { ok: false, reason: "email_unverified" };

  // 3. Mint a Supabase session for this verified identity. signInWithIdToken's REST form --
  // Supabase re-checks aud against its OWN configured client id list (Auth -> Providers ->
  // Google -> Client IDs), which must include env.GOOGLE_CLIENT_ID for this to succeed.
  const supaRes = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=id_token`, {
    method: "POST",
    headers: { apikey: env.SUPABASE_ANON_KEY, "content-type": "application/json" },
    body: JSON.stringify({ provider: "google", id_token: tokenData.id_token }),
  });
  if (!supaRes.ok) {
    console.error("google-auth: session mint failed", supaRes.status, await supaRes.text());
    return { ok: false, reason: "session_failed" };
  }
  const supaData = (await supaRes.json()) as { access_token: string; refresh_token: string };
  return { ok: true, email: info.email, access_token: supaData.access_token, refresh_token: supaData.refresh_token };
}

type GoogleAuthFailureReason = Extract<GoogleAuthResult, { ok: false }>["reason"];
export const GOOGLE_AUTH_FAILURE_MESSAGE: Record<GoogleAuthFailureReason, string> = {
  cancelled: "Google sign-in was cancelled or failed.",
  missing_code: "Missing sign-in code.",
  exchange_failed: "Google sign-in failed at the code exchange.",
  no_id_token: "Google did not return an ID token.",
  verify_failed: "Could not verify the Google sign-in.",
  audience_mismatch: "Could not verify the Google sign-in (audience mismatch).",
  email_unverified: "Your Google account's email is not verified.",
  session_failed: "Signed in with Google, but could not create a session.",
};
