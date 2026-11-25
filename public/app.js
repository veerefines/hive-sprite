/* Hive client: plain JS + Leaflet, no build step. */
const $ = (s, el = document) => el.querySelector(s)
const $$ = (s, el = document) => [...el.querySelectorAll(s)]
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const app = $('#app')
const HEX = '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 3 57 17.5v29L32 61 7 46.5v-29z" fill="#f5a524"/><path d="M32 15 46.7 23.5v17L32 49 17.3 40.5v-17z" fill="#17130f"/><circle cx="32" cy="32" r="6" fill="#f5a524"/></svg>'

const INTERESTS = [['food', '🍽️'], ['culture', '🎭'], ['history', '🏛️'], ['art', '🖼️'], ['nature', '🌿'], ['nightlife', '🍸'], ['shopping', '🛍️'], ['architecture', '🏰'], ['coffee', '☕'], ['markets', '🧺'], ['views', '🌅'], ['music', '🎶']]
const DAY_COLORS = ['#f5a524', '#2f6fb0', '#ff5a3c', '#1f8a4c', '#7b4bb8']
const ICON = { food: '🍽️', restaurant: '🍽️', cafe: '☕', bakery: '🥐', sight: '📍', attraction: '📍', activity: '🎟️', viewpoint: '🌅', museum: '🏛️', gallery: '🖼️', park: '🌳', nightlife: '🍷', bar: '🍷', market: '🧺', shopping: '🛍️', hotel: '🏨', hostel: '🛏️', stay: '🏨' }
const KIND_LABEL = { restaurant: 'Restaurants', cafe: 'Cafés', bakery: 'Bakeries', museum: 'Museums', gallery: 'Galleries', attraction: 'Sights', viewpoint: 'Viewpoints', park: 'Parks & gardens', bar: 'Bars', market: 'Markets', hotel: 'Other hotels', hostel: 'Hostels' }
const MODE = { walk: ['🚶', 'Walk', 'walking'], transit: ['🚇', 'Transit', 'transit'], taxi: ['🚕', 'Taxi', 'driving'] }
const COST = { travel: ['✈️', 'Getting there', '#2f6fb0'], stay: ['🏨', 'Stay', '#7b4bb8'], food: ['🍽️', 'Food', '#ff5a3c'], local: ['🚇', 'Getting around', '#1f8a4c'], activities: ['🎟️', 'Things to do', '#f5a524'], shopping: ['🛍️', 'Shopping', '#e36aa0'], buffer: ['🧯', 'Buffer', '#b9ad9e'] }
const EXAMPLES = [
  { destination: 'Lisbon, Portugal', blurb: 'Seafood & miradouros', prompt: 'Seafood, pastel de nata, one viewpoint at sunset, keep it walkable', interests: ['food', 'history', 'views'] },
  { destination: 'Kyoto, Japan', blurb: 'Temples & tea', prompt: 'Temples early before crowds, a tea house, one great ramen dinner', interests: ['culture', 'food', 'nature'] },
  { destination: 'Mexico City, Mexico', blurb: 'Tacos & murals', prompt: 'Street tacos, Frida Kahlo museum, mezcal bar on the last night', interests: ['food', 'art', 'nightlife'] },
  { destination: 'Rome, Italy', blurb: 'Ruins & gelato', prompt: 'Ancient sites in the morning, long lunches, gelato every day', interests: ['history', 'food', 'architecture'] },
]

let profile = {}
let health = null
let trip = null
let tab = 'overview'
let day = null
let map = null
const covers = {}

// ---------- utils ----------
const iso = (d) => d.toISOString().slice(0, 10)
const addDays = (s, n) => iso(new Date(Date.parse(s) + n * 864e5))
const fmtDay = (d, opts = { weekday: 'short', month: 'short', day: 'numeric' }) => new Date(`${d}T12:00:00`).toLocaleDateString('en', opts)
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5) + 1
const wxIcon = (w) => (!w ? '🗓️' : w.rain || /rain|drizzle|shower|storm|snow/.test(w.desc) ? (/snow/.test(w.desc) ? '🌨️' : '🌧️') : /cloud|overcast|fog/.test(w.desc) ? '⛅' : '☀️')
const toMin = (hhmm) => (hhmm ? Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)) : 9999)
function money(usd, cur, rates) {
  const r = rates?.[cur] ?? (cur === 'USD' ? 1 : null)
  if (r == null || usd == null) return `$${Math.round(usd ?? 0)}`
  const v = usd * r
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: cur, maximumFractionDigits: v >= 10 ? 0 : 2 }).format(v)
  } catch {
    return `${Math.round(v)} ${cur}`
  }
}
const local = (usd) => money(usd, trip.money?.currency ?? 'USD', trip.money?.rates)
const home = (usd) => money(usd, trip.money?.homeCurrency ?? 'USD', trip.money?.rates)
function groupDays(stops) {
  const m = new Map()
  for (const s of stops) (m.get(s.date) ?? m.set(s.date, []).get(s.date)).push(s)
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([d, list]) => [d, list.sort((a, b) => toMin(a.start) - toMin(b.start))])
}
function photo(p, kind, opts = {}) {
  const k = kind ?? 'sight'
  if (p?.url) return `<div class="ph ${opts.cls ?? ''}"><img src="${esc(p.url)}" alt="${esc(p.title ?? '')}" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'art ${esc(k)}',textContent:'${ICON[k] ?? '📍'}'}))" />${opts.credit && p.page ? `<a class="credit" href="${esc(p.page)}" target="_blank" rel="noopener">© Wikimedia</a>` : ''}</div>`
  return `<div class="ph ${opts.cls ?? ''}"><div class="art ${esc(k)}">${ICON[k] ?? '📍'}</div></div>`
}
function toast(msg) {
  const t = $('#toast')
  t.textContent = msg
  t.classList.add('on')
  clearTimeout(toast.h)
  toast.h = setTimeout(() => t.classList.remove('on'), 2600)
}
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status })
  return data
}
async function stream(path, body, onEvent) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw Object.assign(new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`), { status: res.status })
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let last = null
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line) continue
      const ev = JSON.parse(line)
      if (ev.type === 'error') throw new Error(ev.error)
      onEvent(ev)
      last = ev
    }
  }
  return last
}
async function cover(name) {
  if (covers[name] !== undefined) return covers[name]
  covers[name] = await api(`/api/cover?v=2&q=${encodeURIComponent(name.split(',')[0])}`).catch(() => ({}))
  return covers[name]
}
const stepIcon = (e) => ({ setup: '📍', geocode: '📍', find_places: '🔎', propose_plan: '🩺', enrich: '🧭', remember: '🧠', slack: '💬' })[e.tool] ?? '•'
function stepText(e) {
  if (e.tool === 'find_places') return `Searching ${e.note}`
  if (e.tool === 'propose_plan') return `Plan Doctor checked a draft · ${e.note}`
  if (e.tool === 'remember') return `Remembered · ${e.note}`
  return e.note
}

// ---------- routing ----------
function navigate(path) {
  history.pushState({}, '', path)
  route()
}
window.addEventListener('popstate', route)
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-nav], a[data-trip]')
  if (!a || e.metaKey || e.ctrlKey) return
  e.preventDefault()
  navigate(a.dataset.trip ? `/t/${a.dataset.trip}` : a.getAttribute('href'))
})
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeSheets())
$('#scrim').onclick = closeSheets
function closeSheets() {
  $$('.drawer').forEach((d) => d.classList.remove('on'))
  $('#scrim').classList.remove('on')
}
function openSheet(id) {
  closeSheets()
  $(`#${id}`).classList.add('on')
  $('#scrim').classList.add('on')
}
async function route() {
  closeSheets()
  $$('.top nav a').forEach((a) => a.classList.toggle('on', a.dataset.nav === location.pathname + location.hash || (a.dataset.nav === '/' && location.pathname === '/' && !location.hash)))
  $('.fab')?.remove()
  const m = /^\/t\/([\w-]+)/.exec(location.pathname)
  if (m) {
    if (trip?.id !== m[1]) {
      app.innerHTML = `<div class="cover shimmer"></div>`
      try {
        trip = await api(`/api/trips/${m[1]}`)
        tab = 'overview'
        day = null
      } catch (err) {
        app.innerHTML = `<div class="pane"><div class="notice err"><span class="ic">⚠️</span>${esc(err.message)}</div></div>`
        return
      }
    }
    window.scrollTo(0, 0)
    return renderTrip()
  }
  if (location.hash === '#profile') return renderProfile()
  renderHome()
}

