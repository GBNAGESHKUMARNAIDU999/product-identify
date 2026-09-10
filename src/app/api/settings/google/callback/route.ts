import { NextRequest, NextResponse } from "next/server";
import { getGoogleClient, consumeState, exchangeCodeForTokens } from "@/lib/google-auth";

// Google redirects here with ?code&state after consent. The code is exchanged
// for tokens; the refresh token is stored encrypted and the user is sent back
// to /settings with a status flag. Errors are passed URL-encoded, never as raw
// provider payloads.
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return NextResponse.redirect(
      new URL(`/settings?google=error&message=${encodeURIComponent(error)}`, req.url)
    );
  }
  if (!code || !state || !consumeState(state)) {
    return NextResponse.redirect(
      new URL(`/settings?google=error&message=${encodeURIComponent("Invalid or expired authorization state — try again.")}`, req.url)
    );
  }

  const client = await getGoogleClient();
  if (!client) {
    return NextResponse.redirect(
      new URL(`/settings?google=error&message=${encodeURIComponent("No OAuth client saved.")}`, req.url)
    );
  }

  const redirectUri = new URL("/api/settings/google/callback", req.url).toString();
  const result = await exchangeCodeForTokens(client, code, redirectUri);
  if (!result.ok) {
    return NextResponse.redirect(
      new URL(`/settings?google=error&message=${encodeURIComponent(result.error)}`, req.url)
    );
  }
  return NextResponse.redirect(new URL("/settings?google=connected", req.url));
}
