// api/aanvragen.js — zoekopdrachten voor het beheer van h-mcars.nl.
// Alleen toegankelijk voor het beheerdersaccount.
// Environment Variables: SUPABASE_URL, SUPABASE_SERVICE_KEY, (optioneel) ADMIN_EMAIL

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    const token = b && b.token;
    if (!token) { res.status(401).json({ error: 'Geen token' }); return; }

    const URLB = process.env.SUPABASE_URL;
    const KEY = process.env.SUPABASE_SERVICE_KEY;
    const ADMIN = (process.env.ADMIN_EMAIL || 'hmcarrss@gmail.com').toLowerCase();

    const wieR = await fetch(URLB + '/auth/v1/user', { headers: { apikey: KEY, Authorization: 'Bearer ' + token } });
    if (!wieR.ok) { res.status(401).json({ error: 'Niet ingelogd' }); return; }
    const wie = await wieR.json();
    if (((wie && wie.email) || '').toLowerCase() !== ADMIN) { res.status(403).json({ error: 'Geen toegang' }); return; }

    const r = await fetch(URLB + '/rest/v1/aanvragen?select=created_at,email,naam,telefoon,zoekt,budget,wensen,bericht,status&order=created_at.desc&limit=500', {
      headers: { apikey: KEY, Authorization: 'Bearer ' + KEY }
    });
    const rijen = r.ok ? await r.json() : [];

    const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
    const per = {};
    for (const a of rijen) {
      const sleutel = (a.email || 'onbekend').toLowerCase();
      if (!per[sleutel]) per[sleutel] = { email: esc(a.email || 'onbekend'), naam: esc(a.naam || ''), telefoon: esc(a.telefoon || ''), items: [] };
      if (!per[sleutel].naam && a.naam) per[sleutel].naam = esc(a.naam);
      if (!per[sleutel].telefoon && a.telefoon) per[sleutel].telefoon = esc(a.telefoon);
      per[sleutel].items.push({
        datum: new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', dateStyle: 'short', timeStyle: 'short' }).format(new Date(a.created_at)),
        zoekt: esc(a.zoekt), budget: esc(a.budget), wensen: esc(a.wensen), bericht: esc(a.bericht), status: esc(a.status)
      });
    }
    res.status(200).json({ accounts: Object.values(per) });
  } catch (e) {
    res.status(500).json({ error: 'serverfout' });
  }
}
