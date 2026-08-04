import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { generateText } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "./ai-gateway.server";

const MODEL = "google/gemini-3.6-flash";

/** Guarda cada interacción para que el sistema aprenda de nosotros. */
async function logBitacora(
  supabase: any,
  userId: string,
  tipo: string,
  entrada: string,
  salida: string,
) {
  try {
    await supabase.from("bitacora").insert({
      user_id: userId,
      tipo,
      entrada: entrada.slice(0, 4000),
      salida: salida.slice(0, 8000),
    });
  } catch {
    /* el log nunca debe romper la experiencia */
  }
}

/** Memoria reciente: qué hemos hecho y qué ya respondió la IA (para no repetirse). */
async function fetchBitacora(supabase: any, userId: string, tipo?: string, limit = 8) {
  let q = supabase
    .from("bitacora")
    .select("tipo, entrada, salida, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (tipo) q = q.eq("tipo", tipo);
  const { data } = await q;
  return data ?? [];
}

function antiRepeat(prev: any[]) {
  if (!prev.length) return "";
  const chunks = prev
    .map((b, i) => `--- respuesta previa #${i + 1} (${b.entrada.slice(0, 60)}) ---\n${String(b.salida).slice(0, 700)}`)
    .join("\n");
  return `\n\nMEMORIA — ya dijiste esto antes. NO lo repitas, ni sus imágenes, ni su estructura, ni sus ejemplos. Busca un ángulo claramente distinto:\n${chunks}\n`;
}

function seed() {
  return `\n\n[semilla de variación: ${Math.random().toString(36).slice(2, 10)} — usa un enfoque distinto al obvio]`;
}

function styleMemory(prev: any[]) {
  if (!prev.length) return "";
  return `\n\nAPRENDIZAJE: estas son cosas recientes que esta persona escribió. Absorbe su tono, obsesiones y ritmo; escribe como alguien que la conoce:\n${prev
    .map((b) => `• [${b.tipo}] ${String(b.entrada).slice(0, 200)}`)
    .join("\n")}\n`;
}

export const bulkImportPalabras = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({
      items: z
        .array(
          z.object({
            palabra: z.string().min(1),
            definicion: z.string().default(""),
            categoria: z.string().default("sin categoría"),
            ejemplos: z.string().default(""),
          }),
        )
        .min(1)
        .max(1000),
    }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const { data: existing } = await supabase
      .from("palabras")
      .select("palabra")
      .eq("user_id", userId);
    const existingSet = new Set(
      (existing ?? []).map((r: any) => r.palabra.toLowerCase().trim()),
    );
    const seen = new Set<string>();
    const toInsert: any[] = [];
    let skipped = 0;
    for (const it of data.items) {
      const key = it.palabra.toLowerCase().trim();
      if (existingSet.has(key) || seen.has(key)) {
        skipped++;
        continue;
      }
      seen.add(key);
      toInsert.push({
        user_id: userId,
        palabra: it.palabra.trim(),
        definicion: it.definicion,
        categoria: it.categoria || "sin categoría",
        ejemplos: it.ejemplos,
      });
    }
    if (toInsert.length === 0) return { inserted: 0, skipped };
    // batch inserts to avoid payload limits
    let inserted = 0;
    for (let i = 0; i < toInsert.length; i += 100) {
      const chunk = toInsert.slice(i, i + 100);
      const { error } = await supabase.from("palabras").insert(chunk);
      if (error) throw new Error(error.message);
      inserted += chunk.length;
    }
    return { inserted, skipped };
  });

function gateway() {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("Falta LOVABLE_API_KEY");
  return createLovableAiGatewayProvider(key);
}

async function fetchDictionary(supabase: any, userId: string) {
  const { data } = await supabase
    .from("palabras")
    .select("palabra, definicion, categoria, ejemplos")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(200);
  return data ?? [];
}

function dictionaryToPrompt(dict: any[]) {
  if (!dict.length) return "(el diccionario está vacío todavía)";
  return dict
    .map(
      (d) =>
        `- ${d.palabra} [${d.categoria}]: ${d.definicion}${
          d.ejemplos ? ` | Ej: ${d.ejemplos}` : ""
        }`,
    )
    .join("\n");
}

export const suggestCategory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ palabra: z.string().min(1), definicion: z.string().default("") }).parse(input),
  )
  .handler(async ({ data }) => {
    const provider = gateway();
    const { text } = await generateText({
      model: provider(MODEL),
      prompt: `Devuelve UNA sola categoría corta (1-2 palabras, en minúsculas, sin comillas ni puntuación) para esta palabra inventada.\nPalabra: ${data.palabra}\nDefinición: ${data.definicion || "(vacía)"}\n\nEjemplos de categorías: emoción, objeto, verbo, tiempo, cuerpo, relación, sonido, lugar, sensación, filosófico.\n\nResponde SOLO con la categoría.`,
    });
    return { categoria: text.trim().toLowerCase().replace(/[^\p{L}\s-]/gu, "").slice(0, 40) };
  });

