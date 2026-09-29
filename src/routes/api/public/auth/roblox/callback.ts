import { createFileRoute } from "@tanstack/react-router";

import { appOrigin, verifyState } from "@/lib/oauth-state.server";

function backToLink(request: Request, status: string): Response {
  const url = new URL("/link", appOrigin(request));
  url.searchParams.set("roblox", status);
  return Response.redirect(url.toString(), 302);
}

export const Route = createFileRoute("/api/public/auth/roblox/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const origin = appOrigin(request);
        const code = url.searchParams.get("code");

        if (url.searchParams.get("error")) return backToLink(request, "cancelled");
        if (!code) return backToLink(request, "no_code");

        const state = await verifyState(url.searchParams.get("state"));
        const userId = state?.["uid"];
        if (!userId) return backToLink(request, "bad_state");

        const clientId = process.env["ROBLOX_CLIENT_ID"];
        const clientSecret = process.env["ROBLOX_CLIENT_SECRET"];
        if (!clientId || !clientSecret) return backToLink(request, "not_configured");

        const tokenRes = await fetch("https://apis.roblox.com/oauth/v1/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: "authorization_code",
            code,
            redirect_uri: `${origin}/api/public/auth/roblox/callback`,
          }),
        });
        if (!tokenRes.ok) {
          console.error("roblox token exchange failed", await tokenRes.text());
          return backToLink(request, "token_failed");
        }
        const token = (await tokenRes.json()) as { access_token: string };

        const infoRes = await fetch("https://apis.roblox.com/oauth/v1/userinfo", {
          headers: { authorization: `Bearer ${token.access_token}` },
        });
        if (!infoRes.ok) return backToLink(request, "profile_failed");
        const info = (await infoRes.json()) as {
          sub: string;
          preferred_username?: string;
          nickname?: string;
          picture?: string;
        };

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { error } = await supabaseAdmin
          .from("profiles")
          .update({
            roblox_id: Number(info.sub),
            roblox_username: info.preferred_username ?? info.nickname ?? null,
            roblox_avatar_url: info.picture ?? null,
            roblox_verify_code: null,
            roblox_verified_at: new Date().toISOString(),
          })
          .eq("id", userId);

        if (error) {
          console.error("roblox link failed", error);
          return backToLink(request, "already_linked");
        }

        return backToLink(request, "ok");
      },
    },
  },
});
