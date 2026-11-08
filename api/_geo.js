// api/_geo.js — gedeelde hulpfuncties voor bezoekersmeting (geen eigen endpoint:
// bestanden die met _ beginnen worden door Vercel niet als URL aangeboden).

// Showroom H-M Cars, Sint Victorstraat 53, Waddinxveen (ongeveer; voor afstanden in km)
export const SHOWROOM = { lat: 52.0305, lng: 4.6515 };

// Bewaartermijnen (dagen)
export const BEWAAR_DAGEN = 90;      // bezoeken en gedeelde locaties
export const IP_BEWAAR_DAGEN = 30;   // IP-adressen worden daarna leeggemaakt
export const HARTSLAG_DAGEN = 2;     // live-signalen zijn alleen kort nodig

// ISO 3166-2 regiocodes → provincienaam (NL en BE; andere landen houden hun code)
const PROVINCIES = {
  NL: { DR: 'Drenthe', FL: 'Flevoland', FR: 'Friesland', GE: 'Gelderland', GR: 'Groningen', LI: 'Limburg',
        NB: 'Noord-Brabant', NH: 'Noord-Holland', OV: 'Overijssel', UT: 'Utrecht', ZE: 'Zeeland', ZH: 'Zuid-Holland' },
  BE: { VAN: 'Antwerpen', VLI: 'Limburg (BE)', VOV: 'Oost-Vlaanderen', VBR: 'Vlaams-Brabant', VWV: 'West-Vlaanderen',
        WHT: 'Henegouwen', WLG: 'Luik', WLX: 'Luxemburg (BE)', WNA: 'Namen', WBR: 'Waals-Brabant', BRU: 'Brussel' }
};
export function provincieNaam(land, regio) {
  if (!regio) return null;
  const r = String(regio).toUpperCase().replace(/^[A-Z]{2}-/, '');
  return (PROVINCIES[land] && PROVINCIES[land][r]) || r;
}

const LANDEN = { NL: 'Nederland', BE: 'België', DE: 'Duitsland', FR: 'Frankrijk', GB: 'Verenigd Koninkrijk', US: 'Verenigde Staten',
  PL: 'Polen', ES: 'Spanje', IT: 'Italië', MA: 'Marokko', TR: 'Turkije', LU: 'Luxemburg', AT: 'Oostenrijk', CH: 'Zwitserland' };
export function landNaam(code) { return code ? (LANDEN[code] || code) : null; }

// Apparaat, browser en besturingssysteem uit de user-agent (bewust simpel en snel)
export function leesUA(ua) {
  const u = String(ua || '');
  if (!u) return { apparaat: null, browser: null, os: null };
  let apparaat = 'Desktop';
  if (/bot|crawl|spider|slurp|facebookexternalhit|preview/i.test(u)) apparaat = 'Bot';
  else if (/iPad|Tablet|(Android(?!.*Mobile))/i.test(u)) apparaat = 'Tablet';
  else if (/Mobi|iPhone|iPod|Android/i.test(u)) apparaat = 'Mobiel';

  let browser = 'Overig';
  if (/Instagram/i.test(u)) browser = 'Instagram-app';
  else if (/FBAN|FBAV/i.test(u)) browser = 'Facebook-app';
  else if (/musical_ly|TikTok|BytedanceWebview/i.test(u)) browser = 'TikTok-app';
  else if (/Edg\//.test(u)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(u)) browser = 'Opera';
  else if (/SamsungBrowser/.test(u)) browser = 'Samsung Internet';
  else if (/Firefox|FxiOS/.test(u)) browser = 'Firefox';
  else if (/Chrome|CriOS/.test(u)) browser = 'Chrome';
  else if (/Safari/.test(u)) browser = 'Safari';

  let os = 'Overig';
  if (/iPhone|iPad|iPod/.test(u)) os = 'iOS';
  else if (/Android/.test(u)) os = 'Android';
  else if (/Windows/.test(u)) os = 'Windows';
  else if (/Mac OS X|Macintosh/.test(u)) os = 'macOS';
  else if (/CrOS/.test(u)) os = 'ChromeOS';
  else if (/Linux/.test(u)) os = 'Linux';
  return { apparaat, browser, os };
}

// Afstand in km (hemelsbreed)
export function afstandKm(a, b) {
  const R = 6371, rad = (x) => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Afronden op ~100 m (3 decimalen ≈ 111 m noord-zuid, ≈ 70 m oost-west in NL)
export const rond100m = (x) => Math.round(x * 1000) / 1000;

export function supa() {
  const URLB = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
  const kop = { apikey: KEY, Authorization: 'Bearer ' + KEY };
  return { URLB, KEY, kop };
}
