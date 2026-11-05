// api/analyse.js — "Foto's erin, advertentie eruit" voor het beheer van h-mcars.nl.
//
// Werking:
//   1. Controleert dat de aanvraag van het beheerdersaccount komt.
//   2. Laat Claude de foto's bekijken: kenteken, merk/model, kleur, carrosserie,
//      transmissie, kilometerstand (als de teller in beeld is) en zichtbare opties.
//   3. Haalt met het kenteken de officiële gegevens op bij de RDW.
//   4. Laat Claude met al die gegevens een titel, subtitel, omschrijving en
//      optielijst schrijven in de stijl van H-M Cars.
//
// Environment Variables (Vercel → Settings → Environment Variables):
//   ANTHROPIC_API_KEY   verplicht — sleutel van console.anthropic.com
//   SUPABASE_URL        bestaat al
//   SUPABASE_SERVICE_KEY bestaat al
//   ADMIN_EMAIL         optioneel (standaard hmcarrss@gmail.com)
//   ANTHROPIC_MODEL     optioneel (standaard claude-sonnet-5-5)

import { MODEL_STANDAARD, MAX_FOTOS, MAX_GROEPEER, PROMPT_GROEPEER, maakAdvertentie, vraagJson, schoonGroepen } from './_autoai.js';

export const config = { maxDuration: 60 };


export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    b = b || {};

    // ---- 1. Alleen de beheerder ----
    const URLB = process.env.SUPABASE_URL;
    const SKEY = process.env.SUPABASE_SERVICE_KEY;
    const ADMIN = (process.env.ADMIN_EMAIL || 'hmcarrss@gmail.com').toLowerCase();
    if (!b.token) { res.status(401).json({ error: 'Niet ingelogd' }); return; }
    const wieR = await fetch(URLB + '/auth/v1/user', { headers: { apikey: SKEY, Authorization: 'Bearer ' + b.token } });
    if (!wieR.ok) { res.status(401).json({ error: 'Niet ingelogd' }); return; }
    const wie = await wieR.json();
    if (((wie && wie.email) || '').toLowerCase() !== ADMIN) { res.status(403).json({ error: 'Geen toegang' }); return; }

    const KEY = process.env.ANTHROPIC_API_KEY;
    if (!KEY) { res.status(500).json({ error: 'ANTHROPIC_API_KEY ontbreekt in Vercel' }); return; }
    const MODEL = process.env.ANTHROPIC_MODEL || MODEL_STANDAARD;

    // ---- Modus "groepeer": veel kleine foto's van meerdere auto's sorteren ----
    if (b.mode === 'groepeer') {
      const kl = (Array.isArray(b.fotos) ? b.fotos : [])
        .filter(f => typeof f === 'string' && f.length > 100 && f.length < 400_000)
        .slice(0, MAX_GROEPEER);
      if (kl.length < 1) { res.status(400).json({ error: 'Geen foto\'s ontvangen' }); return; }
      const inhoud = [];
      kl.forEach((data, i) => {
        inhoud.push({ type: 'text', text: 'Foto ' + i + ':' });
        inhoud.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } });
      });
      inhoud.push({ type: 'text', text: PROMPT_GROEPEER.replace('{N}', String(kl.length)) });
      const g = await vraagJson(KEY, MODEL, inhoud, 1500);
      res.status(200).json({ groepen: schoonGroepen(g.groepen, kl.length) });
      return;
    }

    const fotos = (Array.isArray(b.fotos) ? b.fotos : [])
      .filter(f => typeof f === 'string' && f.length > 100 && f.length < 2_000_000)
      .slice(0, MAX_FOTOS);
    if (!fotos.length) { res.status(400).json({ error: 'Geen foto\'s ontvangen' }); return; }

    const uit = await maakAdvertentie(KEY, MODEL, fotos, { kenteken: b.kenteken });
    res.status(200).json(uit);
  } catch (e) {
    res.status(500).json({ error: (e && e.message) ? String(e.message).slice(0, 200) : 'serverfout' });
  }
}

