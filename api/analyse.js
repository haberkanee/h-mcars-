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

export const config = { maxDuration: 60 };

const MODEL_STANDAARD = 'claude-sonnet-5-5';
const MAX_FOTOS = 6;

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

    const fotos = (Array.isArray(b.fotos) ? b.fotos : [])
      .filter(f => typeof f === 'string' && f.length > 100 && f.length < 2_000_000)
      .slice(0, MAX_FOTOS);
    if (!fotos.length) { res.status(400).json({ error: 'Geen foto\'s ontvangen' }); return; }

    // ---- 2. Foto's laten bekijken ----
    const zicht = await vraagJson(KEY, MODEL, [
      ...fotos.map(data => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } })),
      { type: 'text', text: PROMPT_FOTOS }
    ], 1200);

    // Kenteken: van de foto, of handmatig meegegeven
    const kenteken = schoonKenteken(b.kenteken) || schoonKenteken(zicht.kenteken);

    // ---- 3. RDW ----
    let rdw = null;
    if (kenteken) rdw = await haalRdw(kenteken);

    // ---- 4. Tekst schrijven met alle feiten samen ----
    const feiten = {
      rdw: rdw ? rdw.samenvatting : null,
      van_foto: {
        merk: zicht.merk, model: zicht.model, uitvoering: zicht.uitvoering,
        kleur: zicht.kleur, carrosserie: zicht.carrosserie, transmissie: zicht.transmissie,
        kilometerstand: zicht.kilometerstand, opties: zicht.opties, staat: zicht.staat
      }
    };
    const tekst = await vraagJson(KEY, MODEL, [
      { type: 'text', text: PROMPT_TEKST + '\n\nFEITEN (JSON):\n' + JSON.stringify(feiten) }
    ], 1500);

    // ---- Samenvoegen: RDW is leidend voor de harde gegevens ----
    const r = rdw ? rdw.velden : {};
    const uit = {
      kenteken: kenteken || '',
      kentekenVanFoto: !!schoonKenteken(zicht.kenteken),
      rdwGevonden: !!rdw,
      model: tekst.titel || r.model || [zicht.merk, zicht.model].filter(Boolean).join(' '),
      subtitel: tekst.subtitel || '',
      bouwjaar: r.bouwjaar || '',
      brandstof: r.brandstof || '',
      vermogen: r.vermogen || '',
      kleur: r.kleur || titel(zicht.kleur || ''),
      carrosserie: r.carrosserie || titel(zicht.carrosserie || ''),
      transmissie: normTransmissie(zicht.transmissie),
      km: normKm(zicht.kilometerstand),
      omschrijving: tekst.omschrijving || '',
      opties: Array.isArray(tekst.opties) ? tekst.opties.filter(x => typeof x === 'string' && x.trim()).slice(0, 25) : [],
      apk: r.apk || '',
      opmerking: zicht.opmerking || ''
    };
    res.status(200).json(uit);
  } catch (e) {
    res.status(500).json({ error: (e && e.message) ? String(e.message).slice(0, 200) : 'serverfout' });
  }
}

/* ------------------------------------------------------------------ */

const PROMPT_FOTOS = `Je bekijkt foto's van één tweedehands personenauto voor een advertentie van autobedrijf H-M Cars.
Geef ALLEEN een JSON-object terug, zonder uitleg, met deze sleutels:
{
 "kenteken": Nederlands kenteken zoals op de plaat (bijv. "GX-123-K"), of "" als het niet duidelijk leesbaar is. Gok NOOIT; liever leeg dan fout.
 "merk": merk, of "",
 "model": model, of "",
 "uitvoering": zichtbare uitvoering/badges (bijv. "R-Line", "AMG Line", "GTD"), of "",
 "kleur": kleur van de carrosserie in het Nederlands, of "",
 "carrosserie": een van Hatchback, Sedan, Stationwagen, SUV, MPV, Coupé, Cabriolet, of "",
 "transmissie": "Automaat" of "Handgeschakeld" als de pook/keuzehendel duidelijk zichtbaar is, anders "",
 "kilometerstand": getal (alleen cijfers) als de kilometerteller duidelijk leesbaar is, anders "",
 "opties": lijst van uitrusting die je ECHT ziet (bijv. "Panoramadak", "Lederen bekleding", "Navigatie", "Achteruitrijcamera", "Lichtmetalen velgen"); niets verzinnen,
 "staat": korte neutrale observatie van de zichtbare staat, of "",
 "opmerking": iets dat de verkoper moet controleren (bijv. "kenteken deels afgedekt"), of ""
}`;

