// api/stats.js — beveiligde statistieken voor het beheer van h-mcars.nl.
// Alleen op te vragen met een geldige beheer-login (Supabase-sessie).
//   {token}                       → tegels, herkomst en recente bezoeken (zoals altijd)
//   {token, actie:'kaart', dagen} → bezoekers met locatie voor de kaart en de filters
// Environment Variables: SUPABASE_URL, SUPABASE_SERVICE_KEY, (optioneel) ADMIN_EMAIL

import { provincieNaam, landNaam, leesUA, supa } from './_geo.js';

const MAX_RIJEN = 30000;

// Haalt alle rijen op in blokken van 1000 (Supabase geeft er standaard maximaal 1000 per keer)
async function alleRijen(URLB, kop, pad) {
  const uit = [];
  for (let van = 0; van < MAX_RIJEN; van += 1000) {
    const r = await fetch(URLB + pad, { headers: { ...kop, Range: van + '-' + (van + 999) } });
    if (!r.ok) { if (van === 0) throw new Error('lezen mislukt: ' + r.status); break; }
    const blok = await r.json();
    uit.push(...blok);
    if (blok.length < 1000) break;
  }
  return uit;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    const token = b && b.token;
    if (!token) { res.status(401).json({ error: 'Geen token' }); return; }

    const { URLB, KEY, kop } = supa();

    // 1) Controleer dat het token bij de beheerder hoort
    const wie = await fetch(URLB + '/auth/v1/user', { headers: { apikey: KEY, Authorization: 'Bearer ' + token } });
    if (!wie.ok) { res.status(401).json({ error: 'Niet ingelogd' }); return; }
    const wieJ = await wie.json();
    const ADMIN = (process.env.ADMIN_EMAIL || 'hmcarrss@gmail.com').toLowerCase();
    if (((wieJ && wieJ.email) || '').toLowerCase() !== ADMIN) { res.status(403).json({ error: 'Geen toegang' }); return; }

    if (b.actie === 'kaart') { res.status(200).json(await kaart(URLB, kop, b.dagen)); return; }

    // 2) Totaal aantal paginaweergaven, inclusief bezoeken die na de bewaartermijn zijn opgeruimd
    const totR = await fetch(URLB + '/rest/v1/bezoeken?select=id&type=not.eq.hartslag&limit=1', {
      headers: { ...kop, Prefer: 'count=exact', Range: '0-0' }
    });
    let totaal = parseInt((totR.headers.get('content-range') || '/0').split('/')[1], 10) || 0;
    try {
      const a = await fetch(URLB + '/rest/v1/instellingen?select=waarde&sleutel=eq.bezoeken_archief', { headers: kop });
      if (a.ok) { const j = await a.json(); totaal += parseInt((j[0] && j[0].waarde) || '0', 10) || 0; }
    } catch (e) {}

    // 3) Laatste 8 dagen samenvatten
    const sinds = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    const rijen = await alleRijen(URLB, kop, '/rest/v1/bezoeken?select=created_at,type,sessie,stad,land,referrer,utm_source,scherm,tijd_lokaal&created_at=gte.' + encodeURIComponent(sinds) + '&order=created_at.desc')
      .catch(() => []);

    const dagVan = (iso) => new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', dateStyle: 'short' }).format(new Date(iso));
    const vandaagS = dagVan(new Date().toISOString());
    const gisterS = dagVan(new Date(Date.now() - 24 * 3600 * 1000).toISOString());

    let vandaag = 0, gisteren = 0, week = 0;
    const liveSes = new Set();
    const bronnen = {};
    const recent = [];
    const nu = Date.now();
    const weekGrens = nu - 7 * 864e5;

    for (const r of rijen) {
      const isHart = r.type === 'hartslag';
      const t = new Date(r.created_at).getTime();
      if (nu - t < 2.5 * 60 * 1000 && r.sessie) liveSes.add(r.sessie);
      if (isHart) continue;
      if (t >= weekGrens) week++;
      const d = dagVan(r.created_at);
      if (d === vandaagS) vandaag++;
      if (d === gisterS) gisteren++;
      let bron = r.utm_source || null;
      if (!bron && r.referrer) { try { bron = new URL(r.referrer).hostname.replace('www.', ''); } catch (e) { bron = r.referrer; } }
      if (bron && !/h-mcars/.test(bron) && t >= weekGrens) bronnen[bron] = (bronnen[bron] || 0) + 1;
      if (recent.length < 20) {
        recent.push({ tijd: r.tijd_lokaal || dagVan(r.created_at), plaats: [r.stad, r.land].filter(Boolean).join(', '), bron: bron || null, scherm: r.scherm || null });
      }
    }
    const bronLijst = Object.keys(bronnen).map((k) => ({ naam: k, n: bronnen[k] })).sort((a, b2) => b2.n - a.n).slice(0, 8);
    res.status(200).json({ live: liveSes.size, vandaag, gisteren, week, totaal, bronnen: bronLijst, recent });
  } catch (e) {
    res.status(500).json({ error: 'serverfout' });
  }
}

