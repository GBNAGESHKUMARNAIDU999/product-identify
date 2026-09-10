import { NextRequest, NextResponse } from "next/server";
import { getGoogleClient, buildAuthUrl, createState } from "@/lib/google-auth";

// Kicks off the Google consent flow. Requires the OAuth client (ID + Secret)
// to be saved on the Settings page first.
export async function GET(req: NextRequest) {
  const client = await getGoogleClient();
  if (!client) {
    return NextResponse.redirect(new URL("/settings?google=error&message=Save%20a%20Client%20ID%20and%20Secret%20first", req.url));
  }
  const redirectUri = new URL("/api/settings/google/callback", req.url).toString();
  const state = createState();
  return NextResponse.redirect(buildAuthUrl(client, redirectUri, state));
}