const PROMPT_TEKST = `Je schrijft een advertentietekst voor autobedrijf H-M Cars in Waddinxveen.
Toon: zakelijk, eerlijk en verzorgd. Geen emoji, geen uitroeptekens, geen overdreven superlatieven.
Gebruik ALLEEN de feiten hieronder; verzin geen uitrusting, onderhoudshistorie, eigenaren of garantie.
RDW-gegevens zijn leidend boven wat op de foto's is gezien.
Geef ALLEEN een JSON-object terug:
{
 "titel": merk + model + eventueel uitvoering, kort (bijv. "Volkswagen Golf 1.6 TDI R-Line"),
 "subtitel": 2 tot 4 korte kenmerken gescheiden door " · " (bijv. "116 pk · Automaat · Panoramadak"),
 "omschrijving": 3 tot 5 zinnen in het Nederlands die de auto netjes presenteren en eindigen met een uitnodiging voor een bezichtiging of proefrit bij H-M Cars,
 "opties": lijst met de uitrusting uit de feiten, netjes geformuleerd
}`;

async function vraagJson(key, model, content, maxTokens) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content }] })
  });
  if (!r.ok) {
    let msg = 'AI-dienst gaf fout ' + r.status;
    try { const j = await r.json(); if (j && j.error && j.error.message) msg += ': ' + j.error.message; } catch (e) {}
    throw new Error(msg);
  }
  const j = await r.json();
  const txt = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return {};
  try { return JSON.parse(m[0]); } catch (e) { return {}; }
}

function schoonKenteken(k) {
  const s = String(k || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return (s.length >= 6 && s.length <= 8) ? s : '';
}

const MERK_SPECIAAL = { BMW: 'BMW', MG: 'MG', DS: 'DS', MINI: 'MINI', SKODA: 'Škoda', CITROEN: 'Citroën', KIA: 'Kia', SEAT: 'SEAT', CUPRA: 'CUPRA' };
function titel(t, kortHoofd) {
  return String(t || '').toLowerCase().replace(/[^\s-]+/g, w =>
    (kortHoofd && w.length <= 3) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1));
}
function merkNaam(m) { const up = String(m || '').trim().toUpperCase(); return MERK_SPECIAAL[up] || titel(up, false); }
function normTransmissie(t) {
  const s = String(t || '').toLowerCase();
  if (/auto/.test(s)) return 'Automaat';
  if (/hand|manu/.test(s)) return 'Handgeschakeld';
  return '';
}
function normKm(k) {
  const n = parseInt(String(k || '').replace(/\D/g, ''), 10);
  return (n > 0 && n < 2_000_000) ? n.toLocaleString('nl-NL') : '';
}

async function haalRdw(plaat) {
  try {
    const basis = 'https://opendata.rdw.nl/resource/';
    const [vR, bR] = await Promise.all([
      fetch(basis + 'm9d7-ebf2.json?kenteken=' + plaat),
      fetch(basis + '8ys7-d773.json?kenteken=' + plaat)
    ]);
    const v = vR.ok ? (await vR.json())[0] : null;
    if (!v) return null;
    const brand = bR.ok ? await bR.json() : [];

    const merk = merkNaam(v.merk), hb = titel(v.handelsbenaming, true);
    const model = (hb.toUpperCase().indexOf(merk.toUpperCase()) === 0) ? hb : (merk + ' ' + hb).trim();
    const jaar = String(v.datum_eerste_toelating || '').slice(0, 4);
    const kleur = (v.eerste_kleur && !/^n\.?\s?v\.?\s?t/i.test(v.eerste_kleur)) ? titel(v.eerste_kleur, false) : '';
    const carr = v.inrichting ? titel(v.inrichting, true) : '';

    const soorten = [];
    let kw = 0;
    brand.forEach(r => {
      const s = (r.brandstof_omschrijving || '').trim();
      if (s && !soorten.includes(s)) soorten.push(s);
      [r.nettomaximumvermogen, r.netto_max_vermogen_elektrisch].forEach(x => { const n = parseFloat(x); if (n > kw) kw = n; });
    });
    let fuel = '';
    if (soorten.length) fuel = (soorten.includes('Elektriciteit') && soorten.length > 1) ? 'Hybride'
      : soorten.map(s => s === 'Elektriciteit' ? 'Elektrisch' : s).join(' / ');
    const pk = kw ? String(Math.round(kw * 1.35962)) : '';
    const apk = /^\d{8}$/.test(String(v.vervaldatum_apk || '')) ? String(v.vervaldatum_apk).replace(/(\d{4})(\d{2})(\d{2})/, '$3-$2-$1') : '';

    return {
      velden: { model, bouwjaar: /^\d{4}$/.test(jaar) ? jaar : '', brandstof: fuel, vermogen: pk, kleur, carrosserie: carr, apk },
      samenvatting: {
        merk, model, bouwjaar: jaar, brandstof: fuel, vermogen_pk: pk, kleur, carrosserie: carr,
        cilinderinhoud_cc: v.cilinderinhoud || '', zitplaatsen: v.aantal_zitplaatsen || '',
        deuren: v.aantal_deuren || '', apk_tot: apk
      }
    };
  } catch (e) { return null; }
}
