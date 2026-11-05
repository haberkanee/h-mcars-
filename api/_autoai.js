// api/_autoai.js — gedeelde logica voor analyse.js en instagram.js.
// Bestanden in api/ die met een _ beginnen worden door Vercel niet als
// losse functie aangeboden; dit is alleen een hulpbestand.

export const MODEL_STANDAARD = 'claude-sonnet-5-5';
export const MAX_FOTOS = 6;
export const MAX_GROEPEER = 40;

/* Kijkt naar foto's (base64 JPEG), leest kenteken, haalt RDW op en schrijft de tekst.
   opties.kenteken: handmatig kenteken (heeft voorrang); opties.bijschrift: tekst van de verkoper. */
export async function maakAdvertentie(KEY, MODEL, fotos, opties = {}) {
  const bijschrift = String(opties.bijschrift || '').slice(0, 2000);
  const zicht = await vraagJson(KEY, MODEL, [
    ...fotos.slice(0, MAX_FOTOS).map(data => ({ type: 'image', source: { type: 'base64', media_type: opties.mediaType || 'image/jpeg', data } })),
    { type: 'text', text: PROMPT_FOTOS + (bijschrift ? '\n\nBijschrift van de verkoper:\n' + bijschrift : '') }
  ], 1200);

  const kenteken = schoonKenteken(opties.kenteken) || schoonKenteken(zicht.kenteken);
  const rdw = kenteken ? await haalRdw(kenteken) : null;

  const feiten = {
    rdw: rdw ? rdw.samenvatting : null,
    van_foto: {
      merk: zicht.merk, model: zicht.model, uitvoering: zicht.uitvoering,
      kleur: zicht.kleur, carrosserie: zicht.carrosserie, transmissie: zicht.transmissie,
      kilometerstand: zicht.kilometerstand, opties: zicht.opties, staat: zicht.staat
    },
    bijschrift_verkoper: bijschrift || null
  };
  const tekst = await vraagJson(KEY, MODEL, [
    { type: 'text', text: PROMPT_TEKST + '\n\nFEITEN (JSON):\n' + JSON.stringify(feiten) }
  ], 1500);

  const r = rdw ? rdw.velden : {};
  return {
    isAuto: zicht.is_auto !== false,
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
    prijs: normPrijs(zicht.prijs),
    omschrijving: tekst.omschrijving || '',
    opties: Array.isArray(tekst.opties) ? tekst.opties.filter(x => typeof x === 'string' && x.trim()).slice(0, 25) : [],
    apk: r.apk || '',
    opmerking: zicht.opmerking || ''
  };
}

export function normPrijs(p) {
  const n = parseInt(String(p || '').replace(/[.,]-?$/, '').replace(/\D/g, ''), 10);
  return (n >= 300 && n < 2_000_000) ? '\u20ac ' + n.toLocaleString('nl-NL') + ',-' : '';
}

/* Controleert dat een Supabase-token van het beheerdersaccount is. */
export async function isBeheerder(token) {
  if (!token) return false;
  const URLB = process.env.SUPABASE_URL, SKEY = process.env.SUPABASE_SERVICE_KEY;
  const ADMIN = (process.env.ADMIN_EMAIL || 'hmcarrss@gmail.com').toLowerCase();
  const r = await fetch(URLB + '/auth/v1/user', { headers: { apikey: SKEY, Authorization: 'Bearer ' + token } });
  if (!r.ok) return false;
  const w = await r.json();
  return ((w && w.email) || '').toLowerCase() === ADMIN;
}

/* ------------------------------------------------------------------ */

export const PROMPT_FOTOS = `Je bekijkt foto's van één tweedehands personenauto voor een advertentie van autobedrijf H-M Cars.
Geef ALLEEN een JSON-object terug, zonder uitleg, met deze sleutels:
{
 "is_auto": true als de foto's een auto laten zien die te koop wordt aangeboden, false als het iets anders is (bijv. een algemene post, een mens, een gebouw),
 "kenteken": Nederlands kenteken zoals op de plaat (bijv. "GX-123-K"), of "" als het niet duidelijk leesbaar is. Gok NOOIT; liever leeg dan fout.
 "merk": merk, of "",
 "model": model, of "",
 "uitvoering": zichtbare uitvoering/badges (bijv. "R-Line", "AMG Line", "GTD"), of "",
 "kleur": kleur van de carrosserie in het Nederlands, of "",
 "carrosserie": een van Hatchback, Sedan, Stationwagen, SUV, MPV, Coupé, Cabriolet, of "",
 "transmissie": "Automaat" of "Handgeschakeld" als de pook/keuzehendel duidelijk zichtbaar is, anders "",
 "kilometerstand": getal (alleen cijfers) als de kilometerteller duidelijk leesbaar is of als het in het bijschrift van de verkoper staat, anders "",
 "prijs": de vraagprijs als die in het bijschrift van de verkoper staat (bijv. "14950"), anders "",
 "opties": lijst van uitrusting die je ECHT ziet (bijv. "Panoramadak", "Lederen bekleding", "Navigatie", "Achteruitrijcamera", "Lichtmetalen velgen"); niets verzinnen,
 "staat": korte neutrale observatie van de zichtbare staat, of "",
 "opmerking": iets dat de verkoper moet controleren (bijv. "kenteken deels afgedekt"), of ""
}`;

