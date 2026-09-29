import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Headphones, MapPin, Radio } from "lucide-react";

import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "صوت المقاطعة — محادثة صوتية بالقرب في ERLC" },
      { name: "description", content: "سجّل بديسكورد، اربط روبلكس، واسمع اللاعبين القريبين منك منك في ERLC." },
      { property: "og:title", content: "صوت المقاطعة — محادثة صوتية بالقرب في ERLC" },
      { property: "og:description", content: "كل ما قربت من لاعب تسمعه أوضح، وكل ما بعدت يخفت صوته." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

const ERRORS: Record<string, string> = {
  discord_not_configured: "تسجيل الدخول بديسكورد لم يُضبط بعد.",
  discord_cancelled: "ألغيت تسجيل الدخول.",
};

function Index() {
  const [signedIn, setSignedIn] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSignedIn(!!data.session));
    const e = new URLSearchParams(window.location.search).get("auth_error");
    if (e) setErr(ERRORS[e] ?? "صار خطأ أثناء تسجيل الدخول، جرّب مرة ثانية.");
  }, []);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <section className="mx-auto flex max-w-5xl flex-col items-center px-6 pb-16 pt-24 text-center">
        <span className="rounded-full bg-secondary px-4 py-1 text-sm font-semibold text-secondary-foreground">
          ERLC · صوت بالقرب
        </span>
        <h1 className="mt-6 font-display text-5xl font-bold leading-tight md:text-6xl">
          اسمع اللي <span className="text-primary">جنبك</span> بس
        </h1>
        <p className="mt-5 max-w-xl text-lg text-muted-foreground">
          محادثة صوتية تعتمد على مكانك داخل اللعبة. قرّبت من لاعب؟ صوته يوضح. بعدت؟ يخفت شوي شوي لين يختفي.
        </p>
        {err && <p className="mt-6 rounded-lg bg-destructive/10 px-4 py-2 text-destructive">{err}</p>}
        <div className="mt-8">
          {signedIn ? (
            <Button asChild size="lg" className="shadow-[var(--shadow-glow)]">
              <Link to="/live">ادخل الغرفة</Link>
            </Button>
          ) : (
            <Button asChild size="lg" className="shadow-[var(--shadow-glow)]">
              <a href="/api/public/auth/discord/start">سجّل دخولك بديسكورد</a>
            </Button>
          )}
        </div>
      </section>

      <section className="mx-auto grid max-w-5xl gap-4 px-6 pb-24 md:grid-cols-3">
        {[
          { icon: Radio, t: "سجّل بديسكورد", d: "دخول سريع بضغطة وحدة." },
          { icon: MapPin, t: "اربط روبلكس", d: "عشان نعرف مين أنت داخل السيرفر." },
          { icon: Headphones, t: "تكلّم", d: "الصوت يتغير حسب المسافة بينكم." },
        ].map(({ icon: Icon, t, d }) => (
          <div key={t} className="rounded-2xl border border-border bg-card p-6 text-card-foreground shadow-[var(--shadow-panel)]">
            <Icon className="h-6 w-6 text-primary" />
            <h3 className="mt-3 text-lg font-bold">{t}</h3>
            <p className="mt-1 text-muted-foreground">{d}</p>
          </div>
        ))}
      </section>
    </main>
  );
}
