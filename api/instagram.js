// api/instagram.js — koppeling Instagram → concept-advertenties op h-mcars.nl
//
// Wat het doet:
//   - Laat de beheerder het Instagram-account koppelen (inloggen bij Instagram).
//   - Haalt nieuwe posts op, kopieert de foto's naar Supabase-opslag en maakt
//     per auto-post een advertentie met status "concept" (niet zichtbaar op de site).
//   - Draait automatisch via de Vercel-cron (zie vercel.json) en via de knop
//     "Nu ophalen" in het beheer.
//
// Environment Variables (Vercel → Settings → Environment Variables):
//   IG_APP_ID, IG_APP_SECRET   App ID en App secret van de Meta-app (App settings → Basic)
//   IG_CONFIG_ID               Configuration ID uit Instagram API → API setup with Unified login
//   CRON_SECRET                een willekeurige lange tekst (beveiligt de automatische run)
//   SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY   (bestaan al)
//   SITE_URL                   optioneel, standaard https://www.h-mcars.nl
//
// Supabase-tabellen (zie de SQL in de uitleg): instellingen, ig_posts.

import { MODEL_STANDAARD, MAX_FOTOS, maakAdvertentie, isBeheerder } from './_autoai.js';

export const config = { maxDuration: 60 };

const GRAPH = 'https://graph.facebook.com/' + (process.env.IG_GRAPH_VERSIE || 'v26.0');
const PER_RUN = 3;          // hoogstens zoveel posts per keer
const BUDGET_MS = 20000;    // na deze tijd geen nieuwe post meer starten (Vercel stopt na 60 s)
const MAX_DOWNLOAD = 10;    // foto's per post
const KIJK_TERUG = 12;      // zoveel recente posts bekijken

const site = () => (process.env.SITE_URL || 'https://www.h-mcars.nl').replace(/\/$/, '');
const redirectUri = () => site() + '/api/instagram';

export default async function handler(req, res) {
  try {
    const q = req.query || {};

    // ---- 1. Terugkomst van Instagram na het inloggen ----
    if (req.method === 'GET' && (q.code || q.error)) {
      if (q.error) return terug(res, 'geweigerd');
      const ok = await verwerkCallback(String(q.code), String(q.state || ''));
      return terug(res, ok === true ? 'gekoppeld' : ok);
    }

    // ---- 2. Automatische run (Vercel-cron) ----
    const cronHeader = req.headers && (req.headers.authorization || req.headers.Authorization);
    if (process.env.CRON_SECRET && cronHeader === 'Bearer ' + process.env.CRON_SECRET) {
      const uit = await synchroniseer({});
      return res.status(200).json(uit);
    }

    // ---- 3. Acties vanuit het beheer ----
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    b = b || {};
    if (!(await isBeheerder(b.token))) return res.status(403).json({ error: 'Geen toegang' });

    if (b.action === 'status') return res.status(200).json(await status());
    if (b.action === 'start') {
      if (!ingesteld()) return res.status(500).json({ error: 'IG_APP_ID, IG_APP_SECRET of IG_CONFIG_ID ontbreekt in Vercel' });
      const st = willekeurig();
      await zet('ig_state', st + '|' + Date.now());
      // Unified login: Facebook Login for Business met de configuratie uit de Meta-app
      const url = 'https://www.facebook.com/dialog/oauth?' + new URLSearchParams({
        client_id: process.env.IG_APP_ID, redirect_uri: redirectUri(), response_type: 'code',
        config_id: process.env.IG_CONFIG_ID, override_default_response_type: 'true', state: st, prompt: 'login'
      }).toString();
      return res.status(200).json({ url });
    }
    if (b.action === 'sync') return res.status(200).json(await synchroniseer({ ouder: !!b.ouder }));
    if (b.action === 'ontkoppel') {
      for (const k of ['ig_token', 'ig_user', 'ig_naam', 'ig_token_datum', 'ig_sinds', 'ig_state']) await wis(k);
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'Onbekende actie' });
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) ? String(e.message).slice(0, 200) : 'serverfout' });
  }
}

/* ---------------- Koppelen ---------------- */

