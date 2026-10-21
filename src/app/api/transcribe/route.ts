import { requireUser } from "@/lib/auth";
import { config, voiceEnabled } from "@/lib/config";
import { takeToken, tooManyRequests } from "@/lib/ratelimit";

export const runtime = "nodejs";

/**
 * Both providers speak the same OpenAI-style transcription API, so one request shape
 * serves either. Groq first (free-tier Whisper), OpenAI if Groq is missing or fails.
 */
const PROVIDERS = [
  {
    name: "groq",
    url: "https://api.groq.com/openai/v1/audio/transcriptions",
    key: () => process.env.GROQ_API_KEY,
    model: () => config.voice.groqModel,
  },
  {
    name: "openai",
    url: "https://api.openai.com/v1/audio/transcriptions",
    key: () => process.env.OPENAI_API_KEY,
    model: () => config.voice.openaiModel,
  },
];

async function transcribe(audio: File): Promise<string> {
  const failures: string[] = [];
  for (const p of PROVIDERS) {
    const key = p.key();
    if (!key) continue;
    const form = new FormData();
    form.set("file", audio, audio.name);
    form.set("model", p.model());
    form.set("response_format", "json");
    form.set("temperature", "0");
    try {
      const res = await fetch(p.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        failures.push(`${p.name}: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
        continue;
      }
      const json = (await res.json()) as { text?: string };
      return (json.text ?? "").trim();
    } catch (err) {
      failures.push(`${p.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.warn("[voice] transcription failed", failures);
  throw new Error("Couldn't transcribe the recording. Please try again or type your question.");
}

/** POST multipart { audio } — a short recording from the mic button, returned as text. */
export async function POST(request: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;
  if (!voiceEnabled())
    return Response.json({ error: "Voice input isn't set up on this server." }, { status: 503 });

  const form = await request.formData();
  const audio = form.get("audio");
  if (!(audio instanceof File) || !audio.size)
    return Response.json({ error: "No recording received." }, { status: 400 });
  if (audio.size > config.voice.maxBytes)
    return Response.json({ error: "That recording is too long. Keep it under two minutes." }, { status: 413 });
  if (!/^(audio|video)\//.test(audio.type))
    return Response.json({ error: "That isn't an audio recording." }, { status: 415 });

  const limit = takeToken(user, "voice");
  if (!limit.ok) return tooManyRequests(limit.message, limit.retryAfterSec);

  try {
    const text = await transcribe(audio);
    if (!text) return Response.json({ error: "No speech was detected. Try again a little closer to the mic." }, { status: 422 });
    return Response.json({ text });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
