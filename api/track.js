// api/track.js — draait op Vercel (server-side).
// Leest het echte IP-adres en de locatie (land/stad/regio) uit de Vercel-headers
// en slaat het bezoek op in je Supabase-tabel "bezoeken".
//
// Vereist twee Environment Variables in Vercel:
//   SUPABASE_URL          = https://kzgapkklsewqexeldgto.supabase.co
//   SUPABASE_SERVICE_KEY  = de service_role key (Supabase > Settings > API) — GEHEIM houden!

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const h = req.headers;

    // Echt IP van de bezoeker (eerste in de lijst)
    const ip = ((h['x-forwarded-for'] || '').split(',')[0] || '').trim() || null;

    // Locatie die Vercel automatisch meestuurt
    const land = h['x-vercel-ip-country'] || null;
    const regio = h['x-vercel-ip-country-region'] || null;
    const stad = h['x-vercel-ip-city'] ? decodeURIComponent(h['x-vercel-ip-city']) : null;
    const postcode = h['x-vercel-ip-postal-code'] || null;
    const tijdzone = h['x-vercel-ip-timezone'] || null;

    // Gegevens vanuit de browser
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    b = b || {};

    const row = {
      pagina: b.pagina || null,
      referrer: b.referrer || null,
      utm_source: b.utm_source || null,
      utm_medium: b.utm_medium || null,
      utm_campaign: b.utm_campaign || null,
      taal: b.taal || null,
      scherm: b.scherm || null,
      user_agent: h['user-agent'] || null,
      ip: ip,
      land: land,
      stad: stad,
      regio: regio,
      postcode: postcode,
      tijdzone: tijdzone
    };

    const r = await fetch(process.env.SUPABASE_URL + '/rest/v1/bezoeken', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.SUPABASE_SERVICE_KEY,
        'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(row)
    });

    res.status(r.ok ? 204 : 500).end();
  } catch (e) {
    res.status(500).end();
  }
}
