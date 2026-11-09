// api/track.js — draait op Vercel (server-side).
// 1) Slaat bezoeken op (alleen na cookie-toestemming): geschatte locatie via de
//    Vercel-headers (IP), pagina, herkomst, apparaat en browser.
// 2) Slaat een door de browser gedeelde locatie op (alleen na expliciete
//    toestemming), afgerond op ~100 m, en wist die weer op verzoek van de bezoeker.
// 3) Ruimt dagelijks oude gegevens op (Vercel cron, zie vercel.json).
//
// Environment Variables in Vercel:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY (geheim), CRON_SECRET (voor het opruimen)

import crypto from 'node:crypto';
import { SHOWROOM, BEWAAR_DAGEN, IP_BEWAAR_DAGEN, HARTSLAG_DAGEN, provincieNaam, leesUA, afstandKm, rond100m, supa } from './_geo.js';

const TYPES = ['bezoek', 'hartslag', 'pagina'];
const kort = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);
const hash = (s) => crypto.createHash('sha256').update('hm-loc|' + s).digest('hex');
// Anoniem bezoek-id: hash van IP + browser met een sleutel die elke dag wisselt
function anoniemId(req) {
  const dag = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(new Date());
  const zout = (process.env.CRON_SECRET || process.env.SUPABASE_SERVICE_KEY || '') + '|' + dag;
  const ip = ((req.headers['x-forwarded-for'] || '').split(',')[0] || '').trim();
  return 'a-' + crypto.createHash('sha256').update(zout + '|' + ip + '|' + (req.headers['user-agent'] || '')).digest('hex').slice(0, 20);
}
const stadUit = (req) => { try { return req.headers['x-vercel-ip-city'] ? decodeURIComponent(req.headers['x-vercel-ip-city']) : null; } catch (e) { return req.headers['x-vercel-ip-city'] || null; } };