// ---------- health / free tier ----------
async function loadHealth() {
  health = await api('/api/health').catch(() => null)
  if (!health) return
  const low = health.plansLeft === 0
  $('#health').innerHTML = [
    `<span class="pill on" title="Hive runs as a service on this Fly.io Sprite"><i></i>Sprite · ${esc(health.host)}</span>`,
    `<span class="pill ${health.llmConnector ? 'on' : ''}" title="Free models via the Sprites OpenRouter connector: ${esc((health.models ?? []).join(', '))}"><i></i>Free AI via connector</span>`,
    `<span class="pill ${low ? 'warn' : ''}" title="Free-tier guardrails">${health.plansLeft} plan${health.plansLeft === 1 ? '' : 's'} · ${health.chatsLeft} msgs left</span>`,
  ].join('')
}
function freeNote() {
  if (!health) return ''
  const pct = Math.round((health.aiCallsLeft / 45) * 100)
  return `<div class="free-note"><div class="meter"><div style="width:${Math.min(100, pct)}%"></div></div><span><b>Free tier</b> · ${health.plansLeft ? `${health.plansLeft} new trip${health.plansLeft === 1 ? '' : 's'} available for you now` : 'no new trips left right now'} · resets ${health.resetsInSec > 3600 ? `in ${Math.round(health.resetsInSec / 3600)}h` : 'within the hour'}</span></div>`
}