async function verwerkCallback(code, state) {
  const opgeslagen = await lees('ig_state');
  const [st, tijd] = String(opgeslagen || '').split('|');
  if (!st || st !== state || Date.now() - Number(tijd) > 15 * 60 * 1000) return 'verlopen';
  await wis('ig_state');

  // Code inwisselen (geeft bij Unified login een systeemgebruiker-token dat niet verloopt)
  const t = await fetch(GRAPH + '/oauth/access_token?' + new URLSearchParams({
    client_id: process.env.IG_APP_ID, client_secret: process.env.IG_APP_SECRET,
    redirect_uri: redirectUri(), code: code.replace(/#_$/, '')
  }).toString());
  const tj = await t.json().catch(() => ({}));
  if (!t.ok || !tj.access_token) return 'tokenfout';
  let token = tj.access_token;

  // Een gewone gebruikerstoken (met verloopdatum) omzetten naar een lange
  if (tj.expires_in) {
    const l = await fetch(GRAPH + '/oauth/access_token?' + new URLSearchParams({
      grant_type: 'fb_exchange_token', client_id: process.env.IG_APP_ID,
      client_secret: process.env.IG_APP_SECRET, fb_exchange_token: token
    }).toString());
    const lj = await l.json().catch(() => ({}));
    if (l.ok && lj.access_token) token = lj.access_token;
  }

  const acc = await zoekAccount(token);
  if (!acc) return 'geenaccount';

  await zet('ig_token', token);
  await zet('ig_token_datum', String(Date.now()));
  await zet('ig_user', String(acc.id));
  await zet('ig_naam', String(acc.username || ''));
  if (!(await lees('ig_sinds'))) await zet('ig_sinds', new Date().toISOString());
  return true;
}

// Welk Instagram-account hoort bij deze token?
async function zoekAccount(token) {
  const tk = '&access_token=' + encodeURIComponent(token);
  // Unified login: accounts die aan de systeemgebruiker zijn toegewezen
  let r = await fetch(GRAPH + '/me/assigned_instagram_accounts?fields=id,username' + tk);
  let j = await r.json().catch(() => ({}));
  let lijst = (r.ok && Array.isArray(j.data)) ? j.data : [];
  let acc = lijst.find(x => x && x.id);
  // Terugval: Instagram gekoppeld aan een Facebook-pagina
  if (!acc) {
    r = await fetch(GRAPH + '/me/accounts?fields=instagram_business_account{id,username}' + tk);
    j = await r.json().catch(() => ({}));
    lijst = (r.ok && Array.isArray(j.data)) ? j.data : [];
    const p = lijst.find(x => x && x.instagram_business_account && x.instagram_business_account.id);
    acc = p && p.instagram_business_account;
  }
  if (!acc) return null;
  if (!acc.username) {
    const u = await fetch(GRAPH + '/' + acc.id + '?fields=username' + tk);
    const uj = await u.json().catch(() => ({}));
    if (u.ok && uj.username) acc = { id: acc.id, username: uj.username };
  }
  return acc;
}

const ingesteld = () => !!(process.env.IG_APP_ID && process.env.IG_APP_SECRET && process.env.IG_CONFIG_ID);

function terug(res, uitkomst) {
  res.statusCode = 302;
  res.setHeader('Location', site() + '/?ig=' + encodeURIComponent(uitkomst) + '#beheer');
  res.end();
}

async function status() {
  const naam = await lees('ig_naam'), token = await lees('ig_token');
  const r = await sb('/rest/v1/ig_posts?select=id,status,model,verwerkt_at&order=verwerkt_at.desc&limit=8');
  return {
    gekoppeld: !!token, naam: naam || '',
    sinds: (await lees('ig_sinds')) || null,
    recent: r.ok ? await r.json() : [],
    ingesteld: ingesteld()
  };
}

/* ---------------- Ophalen en verwerken ---------------- */

export async function synchroniseer({ ouder = false }) {
  const token = await lees('ig_token');
  const igId = await lees('ig_user');
  if (!token || !igId) return { gekoppeld: false, nieuw: 0, melding: 'Instagram is niet gekoppeld' };

  const velden = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,children{media_type,media_url,thumbnail_url}';
  const r = await fetch(GRAPH + '/' + encodeURIComponent(igId) + '/media?fields=' + encodeURIComponent(velden) + '&limit=' + KIJK_TERUG + '&access_token=' + encodeURIComponent(token));
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Instagram gaf fout: ' + ((j.error && j.error.message) || r.status));
  const posts = Array.isArray(j.data) ? j.data : [];

  // Welke posts zijn al eerder bekeken?
  const ids = posts.map(p => p.id).filter(Boolean);
  const bekendR = ids.length ? await sb('/rest/v1/ig_posts?select=id&id=in.(' + ids.map(encodeURIComponent).join(',') + ')') : null;
  const bekend = new Set(bekendR && bekendR.ok ? (await bekendR.json()).map(x => x.id) : []);
  const sinds = ouder ? null : await lees('ig_sinds');

  const teDoen = posts
    .filter(p => p.id && !bekend.has(p.id))
    .filter(p => !sinds || !p.timestamp || new Date(p.timestamp) >= new Date(sinds))
    .sort((a, c) => new Date(a.timestamp || 0) - new Date(c.timestamp || 0));

  const resultaat = [];
  const start = Date.now();
  for (const p of teDoen.slice(0, PER_RUN)) {
    if (resultaat.length && Date.now() - start > BUDGET_MS) break;
    try { resultaat.push(await verwerkPost(p, token)); }
    catch (e) {
      await sb('/rest/v1/ig_posts', { method: 'POST', body: { id: p.id, status: 'fout', melding: String(e.message || e).slice(0, 300), permalink: p.permalink || null } });
      resultaat.push({ id: p.id, status: 'fout', melding: String(e.message || e) });
    }
  }
  return { gekoppeld: true, nieuw: resultaat.filter(x => x.status === 'concept').length, verwerkt: resultaat, resterend: Math.max(0, teDoen.length - resultaat.length) };
}

async function verwerkPost(p, token) {
  // Afbeeldingen verzamelen (bij video's: de omslagfoto)
  let delen = (p.children && Array.isArray(p.children.data)) ? p.children.data : [];
  if (p.media_type === 'CAROUSEL_ALBUM' && !delen.length) {
    const c = await fetch(GRAPH + '/' + p.id + '/children?fields=media_type,media_url,thumbnail_url&access_token=' + encodeURIComponent(token));
    const cj = await c.json().catch(() => ({}));
    delen = Array.isArray(cj.data) ? cj.data : [];
  }
  if (!delen.length) delen = [p];
  const urls = delen.map(d => d.media_type === 'VIDEO' ? d.thumbnail_url : d.media_url).filter(Boolean).slice(0, MAX_DOWNLOAD);
  if (!urls.length) throw new Error('geen afbeeldingen in deze post');

  const fotos = [];
  for (const u of urls) {
    let f;
    try { f = await fetch(u, { signal: AbortSignal.timeout(8000) }); } catch (e) { continue; }
    if (!f.ok) continue;
    const buf = Buffer.from(await f.arrayBuffer());
    if (buf.length > 8 * 1024 * 1024) continue;
    fotos.push({ buf, type: f.headers.get('content-type') || 'image/jpeg' });
  }
  if (!fotos.length) throw new Error('foto\'s konden niet worden gedownload');

  const KEY = process.env.ANTHROPIC_API_KEY;
  if (!KEY) throw new Error('ANTHROPIC_API_KEY ontbreekt');
  const MODEL = process.env.ANTHROPIC_MODEL || MODEL_STANDAARD;
  const jpegs = fotos.filter(f => /jpe?g/i.test(f.type)).slice(0, MAX_FOTOS);
  const d = await maakAdvertentie(KEY, MODEL, (jpegs.length ? jpegs : fotos.slice(0, MAX_FOTOS)).map(f => f.buf.toString('base64')), {
    bijschrift: p.caption || '', mediaType: jpegs.length ? 'image/jpeg' : (fotos[0].type.split(';')[0])
  });

  if (!d.isAuto) {
    await sb('/rest/v1/ig_posts', { method: 'POST', body: { id: p.id, status: 'overgeslagen', melding: 'geen auto-advertentie', permalink: p.permalink || null } });
    return { id: p.id, status: 'overgeslagen' };
  }

  // Foto's blijvend opslaan (Instagram-links verlopen na een tijd)
  const opgeslagen = [];
  for (let i = 0; i < fotos.length; i++) {
    const ext = /png/i.test(fotos[i].type) ? 'png' : (/webp/i.test(fotos[i].type) ? 'webp' : 'jpg');
    const pad = 'ig_' + p.id + '_' + i + '.' + ext;
    const up = await fetch(process.env.SUPABASE_URL + '/storage/v1/object/auto-fotos/' + pad, {
      method: 'POST',
      headers: { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY, 'Content-Type': fotos[i].type.split(';')[0], 'x-upsert': 'true' },
      body: fotos[i].buf
    });
    if (up.ok) opgeslagen.push(process.env.SUPABASE_URL + '/storage/v1/object/public/auto-fotos/' + pad);
  }
  if (!opgeslagen.length) throw new Error('foto\'s konden niet worden opgeslagen');

  const rij = {
    model: d.model || 'Auto van Instagram', subtitle: d.subtitel || '', prijs: d.prijs || '',
    bouwjaar: d.bouwjaar || '', km: d.km || '', brandstof: d.brandstof || '', transmissie: d.transmissie || '',
    carrosserie: d.carrosserie || '', body: bodyType(d.carrosserie), kleur: d.kleur || '', vermogen: d.vermogen || '',
    locatie: 'Waddinxveen', omschrijving: d.omschrijving || '', opties: d.opties || [], fotos: opgeslagen, status: 'concept'
  };
  const ins = await sb('/rest/v1/autos', { method: 'POST', body: rij, prefer: 'return=representation' });
  if (!ins.ok) throw new Error('opslaan in autos mislukt (' + ins.status + ')');
  const nieuw = (await ins.json().catch(() => []))[0] || {};

  await sb('/rest/v1/ig_posts', { method: 'POST', body: { id: p.id, status: 'concept', auto_id: nieuw.id || null, model: rij.model, permalink: p.permalink || null } });
  return { id: p.id, status: 'concept', model: rij.model, prijs: rij.prijs };
}

/* ---------------- Hulpjes ---------------- */

function bodyType(s) {
  s = String(s || '').toLowerCase();
  if (s.includes('suv')) return 'suv';
  if (s.includes('station') || s.includes('combi') || s.includes('estate')) return 'estate';
  if (s.includes('sedan')) return 'sedan';
  return 'hatch';
}

function willekeurig() {
  const a = new Uint8Array(24);
  globalThis.crypto.getRandomValues(a);
  return Array.from(a, x => x.toString(16).padStart(2, '0')).join('');
}

function sb(pad, opt = {}) {
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  const h = { apikey: KEY, Authorization: 'Bearer ' + KEY };
  if (opt.body) h['Content-Type'] = 'application/json';
  const prefer = [opt.prefer, opt.method === 'POST' && pad.includes('ig_posts') ? 'resolution=merge-duplicates' : null].filter(Boolean).join(',');
  if (prefer) h.Prefer = prefer;
  return fetch(process.env.SUPABASE_URL + pad, { method: opt.method || 'GET', headers: h, body: opt.body ? JSON.stringify(opt.body) : undefined });
}

async function lees(sleutel) {
  const r = await sb('/rest/v1/instellingen?select=waarde&sleutel=eq.' + encodeURIComponent(sleutel));
  if (!r.ok) return null;
  const j = await r.json().catch(() => []);
  return (j[0] && j[0].waarde) || null;
}
async function zet(sleutel, waarde) {
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  await fetch(process.env.SUPABASE_URL + '/rest/v1/instellingen', {
    method: 'POST',
    headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ sleutel, waarde })
  });
}
async function wis(sleutel) {
  await sb('/rest/v1/instellingen?sleutel=eq.' + encodeURIComponent(sleutel), { method: 'DELETE' });
}
