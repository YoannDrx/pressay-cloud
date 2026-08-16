import { createHash } from 'node:crypto';

import { Resend } from 'resend';

import { getEnvironment, requireEnvironmentValue } from '../env.ts';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export async function sendMagicLinkEmail(input: {
  email: string;
  url: string;
}): Promise<void> {
  const environment = getEnvironment();
  const resend = new Resend(
    requireEnvironmentValue(environment.RESEND_API_KEY, 'RESEND_API_KEY'),
  );
  const safeUrl = escapeHtml(input.url);
  const idempotencyKey = `magic-link/${createHash('sha256')
    .update(input.url)
    .digest('hex')}`;
  const { error } = await resend.emails.send(
    {
      from: environment.PRESSAY_AUTH_FROM_EMAIL,
      to: input.email,
      subject: 'Votre lien de connexion Pressay',
      text: `Ouvrez ce lien pour vous connecter à Pressay : ${input.url}\n\nCe lien expire dans 10 minutes et ne peut être utilisé qu'une fois.`,
      html: `<div style="background:#0a0b0d;color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;padding:40px"><div style="background:#121419;border:1px solid #262a33;border-radius:12px;margin:auto;max-width:520px;padding:32px"><p style="color:#9298a3;font-size:13px;letter-spacing:.08em;text-transform:uppercase">Pressay</p><h1 style="font-size:24px;font-weight:600;margin:24px 0 12px">Connexion à Pressay</h1><p style="color:#c6cad1;line-height:1.6">Utilisez ce lien unique pour terminer votre connexion. Il expire dans 10 minutes.</p><p style="margin:28px 0"><a href="${safeUrl}" style="background:#5668ff;border-radius:8px;color:white;display:inline-block;padding:12px 18px;text-decoration:none">Se connecter</a></p><p style="color:#9298a3;font-size:13px;line-height:1.5">Si vous n’avez pas demandé ce lien, vous pouvez ignorer cet email.</p></div></div>`,
    },
    { idempotencyKey },
  );

  if (error) throw new Error('Magic-link email delivery failed');
}
