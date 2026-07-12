import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, useMemo } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import {
  suggestCategory,
  exploreMeanings,
  translateToLanguage,
  makeHaiku,
  bulkImportPalabras,
} from "@/lib/dictionary.functions";
import { CURAEIDON_LEXICON } from "@/lib/curaeidon-lexicon";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/")({
  component: DictionaryApp,
});

type Palabra = {
  id: string;
  palabra: string;
  definicion: string;
  categoria: string;
  ejemplos: string;
  notas: string;
  created_at: string;
};

type Tab = "diccionario" | "explorar" | "traducir" | "poemas";

function DictionaryApp() {
  const navigate = useNavigate();
  const [palabras, setPalabras] = useState<Palabra[]>([]);
  const [tab, setTab] = useState<Tab>("diccionario");
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState<string>("");

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? ""));
    load();
  }, []);

  async function load() {
    setLoading(true);
    const { data, error } = await supabase
      .from("palabras")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) toast.error(error.message);
    setPalabras((data as Palabra[]) ?? []);
    setLoading(false);
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  return (
    <div className="msn-page">
      <div className="msn-window msn-main-window">
        <div className="msn-titlebar">
          <div className="msn-titlebar-title">
            <span className="msn-title-icon">📖</span>
            Mi diccionario — {email}
          </div>
          <div className="msn-titlebar-buttons">
            <span className="msn-tb-btn">_</span>
            <span className="msn-tb-btn">□</span>
            <span
              className="msn-tb-btn msn-tb-close"
              onClick={handleSignOut}
              title="Cerrar sesión"
              style={{ cursor: "pointer" }}
            >
              ×
            </span>
          </div>
        </div>

        <div className="msn-tabs">
          {(
            [
              ["diccionario", "📚 Diccionario"],
              ["explorar", "✨ Explorar palabra"],
              ["traducir", "🔤 Traducir"],
              ["poemas", "🌙 Haikus"],
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`msn-tab ${tab === id ? "msn-tab-active" : ""}`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="msn-body">
          {tab === "diccionario" && (
            <DictionaryTab palabras={palabras} loading={loading} onReload={load} />
          )}
          {tab === "explorar" && <ExploreTab />}
          {tab === "traducir" && <TranslateTab />}
          {tab === "poemas" && <PoemsTab />}
        </div>

        <div className="msn-statusbar">
          <span className="msn-status-dot" /> {palabras.length} palabras · sincronizado
          <button className="msn-status-link" onClick={handleSignOut}>
            cerrar sesión
          </button>
        </div>
      </div>
    </div>
  );
}

function DictionaryTab({
  palabras,
  loading,
  onReload,
}: {
  palabras: Palabra[];
  loading: boolean;
  onReload: () => void;
}) {
  const [palabra, setPalabra] = useState("");
  const [definicion, setDefinicion] = useState("");
  const [categoria, setCategoria] = useState("");
  const [ejemplos, setEjemplos] = useState("");
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState("");
  const suggest = useServerFn(suggestCategory);
  const bulkImport = useServerFn(bulkImportPalabras);
  const [importing, setImporting] = useState(false);

  async function handleBulkImport() {
    if (!confirm(`Importar ${CURAEIDON_LEXICON.length} palabras del lexicón Curaeidon?`)) return;
    setImporting(true);
    try {
      const r = await bulkImport({ data: { items: CURAEIDON_LEXICON } });
      toast.success(`Importadas ${r.inserted} · saltadas ${r.skipped} (duplicadas)`);
      onReload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setImporting(false);
    }
  }

  const categorias = useMemo(() => {
    const s = new Set(palabras.map((p) => p.categoria));
    return Array.from(s).sort();
  }, [palabras]);

  const filtered = useMemo(() => {
    if (!filter) return palabras;
    return palabras.filter(
      (p) =>
        p.palabra.toLowerCase().includes(filter.toLowerCase()) ||
        p.definicion.toLowerCase().includes(filter.toLowerCase()) ||
        p.categoria.toLowerCase().includes(filter.toLowerCase()),
    );
  }, [palabras, filter]);

  async function handleAutoCategory() {
    if (!palabra.trim()) return;
    try {
      const { categoria: c } = await suggest({ data: { palabra, definicion } });
      setCategoria(c);
      toast.success(`Categoría sugerida: ${c}`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!palabra.trim()) return;
    setSaving(true);
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) return;
    let cat = categoria.trim();
    if (!cat) {
      try {
        const r = await suggest({ data: { palabra, definicion } });
        cat = r.categoria || "sin categoría";
      } catch {
        cat = "sin categoría";
      }
    }
    const { error } = await supabase.from("palabras").insert({
      user_id: userData.user.id,
      palabra: palabra.trim(),
      definicion: definicion.trim(),
      categoria: cat,
      ejemplos: ejemplos.trim(),
    });
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(`"${palabra}" guardada`);
    setPalabra("");
    setDefinicion("");
    setCategoria("");
    setEjemplos("");
    onReload();
  }

  async function handleDelete(id: string, p: string) {
    if (!confirm(`¿Borrar "${p}"?`)) return;
    const { error } = await supabase.from("palabras").delete().eq("id", id);
    if (error) toast.error(error.message);
    else onReload();
  }

  const grouped = useMemo(() => {
    const g: Record<string, Palabra[]> = {};
    for (const p of filtered) {
      (g[p.categoria] ??= []).push(p);
    }
    return g;
  }, [filtered]);

  return (
    <div className="msn-two-col">
      <div className="msn-panel">
        <div className="msn-panel-title">✏️ Nueva palabra</div>
        <form onSubmit={handleSave} className="msn-form">
          <label className="msn-label">
            Palabra
            <input
              className="msn-input"
              value={palabra}
              onChange={(e) => setPalabra(e.target.value)}
              placeholder="ej. lumibre"
              required
            />
          </label>
          <label className="msn-label">
            Definición
            <textarea
              className="msn-input msn-textarea"
              value={definicion}
              onChange={(e) => setDefinicion(e.target.value)}
              placeholder="qué significa..."
              rows={3}
            />
          </label>
          <label className="msn-label">
            Categoría{" "}
            <button
              type="button"
              className="msn-mini-btn"
              onClick={handleAutoCategory}
              title="Sugerir con IA"
            >
              ✨ sugerir
            </button>
            <input
              className="msn-input"
              value={categoria}
              onChange={(e) => setCategoria(e.target.value)}
              placeholder="emoción, objeto, verbo..."
              list="cat-list"
            />
            <datalist id="cat-list">
              {categorias.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </label>
          <label className="msn-label">
            Ejemplo (opcional)
            <input
              className="msn-input"
              value={ejemplos}
              onChange={(e) => setEjemplos(e.target.value)}
              placeholder="frase de ejemplo"
            />
          </label>
          <button type="submit" disabled={saving} className="msn-btn msn-btn-primary">
            {saving ? "guardando..." : "＋ Agregar al diccionario"}
          </button>
          <button
            type="button"
            onClick={handleBulkImport}
            disabled={importing}
            className="msn-btn"
            style={{ marginTop: 6 }}
          >
            {importing ? "importando..." : "📥 Importar lexicón completo"}
          </button>
        </form>
      </div>

      <div className="msn-panel">
        <div className="msn-panel-title">
          📚 Diccionario ({palabras.length})
          <input
            className="msn-input msn-search"
            placeholder="buscar..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <div className="msn-list">
          {loading && <div className="msn-empty">cargando...</div>}
          {!loading && palabras.length === 0 && (
            <div className="msn-empty">
              Aún no hay palabras. Inventa la primera ✨
            </div>
          )}
          {Object.entries(grouped).map(([cat, items]) => (
            <div key={cat} className="msn-group">
              <div className="msn-group-title">
                <span className="msn-tag">{cat}</span>
                <span className="msn-group-count">{items.length}</span>
              </div>
              {items.map((p) => (
                <div key={p.id} className="msn-word">
                  <div className="msn-word-head">
                    <strong className="msn-word-name">{p.palabra}</strong>
                    <button
                      className="msn-x"
                      onClick={() => handleDelete(p.id, p.palabra)}
                      title="borrar"
                    >
                      ×
                    </button>
                  </div>
                  {p.definicion && <div className="msn-word-def">{p.definicion}</div>}
                  {p.ejemplos && <div className="msn-word-ex">« {p.ejemplos} »</div>}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ExploreTab() {
  const [palabra, setPalabra] = useState("");
  const [hint, setHint] = useState("");
  const [result, setResult] = useState("");
  const [mode, setMode] = useState<"new" | "expand" | null>(null);
  const [existing, setExisting] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const explore = useServerFn(exploreMeanings);

  async function go() {
    if (!palabra.trim()) return;
    setLoading(true);
    setResult("");
    setMode(null);
    setExisting(null);
    try {
      const r = await explore({ data: { palabra, hint } });
      setResult(r.text);
      setMode((r as any).mode ?? "new");
      setExisting((r as any).existing ?? null);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="msn-panel">
      <div className="msn-panel-title">✨ Explorar significados posibles</div>
      <p className="msn-hint">
        Si la palabra <strong>ya está</strong> en tu diccionario, la IA respeta su
        significado y propone nuevos contextos/matices. Si es <strong>nueva</strong>,
        propone significados posibles.
      </p>
      <div className="msn-form">
        <input
          className="msn-input"
          placeholder="palabra (nueva o existente)..."
          value={palabra}
          onChange={(e) => setPalabra(e.target.value)}
        />
        <input
          className="msn-input"
          placeholder="pista opcional (sonido, sensación, contexto...)"
          value={hint}
          onChange={(e) => setHint(e.target.value)}
        />
        <button className="msn-btn msn-btn-primary" onClick={go} disabled={loading}>
          {loading ? "pensando..." : "🔮 Explorar"}
        </button>
      </div>
      {mode === "expand" && existing && (
        <div
          style={{
            marginTop: 10,
            padding: "6px 10px",
            background: "#eaf2ff",
            border: "1px solid #a9c1e5",
            borderRadius: 3,
            fontSize: 12,
            color: "#0a246a",
          }}
        >
          🔒 <strong>{existing.palabra}</strong> ya existe — su significado no se
          modifica, solo se amplían contextos.
        </div>
      )}
      {result && <div className="msn-output">{renderMarkdown(result)}</div>}
    </div>
  );
}

function TranslateTab() {
  const [texto, setTexto] = useState("");
  const [result, setResult] = useState("");
  const [loading, setLoading] = useState(false);
  const translate = useServerFn(translateToLanguage);

  async function go() {
    if (!texto.trim()) return;
    setLoading(true);
    setResult("");
    try {
      const r = await translate({ data: { texto } });
      setResult(r.text);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="msn-panel">
      <div className="msn-panel-title">🔤 Traducir a tu idioma</div>
      <p className="msn-hint">
        Pega un texto o poema. La IA lo re-escribirá usando palabras de tu diccionario donde
        encajen semánticamente.
      </p>
      <textarea
        className="msn-input msn-textarea"
        rows={7}
        placeholder="Escribe o pega aquí..."
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
      />
      <button
        className="msn-btn msn-btn-primary"
        onClick={go}
        disabled={loading}
        style={{ marginTop: 8 }}
      >
        {loading ? "mutando..." : "🌀 Mutar a mi idioma"}
      </button>
      {result && <div className="msn-output">{renderMarkdown(result)}</div>}
    </div>
  );
}

function PoemsTab() {
  const [tema, setTema] = useState("");
  const [forma, setForma] = useState<"haiku" | "mini-poema" | "aforismo">("haiku");
  const [result, setResult] = useState("");
  const [loading, setLoading] = useState(false);
  const makeit = useServerFn(makeHaiku);

  async function go() {
    setLoading(true);
    setResult("");
    try {
      const r = await makeit({ data: { tema, forma } });
      setResult(r.text);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="msn-panel">
      <div className="msn-panel-title">🌙 Haikus & mini-poemas</div>
      <p className="msn-hint">
        Genera piezas breves usando las palabras que has inventado.
      </p>
      <div className="msn-form">
        <div className="msn-radio-row">
          {(["haiku", "mini-poema", "aforismo"] as const).map((f) => (
            <label key={f} className={`msn-radio ${forma === f ? "msn-radio-on" : ""}`}>
              <input
                type="radio"
                name="forma"
                checked={forma === f}
                onChange={() => setForma(f)}
              />
              {f}
            </label>
          ))}
        </div>
        <input
          className="msn-input"
          placeholder="tema o semilla (opcional): lluvia, insomnio, tu gato..."
          value={tema}
          onChange={(e) => setTema(e.target.value)}
        />
        <button className="msn-btn msn-btn-primary" onClick={go} disabled={loading}>
          {loading ? "componiendo..." : "🌸 Generar"}
        </button>
      </div>
      {result && <div className="msn-output msn-poem">{renderMarkdown(result)}</div>}
    </div>
  );
}

// tiny markdown-ish renderer for bold, italics, bullets, headings, line breaks
function renderMarkdown(text: string) {
  const html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/^### (.+)$/gm, "<h4>$1</h4>")
    .replace(/^## (.+)$/gm, "<h3>$1</h3>")
    .replace(/^# (.+)$/gm, "<h2>$1</h2>")
    .replace(/^[-•] (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>[\s\S]*?<\/li>)/g, "<ul>$1</ul>")
    .replace(/\n{2,}/g, "</p><p>")
    .replace(/\n/g, "<br/>");
  return <div dangerouslySetInnerHTML={{ __html: `<p>${html}</p>` }} />;
}