'use strict';
const $ = s => document.querySelector(s);
const number = n => n !== null && n !== undefined && Number.isFinite(Number(n));
const rounded = n => number(n) ? Math.round(Number(n)) : '—';
const escapeHTML = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let locations = [], selected = '1110600', requestId = 0, timezone = 'Europe/Lisbon', forecasts = new Map();
try { selected = localStorage.getItem('clima-location') || selected; } catch {}
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
async function getJSON(url) {
  const response = await fetch(url, {signal:AbortSignal.timeout(35000)});
  if (!response.ok) throw new Error('IPMA indisponível');
  return response.json();
}
function visibleHours(data) {
  return (data.hours || []).filter(h => new Date(h.time).getTime() >= Date.now() - 45*60000).slice(0,24);
}
function cityButtons() {
  const ids = [selected, ...['1110600','1131200','1080500']].filter((id,i,a)=>a.indexOf(id)===i).slice(0,4);
  $('#locations').innerHTML=ids.map(id=>{
    const location=locations.find(l=>String(l.id)===id); if(!location)return '';
    const data=forecasts.get(id), h=data && visibleHours(data)[0];
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
async function loadWeather(id) {
  selected=String(id); const thisRequest=++requestId;
  try {localStorage.setItem('clima-location',selected);}catch{}
  $('#main').setAttribute('aria-busy','true');$('#refresh').disabled=true;status('A consultar a previsão do IPMA…');
  cityButtons();
  try {
    const data=await getJSON('/api/weather?id='+encodeURIComponent(selected));
    if(thisRequest!==requestId)return;
    forecasts.set(selected,data);render(data);
  } catch(error) {
    if(thisRequest!==requestId)return;
    const cached=forecasts.get(selected);
    if(cached)render({...cached,stale:true});
    else {$('#city').textContent=locations.find(l=>String(l.id)===selected)?.name||'Portugal';$('#temperature').textContent='—';$('#condition').textContent='Não foi possível obter a previsão';$('#hero-icon').replaceChildren();$('#high-low').textContent='';$('#forecast-time').textContent='';$('#hours').replaceChildren();$('#days').replaceChildren();$('#day-count').textContent='';$('#hourly-summary').textContent='Prévision indisponível.'.replace('Prévision','Previsão');$('#wind-direction').textContent='';$('#rain-note').textContent='Dados indisponíveis';$('#feels-note').textContent='Dados indisponíveis';for(const id of ['rain-value','wind-value','feels-value','humidity-value'])$('#'+id).textContent='—';$('#updated').textContent='Dados indisponíveis';}
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
$('#refresh').onclick=()=>loadWeather(selected);
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
  try {const result=await getJSON('/api/locations');locations=Array.isArray(result)?result:result.locations;if(!locations.some(l=>String(l.id)===selected))selected=String(locations.find(l=>l.name==='Lisboa')?.id||locations[0].id);cityButtons();await loadWeather(selected);for(const id of ['1110600','1131200','1080500']){if(forecasts.has(id))continue;try{forecasts.set(id,await getJSON('/api/weather?id='+id));cityButtons();}catch{}}}
  catch {status('Não foi possível carregar as localidades do IPMA. Atualiza a página para tentar novamente.',true);$('#condition').textContent='Serviço temporariamente indisponível';$('#main').setAttribute('aria-busy','false');initGlass();}
}
start();