// ---------- home ----------
async function renderHome() {
  document.title = 'Hive · your personal trip agent on a Fly.io Sprite'
  profile = await api('/api/profile').catch(() => ({}))
  const start = addDays(iso(new Date()), 4)
  let travellers = 2
  app.innerHTML = `
  <section class="home-hero">
    <div class="bg" id="hero-bg"></div>
    <div class="inner">
      <div>
        <span class="pill" style="background:rgba(255,255,255,.18);border-color:rgba(255,255,255,.3);color:#fff">⬢ A personal agent living on a Fly.io Sprite</span>
        <h1 style="margin-top:14px">Where to next?</h1>
        <p>Hive finds real places, plans every meal, sight and the stay, argues with a strict plan checker until it all fits, then lets you refine it by chat.</p>
        <div class="where"><input id="where" placeholder="Try Lisbon, Kyoto, Mexico City…" value="" maxlength="120" /><button class="btn coral" id="where-go">Plan it ✦</button></div>
      </div>
      <div class="hero-cards">${EXAMPLES.map((x, i) => `<button class="dest" data-ex="${i}"><div class="ph shimmer" data-cover="${esc(x.destination)}"></div><span>${esc(x.destination.split(',')[0])}<small>${esc(x.blurb)}</small></span></button>`).join('')}</div>
    </div>
  </section>

  <section class="planner">
    <form class="card" id="plan-form" autocomplete="off">
      <div class="blk">
        <h3><b>1</b> Where & when</h3>
        <label>Destination<input name="destination" required placeholder="Lisbon, Portugal" maxlength="120" /></label>
        <div class="row"><label>From<input type="date" name="startDate" required value="${start}" /></label><label>To<input type="date" name="endDate" required value="${addDays(start, 1)}" /></label></div>
        <div class="row"><label>Travellers<div class="stepper"><button type="button" data-st="-1">−</button><output id="trav">2</output><button type="button" data-st="1">+</button></div></label><label>Coming from<input name="origin" placeholder="Los Angeles, USA" value="${esc(profile.homeCity ?? '')}" maxlength="120" /></label></div>
      </div>
      <div class="blk">
        <h3><b>2</b> Your style</h3>
        <label>Pace<div class="seg" id="pace">${['chill', 'balanced', 'packed'].map((p) => `<button type="button" data-pace="${p}" class="${(profile.pace ?? 'balanced') === p ? 'on' : ''}">${{ chill: '🐢 Chill', balanced: '⚖️ Balanced', packed: '⚡ Packed' }[p]}</button>`).join('')}</div></label>
        <label>Into<div class="chips" id="interests">${INTERESTS.map(([x, ic]) => `<button type="button" class="chip ${(profile.interests ?? []).includes(x) ? 'on' : ''}" data-i="${x}">${ic} ${x}</button>`).join('')}</div></label>
      </div>
      <div class="blk">
        <h3><b>3</b> The details</h3>
        <div class="row"><label>Budget / person / day<input type="number" name="dailyBudget" min="0" placeholder="$150" value="${esc(profile.dailyBudget ?? '')}" /></label><label>Wake up<input type="time" name="wakeTime" value="08:00" /></label></div>
        <label>Diet<input name="diet" placeholder="vegetarian, halal, no shellfish…" value="${esc(profile.diet ?? '')}" maxlength="80" /></label>
        <label>Anything else?<textarea name="prompt" rows="2" maxlength="1000" placeholder="One viewpoint at sunset, a cooking class…"></textarea></label>
      </div>
      <div class="full">${freeNote()}<div class="row" style="align-items:center"><span class="err" id="plan-err"></span><button class="btn dark" type="submit" style="padding:13px 26px;font-size:16px">Plan my trip with Hive ✦</button></div></div>
    </form>
  </section>

  <section class="section" id="trips">
    <div class="section-h"><h2>Trips on this Sprite</h2><span class="muted">Saved to the Sprite's disk</span></div>
    <div class="rail" id="trip-list"><div class="card shimmer" style="height:250px"></div><div class="card shimmer" style="height:250px"></div><div class="card shimmer" style="height:250px"></div></div>
  </section>

  <section class="section">
    <div class="section-h"><h2>How Hive works</h2></div>
    <div class="how">
      <div class="card lift"><div class="ic" style="background:var(--sky-soft)">🔎</div><b>Researches real places</b><span>Restaurants, cafés, sights, viewpoints and hotels from OpenStreetMap, with photos from Wikimedia. Nothing invented.</span></div>
      <div class="card lift"><div class="ic" style="background:var(--coral-soft)">🩺</div><b>Plan Doctor, on repeat</b><span>Overlaps, tight travel, missing meals, rain on outdoor stops, early dinners, your sunset request. Hive fixes each one.</span></div>
      <div class="card lift"><div class="ic" style="background:var(--ok-soft)">🧭</div><b>The whole trip</b><span>Stay, best route between stops, costs in two currencies, rainy-day backups, a packing list.</span></div>
      <div class="card lift"><div class="ic" style="background:var(--honey-soft)">🧠</div><b>Remembers you</b><span>Diet, home city and tastes live on this Sprite's disk and shape every next trip.</span></div>
    </div>
  </section>`

  const form = $('#plan-form')
  // Destination cards: real photos, click to prefill.
  EXAMPLES.forEach(async (x, i) => {
    const c = await cover(x.destination)
    const slot = $(`[data-cover="${CSS.escape(x.destination)}"]`)
    if (slot) slot.outerHTML = photo(c, 'sight')
    if (i === 0 && c?.url && $('#hero-bg')) $('#hero-bg').innerHTML = `<img src="${esc(c.url)}" alt="" referrerpolicy="no-referrer" />`
  })
  const useExample = (x) => {
    form.destination.value = x.destination
    form.prompt.value = x.prompt
    $('#where').value = x.destination
    $$('#interests .chip').forEach((c) => c.classList.toggle('on', x.interests.includes(c.dataset.i)))
    cover(x.destination).then((c) => c?.url && ($('#hero-bg').innerHTML = `<img src="${esc(c.url)}" alt="" referrerpolicy="no-referrer" />`))
  }
  $('.hero-cards').onclick = (e) => {
    const b = e.target.closest('[data-ex]')
    if (!b) return
    $$('.dest').forEach((d) => d.classList.toggle('on', d === b))
    useExample(EXAMPLES[b.dataset.ex])
    toast(`${EXAMPLES[b.dataset.ex].destination.split(',')[0]} loaded. Check the details and plan.`)
  }
  $('#where-go').onclick = () => {
    const v = $('#where').value.trim()
    if (v) form.destination.value = v
    $('.planner').scrollIntoView({ behavior: 'smooth', block: 'center' })
    if (v) cover(v).then((c) => c?.url && ($('#hero-bg').innerHTML = `<img src="${esc(c.url)}" alt="" referrerpolicy="no-referrer" />`))
    form.destination.focus()
  }
  $('#where').onkeydown = (e) => e.key === 'Enter' && (e.preventDefault(), $('#where-go').click())
  $('#pace').onclick = (e) => {
    const b = e.target.closest('[data-pace]')
    if (b) $$('#pace button').forEach((x) => x.classList.toggle('on', x === b))
  }
  $('#interests').onclick = (e) => e.target.closest('.chip')?.classList.toggle('on')
  form.onclick = (e) => {
    const s = e.target.closest('[data-st]')
    if (!s) return
    travellers = Math.max(1, Math.min(12, travellers + Number(s.dataset.st)))
    $('#trav').textContent = travellers
  }
  form.startDate.onchange = () => {
    if (form.endDate.value < form.startDate.value) form.endDate.value = addDays(form.startDate.value, 1)
  }
  form.onsubmit = (e) => {
    e.preventDefault()
    const body = Object.fromEntries(new FormData(form))
    body.travellers = travellers
    body.pace = $('#pace .on')?.dataset.pace ?? 'balanced'
    body.interests = $$('#interests .on').map((c) => c.dataset.i)
    if (daysBetween(body.startDate, body.endDate) > 5) return ($('#plan-err').textContent = 'Hive plans up to 5 days at a time.')
    if (health && health.plansLeft === 0) return ($('#plan-err').textContent = 'No free plans left for you right now. Browse the trips below, or chat with Hive about one.')
    planTrip(body)
  }
  if (location.hash === '#trips') setTimeout(() => $('#trips').scrollIntoView(), 50)
  loadTrips()
}

async function loadTrips() {
  const list = await api('/api/trips').catch(() => [])
  $('#trip-list').innerHTML = list.length
    ? list
        .map(
          (t) => `<a class="card tripcard lift fade-up" href="/t/${esc(t.id)}" data-trip="${esc(t.id)}">${photo(t.cover, 'sight')}
        <div class="body"><span class="tag">${esc(fmtDay(t.startDate, { month: 'short', day: 'numeric' }))} – ${esc(fmtDay(t.endDate, { month: 'short', day: 'numeric' }))}</span>
        <h3>${esc(t.title)}</h3><div class="meta">📍 ${esc(t.destination)} · ${t.stops} stops${t.totalUsd ? ` · ~$${t.totalUsd.toLocaleString()} pp` : ''}</div></div></a>`,
        )
        .join('')
    : '<div class="card pad muted">No trips yet. Plan the first one above.</div>'
}

async function planTrip(body) {
  const c = await cover(body.destination)
  app.innerHTML = `<section class="working"><div class="bg">${c?.url ? `<img src="${esc(c.url)}" alt="" referrerpolicy="no-referrer" />` : ''}</div>
    <div class="card panel fade-up">
      <div class="row" style="align-items:center;gap:16px;flex-wrap:nowrap"><svg class="spin" viewBox="0 0 64 64"><path d="M32 3 57 17.5v29L32 61 7 46.5v-29z" fill="#f5a524"/><path d="M32 15 46.7 23.5v17L32 49 17.3 40.5v-17z" fill="#17130f"/></svg>
      <div><h2>Planning ${esc(body.destination.split(',')[0])}</h2><p class="muted" style="margin:2px 0 0">Researching real places, drafting, and letting the Plan Doctor tear it apart. Free AI takes 1–3 minutes.</p></div></div>
      <div class="progress"><div id="bar"></div></div>
      <ul class="steps" id="steps"></ul>
    </div></section>`
  window.scrollTo(0, 0)
  let n = 0
  try {
    const done = await stream('/api/plan', body, (ev) => {
      if (ev.type !== 'step') return
      n++
      $('#bar').style.width = `${Math.min(95, ev.tool === 'enrich' ? 90 : 6 + n * 7)}%`
      const li = document.createElement('li')
      const clean = ev.tool === 'propose_plan' && /· 0 error/.test(ev.note)
      li.className = ev.tool === 'propose_plan' ? `doc ${clean ? 'clean' : ''}` : ''
      li.innerHTML = `<span class="ic">${stepIcon(ev)}</span><span>${esc(stepText(ev))}</span>`
      $('#steps').appendChild(li)
      li.scrollIntoView({ block: 'nearest' })
    })
    $('#bar').style.width = '100%'
    trip = done.trip
    tab = 'overview'
    day = null
    navigate(`/t/${trip.id}`)
    loadHealth()
  } catch (err) {
    $('#steps').insertAdjacentHTML('beforeend', `<li class="doc"><span class="ic">⚠️</span><span>${esc(err.message)} <a href="/" data-nav="/"><b>Back</b></a></span></li>`)
    loadHealth()
  }
}