export default async function handler(req, res) {
  // Dagelijks opruimen door Vercel cron
  if (req.method === 'GET') {
    const auth = req.headers.authorization || '';
    if (process.env.CRON_SECRET && auth === 'Bearer ' + process.env.CRON_SECRET) {
      try { res.status(200).json(await opruimen()); } catch (e) { res.status(500).json({ error: 'opruimen mislukt' }); }
      return;
    }
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    b = b || {};
    const { URLB, kop } = supa();

    /* ---------- Gedeelde locatie opslaan (toestemming gegeven in de browser) ---------- */
    if (b.type === 'locatie') {
      const lat = Number(b.lat), lng = Number(b.lng), acc = Number(b.nauwkeurigheid);
      // Zonder cookietoestemming: koppelen aan het anonieme bezoek van dezelfde bezoeker
      const sessie = b.anoniem === true ? anoniemId(req) : kort(b.sessie, 40), sleutel = kort(b.sleutel, 80);
      if (!sessie || !sleutel || sleutel.length < 16 || !isFinite(lat) || !isFinite(lng) ||
          Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) {
        res.status(400).json({ error: 'ongeldige locatie' }); return;
      }
      const h = hash(sleutel);
      const rij = {
        sessie, sleutel: h,
        lat: rond100m(lat), lng: rond100m(lng),
        nauwkeurigheid_m: isFinite(acc) && acc >= 0 ? Math.min(Math.round(acc), 1000000) : null,
        afstand_km: Math.round(afstandKm({ lat, lng }, SHOWROOM) * 10) / 10
      };
      // Eén locatie per bezoek: een eerdere van deze sessie wordt vervangen
      const weg = await fetch(URLB + '/rest/v1/locaties?sessie=eq.' + encodeURIComponent(sessie) + '&sleutel=eq.' + h, {
        method: 'DELETE', headers: { ...kop, Prefer: 'return=representation' }
      });
      const eerder = weg.ok ? await weg.json().catch(() => []) : [];
      const r = await fetch(URLB + '/rest/v1/locaties', {
        method: 'POST', headers: { ...kop, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(rij)
      });
      // Melding naar de eigenaar, één keer per bezoek (niet opnieuw bij nog een klik in hetzelfde bezoek)
      if (r.ok && b.stil !== true && !(Array.isArray(eerder) && eerder.length)) {
        await meldLocatie(rij, { stad: stadUit(req), ua: leesUA(req.headers['user-agent']), knop: kort(b.knop, 20) }).catch(() => {});
      }
      res.status(r.ok ? 204 : 500).end();
      return;
    }

    /* ---------- Toestemming ingetrokken: alle gedeelde locaties van deze browser wissen ---------- */
    if (b.type === 'locatie_wis') {
      const sleutel = kort(b.sleutel, 80);
      if (!sleutel || sleutel.length < 16) { res.status(400).json({ error: 'geen sleutel' }); return; }
      const r = await fetch(URLB + '/rest/v1/locaties?sleutel=eq.' + hash(sleutel), {
        method: 'DELETE', headers: { ...kop, Prefer: 'return=representation' }
      });
      const weg = r.ok ? await r.json().catch(() => []) : null;
      res.status(r.ok ? 200 : 500).json(r.ok ? { gewist: Array.isArray(weg) ? weg.length : 0 } : { error: 'wissen mislukt' });
      return;
    }

    /* ---------- Bezoek, paginaweergave of hartslag ---------- */
    const h = req.headers;
    const ip = ((h['x-forwarded-for'] || '').split(',')[0] || '').trim() || null;
    const land = h['x-vercel-ip-country'] || null;
    const regio = h['x-vercel-ip-country-region'] || null;
    let stad = null; try { stad = h['x-vercel-ip-city'] ? decodeURIComponent(h['x-vercel-ip-city']) : null; } catch (e) { stad = h['x-vercel-ip-city']; }
    const ipLat = parseFloat(h['x-vercel-ip-latitude']), ipLng = parseFloat(h['x-vercel-ip-longitude']);

    let tijd_lokaal = null;
    try {
      tijd_lokaal = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', dateStyle: 'short', timeStyle: 'medium' }).format(new Date());
    } catch (e) {}

    const type = TYPES.includes(b.type) ? b.type : 'bezoek';
    const ua = leesUA(h['user-agent']);
    const row = {
      type,
      sessie: kort(b.sessie, 40),
      pagina: kort(b.pagina, 200),
      referrer: kort(b.referrer, 500),
      utm_source: kort(b.utm_source, 100),
      utm_medium: kort(b.utm_medium, 100),
      utm_campaign: kort(b.utm_campaign, 100),
      taal: kort(b.taal, 20),
      scherm: kort(b.scherm, 20),
      user_agent: kort(h['user-agent'], 400),
      ip,
      land, stad, regio,
      postcode: h['x-vercel-ip-postal-code'] || null,
      tijdzone: h['x-vercel-ip-timezone'] || null,
      tijd_lokaal
    };
    // Nieuwe velden (alleen voor echte bezoeken; hartslagen blijven zo klein mogelijk)
    const extra = type === 'hartslag' ? {} : {
      provincie: provincieNaam(land, regio),
      apparaat: ua.apparaat, browser: ua.browser, os: ua.os,
      ip_lat: isFinite(ipLat) ? ipLat : null, ip_lng: isFinite(ipLng) ? ipLng : null
    };

    const opslaan = (data) => fetch(URLB + '/rest/v1/bezoeken', {
      method: 'POST', headers: { ...kop, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(data)
    });
    // Zonder cookietoestemming: anoniem tellen. Geen IP-adres, user-agent, postcode, taal of scherm opslaan;
    // van de herkomst alleen het domein. Het bezoek-id is een hash met een dagelijks wisselende sleutel,
    // zodat een bezoeker alleen binnen dezelfde dag als één bezoeker telt en niet te herleiden is.
    if (b.anoniem === true) {
      row.sessie = anoniemId(req);
      let herkomst = null; try { herkomst = b.referrer ? new URL(b.referrer).origin : null; } catch (e) {}
      Object.assign(row, { ip: null, user_agent: null, postcode: null, taal: null, scherm: null, referrer: herkomst });
    }
    // Melding bij een nieuwe bezoeker: één keer per bezoeker (per bezoek of, anoniem, per dag),
    // niet voor bots en niet voor de eigenaar zelf (stil=true vanuit het beheer)
    let nieuw = false;
    if (type === 'bezoek' && b.stil !== true && extra.apparaat !== 'Bot' && meldingAan('bezoek') && row.sessie) {
      const al = await fetch(URLB + '/rest/v1/bezoeken?select=id&type=eq.bezoek&sessie=eq.' + encodeURIComponent(row.sessie) + '&limit=1', { headers: kop })
        .then((x) => (x.ok ? x.json() : [{}])).catch(() => [{}]);
      nieuw = Array.isArray(al) && al.length === 0;
    }
    let r = await opslaan({ ...row, ...extra });
    // Staan de nieuwe kolommen nog niet in de database? Dan toch het bezoek bewaren zoals vroeger.
    if (!r.ok && Object.keys(extra).length) r = await opslaan(row);
    if (r.ok && nieuw) await meldBezoek({ ...row, ...extra }, URLB, kop).catch(() => {});
    res.status(r.ok ? 204 : 500).end();
  } catch (e) {
    res.status(500).end();
  }
}

/* ---------- Meldingen ----------
   Pushbericht via ntfy (NTFY_TOPIC) en/of e-mail via Resend (RESEND_API_KEY + MELDING_EMAIL).
   MELD_BEZOEKEN = beide (standaard) | push | mail | uit  → meldingen bij nieuwe bezoekers
   MELD_LOCATIE  = beide (standaard) | push | mail | uit  → meldingen bij een gedeelde locatie
   MELD_MAIL_MAX = maximaal aantal bezoekers-mails per dag (standaard 90; Resend gratis = 100/dag)
   Een mislukte melding houdt het opslaan nooit tegen. */
function kanalen(soort) {
  const stand = String(process.env[soort === 'bezoek' ? 'MELD_BEZOEKEN' : 'MELD_LOCATIE'] || 'beide').toLowerCase();
  const push = !!process.env.NTFY_TOPIC && (stand === 'beide' || stand === 'push');
  const mail = !!(process.env.RESEND_API_KEY && process.env.MELDING_EMAIL) && (stand === 'beide' || stand === 'mail');
  return { push, mail };
}
function meldingAan(soort) { const k = kanalen(soort); return k.push || k.mail; }
const SITE = () => (process.env.SITE_URL || 'https://www.h-mcars.nl').replace(/\/$/, '');
const nuTijd = () => new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', dateStyle: 'short', timeStyle: 'short' }).format(new Date());

async function verstuur(soort, { titel, regels, klik, knoppen, tag }, { mail = true } = {}) {
  const k = kanalen(soort);
  const met = (ms) => ({ signal: AbortSignal.timeout(ms) });
  const taken = [];
  if (k.push) {
    taken.push(fetch('https://ntfy.sh/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, ...met(4000),
      body: JSON.stringify({ topic: process.env.NTFY_TOPIC, title: titel, message: regels.join('\n'), tags: [tag], click: klik,
        actions: knoppen.map((x) => ({ action: 'view', label: x[0], url: x[1] })) })
    }));
  }
  if (k.mail && mail) {
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    taken.push(fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' }, ...met(4000),
      body: JSON.stringify({
        from: process.env.MELDING_AFZENDER || 'H-M Cars <onboarding@resend.dev>', to: [process.env.MELDING_EMAIL], subject: titel,
        html: '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6"><p><strong>' + esc(titel) + '</strong></p><p>' + regels.map(esc).join('<br>') +
          '</p><p>' + knoppen.map((x) => '<a href="' + x[1] + '">' + esc(x[0]) + '</a>').join(' &middot; ') + '</p></div>'
      })
    }));
  }
  await Promise.allSettled(taken);
}

