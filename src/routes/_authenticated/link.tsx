import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  confirmBioVerification,
  createRobloxAuthUrl,
  getMyProfile,
  startBioVerification,
} from "@/lib/roblox.functions";

export const Route = createFileRoute("/_authenticated/link")({
  head: () => ({
    meta: [
      { title: "ربط حساب روبلكس — صوت المقاطعة" },
      { name: "description", content: "اربط حساب روبلكس عشان نعرف مكانك في الخريطة." },
      { property: "og:title", content: "ربط حساب روبلكس — صوت المقاطعة" },
      { property: "og:description", content: "اربط حساب روبلكس عشان نعرف مكانك في الخريطة." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: LinkPage,
});

function LinkPage() {
  const fetchProfile = useServerFn(getMyProfile);
  const authUrl = useServerFn(createRobloxAuthUrl);
  const startBio = useServerFn(startBioVerification);
  const confirmBio = useServerFn(confirmBioVerification);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: profile } = useQuery({ queryKey: ["profile"], queryFn: () => fetchProfile() });
  const [username, setUsername] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const s = new URLSearchParams(window.location.search).get("roblox");
    if (s === "ok") toast.success("تم ربط روبلكس");
    else if (s === "not_configured") toast.error("الدخول الرسمي بروبلكس غير مضبوط — استخدم التحقق بالوصف.");
    else if (s) toast.error("ما زبط الربط، جرّب التحقق بالوصف.");
  }, []);

  const official = async () => {
    const { url } = await authUrl();
    if (url) window.location.href = url;
    else toast.error("الدخول الرسمي بروبلكس غير مضبوط بعد — استخدم التحقق بالوصف تحت.");
  };

  if (profile?.roblox_username) {
    return (
      <main className="mx-auto max-w-md px-6 py-20 text-center">
        {profile.roblox_avatar_url && <img src={profile.roblox_avatar_url} alt="" className="mx-auto h-24 w-24 rounded-full bg-secondary" />}
        <h1 className="mt-4 text-2xl font-bold">مربوط بـ {profile.roblox_username}</h1>
        <Button asChild className="mt-6"><Link to="/live">افتح الخريطة</Link></Button>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md px-6 py-16">
      <h1 className="font-display text-3xl font-bold">اربط حساب روبلكس</h1>
      <p className="mt-2 text-muted-foreground">نحتاجه عشان نعرف مكانك في السيرفر.</p>

      <Button size="lg" className="mt-8 w-full" onClick={official}>دخول رسمي بروبلكس</Button>

      <div className="mt-10 rounded-2xl border border-border bg-card p-5">
        <h2 className="font-bold">أو تحقق بالوصف (Bio)</h2>
        {!code ? (
          <div className="mt-4 flex gap-2">
            <Input dir="ltr" placeholder="اسم المستخدم في روبلكس" value={username} onChange={(e) => setUsername(e.target.value)} />
            <Button disabled={busy} onClick={async () => {
              setBusy(true);
              try { setCode((await startBio({ data: { username } })).code); }
              catch (e) { toast.error((e as Error).message); }
              finally { setBusy(false); }
            }}>التالي</Button>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <p className="text-sm text-muted-foreground">حط هذا الكود في وصف حسابك (About) في روبلكس ثم اضغط تحقق:</p>
            <code dir="ltr" className="block rounded-lg bg-secondary p-3 text-center text-lg font-bold">{code}</code>
            <Button className="w-full" disabled={busy} onClick={async () => {
              setBusy(true);
              const r = await confirmBio();
              setBusy(false);
              if (r.ok) { toast.success(r.message); await qc.invalidateQueries({ queryKey: ["profile"] }); navigate({ to: "/live" }); }
              else toast.error(r.message);
            }}>تحقق</Button>
          </div>
        )}
      </div>
    </main>
  );
}