export const exploreMeanings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ palabra: z.string().min(1), hint: z.string().default("") }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const dict = await fetchDictionary(context.supabase, context.userId);
    const prev = await fetchBitacora(context.supabase, context.userId, "explorar", 5);
    const provider = gateway();
    const existing = dict.find(
      (d: any) => d.palabra.toLowerCase().trim() === data.palabra.toLowerCase().trim(),
    );

    const prompt = existing
      ? `Eres cómplice poético de un idioma privado. La persona ya tiene esta palabra definida y quiere EXPANDIRLA sin modificar su significado base.\n\nPalabra: "${existing.palabra}"\nDefinición existente (NO la cambies, respétala como base): ${existing.definicion || "(sin definición escrita, pero la persona ya la considera suya)"}\nCategoría: ${existing.categoria}\n${existing.ejemplos ? `Ejemplo previo: ${existing.ejemplos}` : ""}\n\nResto del diccionario para contexto:\n${dictionaryToPrompt(dict.filter((d: any) => d !== existing))}\n${data.hint ? `\nPista de la persona: ${data.hint}` : ""}\n\nManteniendo intacto el significado original, propón 4-6 EXTENSIONES:\n• un contexto o registro nuevo (íntimo / cotidiano / técnico / mítico / conversacional / poético)\n• un matiz o derivación (verbo, adjetivo, uso metafórico, etc.)\n• un ejemplo breve donde se aprecie ese matiz\n\nNo redefinas la palabra: amplía su rango de uso. Español, tono íntimo. Markdown con viñetas.`
      : `Eres cómplice poético de un idioma privado en construcción. La persona propone una palabra NUEVA (no está en el diccionario) y quiere explorar sus significados posibles.\n\nDiccionario existente para contexto:\n${dictionaryToPrompt(dict)}\n\nPalabra nueva: "${data.palabra}"\n${data.hint ? `Pista: ${data.hint}` : ""}\n\nProponme 4-6 significados distintos y evocadores para esta palabra. Cada uno con:\n• un matiz (concreto / abstracto / emocional / técnico / mítico)\n• una definición de 1-2 frases\n• un ejemplo brevísimo de uso\n\nTono: íntimo, curioso, ligero. Español. Formato markdown con viñetas.`;

    const { text } = await generateText({
      model: provider(MODEL),
      prompt:
        prompt +
        antiRepeat(prev.filter((p: any) => String(p.entrada).startsWith(data.palabra))) +
        seed(),
    });
    await logBitacora(
      context.supabase,
      context.userId,
      "explorar",
      `${data.palabra} ${data.hint}`,
      text,
    );
    return { text, mode: existing ? "expand" : "new", existing: existing ?? null };
  });

export const translateToLanguage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ texto: z.string().min(1) }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const dict = await fetchDictionary(context.supabase, context.userId);
    const prev = await fetchBitacora(context.supabase, context.userId, "traducir", 4);
    const provider = gateway();
    const { text } = await generateText({
      model: provider(MODEL),
      prompt: `Eres traductora al idioma privado de esta persona.${styleMemory(prev)} Usa SOLO palabras del diccionario cuando encajen semánticamente; para el resto conserva español natural. Prioriza sustituir sustantivos, verbos y emociones clave. No inventes palabras nuevas fuera del diccionario.\n\nDiccionario:\n${dictionaryToPrompt(dict)}\n\nTexto original:\n${data.texto}\n\nDevuélveme:\n1. **Versión traducida** (el texto mutado con las palabras del diccionario en cursivas *así*).\n2. **Glosario** de las palabras del diccionario que usaste, con su definición.\n\nNo agregues nada más.${seed()}`,
    });
    await logBitacora(context.supabase, context.userId, "traducir", data.texto, text);
    await logBitacora(
      context.supabase,
      context.userId,
      "poema",
      `${data.forma}: ${data.tema}`,
      text,
    );
    return { text };
  });

/* ─────────── Ingesta masiva de texto largo ─────────── */

function chunkText(text: string, size = 9000) {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size * 0.5) cut = size;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) chunks.push(rest);
  return chunks;
}

