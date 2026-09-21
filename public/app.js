'use strict';
const $ = s => document.querySelector(s);
const number = n => n !== null && n !== undefined && n !== '' && typeof n !== 'boolean' && Number.isFinite(Number(n));
const rounded = n => number(n) ? Math.round(Number(n)) : '—';
const escapeHTML = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let locations = [], selected = '1110600', requestId = 0, timezone = 'Europe/Lisbon';
try { selected = localStorage.getItem('clima-location') || selected; } catch {}

// The browser talks to the public IPMA resources directly. These cache windows
// intentionally mirror server.py; the cache lasts only for this page session.
const IPMA_LOCATIONS_URL = 'https://api.ipma.pt/public-data/forecast/locations.json';
const IPMA_AGGREGATE_URL = id => `https://api.ipma.pt/public-data/forecast/aggregate/${id}.json`;
const IPMA_DAILY_URL = id => `https://api.ipma.pt/open-data/forecast/meteorology/cities/daily/${id}.json`;
const LOCATIONS_TTL_MS = 6 * 60 * 60 * 1000;
const LOCATIONS_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const WEATHER_TTL_MS = 10 * 60 * 1000;
const WEATHER_STALE_MS = 24 * 60 * 60 * 1000;
const WEATHER_CACHE_MAX_ENTRIES = 64;
const FETCH_TIMEOUT_MS = 10000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const WEATHER_DESCRIPTIONS = Object.freeze({
  0: 'Sem informação', 1: 'Céu limpo', 2: 'Céu pouco nublado',
  3: 'Céu parcialmente nublado', 4: 'Céu muito nublado ou encoberto',
  5: 'Céu nublado por nuvens altas', 6: 'Aguaceiros/chuva',
  7: 'Aguaceiros/chuva fracos', 8: 'Aguaceiros/chuva forte',
  9: 'Chuva/aguaceiros', 10: 'Chuva fraca ou chuvisco',
  11: 'Chuva/aguaceiros fortes', 12: 'Períodos de chuva',
  13: 'Períodos de chuva fraca', 14: 'Períodos de chuva forte',
  15: 'Chuvisco', 16: 'Neblina', 17: 'Nevoeiro ou nuvens baixas',
  18: 'Neve', 19: 'Trovoada', 20: 'Aguaceiros e possibilidade de trovoada',
  21: 'Granizo', 22: 'Geada', 23: 'Chuva e possibilidade de trovoada',
  24: 'Nebulosidade convectiva', 25: 'Céu com períodos de muito nublado',
  26: 'Nevoeiro', 27: 'Céu nublado', 28: 'Aguaceiros de neve',
  29: 'Chuva e Neve', 30: 'Chuva e Neve'
});
const SENTINEL_NUMBERS = new Set(['-99', '-99.0', '-999', '-999.0']);
let locationsCache = null;
let locationsRequest = null;
let locationsStale = false;
const weatherCache = new Map();
const weatherRequests = new Map();

class IPMAClientError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'IPMAClientError';
  }
}

const copyJSON = value => JSON.parse(JSON.stringify(value));
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function asNumber(value, integer = false) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string') {
    value = value.trim();
    if (!value || SENTINEL_NUMBERS.has(value)) return null;
  }
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed === -99 || parsed === -999) return null;
  return integer ? Math.trunc(parsed) : parsed;
}