async function meldLocatie(rij, { stad, ua, knop }) {
  if (!meldingAan('locatie')) return;
  const kaart = 'https://www.google.com/maps?q=' + rij.lat + ',' + rij.lng;
  const km = String(rij.afstand_km).replace('.', ',');
  const toestel = [ua.apparaat, ua.browser].filter(Boolean).join(' · ');
  const waar = knop === 'route' ? 'via Route plannen' : 'via Afstand berekenen';
  await verstuur('locatie', {
    titel: 'Locatie gedeeld: ' + km + ' km van de showroom', tag: 'round_pushpin', klik: kaart,
    regels: [
      (stad ? 'Omgeving (schatting): ' + stad : null),
      'Afstand hemelsbreed: ' + km + ' km',
      'Nauwkeurigheid: ' + (rij.nauwkeurigheid_m != null ? '± ' + rij.nauwkeurigheid_m + ' m' : 'onbekend') + ' (opgeslagen op ~100 m)',
      (toestel ? 'Toestel: ' + toestel : null),
      'Gedeeld ' + waar + ', ' + nuTijd()
    ].filter(Boolean),
    knoppen: [['Op kaart', kaart], ['Statistieken', SITE() + '/#beheer']]
  });
}

async function meldBezoek(rij, URLB, kop) {
  if (!meldingAan('bezoek')) return;
  // Begrens het aantal e-mails per dag (pushberichten gaan altijd door)
  let mail = true;
  if (kanalen('bezoek').mail) {
    const max = parseInt(process.env.MELD_MAIL_MAX || '90', 10) || 90;
    const vandaag = new Date(); vandaag.setUTCHours(0, 0, 0, 0);
    const t = await fetch(URLB + '/rest/v1/bezoeken?select=id&type=eq.bezoek&created_at=gte.' + encodeURIComponent(vandaag.toISOString()),
      { headers: { ...kop, Prefer: 'count=exact', Range: '0-0' } }).catch(() => null);
    const n = t ? parseInt((t.headers.get('content-range') || '/0').split('/')[1], 10) || 0 : 0;
    if (n > max) mail = false;
  }
  let herkomst = rij.utm_source || null;
  if (!herkomst && rij.referrer) { try { herkomst = new URL(rij.referrer).hostname.replace(/^www\./, ''); } catch (e) { herkomst = null; } }
  if (herkomst && /h-mcars/.test(herkomst)) herkomst = null;
  const plaats = [rij.stad, rij.provincie, rij.land].filter(Boolean).join(', ') || 'onbekend';
  const toestel = [rij.apparaat, rij.browser, rij.os].filter(Boolean).join(' · ');
  await verstuur('bezoek', {
    titel: 'Nieuwe bezoeker' + (rij.stad ? ' uit ' + rij.stad : ''), tag: 'eyes', klik: SITE() + '/#beheer',
    regels: [
      'Plaats (schatting via IP): ' + plaats,
      (toestel ? 'Toestel: ' + toestel : null),
      'Herkomst: ' + (herkomst || 'direct') + (rij.utm_campaign ? ' (' + rij.utm_campaign + ')' : ''),
      'Pagina: ' + (rij.pagina || '/'),
      (String(rij.sessie || '').startsWith('a-') ? 'Zonder cookietoestemming (anoniem)' : 'Met cookietoestemming'),
      nuTijd()
    ].filter(Boolean),
    knoppen: [['Statistieken', SITE() + '/#beheer']]
  }, { mail });
}

