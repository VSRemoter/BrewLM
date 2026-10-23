/**
 * Sign-in emails through Resend. Without RESEND_API_KEY (local development)
 * the link is printed to the server console instead, so the whole flow can
 * be tested without sending mail.
 */
export async function sendSignInEmail(env: Env, to: string, link: string, code: string): Promise<void> {
  if (!env.RESEND_API_KEY) {
    console.log(`[dev] sign-in link for ${to} (code ${code}): ${link}`);
    return;
  }
  const text = `Click to sign in to BrewLM Sync:\n\n${link}\n\nCheck that BrewLM shows the code ${code}. The link works once, for 15 minutes.\nDidn't try to sign in? Ignore this email.`;
  const html = `<p>Click to sign in to BrewLM Sync:</p>
<p><a href="${link}" style="display:inline-block;padding:10px 20px;border-radius:999px;background:#c2410c;color:#fff;text-decoration:none;font-weight:600">Sign in to BrewLM</a></p>
<p>Check that BrewLM shows the code <b>${code}</b>. The link works once, for 15 minutes.</p>
<p style="color:#888">Didn't try to sign in? Ignore this email.</p>`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: env.EMAIL_FROM, to, subject: "Your BrewLM sign-in link", text, html }),
  });
  if (!res.ok) throw new Error(`email: Resend HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}
