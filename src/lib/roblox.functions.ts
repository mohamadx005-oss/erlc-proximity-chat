import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type ProfileRow = {
  id: string;
  discord_username: string | null;
  discord_avatar_url: string | null;
  roblox_id: number | null;
  roblox_username: string | null;
  roblox_avatar_url: string | null;
  roblox_verify_code: string | null;
  roblox_verified_at: string | null;
};

export const getMyProfile = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ProfileRow | null> => {
    const { data, error } = await context.supabase
      .from("profiles")
      .select(
        "id, discord_username, discord_avatar_url, roblox_id, roblox_username, roblox_avatar_url, roblox_verify_code, roblox_verified_at",
      )
      .eq("id", context.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data as ProfileRow | null;
  });

/** Builds the Roblox OAuth URL; state is HMAC-signed and carries the user id. */
export const createRobloxAuthUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ url: string | null }> => {
    const clientId = process.env["ROBLOX_CLIENT_ID"];
    if (!clientId) return { url: null };

    const { signState } = await import("@/lib/oauth-state.server");
    const origin = new URL(getRequest().url).origin;
    const state = await signState({ kind: "roblox", uid: context.userId });

    const url = new URL("https://apis.roblox.com/oauth/v1/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", `${origin}/api/public/auth/roblox/callback`);
    url.searchParams.set("scope", "openid profile");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    return { url: url.toString() };
  });

function randomCode(): string {
  const words = ["SUN", "WAVE", "PALM", "REEF", "DUNE", "SAIL", "CORAL", "BREEZE"];
  const w = words[Math.floor(Math.random() * words.length)];
  const n = Math.floor(100000 + Math.random() * 900000);
  return `LR-${w}-${n}`;
}

type RobloxUserLookup = { id: number; name: string; displayName: string };

async function lookupRobloxUser(username: string): Promise<RobloxUserLookup | null> {
  const res = await fetch("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: true }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { data?: RobloxUserLookup[] };
  return json.data?.[0] ?? null;
}

async function robloxAvatar(userId: number): Promise<string | null> {
  const res = await fetch(
    `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`,
  );
  if (!res.ok) return null;
  const json = (await res.json()) as { data?: { imageUrl?: string }[] };
  return json.data?.[0]?.imageUrl ?? null;
}

/** Fallback path: put a one-time code in the Roblox "About" section. */
export const startBioVerification = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { username: string }) => {
    const username = String(input?.username ?? "").trim();
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) throw new Error("اسم مستخدم روبلكس غير صالح");
    return { username };
  })
  .handler(async ({ data, context }): Promise<{ code: string; robloxId: number }> => {
    const user = await lookupRobloxUser(data.username);
    if (!user) throw new Error("ما لقينا حساب روبلكس بهذا الاسم");

    const code = randomCode();
    const { error } = await context.supabase
      .from("profiles")
      .update({ roblox_verify_code: `${user.id}:${code}` })
      .eq("id", context.userId);
    if (error) throw new Error(error.message);

    return { code, robloxId: user.id };
  });

export const confirmBioVerification = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ ok: boolean; message: string }> => {
    const { data: profile } = await context.supabase
      .from("profiles")
      .select("roblox_verify_code")
      .eq("id", context.userId)
      .maybeSingle();

    const stored = profile?.roblox_verify_code as string | null | undefined;
    if (!stored) return { ok: false, message: "ابدأ التحقق أول" };

    const [idPart, code] = stored.split(":");
    const robloxId = Number(idPart);
    if (!robloxId || !code) return { ok: false, message: "ابدأ التحقق من جديد" };

    const res = await fetch(`https://users.roblox.com/v1/users/${robloxId}`);
    if (!res.ok) return { ok: false, message: "تعذّر الوصول لروبلكس، جرّب بعد شوي" };
    const info = (await res.json()) as { name: string; description: string };

    if (!info.description?.includes(code)) {
      return { ok: false, message: "ما لقينا الكود في وصف حسابك" };
    }

    const avatar = await robloxAvatar(robloxId);
    const { error } = await context.supabase
      .from("profiles")
      .update({
        roblox_id: robloxId,
        roblox_username: info.name,
        roblox_avatar_url: avatar,
        roblox_verify_code: null,
        roblox_verified_at: new Date().toISOString(),
      })
      .eq("id", context.userId);
    if (error) return { ok: false, message: "هذا الحساب مرتبط بمستخدم ثاني" };

    return { ok: true, message: "تم ربط حساب روبلكس" };
  });
