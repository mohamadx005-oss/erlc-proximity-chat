import { createFileRoute } from "@tanstack/react-router";

import { appOrigin, errorRedirect, signState } from "@/lib/oauth-state.server";

export const Route = createFileRoute("/api/public/auth/discord/start")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const clientId = process.env["DISCORD_CLIENT_ID"];
        if (!clientId) return errorRedirect(request, "discord_not_configured");

        const origin = appOrigin(request);
        const state = await signState({ kind: "discord" });

        const url = new URL("https://discord.com/oauth2/authorize");
        url.searchParams.set("client_id", clientId);
        url.searchParams.set("redirect_uri", `${origin}/api/public/auth/discord/callback`);
        url.searchParams.set("response_type", "code");
        // identify only: username + avatar. No email, no guilds.
        url.searchParams.set("scope", "identify");
        url.searchParams.set("state", state);
        url.searchParams.set("prompt", "consent");

        return Response.redirect(url.toString(), 302);
      },
    },
  },
});