function extractJsonArray(raw: string): any[] {
  const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1) return [];
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export const analyzeLongText = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ texto: z.string().min(10).max(200000) }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const provider = gateway();

    const { data: existing } = await supabase
      .from("palabras")
      .select("palabra")
      .eq("user_id", userId);
    const existingSet = new Set(
      (existing ?? []).map((r: any) => String(r.palabra).toLowerCase().trim()),
    );

    const chunks = chunkText(data.texto);
    const seen = new Set<string>();
    const nuevas: any[] = [];
    let repetidas = 0;

    for (const chunk of chunks) {
      const { text } = await generateText({
        model: provider(MODEL),
        prompt: `Analiza este texto y extrae ÚNICAMENTE las palabras inventadas / neologismos / términos no estándar del español (ignora palabras normales, nombres propios comunes y erratas obvias).\n\nPara cada una devuelve un objeto con:\n"palabra" (la forma base, en minúsculas),\n"definicion" (si el texto la define, úsala tal cual, resumida; si no, deduce una definición breve y plausible desde el contexto),\n"categoria" (1-2 palabras en minúsculas: emoción, objeto, verbo, tiempo, cuerpo, relación, sonido, lugar, sensación, filosófico, etc.),\n"ejemplos" (una frase del texto donde aparece, o "").\n\nResponde SOLO con un array JSON válido, sin explicaciones ni markdown.\n\nTEXTO:\n${chunk}`,
      });
      for (const it of extractJsonArray(text)) {
        const palabra = String(it?.palabra ?? "").trim();
        if (!palabra || palabra.length > 60) continue;
        const key = palabra.toLowerCase();
        if (seen.has(key)) {
          repetidas++;
          continue;
        }
        seen.add(key);
        if (existingSet.has(key)) {
          repetidas++;
          continue;
        }
        nuevas.push({
          palabra,
          definicion: String(it?.definicion ?? "").trim(),
          categoria: String(it?.categoria ?? "sin categoría").trim().toLowerCase() || "sin categoría",
          ejemplos: String(it?.ejemplos ?? "").trim(),
        });
      }
    }

    await logBitacora(
      supabase,
      userId,
      "ingesta",
      data.texto.slice(0, 2000),
      `${nuevas.length} nuevas / ${repetidas} repetidas`,
    );

    return { nuevas, repetidas, bloques: chunks.length };
  });

/* ─────────── Autocrecimiento: propone nuevos juegos ─────────── */

export const proposeGames = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ nota: z.string().default("") }).parse(input))
  .handler(async ({ context, data }) => {
    const dict = await fetchDictionary(context.supabase, context.userId);
    const prev = await fetchBitacora(context.supabase, context.userId, undefined, 20);
    const juegosPrev = prev.filter((p: any) => p.tipo === "juegos");
    const provider = gateway();

    const { text } = await generateText({
      model: provider(MODEL),
      prompt: `Eres el motor de autocrecimiento de un idioma privado. Observa cómo esta persona ha estado usando su diccionario y propón 4 JUEGOS o RITUALES nuevos, específicos para ELLA (no genéricos).\n\nMuestra del diccionario (${dict.length} palabras cargadas):\n${dictionaryToPrompt(dict.slice(0, 60))}\n${styleMemory(prev)}\n${data.nota ? `Deseo explícito de la persona: ${data.nota}\n` : ""}\nPara cada juego:\n**Nombre del juego** (inventado, puede usar sus propias palabras)\n• cómo se juega en 2 frases\n• un ejemplo concreto YA JUGADO con palabras reales de su diccionario\n\nAl final añade una sección "🌱 Lo que noto en tu idioma": 3 observaciones sobre patrones, huecos o direcciones de crecimiento del léxico (qué tipo de palabra le falta inventar).\n\nEspañol, íntimo, sin relleno. Markdown.${antiRepeat(juegosPrev)}${seed()}`,
    });

    await logBitacora(context.supabase, context.userId, "juegos", data.nota, text);
    return { text };
  });

export const makeHaiku = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({
      tema: z.string().default(""),
      forma: z.enum(["haiku", "mini-poema", "aforismo"]).default("haiku"),
    }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const dict = await fetchDictionary(context.supabase, context.userId);
    const prev = await fetchBitacora(context.supabase, context.userId, "poema", 6);
    const provider = gateway();
    const forma =
      data.forma === "haiku"
        ? "un haiku (3 líneas, 5-7-5 sílabas aproximadas)"
        : data.forma === "aforismo"
          ? "un aforismo de una sola línea"
          : "un mini-poema de 4 a 6 líneas breves";
    const { text } = await generateText({
      model: provider(MODEL),
      prompt: `Escribe ${forma} usando al menos 2 palabras del diccionario privado. Ponlas en *cursivas*. Elige palabras poco frecuentes del diccionario, no siempre las primeras de la lista.\n\nDiccionario:\n${dictionaryToPrompt(dict)}\n\nTema o semilla: ${data.tema || "(libre)"}\n\nAl final, en una línea aparte muy breve, glosa entre paréntesis las palabras inventadas que usaste.${styleMemory(prev)}${antiRepeat(prev)}${seed()}`,
    });
    await logBitacora(
      context.supabase,
      context.userId,
      "poema",
      `${data.forma}: ${data.tema}`,
      text,
    );
    return { text };
  });