export const PROMPT_TEKST = `Je schrijft een advertentietekst voor autobedrijf H-M Cars in Waddinxveen.
Toon: zakelijk, eerlijk en verzorgd. Geen emoji, geen uitroeptekens, geen overdreven superlatieven.
Gebruik ALLEEN de feiten hieronder; een bijschrift van de verkoper mag je gebruiken, maar negeer hashtags, emoji en oproepen als "link in bio". Verzin geen uitrusting, onderhoudshistorie, eigenaren of garantie.
RDW-gegevens zijn leidend boven wat op de foto's is gezien.
Geef ALLEEN een JSON-object terug:
{
 "titel": merk + model + eventueel uitvoering, kort (bijv. "Volkswagen Golf 1.6 TDI R-Line"),
 "subtitel": 2 tot 4 korte kenmerken gescheiden door " · " (bijv. "116 pk · Automaat · Panoramadak"),
 "omschrijving": 3 tot 5 zinnen in het Nederlands die de auto netjes presenteren en eindigen met een uitnodiging voor een bezichtiging of proefrit bij H-M Cars,
 "opties": lijst met de uitrusting uit de feiten, netjes geformuleerd
}`;

export const PROMPT_GROEPEER = `Hierboven staan {N} foto's (genummerd vanaf 0) van één of meer tweedehands auto's, voor autobedrijf H-M Cars.
Verdeel ze in groepen: één groep per auto. Gebruik kenteken, merk, model, kleur, velgen, interieur en achtergrond.
Foto's van het interieur of dashboard horen bij de auto die er in de volgorde direct omheen staat, tenzij duidelijk iets anders.
Elke foto komt in precies één groep. Behoud binnen een groep de oorspronkelijke volgorde.
Geef ALLEEN JSON terug: {"groepen": [[0,1,2],[3,4]]}`;

// Maakt de groepen veilig: alleen geldige nummers, geen dubbele, ontbrekende foto's in een eigen groep.
export function schoonGroepen(g, n) {
  const gezien = new Set(), uit = [];
  (Array.isArray(g) ? g : []).forEach(groep => {
    const rij = (Array.isArray(groep) ? groep : [])
      .map(x => parseInt(x, 10))
      .filter(x => Number.isInteger(x) && x >= 0 && x < n && !gezien.has(x));
    rij.forEach(x => gezien.add(x));
    if (rij.length) uit.push(rij.sort((a, c) => a - c));
  });
  const rest = [];
  for (let i = 0; i < n; i++) if (!gezien.has(i)) rest.push(i);
  if (rest.length) uit.push(rest);
  return uit;
}

export async function vraagJson(key, model, content, maxTokens) {
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

export function schoonKenteken(k) {
  const s = String(k || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return (s.length >= 6 && s.length <= 8) ? s : '';
}

const MERK_SPECIAAL = { BMW: 'BMW', MG: 'MG', DS: 'DS', MINI: 'MINI', SKODA: 'Škoda', CITROEN: 'Citroën', KIA: 'Kia', SEAT: 'SEAT', CUPRA: 'CUPRA' };
export function titel(t, kortHoofd) {
  return String(t || '').toLowerCase().replace(/[^\s-]+/g, w =>
    (kortHoofd && w.length <= 3) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1));
}
export function merkNaam(m) { const up = String(m || '').trim().toUpperCase(); return MERK_SPECIAAL[up] || titel(up, false); }
export function normTransmissie(t) {
  const s = String(t || '').toLowerCase();
  if (/auto/.test(s)) return 'Automaat';
  if (/hand|manu/.test(s)) return 'Handgeschakeld';
  return '';
}
export function normKm(k) {
  const n = parseInt(String(k || '').replace(/\D/g, ''), 10);
  return (n > 0 && n < 2_000_000) ? n.toLocaleString('nl-NL') : '';
}

export async function haalRdw(plaat) {
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