// ---------- trip ----------
function renderTrip() {
  const r = trip.request
  const days = groupDays(trip.stops)
  if (!day || !days.some(([d]) => d === day)) day = days[0]?.[0] ?? r.startDate
  const openProps = trip.proposals.filter((p) => p.status === 'open').length
  document.title = `${trip.title} · Hive`
  app.innerHTML = `
  <section class="cover">${photo(trip.cover, 'sight', { credit: true })}
    <div class="top-actions"><a class="btn ghost sm" href="/" data-nav="/">← New trip</a></div>
  </section>
  <div class="card titlecard fade-up">
    <div>
      <div class="meta" style="margin:0 0 8px"><span class="tag">📍 ${esc(trip.center?.name ?? r.destination)}</span><span class="tag">🗓️ ${esc(fmtDay(r.startDate))} – ${esc(fmtDay(r.endDate))}</span><span class="tag">👥 ${r.travellers ?? 1}</span><span class="tag">${{ chill: '🐢', balanced: '⚖️', packed: '⚡' }[r.pace ?? 'balanced']} ${esc(r.pace ?? 'balanced')}</span></div>
      <h1>${esc(trip.title)}</h1>
    </div>
    <div class="actions">
      <button class="btn sm" id="recheck" title="Fetch the latest forecast and re-run every check">🌦️ Re-check</button>
      <a class="btn sm" href="/api/trips/${esc(trip.id)}/calendar.ics">📅 Calendar</a>
      <button class="btn sm" id="print">🖨️ Print</button>
      <button class="btn sm dark" id="copy">🔗 Share</button>
    </div>
  </div>
  <nav class="tabs">${[
    ['overview', 'Overview'],
    ['itinerary', 'Itinerary'],
    ['map', 'Map'],
    ['budget', 'Budget'],
    ['explore', 'Explore'],
    ['packing', 'Packing'],
  ]
    .map(([k, l]) => `<button data-tab="${k}" class="${tab === k ? 'on' : ''}">${l}</button>`)
    .join('')}</nav>
  <div id="recheck-note" class="pane" style="margin-top:12px"></div>
  <section class="pane" id="pane"></section>`
  document.body.insertAdjacentHTML('beforeend', `<button class="fab" id="fab">${HEX}<span class="lbl">Ask Hive</span>${openProps ? '<span class="badge">1 suggestion</span>' : ''}</button>`)
  $('#fab').onclick = openChat
  $('.tabs').onclick = (e) => {
    const b = e.target.closest('[data-tab]')
    if (!b) return
    tab = b.dataset.tab
    $$('.tabs button').forEach((x) => x.classList.toggle('on', x === b))
    renderPane()
    window.scrollTo({ top: $('.tabs').offsetTop - 70, behavior: 'smooth' })
  }
  $('#print').onclick = () => window.print()
  $('#copy').onclick = async () => {
    await navigator.clipboard?.writeText(location.href).catch(() => {})
    toast('Link copied. Anyone with it can view this trip.')
  }
  $('#recheck').onclick = recheck
  renderPane()
}

function renderPane() {
  const pane = $('#pane')
  const views = { overview: overviewHtml, itinerary: itineraryHtml, map: () => mapHtml(), budget: budgetHtml, explore: exploreHtml, packing: packingHtml }
  pane.innerHTML = views[tab]()
  pane.classList.remove('fade-up')
  void pane.offsetWidth
  pane.classList.add('fade-up')
  bindPane()
  if (tab === 'map') drawMap()
}