function asLocationId(value) {
  const parsed = asNumber(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function utcTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let text = value.trim();
  if (text.endsWith('Z')) text = text.slice(0, -1);
  const datePart = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(text);
  if (!datePart || Number(datePart[1]) < 1) return null;
  const dayCheck = new Date(Date.UTC(Number(datePart[1]), Number(datePart[2]) - 1, Number(datePart[3])));
  if (dayCheck.getUTCFullYear() !== Number(datePart[1]) || dayCheck.getUTCMonth() !== Number(datePart[2]) - 1 || dayCheck.getUTCDate() !== Number(datePart[3])) return null;
  const hasOffset = /[+-]\d{2}:?\d{2}$/.test(text);
  const parsed = new Date(`${text}${hasOffset ? '' : 'Z'}`);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function dateOnly(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const parsed = new Date(`${text}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) return null;
  return text;
}

function description(code) {
  return code === null ? null : WEATHER_DESCRIPTIONS[code] ?? null;
}

function asWeatherCode(value) {
  const code = asNumber(value, true);
  return code === null || code === -99 ? null : code;
}

function normalizeLocations(raw) {
  if (!Array.isArray(raw)) throw new IPMAClientError('O catálogo de localidades do IPMA tem um formato inválido.');
  const result = [], seen = new Set();
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const rawId = Object.prototype.hasOwnProperty.call(item, 'globalIdLocal') ? item.globalIdLocal : item.id;
    const id = asLocationId(rawId);
    if (id === null || seen.has(id)) continue;
    const rawName = Object.prototype.hasOwnProperty.call(item, 'local') ? item.local : item.name;
    if (typeof rawName !== 'string' || !rawName.trim()) continue;
    const region = asNumber(item.idRegiao, true) ?? 0;
    result.push({
      id,
      name: rawName.trim(),
      lat: asNumber(item.latitude),
      lon: asNumber(item.longitude),
      timezone: region === 3 ? 'Atlantic/Azores' : 'Europe/Lisbon'
    });
    seen.add(id);
  }
  if (!result.length) throw new IPMAClientError('O catálogo de localidades do IPMA não contém localidades válidas.');
  return result;
}

function normalizeAggregate(location, raw, sourceUrl) {
  if (!Array.isArray(raw)) throw new IPMAClientError('A previsão agregada do IPMA tem um formato inválido.');
  const hourly = new Map(), daily = new Map();
  let updatedAt = null, recognized = false;
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const update = utcTimestamp(item.dataUpdate);
    if (update && (updatedAt === null || update > updatedAt)) updatedAt = update;
    const period = asNumber(item.idPeriodo, true);
    if (period === 1 || period === 3) {
      const timestamp = utcTimestamp(item.dataPrev);
      if (timestamp === null) continue;
      const code = asWeatherCode(item.idTipoTempo);
      const row = {
        time: timestamp,
        temp: asNumber(item.tMed),
        feelsLike: asNumber(item.utci),
        rain: asNumber(item.probabilidadePrecipita),
        wind: asNumber(item.ffVento),
        direction: typeof item.ddVento === 'string' ? item.ddVento : null,
        humidity: asNumber(item.hR),
        weatherCode: code,
        description: description(code)
      };
      const previous = hourly.get(timestamp);
      if (!previous || period < previous.period) hourly.set(timestamp, {period, row});
      recognized = true;
    } else if (period === 24) {
      const date = dateOnly(item.dataPrev);
      if (date === null) continue;
      const code = asWeatherCode(item.idTipoTempo);
      daily.set(date, {
        date,
        min: asNumber(item.tMin),
        max: asNumber(item.tMax),
        rain: asNumber(item.probabilidadePrecipita),
        weatherCode: code,
        description: description(code)
      });
      recognized = true;
    }
  }
  if (!recognized) throw new IPMAClientError('A previsão agregada do IPMA não contém períodos reconhecidos.');
  return {
    location: copyJSON(location),
    updatedAt,
    fetchedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    sourceUrl,
    hours: [...hourly.keys()].sort().map(key => hourly.get(key).row),
    days: [...daily.keys()].sort().map(key => daily.get(key)),
    stale: false
  };
}

function normalizeDaily(location, raw, sourceUrl) {
  if (!isRecord(raw) || !Array.isArray(raw.data)) throw new IPMAClientError('A previsão diária do IPMA tem um formato inválido.');
  const days = [], updatedAt = utcTimestamp(raw.dataUpdate);
  for (const item of raw.data) {
    if (!isRecord(item)) continue;
    const date = dateOnly(item.forecastDate);
    if (date === null) continue;
    const code = asWeatherCode(item.idWeatherType);
    days.push({
      date,
      min: asNumber(item.tMin),
      max: asNumber(item.tMax),
      rain: asNumber(item.precipitaProb),
      weatherCode: code,
      description: description(code)
    });
  }
  if (!days.length) throw new IPMAClientError('A previsão diária do IPMA não contém dias válidos.');
  days.sort((a, b) => a.date.localeCompare(b.date));
  return {
    location: copyJSON(location),
    updatedAt,
    fetchedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    sourceUrl,
    hours: [],
    days,
    stale: false
  };
}

function requestSignal(timeoutMs) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(timeoutMs);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
}

async function getJSON(url, label = 'IPMA') {
  let response;
  try {
    response = await fetch(url, {
      cache: 'no-cache',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: requestSignal(FETCH_TIMEOUT_MS)
    });
  } catch (error) {
    const reason = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'tempo limite excedido' : 'pedido falhou';
    throw new IPMAClientError(`${label}: ${reason}.`, {cause: error});
  }
  if (!response.ok) throw new IPMAClientError(`${label}: resposta HTTP ${response.status}.`);
  try {
    const declaredLength = response.headers?.get?.('content-length');
    if (declaredLength && Number.isFinite(Number(declaredLength)) && Number(declaredLength) > MAX_JSON_BYTES) {
      throw new IPMAClientError(`${label}: resposta demasiado grande.`);
    }
    if (!response.body?.getReader || typeof TextDecoder !== 'function') {
      const text = await response.text();
      const bytes = typeof TextEncoder === 'function' ? new TextEncoder().encode(text).byteLength : text.length;
      if (bytes > MAX_JSON_BYTES) throw new IPMAClientError(`${label}: resposta demasiado grande.`);
      return JSON.parse(text);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', {fatal: true});
    let bytes = 0, text = '';
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_JSON_BYTES) {
        await reader.cancel('response too large');
        throw new IPMAClientError(`${label}: resposta demasiado grande.`);
      }
      text += decoder.decode(value, {stream: true});
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof IPMAClientError) throw error;
    throw new IPMAClientError(`${label}: a resposta não é JSON válido.`, {cause: error});
  }
}

async function fetchLocations() {
  const now = Date.now();
  if (locationsCache && now - locationsCache.storedAt < LOCATIONS_TTL_MS) {
    return {locations: copyJSON(locationsCache.value), stale: false};
  }
  if (locationsRequest) return locationsRequest;
  locationsRequest = (async () => {
    try {
      const value = normalizeLocations(await getJSON(IPMA_LOCATIONS_URL, 'Catálogo de localidades'));
      locationsCache = {value, storedAt: Date.now()};
      return {locations: copyJSON(value), stale: false};
    } catch (error) {
      const age = locationsCache ? Date.now() - locationsCache.storedAt : Infinity;
      if (locationsCache && age <= LOCATIONS_STALE_MS) return {locations: copyJSON(locationsCache.value), stale: true};
      throw new IPMAClientError('Não foi possível carregar o catálogo de localidades do IPMA.', {cause: error});
    } finally {
      locationsRequest = null;
    }
  })();
  return locationsRequest;
}

function cacheForecast(id, value) {
  const key = String(id);
  weatherCache.set(key, {value: copyJSON(value), storedAt: Date.now()});
  while (weatherCache.size > WEATHER_CACHE_MAX_ENTRIES) {
    const oldest = weatherCache.keys().next().value;
    weatherCache.delete(oldest);
  }
}

function cachedForecast(id, maxAge = WEATHER_STALE_MS) {
  const key = String(id);
  const cached = weatherCache.get(key);
  if (!cached) return null;
  const age = Date.now() - cached.storedAt;
  if (age > WEATHER_STALE_MS) {
    weatherCache.delete(key);
    return null;
  }
  if (age > maxAge) return null;
  return copyJSON(cached.value);
}

async function fetchWeather(id, {force = false} = {}) {
  const catalog = await fetchLocations();
  locations = catalog.locations;
  locationsStale = catalog.stale;
  const locationId = asLocationId(id);
  const location = locations.find(item => item.id === locationId);
  if (!location) throw new IPMAClientError('A localidade pedida não pertence ao catálogo do IPMA.');
  const key = String(locationId);
  const cached = weatherCache.get(key);
  if (!force && cached && Date.now() - cached.storedAt < WEATHER_TTL_MS) {
    weatherCache.delete(key);
    weatherCache.set(key, cached);
    const value = copyJSON(cached.value);
    if (locationsStale) value.stale = true;
    return value;
  }
  if (weatherRequests.has(key)) return weatherRequests.get(key);
  const request = (async () => {
    let result, servedCached = false;
    try {
      const aggregateUrl = IPMA_AGGREGATE_URL(locationId);
      try {
        result = normalizeAggregate(location, await getJSON(aggregateUrl, 'Previsão horária'), aggregateUrl);
      } catch (aggregateError) {
        const dailyUrl = IPMA_DAILY_URL(locationId);
        try {
          result = normalizeDaily(location, await getJSON(dailyUrl, 'Previsão diária'), dailyUrl);
        } catch (dailyError) {
          const stale = cachedForecast(locationId);
          if (stale) {
            result = stale;
            result.stale = true;
            servedCached = true;
          } else {
            throw new IPMAClientError('O IPMA não disponibilizou a previsão horária nem diária.', {cause: dailyError, aggregateError});
          }
        }
      }
      if (locationsStale) result.stale = true;
      if (!servedCached) cacheForecast(locationId, result);
      return copyJSON(result);
    } finally {
      weatherRequests.delete(key);
    }
  })();
  weatherRequests.set(key, request);
  return request;
}

const timeFormat = (time, options = {}) => new Intl.DateTimeFormat('pt-PT', {timeZone:timezone,...options}).format(new Date(time));
const dateKey = (date = new Date()) => new Intl.DateTimeFormat('sv-SE',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
function icon(code, isNight = false) {
  const n = Number(code);
  const sun = '<g stroke="#ffe19a" stroke-width="1.8" stroke-linecap="round"><path d="M16 2v3m0 22v3M2 16h3m22 0h3M6 6l2 2m16 16 2 2M6 26l2-2M24 8l2-2"/><circle cx="16" cy="16" r="6" fill="#ffdc82" stroke="none"/></g>';
  const moon = '<path d="M23 24A12 12 0 0 1 14 3a11 11 0 1 0 9 21" fill="#e6effb"/>';
  const cloud = '<path d="M8 25a6 6 0 1 1 .5-12 8 8 0 0 1 15-1 6.5 6.5 0 1 1 1 13Z" fill="#e8f2f7"/>';
  const rain = '<path d="m10 25-2 4m9-4-2 4m9-4-2 4" stroke="#9ad8ff" stroke-width="2" stroke-linecap="round"/>';
  let shape = cloud;
  if (n===1) shape = isNight ? moon : sun;
  else if ([2,3,5].includes(n)) shape = '<g transform="translate(0 -3) scale(.85)">'+(isNight?moon:sun)+'</g><g transform="translate(4 7) scale(.8)">'+cloud+'</g>';
  else if ([6,7,8,9,10,11,12,13,14,15,21,29,30].includes(n)) shape = '<g transform="translate(0 -4)">'+cloud+'</g>'+rain;
  else if ([16,17,26].includes(n)) shape = cloud+'<path d="M5 28h22M3 31h23" stroke="#d0e4ee" stroke-width="1.5"/>';
  else if ([19,20,23].includes(n)) shape = cloud+'<path d="m18 19-7 9h6l-3 6 11-12h-7l4-5" fill="#ffdc82"/>';
  else if ([18,22,28].includes(n)) shape = cloud+'<path d="M16 24v8m-4-6 8 4m-8 0 8-4" stroke="#daf1ff" stroke-width="1.5"/>';
  return '<svg class="weather-icon" viewBox="0 0 32 34" aria-hidden="true">'+shape+'</svg>';
}
function status(message, retry = false) {
  const el = $('#status'); el.replaceChildren(); el.hidden = !message;
  if (!message) return;
  el.append(document.createTextNode(message));
  if (retry) {const b = document.createElement('button');b.textContent='Tentar novamente';b.onclick=()=>locations.length?loadWeather(selected):start();el.append(b);}
}
function visibleHours(data) {
  return (data.hours || []).filter(h => new Date(h.time).getTime() >= Date.now() - 45*60000).slice(0,24);
}
function cityButtons() {
  const ids = [selected, ...['1110600','1131200','1080500']].filter((id,i,a)=>a.indexOf(id)===i).slice(0,4);
  $('#locations').innerHTML=ids.map(id=>{
    const location=locations.find(l=>String(l.id)===id); if(!location)return '';
    const data=cachedForecast(id), h=data && visibleHours(data)[0];
    return `<button class="city-button ${id===selected?'active':''}" data-id="${id}" aria-pressed="${id===selected}"><strong>${escapeHTML(location.name)}</strong><span class="city-temp">${rounded(h?.temp)}°</span><small class="city-meta">${escapeHTML(h?.description || 'Ver previsão')}</small></button>`;
  }).join('');
  $('#locations').querySelectorAll('button').forEach(button=>button.onclick=()=>loadWeather(button.dataset.id));
}
function render(data) {
  timezone=data.location.timezone || 'Europe/Lisbon';
  const hours=visibleHours(data), h=hours[0], today=dateKey();
  const days=(data.days||[]).filter(d=>d.date>=today), day=days[0];
  $('#city').textContent=data.location.name;
  document.title=`${data.location.name} — Previsão IPMA`;
  $('#date-label').textContent=timeFormat(new Date(),{weekday:'long',day:'numeric',month:'long'});
  $('#local-clock').textContent=timeFormat(new Date(),{hour:'2-digit',minute:'2-digit'})+' LOCAL';
  const localHour=Number(timeFormat(h?.time||new Date(),{hour:'2-digit',hourCycle:'h23'}));
  $('#hero-icon').innerHTML=icon(h?.weatherCode ?? day?.weatherCode,localHour<7||localHour>=20);
  $('#temperature').textContent=rounded(h?.temp);
  $('#condition').textContent=h?.description || day?.description || 'Previsão horária indisponível';
  $('#high-low').textContent=day?`Máx. ${rounded(day.max)}°  ·  Mín. ${rounded(day.min)}°`:'Previsão diária indisponível';
  $('#forecast-time').textContent=h?`Previsão para ${timeFormat(h.time,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}`:'Sem temperatura horária disponível';
  $('#hourly-caption').textContent=data.location.timezone==='Atlantic/Azores'?'Hora dos Açores':'Hora local';
  const rainHours=hours.slice(0,8).filter(x=>number(x.rain)), maxRain=rainHours.length?Math.max(...rainHours.map(x=>Number(x.rain))):null;
  $('#hourly-summary').textContent=h?`${h.description || 'Previsão local'}.${maxRain!==null?` Probabilidade de chuva até ${rounded(maxRain)}% nos próximos períodos.`:''}`:'O IPMA não disponibilizou previsão horária para esta localidade.';
  $('#hours').innerHTML=hours.length?hours.map((hour,i)=>{
    const hourOfDay=Number(timeFormat(hour.time,{hour:'2-digit',hourCycle:'h23'}));
    return `<div class="hour" title="${escapeHTML(hour.description)}"><span class="time">${timeFormat(hour.time,{hour:'2-digit',minute:'2-digit'})}</span>${icon(hour.weatherCode,hourOfDay<7||hourOfDay>=20)}<span class="temp">${rounded(hour.temp)}°</span><span class="rain">${number(hour.rain)?rounded(hour.rain)+'%':'—'}</span></div>`;
  }).join(''):'<p class="empty">Sem dados horários. Consulta a previsão diária abaixo.</p>';
  $('#hours').scrollLeft=0;
  const mins=days.filter(d=>number(d.min)).map(d=>Number(d.min)), maxs=days.filter(d=>number(d.max)).map(d=>Number(d.max));
  const min=Math.min(...mins), max=Math.max(...maxs), span=Math.max(1,max-min);
  $('#day-count').textContent=days.length?`${days.length} dias ↓`:'';
  $('#days').innerHTML=days.length?days.map((d,i)=>{
    const name=d.date===today?'Hoje':timeFormat(d.date+'T12:00:00Z',{weekday:'short'}).replace('.','');
    const left=number(d.min)?(Number(d.min)-min)/span*100:0, width=number(d.max)&&number(d.min)?Math.max(3,(Number(d.max)-Number(d.min))/span*100):0;
    return `<div class="day" title="${escapeHTML(d.description)}"><span>${escapeHTML(name)}</span><span class="day-icon">${icon(d.weatherCode)}<small>${number(d.rain)?rounded(d.rain)+'%':''}</small></span><span class="low">${rounded(d.min)}°</span><span class="range"><span style="left:${left}%;width:${width}%"></span></span><span class="high">${rounded(d.max)}°</span></div>`;
  }).join(''):'<p class="empty">A previsão diária está indisponível.</p>';
  const rainPeriod=hours.slice(0,4).find(x=>number(x.rain));
  $('#rain-value').innerHTML=rainPeriod?`${rounded(rainPeriod.rain)}<small>%</small>`:'—';
  $('#rain-note').textContent=rainPeriod?'Probabilidade nas 3 h até às '+timeFormat(rainPeriod.time,{hour:'2-digit',minute:'2-digit'}):'Probabilidade não disponibilizada';
  $('#wind-value').innerHTML=number(h?.wind)?`${rounded(h.wind)}<small> km/h</small>`:'—';
  $('#wind-direction').textContent=h?.direction?`De ${h.direction}`:'Direção indisponível';
  const angles={N:0,NE:45,E:90,SE:135,S:180,SW:225,SO:225,W:270,O:270,NW:315,NO:315};
  $('#wind-arrow').style.transform=`rotate(${angles[h?.direction]??0}deg)`;
  $('#feels-value').textContent=number(h?.feelsLike)?`${rounded(h.feelsLike)}°`:'—';
  $('#feels-note').textContent=number(h?.feelsLike)&&number(h?.temp)?(Math.abs(h.feelsLike-h.temp)<2?'Semelhante à temperatura do ar':h.feelsLike<h.temp?'Sensação mais fresca do que o ar':'Sensação mais quente do que o ar'):'Não disponibilizada pelo IPMA';
  $('#humidity-value').innerHTML=number(h?.humidity)?`${rounded(h.humidity)}<small>%</small>`:'—';
  const update=data.updatedAt&&Number.isFinite(new Date(data.updatedAt).getTime());
  $('#updated').textContent=update?`Atualizado ${timeFormat(data.updatedAt,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}`:'Hora de atualização não disponível';
  status(data.stale?'O IPMA está temporariamente indisponível. A mostrar a última previsão guardada.':!hours.length?'A previsão horária não está disponível neste momento. Os dados diários disponíveis são apresentados abaixo.':data.warnings?.join(' ')||'');
  cityButtons();
  initGlass();
}
async function loadWeather(id, force = false) {
  selected=String(id); const thisRequest=++requestId;
  try {localStorage.setItem('clima-location',selected);}catch{}
  $('#main').setAttribute('aria-busy','true');$('#refresh').disabled=true;status('A consultar a previsão do IPMA…');
  cityButtons();
  try {
    const data=await fetchWeather(selected, {force});
    if(thisRequest!==requestId)return;
    render(data);
  } catch(error) {
    if(thisRequest!==requestId)return;
    console.warn('IPMA forecast request failed', error);
    const cached=cachedForecast(selected);
    if(cached)render({...cached,stale:true});
    else {$('#city').textContent=locations.find(l=>String(l.id)===selected)?.name||'Portugal';$('#temperature').textContent='—';$('#condition').textContent='Não foi possível obter a previsão';$('#hero-icon').replaceChildren();$('#high-low').textContent='';$('#forecast-time').textContent='';$('#hours').replaceChildren();$('#days').replaceChildren();$('#day-count').textContent='';$('#hourly-summary').textContent='Previsão indisponível.';$('#wind-direction').textContent='';$('#rain-note').textContent='Dados indisponíveis';$('#feels-note').textContent='Dados indisponíveis';for(const id of ['rain-value','wind-value','feels-value','humidity-value'])$('#'+id).textContent='—';$('#updated').textContent='Dados indisponíveis';}
    status('Não foi possível contactar o IPMA. Tenta novamente dentro de instantes.',true);initGlass();
  } finally {if(thisRequest===requestId){$('#main').setAttribute('aria-busy','false');$('#refresh').disabled=false;}}
}
$('#search').addEventListener('input',()=>{
  const term=$('#search').value.trim().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  const box=$('#search-results');box.hidden=!term;box.replaceChildren();if(!term)return;
  const results=locations.filter(l=>l.name.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().includes(term)).slice(0,16);
  if(!results.length){box.textContent='Nenhuma localidade encontrada.';return;}
  results.forEach(l=>{const b=document.createElement('button');b.className='search-result';b.textContent=l.name;b.onclick=()=>{box.hidden=true;$('#search').value='';loadWeather(l.id);};box.append(b);});
});
$('#search').addEventListener('keydown',e=>{if(e.key==='Escape'){$('#search-results').hidden=true;$('#search').value='';}if(e.key==='Enter')$('#search-results button')?.click();});
$('#refresh').onclick=()=>loadWeather(selected, true);
$('#locate').onclick=()=>{
  const el=$('#location-message');
  if(!navigator.geolocation){el.textContent='Localização indisponível. Procura a tua localidade acima.';return;}
  el.textContent='A localizar…';
  navigator.geolocation.getCurrentPosition(p=>{
    let best=null,distance=Infinity;
    for(const l of locations){if(!number(l.lat)||!number(l.lon))continue;const d=(l.lat-p.coords.latitude)**2+((l.lon-p.coords.longitude)*Math.cos(p.coords.latitude*Math.PI/180))**2;if(d<distance){distance=d;best=l;}}
    if(best&&distance<4){el.textContent=`Localidade mais próxima: ${best.name}`;loadWeather(best.id);}else el.textContent='Escolhe uma localidade portuguesa na pesquisa.';
  },()=>{el.textContent='Não foi possível obter a localização. Usa a pesquisa acima.';},{timeout:10000,maximumAge:300000});
};
let glassStarted=false;
function initGlass(){
  if(glassStarted||typeof window.liquidGL!=='function')return;
  glassStarted=true;
  if(matchMedia('(prefers-reduced-transparency: reduce)').matches)return;
  try {
    window.climaGlass=window.liquidGL({target:'.glass:not(.status)',snapshot:'.sky',resolution:Math.min(devicePixelRatio,1.5),refraction:0.012,bevelDepth:0.065,bevelWidth:0.12,frost:2,shadow:false,specular:!matchMedia('(prefers-reduced-motion: reduce)').matches,reveal:'none',tilt:false,aberration:0.008});
    document.documentElement.dataset.glass='liquidGL';
  } catch { document.documentElement.dataset.glass='fallback'; }
  // A failed GPU initialization must never hide forecast content.
  setTimeout(()=>document.querySelectorAll('.glass').forEach(el=>{el.style.opacity='1';}),4000);
}
async function start(){
  try {
    const result=await fetchLocations();
    locations=result.locations;locationsStale=result.stale;
    if(!locations.some(l=>String(l.id)===selected))selected=String(locations.find(l=>l.name==='Lisboa')?.id||locations[0].id);
    cityButtons();
    await loadWeather(selected);
    for(const id of ['1110600','1131200','1080500']){
      if(cachedForecast(id, WEATHER_TTL_MS))continue;
      try {await fetchWeather(id);cityButtons();}
      catch(error){console.warn('IPMA city prefetch failed', error);}
    }
  } catch(error) {
    console.warn('IPMA locations request failed', error);
    status('Não foi possível carregar as localidades do IPMA. Atualiza a página para tentar novamente.',true);$('#condition').textContent='Serviço temporariamente indisponível';$('#main').setAttribute('aria-busy','false');initGlass();
  }
}
start();
