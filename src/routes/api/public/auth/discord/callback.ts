import { createFileRoute } from "@tanstack/react-router";

import { appOrigin, errorRedirect, verifyState } from "@/lib/oauth-state.server";

type DiscordUser = {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
};

export const Route = createFileRoute("/api/public/auth/discord/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const origin = appOrigin(request);

        if (url.searchParams.get("error")) return errorRedirect(request, "discord_cancelled");
        if (!code) return errorRedirect(request, "discord_no_code");
        if (!(await verifyState(url.searchParams.get("state")))) {
          return errorRedirect(request, "discord_bad_state");
        }

        const clientId = process.env["DISCORD_CLIENT_ID"];
        const clientSecret = process.env["DISCORD_CLIENT_SECRET"];
        if (!clientId || !clientSecret) return errorRedirect(request, "discord_not_configured");

        const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: "authorization_code",
            code,
            redirect_uri: `${origin}/api/public/auth/discord/callback`,
          }),
        });
        if (!tokenRes.ok) {
          console.error("discord token exchange failed", await tokenRes.text());
          return errorRedirect(request, "discord_token_failed");
        }
        const token = (await tokenRes.json()) as { access_token: string };

        const userRes = await fetch("https://discord.com/api/users/@me", {
          headers: { authorization: `Bearer ${token.access_token}` },
        });
        if (!userRes.ok) return errorRedirect(request, "discord_profile_failed");
        const discord = (await userRes.json()) as DiscordUser;

        const avatarUrl = discord.avatar
          ? `https://cdn.discordapp.com/avatars/${discord.id}/${discord.avatar}.png?size=256`
          : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(discord.id) >> 22n) % 6}.png`;
        const displayName = discord.global_name || discord.username;

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        // Synthetic, non-deliverable address: we never ask Discord for an email.
        const email = `discord_${discord.id}@erlc-voice.local`;

        const { data: existing } = await supabaseAdmin
          .from("profiles")
          .select("id")
          .eq("discord_id", discord.id)
          .maybeSingle();

        let userId = existing?.id ?? null;

        if (!userId) {
          const { data: created, error: createError } = await supabaseAdmin.auth.admin.createUser({
            email,
            email_confirm: true,
            user_metadata: { discord_id: discord.id, name: displayName, avatar_url: avatarUrl },
          });
          if (createError || !created.user) {
            console.error("createUser failed", createError);
            return errorRedirect(request, "account_create_failed");
          }
          userId = created.user.id;
        }

        const { error: upsertError } = await supabaseAdmin.from("profiles").upsert(
          {
            id: userId,
            discord_id: discord.id,
            discord_username: displayName,
            discord_avatar_url: avatarUrl,
          },
          { onConflict: "id" },
        );
        if (upsertError) {
          console.error("profile upsert failed", upsertError);
          return errorRedirect(request, "profile_save_failed");
        }

        const { data: link, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
          type: "magiclink",
          email,
          options: { redirectTo: `${origin}/live` },
        });
        if (linkError || !link.properties?.action_link) {
          console.error("generateLink failed", linkError);
          return errorRedirect(request, "session_create_failed");
        }

        return Response.redirect(link.properties.action_link, 302);
      },
    },
  },
});
