import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable";
import { toast } from "sonner";

export const Route = createFileRoute("/auth")({
  ssr: false,
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) navigate({ to: "/" });
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN") navigate({ to: "/" });
    });
    return () => sub.subscription.unsubscribe();
  }, [navigate]);

  const handleGoogle = async () => {
    const result = await lovable.auth.signInWithOAuth("google", {
      redirect_uri: window.location.origin,
    });
    if (result.error) toast.error("Error con Google: " + result.error.message);
  };

  const handleEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin },
        });
        if (error) throw error;
        toast.success("¡Cuenta creada! Revisa tu correo si es necesario.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="msn-page">
      <div className="msn-window msn-auth-window">
        <div className="msn-titlebar">
          <div className="msn-titlebar-title">
            <span className="msn-title-icon">💬</span>
            Diccionario Personal — Iniciar sesión
          </div>
          <div className="msn-titlebar-buttons">
            <span className="msn-tb-btn">_</span>
            <span className="msn-tb-btn">□</span>
            <span className="msn-tb-btn msn-tb-close">×</span>
          </div>
        </div>
        <div className="msn-body">
          <div className="msn-hero">
            <div className="msn-hero-icon">📖</div>
            <div>
              <h1 className="msn-hero-title">Tu diccionario privado</h1>
              <p className="msn-hero-sub">Inventa palabras. Tradúcelas. Haz haikus.</p>
            </div>
          </div>

          <button className="msn-btn msn-btn-google" onClick={handleGoogle}>
            <span className="msn-google-g">G</span>
            Iniciar sesión con Google
          </button>

          <div className="msn-sep">
            <span>o con correo</span>
          </div>

          <form onSubmit={handleEmail} className="msn-form">
            <label className="msn-label">
              Correo
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="msn-input"
                placeholder="tu@correo.com"
              />
            </label>
            <label className="msn-label">
              Contraseña
              <input
                type="password"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="msn-input"
                placeholder="••••••••"
              />
            </label>
            <button type="submit" disabled={loading} className="msn-btn msn-btn-primary">
              {loading ? "..." : mode === "signup" ? "Crear cuenta" : "Entrar"}
            </button>
          </form>

          <div className="msn-switch">
            {mode === "signin" ? (
              <>
                ¿No tienes cuenta?{" "}
                <button type="button" onClick={() => setMode("signup")} className="msn-link">
                  Regístrate
                </button>
              </>
            ) : (
              <>
                ¿Ya tienes cuenta?{" "}
                <button type="button" onClick={() => setMode("signin")} className="msn-link">
                  Entra
                </button>
              </>
            )}
          </div>
        </div>
        <div className="msn-statusbar">
          <span className="msn-status-dot" /> Conectado a la red
        </div>
      </div>
    </div>
  );
}