function overviewHtml() {
  const r = trip.request
  const b = trip.budget
  const days = groupDays(trip.stops)
  const errs = trip.issues.filter((i) => i.severity === 'error')
  const warns = trip.issues.filter((i) => i.severity === 'warn')
  const legMin = trip.legs.reduce((s, l) => s + l.best.minutes, 0)
  const ground = groundPerDay()
  const doctor = errs.length
    ? `<div class="notice err"><span class="ic">🩺</span><div><b>${errs.length} thing${errs.length > 1 ? 's' : ''} to fix.</b> Ask Hive to sort ${errs.length > 1 ? 'them' : 'it'} out.<ul>${errs.map((i) => `<li>${esc(i.message)}</li>`).join('')}</ul></div></div>`
    : `<div class="notice ok"><span class="ic">🩺</span><div><b>Plan Doctor: no conflicts.</b> ${warns.length ? `${warns.length} heads-up${warns.length > 1 ? 's' : ''}: ${warns.map((i) => esc(i.message)).join(' ')}` : 'Every stop fits, with time to get between them.'}</div></div>`
  return `
    <p style="font-size:17px;color:var(--ink2);max-width:860px;margin:0 0 16px">${esc(trip.summary)}</p>
    <div class="grid4">
      <div class="card stat honey"><small>All-in per person</small><b>${b ? local(b.totalUsd) : '—'}</b><span>${b && trip.money?.homeCurrency !== trip.money?.currency ? `≈ ${home(b.totalUsd)} · flights included` : 'flights included'}</span></div>
      <div class="card stat"><small>Per day on the ground</small><b>${b ? local(ground) : '—'}</b><span>${r.dailyBudget ? `${ground <= r.dailyBudget ? '✅' : '⚠️'} budget ${local(r.dailyBudget)}` : 'no budget set'}</span></div>
      <div class="card stat"><small>Places</small><b>${trip.stops.length}</b><span>${days.length} day${days.length > 1 ? 's' : ''} · ${Object.keys(trip.known ?? {}).length} researched</span></div>
      <div class="card stat"><small>Getting around</small><b>${Math.floor(legMin / 60)}h ${legMin % 60}m</b><span>${trip.legs.filter((l) => l.best.mode === 'walk').length} of ${trip.legs.length} legs on foot</span></div>
    </div>
    <div style="margin-top:14px">${doctor}</div>
    <div class="two">
      ${trip.stay ? `<div class="card staycard lift" data-open="stay">${photo(trip.stay.photo, 'hotel')}<div class="body"><small class="muted" style="font-weight:800;letter-spacing:.06em">WHERE YOU'LL STAY</small><h3 style="font-size:20px">${esc(trip.stay.name)}</h3><div class="muted" style="font-size:13px">${esc(trip.stay.area ?? '')}</div>${trip.stay.why ? `<div style="font-size:14px">${esc(trip.stay.why)}</div>` : ''}${trip.stay.nightlyUsd ? `<b>${local(trip.stay.nightlyUsd)} <span class="muted" style="font-weight:600">/ night</span></b>` : ''}</div></div>` : '<div></div>'}
      <div class="wxrow">${days.map(([d]) => { const w = trip.forecast?.[d]; return `<div class="card wx"><b>${esc(fmtDay(d, { weekday: 'short', day: 'numeric' }))}</b><div class="big">${wxIcon(w)}</div><span>${w ? `${w.min}–${w.max}°C` : 'too far out'}</span>${w?.sunset ? `<span>🌅 ${w.sunset}</span>` : ''}</div>` }).join('')}</div>
    </div>
    <div class="section-h" style="margin-top:28px"><h2>Day by day</h2><span class="muted">Tap a day to open it</span></div>
    <div class="rail">${days.map(([d, stops], i) => { const pics = stops.filter((s) => s.photo?.url); const first = [...pics, ...stops].slice(0, 3); while (first.length < 3) first.push(stops[0] ?? {}); return `<button class="card daycard lift" data-day="${d}"><div class="mosaic">${first.map((s) => photo(s.photo, s.kind ?? s.category)).join('')}</div><div class="body"><span class="tag" style="background:${DAY_COLORS[i % 5]};color:#fff;border-color:transparent">Day ${i + 1}</span><h3 style="margin-top:6px">${esc(fmtDay(d, { weekday: 'long', month: 'short', day: 'numeric' }))}</h3><div class="muted" style="font-size:13px">${stops.length} stops · ${esc(stops.filter((s) => s.category !== 'food').map((s) => s.place ?? s.title).slice(0, 2).join(', '))}</div></div></button>` }).join('')}</div>
    ${trip.tips?.length ? `<div class="section-h" style="margin-top:20px"><h2>Hive's tips</h2></div><div class="rail">${trip.tips.map((x, i) => `<div class="card tipcard"><span class="ic">${['💡', '🎟️', '🚇', '🧥', '🗣️', '💶'][i % 6]}</span><span>${esc(x)}</span></div>`).join('')}</div>` : ''}`
}

function itineraryHtml() {
  const days = groupDays(trip.stops)
  const idx = Math.max(0, days.findIndex(([d]) => d === day))
  const [d, stops] = days[idx] ?? [day, []]
  const w = trip.forecast?.[d]
  const legs = new Map(trip.legs.map((l) => [`${l.fromId}>${l.toId}`, l]))
  const flagged = new Set(trip.issues.flatMap((x) => x.stopIds ?? []))
  const cost = stops.reduce((s, x) => s + (x.costPerPerson ?? 0), 0)
  let html = ''
  stops.forEach((s, k) => {
    if (k > 0) {
      const l = legs.get(`${stops[k - 1].id}>${s.id}`)
      if (l) {
        const [ic, label, gm] = MODE[l.best.mode]
        const a = stops[k - 1]
        html += `<div class="connector"><span class="leg"><span class="m">${ic}</span><b>${label} ${l.best.minutes} min</b><span class="muted">${l.best.km} km${l.best.usd ? ` · ${local(l.best.usd)}` : ''}${l.estimated ? ' · est.' : ''}</span><a href="https://www.google.com/maps/dir/?api=1&origin=${a.lat},${a.lng}&destination=${s.lat},${s.lng}&travelmode=${gm}" target="_blank" rel="noopener">Directions ↗</a></span></div>`
      }
    }
    html += `<div class="card place lift fade-up" data-stop="${esc(s.id)}" style="animation-delay:${k * 40}ms">${photo(s.photo, s.kind ?? s.category)}
      <div class="body">
        <div class="head"><span class="tag time">${esc(s.start ?? '')}–${esc(s.end ?? '')}</span>${s.category ? `<span class="tag ${esc(s.category)}">${ICON[s.category] ?? ''} ${esc(s.category)}</span>` : ''}${s.outdoor ? '<span class="tag outdoor">outdoor</span>' : ''}${flagged.has(s.id) ? '<span class="tag flag">check</span>' : ''}<span class="cost">${s.costPerPerson ? local(s.costPerPerson) : '<span class="muted">free</span>'}</span></div>
        <h4>${esc(s.title)}</h4>
        <div class="addr">${esc(s.place ?? '')}${s.address ? ` · ${esc(s.address)}` : ''}</div>
        ${s.note ? `<p class="note">${esc(s.note)}</p>` : ''}
        ${s.tip ? `<div class="tip">💡 ${esc(s.tip)}</div>` : ''}
      </div></div>`
  })
  return `
    <div class="daypills">${days.map(([dd, st], i) => `<button class="daypill ${dd === d ? 'on' : ''}" data-day="${dd}"><span class="dot" style="background:${DAY_COLORS[i % 5]}"></span><span><b>Day ${i + 1}</b><small>${esc(fmtDay(dd))} · ${st.length} stops</small></span></button>`).join('')}</div>
    <div class="dayhead"><div><span class="muted" style="font-weight:700">Day ${idx + 1}</span><h2>${esc(fmtDay(d, { weekday: 'long', month: 'long', day: 'numeric' }))}</h2></div>
      <div class="wxl">${w ? `${wxIcon(w)} ${esc(w.desc)}, ${w.min}–${w.max}°C${w.sunset ? ` · 🌅 sunset ${w.sunset}` : ''}<br>` : ''}<b>${local(cost)}</b> planned per person</div></div>
    <div class="timeline">${html}</div>
    <div class="row" style="justify-content:space-between;margin-top:18px">${idx > 0 ? `<button class="btn" data-day="${days[idx - 1][0]}">← Day ${idx}</button>` : '<span></span>'}${idx < days.length - 1 ? `<button class="btn dark" data-day="${days[idx + 1][0]}">Day ${idx + 2} →</button>` : ''}</div>`
}

function openStop(id) {
  const s = id === 'stay' ? { ...trip.stay, title: trip.stay.name, place: trip.stay.name, kind: 'hotel', note: trip.stay.why, address: trip.stay.area } : trip.stops.find((x) => x.id === id)
  if (!s) return
  const isStay = id === 'stay'
  $('#drawer').innerHTML = `${photo(s.photo, s.kind ?? s.category, { cls: 'hero', credit: true })}<button class="btn icon close" aria-label="Close">✕</button>
    <div class="content">
      <div class="row">${isStay ? '<span class="tag">🏨 your stay</span>' : `<span class="tag time">${esc(fmtDay(s.date))} · ${esc(s.start)}–${esc(s.end)}</span>`}${s.category ? `<span class="tag ${esc(s.category)}">${esc(s.category)}</span>` : ''}</div>
      <h2>${esc(s.title)}</h2>
      <div class="muted">${esc(s.place ?? '')}${s.address ? ` · ${esc(s.address)}` : ''}</div>
      ${s.note ? `<p style="margin:0;font-size:15px">${esc(s.note)}</p>` : ''}
      ${s.tip ? `<div class="notice warn"><span class="ic">💡</span><div>${esc(s.tip)}</div></div>` : ''}
      <div class="kv"><div><small>Cost</small><b>${isStay ? (s.nightlyUsd ? `${local(s.nightlyUsd)}/nt` : '—') : s.costPerPerson ? local(s.costPerPerson) : 'Free'}</b></div><div><small>Type</small><b>${esc(s.kind ?? s.category ?? '—')}</b></div><div><small>Setting</small><b>${s.outdoor ? 'Outdoor' : 'Indoor'}</b></div></div>
      <div class="row">
        <a class="btn dark" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${s.place ?? s.title} ${s.lat},${s.lng}`)}">🧭 Open in Maps</a>
        ${isStay ? '' : `<button class="btn" data-swap="${esc(s.place ?? s.title)}">🔁 Ask Hive to swap</button>`}
        ${s.photo?.page ? `<a class="btn" target="_blank" rel="noopener" href="${esc(s.photo.page)}">📖 Read more</a>` : ''}
      </div>
    </div>`
  openSheet('drawer')
  $('#drawer .close').onclick = closeSheets
  $('#drawer [data-swap]')?.addEventListener('click', (e) => {
    openChat(`Swap ${e.target.dataset.swap} on ${fmtDay(s.date)} for something similar that fits better.`)
  })
}