/* ---------- Bewaartermijnen ---------- */
async function opruimen() {
  const { URLB, kop } = supa();
  const dagenGeleden = (d) => encodeURIComponent(new Date(Date.now() - d * 864e5).toISOString());
  const oud = dagenGeleden(BEWAAR_DAGEN);
  const uit = {};

  // 1) Tel echte bezoeken die we gaan opruimen, zodat het totaal in je dashboard blijft kloppen
  const telR = await fetch(URLB + '/rest/v1/bezoeken?select=id&type=not.eq.hartslag&created_at=lt.' + oud, {
    headers: { ...kop, Prefer: 'count=exact', Range: '0-0' }
  });
  const weg = parseInt((telR.headers.get('content-range') || '/0').split('/')[1], 10) || 0;
  if (weg > 0) {
    const huidig = await fetch(URLB + '/rest/v1/instellingen?select=waarde&sleutel=eq.bezoeken_archief', { headers: kop })
      .then((r) => (r.ok ? r.json() : [])).catch(() => []);
    const oudTotaal = parseInt((huidig[0] && huidig[0].waarde) || '0', 10) || 0;
    const opgeslagen = await fetch(URLB + '/rest/v1/instellingen?on_conflict=sleutel', {
      method: 'POST', headers: { ...kop, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ sleutel: 'bezoeken_archief', waarde: String(oudTotaal + weg) })
    });
    // Alleen opruimen als de teller bijgewerkt is, anders kloppen je totalen niet meer
    if (!opgeslagen.ok) throw new Error('teller niet bijgewerkt');
  }
  uit.bezoeken_opgeruimd = weg;

  const del = (pad) => fetch(URLB + '/rest/v1/' + pad, { method: 'DELETE', headers: { ...kop, Prefer: 'return=minimal' } }).then((r) => r.ok);
  uit.bezoeken = await del('bezoeken?created_at=lt.' + oud);
  uit.hartslagen = await del('bezoeken?type=eq.hartslag&created_at=lt.' + dagenGeleden(HARTSLAG_DAGEN));
  uit.locaties = await del('locaties?created_at=lt.' + oud);
  // 2) IP-adressen na 30 dagen leegmaken (de geschatte plaats blijft)
  const ipR = await fetch(URLB + '/rest/v1/bezoeken?ip=not.is.null&created_at=lt.' + dagenGeleden(IP_BEWAAR_DAGEN), {
    method: 'PATCH', headers: { ...kop, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ ip: null })
  });
  uit.ip_geanonimiseerd = ipR.ok;
  return uit;
}