/* ---------- Bezoekers per sessie, met locatie, voor kaart en filters ---------- */
async function kaart(URLB, kop, dagenIn) {
  const dagen = [1, 7, 30, 90].includes(Number(dagenIn)) ? Number(dagenIn) : 7;
  const sinds = encodeURIComponent(new Date(Date.now() - dagen * 864e5).toISOString());

  const rijen = await alleRijen(URLB, kop, '/rest/v1/bezoeken?select=*&type=not.eq.hartslag&created_at=gte.' + sinds + '&order=created_at.asc');
  let locs = [];
  try {
    locs = await alleRijen(URLB, kop, '/rest/v1/locaties?select=sessie,lat,lng,nauwkeurigheid_m,afstand_km,created_at&created_at=gte.' + sinds + '&order=created_at.asc');
  } catch (e) { /* tabel bestaat nog niet: alleen IP-locaties */ }

  const per = new Map();
  rijen.forEach((r, i) => {
    const k = r.sessie || ('rij-' + i);
    let v = per.get(k);
    if (!v) {
      const ua = (r.apparaat || r.browser) ? { apparaat: r.apparaat, browser: r.browser, os: r.os } : leesUA(r.user_agent);
      let herkomst = r.utm_source || null;
      if (!herkomst && r.referrer) { try { herkomst = new URL(r.referrer).hostname.replace(/^www\./, ''); } catch (e) { herkomst = r.referrer; } }
      if (herkomst && /h-mcars/.test(herkomst)) herkomst = null;
      v = {
        t: r.created_at, tijd: r.tijd_lokaal || null,
        land: r.land || null, landNaam: landNaam(r.land), provincie: r.provincie || provincieNaam(r.land, r.regio), stad: r.stad || null,
        bron: 'ip', lat: r.ip_lat ?? null, lng: r.ip_lng ?? null, acc: null, afstand: null,
        paginas: [], n: 0, herkomst, utm: r.utm_campaign || null,
        apparaat: ua.apparaat, browser: ua.browser, os: ua.os
      };
      per.set(k, v);
    }
    v.n++;
    if (r.pagina && !v.paginas.includes(r.pagina) && v.paginas.length < 15) v.paginas.push(r.pagina);
    if (v.lat == null && r.ip_lat != null) { v.lat = r.ip_lat; v.lng = r.ip_lng; }
  });

  // Gedeelde locaties gaan vóór de IP-schatting
  let gedeeld = 0;
  for (const l of locs) {
    let v = per.get(l.sessie);
    if (!v) {
      // Locatie gedeeld zonder cookie-toestemming: alleen de locatie zelf is bekend
      v = { t: l.created_at, tijd: null, land: null, landNaam: null, provincie: null, stad: null, paginas: [], n: 0,
            herkomst: null, utm: null, apparaat: null, browser: null, os: null };
      per.set(l.sessie, v);
    }
    v.bron = 'browser'; v.lat = l.lat; v.lng = l.lng; v.acc = l.nauwkeurigheid_m; v.afstand = l.afstand_km != null ? Number(l.afstand_km) : null;
    gedeeld++;
  }

  const bezoekers = Array.from(per.values()).filter((v) => v.apparaat !== 'Bot').sort((a, b) => (a.t < b.t ? 1 : -1));
  return { dagen, weergaven: rijen.length, bezoekers: bezoekers.slice(0, 5000), totaalBezoekers: bezoekers.length, gedeeld, afgekapt: rijen.length >= MAX_RIJEN };
}