// ---------- map ----------
function mapHtml() {
  const days = groupDays(trip.stops)
  return `<div class="mapbox"><div id="map"></div>
    <div class="floating"><button class="chip on" data-mday="all">All days</button>${days.map(([d], i) => `<button class="chip" data-mday="${d}"><span style="width:9px;height:9px;border-radius:50%;background:${DAY_COLORS[i % 5]};display:inline-block"></span>Day ${i + 1}</button>`).join('')}</div>
    <div class="card mapcard hidden" id="mapcard"></div></div>`
}
function drawMap() {
  if (!window.L) return
  if (map) map.remove()
  map = L.map('map', { scrollWheelZoom: false, zoomControl: false })
  L.control.zoom({ position: 'topright' }).addTo(map)
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap contributors', maxZoom: 19 }).addTo(map)
  const days = groupDays(trip.stops)
  const layers = []
  days.forEach(([date, stops], i) => {
    const color = DAY_COLORS[i % 5]
    const g = L.layerGroup()
    trip.legs.filter((l) => l.date === date).forEach((l) => {
      const a = stops.find((s) => s.id === l.fromId)
      const b = stops.find((s) => s.id === l.toId)
      const path = l.path ?? (a && b ? [[a.lat, a.lng], [b.lat, b.lng]] : null)
      if (path) L.polyline(path, { color, weight: 5, opacity: 0.85, dashArray: l.best.mode === 'walk' ? null : '6 9', lineCap: 'round' }).addTo(g)
    })
    stops.forEach((s, k) => {
      if (typeof s.lat !== 'number') return
      const face = s.photo?.url ? `<img src="${esc(s.photo.url)}" referrerpolicy="no-referrer" />` : `<div class="art ${esc(s.kind ?? s.category)}" style="font-size:18px">${ICON[s.kind ?? s.category] ?? '📍'}</div>`
      const icon = L.divIcon({ className: '', html: `<div class="pin" style="border-color:${color}"><div class="face">${face}</div><i style="background:${color}">${k + 1}</i></div>`, iconSize: [46, 46], iconAnchor: [23, 23] })
      L.marker([s.lat, s.lng], { icon }).on('click', () => showMapCard(s, color, k + 1)).addTo(g)
    })
    g.addTo(map)
    layers.push({ date, g })
  })
  if (trip.stay) L.marker([trip.stay.lat, trip.stay.lng], { icon: L.divIcon({ className: '', html: `<div class="pin stay"><div class="face">🏨</div></div>`, iconSize: [46, 46], iconAnchor: [23, 23] }) }).on('click', () => openStop('stay')).addTo(map)
  const fit = (stops) => {
    const pts = stops.filter((s) => typeof s.lat === 'number').map((s) => [s.lat, s.lng])
    if (trip.stay) pts.push([trip.stay.lat, trip.stay.lng])
    if (pts.length) map.fitBounds(pts, { padding: [60, 60] })
    else if (trip.center) map.setView([trip.center.lat, trip.center.lng], 13)
  }
  fit(trip.stops)
  $('.mapbox .floating').onclick = (e) => {
    const d = e.target.closest('[data-mday]')?.dataset.mday
    if (!d) return
    $$('.mapbox .floating .chip').forEach((c) => c.classList.toggle('on', c.dataset.mday === d))
    layers.forEach((l) => (d === 'all' || l.date === d ? l.g.addTo(map) : map.removeLayer(l.g)))
    fit(d === 'all' ? trip.stops : trip.stops.filter((s) => s.date === d))
    $('#mapcard').classList.add('hidden')
  }
}
function showMapCard(s, color, n) {
  const c = $('#mapcard')
  c.innerHTML = `${photo(s.photo, s.kind ?? s.category)}<div class="body"><span class="tag" style="background:${color};color:#fff;border-color:transparent;justify-self:start">${esc(fmtDay(s.date))} · #${n} · ${esc(s.start)}</span><b style="font-size:16px">${esc(s.title)}</b><span class="muted" style="font-size:12.5px">${esc(s.place ?? '')}</span><div class="row" style="margin-top:4px"><button class="btn sm dark" data-stop="${esc(s.id)}">Details</button><a class="btn sm" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}">Directions</a></div></div>`
  c.classList.remove('hidden')
  c.classList.remove('fade-up')
  void c.offsetWidth
  c.classList.add('fade-up')
}

