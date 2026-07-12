import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { generateText } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "./ai-gateway.server";

const MODEL = "google/gemini-2.5-flash";

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
    const provider = gateway();
    const existing = dict.find(
      (d: any) => d.palabra.toLowerCase().trim() === data.palabra.toLowerCase().trim(),
    );

    const prompt = existing
      ? `Eres cómplice poético de un idioma privado. La persona ya tiene esta palabra definida y quiere EXPANDIRLA sin modificar su significado base.\n\nPalabra: "${existing.palabra}"\nDefinición existente (NO la cambies, respétala como base): ${existing.definicion || "(sin definición escrita, pero la persona ya la considera suya)"}\nCategoría: ${existing.categoria}\n${existing.ejemplos ? `Ejemplo previo: ${existing.ejemplos}` : ""}\n\nResto del diccionario para contexto:\n${dictionaryToPrompt(dict.filter((d: any) => d !== existing))}\n${data.hint ? `\nPista de la persona: ${data.hint}` : ""}\n\nManteniendo intacto el significado original, propón 4-6 EXTENSIONES:\n• un contexto o registro nuevo (íntimo / cotidiano / técnico / mítico / conversacional / poético)\n• un matiz o derivación (verbo, adjetivo, uso metafórico, etc.)\n• un ejemplo breve donde se aprecie ese matiz\n\nNo redefinas la palabra: amplía su rango de uso. Español, tono íntimo. Markdown con viñetas.`
      : `Eres cómplice poético de un idioma privado en construcción. La persona propone una palabra NUEVA (no está en el diccionario) y quiere explorar sus significados posibles.\n\nDiccionario existente para contexto:\n${dictionaryToPrompt(dict)}\n\nPalabra nueva: "${data.palabra}"\n${data.hint ? `Pista: ${data.hint}` : ""}\n\nProponme 4-6 significados distintos y evocadores para esta palabra. Cada uno con:\n• un matiz (concreto / abstracto / emocional / técnico / mítico)\n• una definición de 1-2 frases\n• un ejemplo brevísimo de uso\n\nTono: íntimo, curioso, ligero. Español. Formato markdown con viñetas.`;

    const { text } = await generateText({ model: provider(MODEL), prompt });
    return { text, mode: existing ? "expand" : "new", existing: existing ?? null };
  });

export const translateToLanguage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ texto: z.string().min(1) }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const dict = await fetchDictionary(context.supabase, context.userId);
    const provider = gateway();
    const { text } = await generateText({
      model: provider(MODEL),
      prompt: `Eres traductora al idioma privado de esta persona. Usa SOLO palabras del diccionario cuando encajen semánticamente; para el resto conserva español natural. Prioriza sustituir sustantivos, verbos y emociones clave. No inventes palabras nuevas fuera del diccionario.\n\nDiccionario:\n${dictionaryToPrompt(dict)}\n\nTexto original:\n${data.texto}\n\nDevuélveme:\n1. **Versión traducida** (el texto mutado con las palabras del diccionario en cursivas *así*).\n2. **Glosario** de las palabras del diccionario que usaste, con su definición.\n\nNo agregues nada más.`,
    });
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
    const provider = gateway();
    const forma =
      data.forma === "haiku"
        ? "un haiku (3 líneas, 5-7-5 sílabas aproximadas)"
        : data.forma === "aforismo"
          ? "un aforismo de una sola línea"
          : "un mini-poema de 4 a 6 líneas breves";
    const { text } = await generateText({
      model: provider(MODEL),
      prompt: `Escribe ${forma} usando al menos 2 palabras del diccionario privado. Ponlas en *cursivas*.\n\nDiccionario:\n${dictionaryToPrompt(dict)}\n\nTema o semilla: ${data.tema || "(libre)"}\n\nAl final, en una línea aparte muy breve, glosa entre paréntesis las palabras inventadas que usaste.`,
    });
    return { text };
  });