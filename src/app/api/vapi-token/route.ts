import { NextResponse } from "next/server";

export async function GET() {
  const apiKey = process.env.VAPI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Missing VAPI_API_KEY" }, { status: 500 });
  }
  // TODO: Replace this with a real call to Vapi to mint a client token using the server API key.
  // For now, return a short-lived opaque token string from our server so the client doesn't need the secret.
  const token = `stub-${Math.random().toString(36).slice(2)}`;
  return NextResponse.json({ token });
}