// ---------- budget ----------
function groundPerDay() {
  const b = trip.budget
  if (!b) return 0
  const travel = b.lines.find((l) => l.category === 'travel')?.usd ?? 0
  return Math.round((b.totalUsd - travel * 1.1) / daysBetween(trip.request.startDate, trip.request.endDate))
}
function budgetHtml() {
  const b = trip.budget
  if (!b) return '<div class="card pad muted">No cost estimate yet.</div>'
  const tr = trip.request.travellers ?? 1
  let acc = 0
  const stops = b.lines.filter((l) => l.usd > 0).map((l) => { const from = (acc / b.totalUsd) * 360; acc += l.usd; return `${COST[l.category]?.[2] ?? '#ccc'} ${from}deg ${(acc / b.totalUsd) * 360}deg` }).join(', ')
  const ground = groundPerDay()
  return `<div class="budget">
    <div class="card pad">
      <small class="muted" style="font-weight:800;letter-spacing:.06em">ALL-IN, PER PERSON</small>
      <div class="bigmoney">${local(b.totalUsd)}</div>
      ${trip.money?.homeCurrency !== trip.money?.currency ? `<div class="muted">≈ ${home(b.totalUsd)} ${esc(trip.money.homeCurrency)}</div>` : ''}
      <div class="donutrow" style="margin-top:18px"><div class="donut" style="background:conic-gradient(${stops})"><div><span><b>${local(ground)}</b>per day<br>on the ground</span></div></div>
        <div style="flex:1;min-width:180px;display:grid;gap:8px">
          ${trip.request.dailyBudget ? `<div class="notice ${ground <= trip.request.dailyBudget ? 'ok' : 'warn'}"><span class="ic">${ground <= trip.request.dailyBudget ? '✅' : '⚠️'}</span><div>${ground <= trip.request.dailyBudget ? 'Under' : 'Over'} your ${local(trip.request.dailyBudget)} daily budget.</div></div>` : ''}
          <div class="notice warn"><span class="ic">👥</span><div>For ${tr} traveller${tr > 1 ? 's' : ''}: <b>${local(b.totalUsd * tr)}</b> all in.</div></div>
          ${b.cashUsd ? `<div class="notice warn"><span class="ic">💵</span><div>Carry about <b>${local(b.cashUsd)}</b> cash each${trip.money?.country ? ` (${esc(trip.money.country)} is ${Math.round((trip.money.cashShare ?? 0) * 100)}% cash)` : ''}.</div></div>` : ''}
        </div></div>
      <p class="muted" style="font-size:12.5px;margin:14px 0 0">Prices in ${esc(trip.money?.currency ?? 'USD')}${trip.money?.live ? ' at today’s rates (Frankfurter)' : ' at offline rates'}. Planned prices first, then local price levels.</p>
    </div>
    <div class="card pad">${b.lines.map((l) => { const [ic, label, color] = COST[l.category] ?? ['•', l.category, '#ccc']; return `<div class="costrow"><span class="ic" style="background:${color}22">${ic}</span><span><b style="font-size:15px">${label}</b><small>${esc(l.basis)}</small></span><b>${local(l.usd)}</b></div>` }).join('')}</div>
  </div>`
}

// ---------- explore ----------
function exploreHtml() {
  const card = (p) => `<div class="card ideacard lift">${photo(p.photo, p.kind)}<div class="body"><span class="tag">${ICON[p.kind] ?? '📍'} ${esc(p.kind)}</span><h4>${esc(p.name)}</h4><span class="muted" style="font-size:12.5px">${esc(p.address ?? '')}</span><button class="btn sm" data-add="${esc(p.name)}">✦ Fit it in</button></div></div>`
  const groups = Object.entries(trip.ideas ?? {}).filter(([, l]) => l.length)
  return `${trip.rainyBackups?.length ? `<div class="section-h"><h2>☔ Rainy-day backups</h2><span class="muted">Indoor places nearby</span></div><div class="rail">${trip.rainyBackups.map(card).join('')}</div>` : ''}
    ${groups.map(([k, l]) => `<div class="section-h" style="margin-top:18px"><h2>${ICON[k] ?? ''} ${KIND_LABEL[k] ?? esc(k)}</h2><span class="muted">Found while researching</span></div><div class="rail">${l.map(card).join('')}</div>`).join('')}
    ${!groups.length && !trip.rainyBackups?.length ? '<div class="card pad muted">Every place Hive found is already in your plan.</div>' : ''}`
}

// ---------- packing ----------
function packingHtml() {
  const items = trip.packing ?? []
  const done = items.filter((x) => x.done).length
  const pct = items.length ? Math.round((done / items.length) * 100) : 0
  const groups = {}
  for (const it of items) (groups[it.group] ??= []).push(it)
  return `<div class="packing">
    <div class="card pad" style="text-align:center"><div class="ring" id="ring" style="background:conic-gradient(var(--ok) ${pct * 3.6}deg, var(--line) 0)"><div>${pct}%</div></div><b>${done} of ${items.length} packed</b><p class="muted" style="font-size:13px">Built from your forecast, plan and destination. Ticks are saved with the trip.</p></div>
    <div class="packgroups">${Object.entries(groups).map(([g, list]) => `<div class="card pad"><h3 style="font-size:16px;margin-bottom:6px">${esc(g)}</h3>${list.map((it) => `<div class="packitem ${it.done ? 'done' : ''}" data-pack="${esc(it.id)}"><span class="box">✓</span><div><span>${esc(it.label)}</span>${it.why ? `<small>${esc(it.why)}</small>` : ''}</div></div>`).join('')}</div>`).join('')}</div>
  </div>`
}

function bindPane() {
  const pane = $('#pane')
  pane.onclick = async (e) => {
    const t = e.target
    const dayBtn = t.closest('[data-day]')
    if (dayBtn) {
      day = dayBtn.dataset.day
      if (tab !== 'itinerary') {
        tab = 'itinerary'
        $$('.tabs button').forEach((x) => x.classList.toggle('on', x.dataset.tab === 'itinerary'))
      }
      renderPane()
      window.scrollTo({ top: $('.tabs').offsetTop - 70, behavior: 'smooth' })
      return
    }
    if (t.closest('a')) return
    const open = t.closest('[data-stop], [data-open]')
    if (open) return openStop(open.dataset.stop ?? open.dataset.open)
    const add = t.closest('[data-add]')
    if (add) return openChat(`Can you fit ${add.dataset.add} into the plan? Swap out whatever fits least.`)
    const pack = t.closest('[data-pack]')
    if (pack) {
      pack.classList.toggle('done')
      const r = await api(`/api/trips/${trip.id}/packing`, { method: 'POST', body: JSON.stringify({ id: pack.dataset.pack }) }).catch(() => null)
      if (r) {
        trip.packing = r.packing
        const done = r.packing.filter((x) => x.done).length
        const pct = Math.round((done / r.packing.length) * 100)
        $('#ring').style.background = `conic-gradient(var(--ok) ${pct * 3.6}deg, var(--line) 0)`
        $('#ring div').textContent = `${pct}%`
        $('#ring').nextElementSibling.textContent = `${done} of ${r.packing.length} packed`
        if (pct === 100) toast('All packed. Bon voyage! ✈️')
      }
    }
  }
}

async function recheck() {
  const btn = $('#recheck')
  btn.disabled = true
  btn.textContent = '🌦️ Checking…'
  try {
    const { trip: t, newIssues } = await api(`/api/trips/${trip.id}/recheck`, { method: 'POST' })
    trip = t
    renderTrip()
    $('#recheck-note').innerHTML = newIssues.length
      ? `<div class="notice warn fade-up"><span class="ic">🌦️</span><div><b>The forecast changed things.</b><ul>${newIssues.map((i) => `<li>${esc(i.message)}</li>`).join('')}</ul>Ask Hive to adjust the plan.</div></div>`
      : `<div class="notice ok fade-up"><span class="ic">🌦️</span><div>Latest forecast checked. Nothing new to worry about.</div></div>`
  } catch (err) {
    btn.disabled = false
    btn.textContent = '🌦️ Re-check'
    toast(err.message)
  }
}

