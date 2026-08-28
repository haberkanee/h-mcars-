// api/stats.js — beveiligde statistieken voor het beheer van h-mcars.nl.
// Alleen op te vragen met een geldige beheer-login (Supabase-sessie).
// Gebruikt dezelfde Environment Variables als track.js:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    const token = b && b.token;
    if (!token) { res.status(401).json({ error: 'Geen token' }); return; }

    const URLB = process.env.SUPABASE_URL;
    const KEY = process.env.SUPABASE_SERVICE_KEY;

    // 1) Controleer dat het token bij een ingelogde beheerder hoort
    const wie = await fetch(URLB + '/auth/v1/user', {
      headers: { apikey: KEY, Authorization: 'Bearer ' + token }
    });
    if (!wie.ok) { res.status(401).json({ error: 'Niet ingelogd' }); return; }
    const wieJ = await wie.json();
    const ADMIN = (process.env.ADMIN_EMAIL || 'hmcarrss@gmail.com').toLowerCase();
    if (((wieJ && wieJ.email) || '').toLowerCase() !== ADMIN) { res.status(403).json({ error: 'Geen toegang' }); return; }

    const kop = { apikey: KEY, Authorization: 'Bearer ' + KEY };

    // 2) Totaal aantal paginaweergaven (alleen echte bezoeken, geen hartslagen)
    const totR = await fetch(URLB + "/rest/v1/bezoeken?select=id&type=not.eq.hartslag&limit=1", {
      headers: { ...kop, Prefer: 'count=exact', Range: '0-0' }
    });
    const totaal = parseInt((totR.headers.get('content-range') || '/0').split('/')[1], 10) || 0;

    // 3) Rijen van de laatste 8 dagen ophalen en hier samenvatten
    const sinds = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    const rijenR = await fetch(URLB + '/rest/v1/bezoeken?select=created_at,type,sessie,stad,land,referrer,utm_source,scherm,tijd_lokaal&created_at=gte.' + encodeURIComponent(sinds) + '&order=created_at.desc&limit=5000', { headers: kop });
    const rijen = rijenR.ok ? await rijenR.json() : [];

    // Dagen berekenen in Nederlandse tijd
    const dagVan = (iso) => new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', dateStyle: 'short' }).format(new Date(iso));
    const vandaagS = dagVan(new Date().toISOString());
    const gisterS = dagVan(new Date(Date.now() - 24 * 3600 * 1000).toISOString());

    let vandaag = 0, gisteren = 0, week = 0;
    const liveSes = new Set();
    const bronnen = {};
    const recent = [];
    const nu = Date.now();

    for (const r of rijen) {
      const isHart = r.type === 'hartslag';
      const t = new Date(r.created_at).getTime();
      if (nu - t < 2.5 * 60 * 1000 && r.sessie) liveSes.add(r.sessie);
      if (isHart) continue;
      week++;
      const d = dagVan(r.created_at);
      if (d === vandaagS) vandaag++;
      if (d === gisterS) gisteren++;
      let bron = r.utm_source || null;
      if (!bron && r.referrer) { try { bron = new URL(r.referrer).hostname.replace('www.', ''); } catch (e) { bron = r.referrer; } }
      if (bron && !/h-mcars/.test(bron)) bronnen[bron] = (bronnen[bron] || 0) + 1;
      if (recent.length < 20) {
        recent.push({
          tijd: r.tijd_lokaal || dagVan(r.created_at),
          plaats: [r.stad, r.land].filter(Boolean).join(', '),
          bron: bron || null,
          scherm: r.scherm || null
        });
      }
    }

    const bronLijst = Object.keys(bronnen).map(k => ({ naam: k, n: bronnen[k] }))
      .sort((a, b2) => b2.n - a.n).slice(0, 8);

    res.status(200).json({ live: liveSes.size, vandaag, gisteren, week, totaal, bronnen: bronLijst, recent });
  } catch (e) {
    res.status(500).json({ error: 'serverfout' });
  }
}
