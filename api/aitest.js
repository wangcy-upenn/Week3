// Debug helper: open /api/aitest to see whether the AI key works.
// Never prints the key itself.
export default async function handler(req, res) {
  const key = process.env.DEEPSEEK_API_KEY;
  const out = {
    hasDeepSeekKey: !!key,
    keyLooksRight: !!key && key.trim().startsWith("sk-"),
    keyHasSpaces: !!key && key !== key.trim(),
    hasTomTomKey: !!process.env.TOMTOM_API_KEY,
    model: process.env.DEEPSEEK_MODEL || "deepseek-flash",
  };
  if (!key) return res.status(200).json(out);
  try {
    const r = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + key.trim() },
      body: JSON.stringify({
        model: out.model,
        max_tokens: 20,
        messages: [{ role: "user", content: "Say hi in 3 words." }],
      }),
    });
    out.status = r.status;
    out.reply = (await r.text()).slice(0, 400);
  } catch (e) {
    out.error = String(e.message || e);
  }
  res.status(200).json(out);
}