// ---------- chat ----------
const QUICK = ['Make day 2 cheaper', 'Rainy-day version of day 1', 'Add a local market', 'Start later each morning', 'What should I book ahead?']
function openChat(prefill) {
  const props = new Map(trip.proposals.map((p) => [p.id, p]))
  $('#chat').innerHTML = `<div class="chathead">${HEX}<div><b>Ask Hive</b><div class="muted" style="font-size:12.5px">Changes come back as suggestions you approve</div></div><button class="btn icon close" style="margin-left:auto" aria-label="Close">✕</button></div>
    <div class="thread" id="thread"><div class="msg hive">Hi! I planned ${esc(trip.title)}. Ask me to change anything (swap a dinner, make a day cheaper, plan around rain) or ask a question. Tell me about yourself and I'll remember it.</div>
    ${trip.chat.map((m) => `<div class="msg ${m.role}">${esc(m.text)}</div>${m.proposalId && props.get(m.proposalId) ? proposalHtml(props.get(m.proposalId)) : ''}`).join('')}</div>
    <div class="quick">${QUICK.map((q) => `<button class="chip" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>
    <form class="composer" id="composer"><input id="chat-input" maxlength="600" placeholder="Ask Hive anything about this trip…" autocomplete="off" /><button class="btn dark" type="submit">Send</button></form>
    <div class="limits">${health ? `Free tier: ${health.chatsLeft} message${health.chatsLeft === 1 ? '' : 's'} left for you today.` : ''}</div>`
  openSheet('chat')
  const thread = $('#thread')
  thread.scrollTop = 1e9
  $('#chat .close').onclick = closeSheets
  $('.quick').onclick = (e) => {
    const q = e.target.closest('[data-q]')?.dataset.q
    if (!q) return
    $('#chat-input').value = q
    $('#composer').requestSubmit()
  }
  thread.onclick = async (e) => {
    const btn = e.target.closest('[data-v]')
    if (!btn) return
    const pid = btn.closest('[data-pid]').dataset.pid
    $$('[data-v]', btn.closest('.proposal')).forEach((b) => (b.disabled = true))
    try {
      trip = await api(`/api/trips/${trip.id}/proposals/${pid}/${btn.dataset.v}`, { method: 'POST' })
    } catch (err) {
      return toast(err.message)
    }
    if (btn.dataset.v === 'accept') {
      closeSheets()
      tab = 'itinerary'
      renderTrip()
      toast('Change applied ✓ Routes, costs and packing updated.')
    } else openChat()
  }
  $('#composer').onsubmit = async (e) => {
    e.preventDefault()
    const input = $('#chat-input')
    const text = input.value.trim()
    if (!text) return
    input.value = ''
    input.disabled = true
    thread.insertAdjacentHTML('beforeend', `<div class="msg user">${esc(text)}</div><div class="msg hive work" id="work">🐝 thinking…</div>`)
    thread.scrollTop = 1e9
    try {
      const done = await stream(`/api/trips/${trip.id}/chat`, { message: text }, (ev) => {
        if (ev.type === 'step') {
          $('#work').textContent = `${stepIcon(ev)} ${stepText(ev)}`
          thread.scrollTop = 1e9
        }
      })
      trip = done.trip
      await loadHealth()
      $('.fab .badge')?.remove()
      if (trip.proposals.some((p) => p.status === 'open')) $('#fab').insertAdjacentHTML('beforeend', '<span class="badge">1 suggestion</span>')
      openChat()
    } catch (err) {
      $('#work')?.remove()
      thread.insertAdjacentHTML('beforeend', `<div class="msg hive">⚠️ ${esc(err.message)}</div>`)
      thread.scrollTop = 1e9
      input.disabled = false
    }
  }
  if (prefill) $('#chat-input').value = prefill
  setTimeout(() => $('#chat-input')?.focus(), 300)
}
function proposalHtml(p) {
  const d = p.diff
  const status = { open: '', accepted: '✅ Applied', rejected: 'Kept your plan', stale: 'Replaced by a newer suggestion' }[p.status]
  return `<div class="proposal ${p.status}" data-pid="${esc(p.id)}"><h4>✦ ${esc(p.summary)}</h4>
    <div class="diff">${d.added.map((x) => `<span class="add">＋ ${esc(x)}</span>`).join('')}${d.removed.map((x) => `<span class="rem">－ ${esc(x)}</span>`).join('')}${d.moved.map((x) => `<span class="mov">↻ ${esc(x)}</span>`).join('')}${!d.added.length && !d.removed.length && !d.moved.length ? '<span class="muted">Small edits to notes, prices or the stay.</span>' : ''}</div>
    ${p.status === 'open' ? `<div class="row"><button class="btn sm dark" data-v="accept">Apply change</button><button class="btn sm" data-v="reject">Keep my plan</button></div>` : `<b class="muted" style="font-size:13px">${status}</b>`}</div>`
}

// ---------- profile ----------
async function renderProfile() {
  document.title = 'Profile · Hive'
  profile = await api('/api/profile').catch(() => ({}))
  app.innerHTML = `<section class="profile fade-up">
    <div class="row" style="align-items:center;gap:14px;margin-bottom:8px"><div style="width:64px;height:64px">${HEX}</div><div><h1 style="font-size:32px">Your traveller profile</h1><p class="muted" style="margin:2px 0 0">Saved on this Sprite's disk. Hive reads it before every trip.</p></div></div>
    <form class="card pad" id="profile-form" style="margin-top:14px">
      <div class="row"><label>Home city<input name="homeCity" value="${esc(profile.homeCity ?? '')}" placeholder="Los Angeles, USA" /></label><label>Diet<input name="diet" value="${esc(profile.diet ?? '')}" placeholder="vegetarian, halal…" /></label></div>
      <div class="row"><label>Usual pace<select name="pace">${['', 'chill', 'balanced', 'packed'].map((p) => `<option value="${p}" ${profile.pace === p ? 'selected' : ''}>${p || '—'}</option>`).join('')}</select></label><label>Usual budget / day (USD)<input type="number" name="dailyBudget" value="${esc(profile.dailyBudget ?? '')}" /></label></div>
      <label>Loves<div class="chips" id="p-interests">${INTERESTS.map(([x, ic]) => `<button type="button" class="chip ${(profile.interests ?? []).includes(x) ? 'on' : ''}" data-i="${x}">${ic} ${x}</button>`).join('')}</div></label>
      ${profile.notes?.length ? `<label>Things Hive picked up in chat<ul class="remembered">${profile.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></label>` : ''}
      <button class="btn dark" type="submit">Save profile</button>
    </form></section>`
  $('#p-interests').onclick = (e) => e.target.closest('.chip')?.classList.toggle('on')
  $('#profile-form').onsubmit = async (e) => {
    e.preventDefault()
    const body = Object.fromEntries(new FormData(e.target))
    body.interests = $$('#p-interests .on').map((c) => c.dataset.i)
    profile = await api('/api/profile', { method: 'PUT', body: JSON.stringify(body) })
    toast('Saved to the Sprite ✓')
  }
}

loadHealth().then(route)
