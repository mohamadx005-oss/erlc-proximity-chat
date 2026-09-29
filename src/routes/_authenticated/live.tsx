import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { LogOut, Mic, MicOff, Radio, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useProximityVoice, type PeerVolume } from "@/hooks/useProximityVoice";
import { supabase } from "@/integrations/supabase/client";
import { getMyProfile } from "@/lib/roblox.functions";
import { getLivePlayers } from "@/lib/positions.functions";
import { distanceMeters, MAX_RADIUS_M, type WorldPosition } from "@/lib/proximity";

export const Route = createFileRoute("/_authenticated/live")({
  head: () => ({
    meta: [
      { title: "الغرفة المباشرة — صوت المقاطعة" },
      { name: "description", content: "شوف مين قريب منك في اللعبة واسمعه حسب المسافة." },
      { property: "og:title", content: "الغرفة المباشرة — صوت المقاطعة" },
      { property: "og:description", content: "شوف مين قريب منك في اللعبة واسمعه حسب المسافة." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: LivePage,
});

function LivePage() {
  const { user } = Route.useRouteContext();
  const fetchProfile = useServerFn(getMyProfile);
  const fetchPlayers = useServerFn(getLivePlayers);
  const { data: profile, isLoading } = useQuery({ queryKey: ["profile"], queryFn: () => fetchProfile() });
  const { data } = useQuery({
    queryKey: ["live-players"],
    queryFn: () => fetchPlayers(),
    refetchInterval: 3000,
    enabled: !!profile?.roblox_username,
  });
  const voice = useProximityVoice(profile?.roblox_username ? user.id : null);
  const [volumes, setVolumes] = useState<PeerVolume[]>([]);

  const players = data?.players ?? [];
  const meName = profile?.roblox_username?.toLowerCase();
  const me = players.find((p) => p.username.toLowerCase() === meName) ?? null;
  const mePos: WorldPosition | null = me ? { x: me.x, y: 0, z: me.z } : null;

  useEffect(() => {
    const others = new Map<string, WorldPosition>();
    for (const p of players) if (p.userId && p.userId !== user.id) others.set(p.userId, { x: p.x, y: 0, z: p.z });
    setVolumes(voice.applyDistances(mePos, others));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, voice.connectedPeers]);

  const volumeOf = (uid: string | null) => volumes.find((v) => v.userId === uid)?.volume ?? 0;
  const voiceConnected = (uid: string | null) => !!uid && voice.connectedPeers.includes(uid);

  // Only people within hearing range appear; they vanish once they walk away.
  const nearby = mePos
    ? players
        .filter((p) => p.username.toLowerCase() !== meName)
        .map((p) => ({ ...p, meters: distanceMeters(mePos, { x: p.x, y: 0, z: p.z }), vol: volumeOf(p.userId) }))
        .filter((p) => p.meters <= MAX_RADIUS_M)
        .sort((a, b) => a.meters - b.meters)
    : [];

  if (isLoading) return <div className="p-10 text-center text-muted-foreground">جاري التحميل…</div>;

  if (!profile?.roblox_username) {
    return (
      <main className="mx-auto max-w-md px-6 py-20 text-center">
        <h1 className="text-2xl font-bold">باقي خطوة</h1>
        <p className="mt-2 text-muted-foreground">اربط حساب روبلكس عشان نعرف مين أنت في السيرفر.</p>
        <Button asChild className="mt-6"><Link to="/link">اربط روبلكس</Link></Button>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-8">
        <header className="flex items-center gap-3 rounded-3xl border border-border bg-card p-4 shadow-[var(--shadow-panel)]">
          <div className="relative">
            {profile.discord_avatar_url && <img src={profile.discord_avatar_url} alt="" className="h-14 w-14 rounded-full" />}
            <span className={`absolute bottom-0 left-0 h-4 w-4 rounded-full border-2 border-card ${me ? "bg-primary" : "bg-muted-foreground"}`} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-lg font-bold">{profile.discord_username}</div>
            <div dir="ltr" className="truncate text-right text-sm text-muted-foreground">@{profile.roblox_username}</div>
          </div>
          <Button variant="ghost" size="icon" aria-label="خروج" onClick={() => supabase.auth.signOut().then(() => (window.location.href = "/"))}>
            <LogOut />
          </Button>
        </header>

        <div className={`flex items-center gap-2 rounded-2xl px-4 py-3 text-sm ${me ? "bg-primary/10 text-primary" : "bg-secondary text-secondary-foreground"}`}>
          <Radio className="h-4 w-4 shrink-0" />
          {me ? `متصل — أنت داخل السيرفر${me.team ? ` (${me.team})` : ""}` : "ما لقيناك في السيرفر — ادخل اللعبة وانتظر ثواني."}
        </div>
        {data?.error && <p className="rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{data.error}</p>}

        <Button
          size="lg"
          variant={voice.micOn ? "default" : "outline"}
          className={`h-16 rounded-2xl text-lg ${voice.speaking ? "shadow-[var(--shadow-glow)]" : ""}`}
          onClick={voice.micOn ? voice.stopMic : voice.startMic}
        >
          {voice.micOn ? <Mic /> : <MicOff />}
          {voice.micOn ? "المايك شغال" : "شغّل المايك"}
        </Button>
        {voice.error && <p className="text-sm text-destructive">{voice.error}</p>}

        <section className="rounded-3xl border border-border bg-card p-5 shadow-[var(--shadow-panel)]">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="flex items-center gap-2 font-bold"><Users className="h-5 w-5 text-primary" /> القريبين منك</h2>
            <span className="rounded-full bg-secondary px-3 py-0.5 text-sm text-secondary-foreground">{nearby.length}</span>
          </div>
          {nearby.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">ما في أحد قريب منك الحين.</p>
          )}
          <ul className="space-y-3">
            {nearby.map((p) => (
              <li key={p.username} className="flex items-center gap-3 rounded-2xl bg-background/60 p-3 animate-in fade-in">
                {p.avatar ? (
                  <img src={p.avatar} alt="" className="h-10 w-10 rounded-full bg-secondary" />
                ) : (
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-secondary font-bold">{p.username[0]}</div>
                )}
                <div className="min-w-0 flex-1">
                  <div dir="ltr" className="truncate text-right font-semibold">{p.username}</div>
                  <div className="mt-1 h-1.5 rounded-full bg-secondary">
                    <div className="h-1.5 rounded-full bg-primary transition-all" style={{ width: `${Math.round((p.userId ? p.vol : 0) * 100)}%` }} />
                  </div>
                  {!p.userId ? (
                    <div className="mt-1 text-xs text-muted-foreground">مو مسجّل في الموقع</div>
                  ) : voiceConnected(p.userId) ? (
                    <div className="mt-1 text-xs text-primary">متصل بالصوت</div>
                  ) : (
                    <div className="mt-1 text-xs text-muted-foreground">داخل اللعبة — بانتظار تشغيل المايك</div>
                  )}
                </div>
                <span className="text-sm tabular-nums text-muted-foreground">{Math.round(p.meters)} م</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}
