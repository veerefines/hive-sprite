/* Hive client: plain JS, no build step. */
const $ = (s, el = document) => el.querySelector(s)
const $$ = (s, el = document) => [...el.querySelectorAll(s)]
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const app = $('#app')

const INTERESTS = ['food', 'culture', 'history', 'art', 'nature', 'nightlife', 'shopping', 'architecture', 'coffee', 'markets', 'views', 'music']
const DAY_COLORS = ['#f5a524', '#2f6fb0', '#c2531f', '#2e7d32', '#7b4bb8']
const KIND_LABEL = { restaurant: '🍽️ Restaurants', cafe: '☕ Cafés', bakery: '🥐 Bakeries', museum: '🏛️ Museums', gallery: '🖼️ Galleries', attraction: '📍 Sights', viewpoint: '🌅 Viewpoints', park: '🌳 Parks', bar: '🍷 Bars', market: '🧺 Markets', hotel: '🏨 Hotels', hostel: '🛏️ Hostels' }
const CAT_ICON = { food: '🍽️', sight: '📍', activity: '🎟️', nightlife: '🍷', shopping: '🛍️' }
const MODE = { walk: ['🚶', 'Walk', 'walking'], transit: ['🚇', 'Transit', 'transit'], taxi: ['🚕', 'Taxi', 'driving'] }
const COST_LABEL = { travel: '✈️ Getting there', stay: '🏨 Stay', food: '🍽️ Food', local: '🚇 Getting around', activities: '🎟️ Things to do', shopping: '🛍️ Shopping', buffer: '🧯 Buffer' }
const EXAMPLES = [
  { destination: 'Lisbon, Portugal', prompt: 'Seafood, pastel de nata, one viewpoint at sunset, keep it walkable', interests: ['food', 'history', 'views'] },
  { destination: 'Kyoto, Japan', prompt: 'Temples early before crowds, a tea house, one great ramen dinner', interests: ['culture', 'food', 'nature'] },
  { destination: 'Mexico City, Mexico', prompt: 'Street tacos, Frida Kahlo museum, mezcal bar on the last night', interests: ['food', 'art', 'nightlife'] },
  { destination: 'Rome, Italy', prompt: 'Ancient sites in the morning, long lunches, gelato every day', interests: ['history', 'food', 'architecture'] },
]

let profile = {}
let currentTrip = null
let currentTab = 'plan'
let map = null

// ---------- utils ----------
const iso = (d) => d.toISOString().slice(0, 10)
const addDays = (s, n) => iso(new Date(Date.parse(s) + n * 864e5))
const fmtDay = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' })
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5) + 1
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
const local = (t, usd) => money(usd, t.money?.currency ?? 'USD', t.money?.rates)
const home = (t, usd) => money(usd, t.money?.homeCurrency ?? 'USD', t.money?.rates)
const toMin = (hhmm) => (hhmm ? Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)) : 9999)
const byStart = (a, b) => toMin(a.start) - toMin(b.start)
function groupDays(stops) {
  const m = new Map()
  for (const s of stops) (m.get(s.date) ?? m.set(s.date, []).get(s.date)).push(s)
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([d, list]) => [d, list.sort(byStart)])
}
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}
async function stream(path, body, onEvent) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`)
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
function stepIcon(e) {
  return { setup: '📍', geocode: '📍', find_places: '🔎', propose_plan: '🩺', enrich: '🧭', remember: '🧠', slack: '💬' }[e.tool] ?? '•'
}
function stepText(e) {
  if (e.tool === 'find_places') return `Searching ${e.note}`
  if (e.tool === 'propose_plan') return `Plan Doctor checked a draft: ${e.note}`
  if (e.tool === 'remember') return `Remembered: ${e.note}`
  return e.note
}

// ---------- routing ----------
function navigate(path, push = true) {
  if (push) history.pushState({}, '', path)
  route()
}
window.addEventListener('popstate', () => route())
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-nav], a[data-trip]')
  if (!a || e.metaKey || e.ctrlKey) return
  e.preventDefault()
  navigate(a.dataset.trip ? `/t/${a.dataset.trip}` : a.getAttribute('href'))
})
function setNav() {
  const here = location.pathname + location.hash
  $$('.top nav a').forEach((a) => a.classList.toggle('on', a.dataset.nav === here || (here === '/' && a.dataset.nav === '/')))
}
async function route() {
  setNav()
  const m = /^\/t\/([\w-]+)/.exec(location.pathname)
  if (m) {
    if (currentTrip?.id !== m[1]) {
      app.innerHTML = '<p class="muted">Loading trip…</p>'
      try {
        currentTrip = await api(`/api/trips/${m[1]}`)
      } catch (err) {
        app.innerHTML = `<div class="notice err">${esc(err.message)}</div>`
        return
      }
    }
    return renderTrip()
  }
  if (location.hash === '#profile') return renderProfile()
  renderHome()
}

// ---------- health ----------
async function health() {
  const h = await api('/api/health').catch(() => null)
  if (!h) return
  $('#health').innerHTML = [
    `<span class="pill on" title="Hive runs as a service on this Fly.io Sprite"><i></i>Sprite · ${esc(h.host)}</span>`,
    `<span class="pill ${h.llmConnector ? 'on' : ''}" title="${esc(h.model)} via the Sprites OpenRouter connector"><i></i>OpenRouter connector</span>`,
    `<span class="pill" title="Daily public quota">${h.plansLeftToday} plans left today</span>`,
  ].join('')
}

// ---------- home ----------
async function renderHome() {
  profile = await api('/api/profile').catch(() => ({}))
  const start = addDays(iso(new Date()), 4)
  app.innerHTML = `
  <section class="hero">
    <div>
      <h1>Your personal trip agent, <em>living on a Sprite</em>.</h1>
      <p class="lede">Tell Hive where you're going. It finds real places, plans every meal, sight and the stay, checks the plan against the forecast and fixes it, works out how to get between stops and what it'll cost, then lets you refine it by chat.</p>
      <div class="how">
        <div><span class="n">1</span><b>Researches real places</b><span>Restaurants, cafés, sights, viewpoints and hotels from OpenStreetMap. Nothing invented.</span></div>
        <div><span class="n">2</span><b>Plan Doctor, on repeat</b><span>Overlaps, tight travel, missing meals, rain on outdoor stops, your sunset request. Hive fixes each one.</span></div>
        <div><span class="n">3</span><b>The whole trip</b><span>Stay, best route between stops, costs in local and home currency, rainy-day backups, tips.</span></div>
        <div><span class="n">4</span><b>Remembers you</b><span>Your diet, home city and tastes live on this Sprite's disk and shape every next trip.</span></div>
      </div>
    </div>
    <form class="plan card" id="plan-form" autocomplete="off">
      <h2>Plan a trip</h2>
      <div class="examples"><span class="muted">Try:</span>${EXAMPLES.map((x, i) => `<button type="button" data-ex="${i}">${esc(x.destination.split(',')[0])}</button>`).join('')}</div>
      <label>Where to?<input name="destination" required placeholder="Lisbon, Portugal" maxlength="120" /></label>
      <div class="row">
        <label>From<input type="date" name="startDate" required value="${start}" /></label>
        <label>To<input type="date" name="endDate" required value="${addDays(start, 1)}" /></label>
        <label style="max-width:110px">Travellers<input type="number" name="travellers" min="1" max="12" value="2" /></label>
      </div>
      <div class="row">
        <label>Coming from<input name="origin" placeholder="Los Angeles, USA" value="${esc(profile.homeCity ?? '')}" maxlength="120" /></label>
        <label style="max-width:170px">Budget / person / day<input type="number" name="dailyBudget" min="0" placeholder="$150" value="${esc(profile.dailyBudget ?? '')}" /></label>
      </div>
      <label>Pace<div class="seg" id="pace">${['chill', 'balanced', 'packed'].map((p) => `<button type="button" data-pace="${p}" class="${(profile.pace ?? 'balanced') === p ? 'on' : ''}">${p[0].toUpperCase() + p.slice(1)}</button>`).join('')}</div></label>
      <label>Into<div class="chips" id="interests">${INTERESTS.map((x) => `<button type="button" class="chip ${(profile.interests ?? []).includes(x) ? 'on' : ''}" data-i="${x}">${x}</button>`).join('')}</div></label>
      <div class="row">
        <label>Diet<input name="diet" placeholder="vegetarian, halal, no shellfish…" value="${esc(profile.diet ?? '')}" maxlength="80" /></label>
        <label style="max-width:130px">Wake up<input type="time" name="wakeTime" value="08:00" /></label>
      </div>
      <label>Anything else?<textarea name="prompt" rows="2" maxlength="1000" placeholder="One viewpoint at sunset, a cooking class, no museums on day 1…"></textarea></label>
      <button class="btn primary submit" type="submit">Plan my trip with Hive</button>
      <div class="err" id="plan-err"></div>
    </form>
  </section>
  <div class="section-h" id="trips"><h2>Trips on this Sprite</h2><span class="muted">Saved to the Sprite's disk</span></div>
  <div class="trips" id="trip-list"><p class="muted">Loading…</p></div>`

  const form = $('#plan-form')
  $('#pace').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pace]')
    if (!b) return
    $$('#pace button').forEach((x) => x.classList.toggle('on', x === b))
  })
  $('#interests').addEventListener('click', (e) => e.target.closest('.chip')?.classList.toggle('on'))
  $('.examples').addEventListener('click', (e) => {
    const ex = EXAMPLES[e.target.dataset.ex]
    if (!ex) return
    form.destination.value = ex.destination
    form.prompt.value = ex.prompt
    $$('#interests .chip').forEach((c) => c.classList.toggle('on', ex.interests.includes(c.dataset.i)))
  })
  form.startDate.addEventListener('change', () => {
    if (form.endDate.value < form.startDate.value) form.endDate.value = addDays(form.startDate.value, 1)
  })
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const body = Object.fromEntries(new FormData(form))
    body.pace = $('#pace .on')?.dataset.pace ?? 'balanced'
    body.interests = $$('#interests .on').map((c) => c.dataset.i)
    if (daysBetween(body.startDate, body.endDate) > 5) return ($('#plan-err').textContent = 'Hive plans up to 5 days at a time.')
    planTrip(body)
  })
  if (location.hash === '#trips') $('#trips').scrollIntoView()
  loadTripList()
}

async function loadTripList() {
  const list = await api('/api/trips').catch(() => [])
  $('#trip-list').innerHTML = list.length
    ? list
        .map(
          (t) => `<a class="card tripcard" href="/t/${esc(t.id)}" data-trip="${esc(t.id)}">
        <span class="tag">${esc(fmtDay(t.startDate))} → ${esc(fmtDay(t.endDate))}</span>
        <h3>${esc(t.title)}</h3>
        <div class="meta">${esc(t.destination)} · ${t.stops} stops${t.totalUsd ? ` · ~$${t.totalUsd.toLocaleString()} pp` : ''}</div></a>`,
        )
        .join('')
    : '<p class="muted">No trips yet. Plan one above.</p>'
}

async function planTrip(body) {
  app.innerHTML = `<section class="working">
    <div class="row" style="align-items:center;gap:16px"><svg class="spin" viewBox="0 0 64 64"><path d="M32 3 57 17.5v29L32 61 7 46.5v-29z" fill="#f5a524"/><path d="M32 15 46.7 23.5v17L32 49 17.3 40.5v-17z" fill="#1f1a17"/></svg>
    <div><h2>Hive is planning ${esc(body.destination)}</h2><p class="muted" style="margin:0">Researching real places, drafting, and letting the Plan Doctor tear it apart. This takes about a minute.</p></div></div>
    <ul class="steps" id="steps"></ul></section>`
  window.scrollTo(0, 0)
  try {
    const done = await stream('/api/plan', body, (ev) => {
      if (ev.type !== 'step') return
      const li = document.createElement('li')
      const clean = ev.tool === 'propose_plan' && /· 0 error/.test(ev.note)
      li.className = ev.tool === 'propose_plan' ? `doc ${clean ? 'clean' : ''}` : ''
      li.innerHTML = `<span class="ic">${stepIcon(ev)}</span><span>${esc(stepText(ev))}</span>`
      $('#steps').appendChild(li)
      li.scrollIntoView({ block: 'nearest' })
    })
    currentTrip = done.trip
    currentTab = 'plan'
    navigate(`/t/${done.trip.id}`)
    health()
  } catch (err) {
    $('#steps').insertAdjacentHTML('beforeend', `<li class="doc"><span class="ic">⚠️</span><span>${esc(err.message)} <a href="/" data-nav="/">Back</a></span></li>`)
  }
}

// ---------- trip ----------
function renderTrip() {
  const t = currentTrip
  const r = t.request
  const days = groupDays(t.stops)
  const errs = t.issues.filter((i) => i.severity === 'error')
  const warns = t.issues.filter((i) => i.severity === 'warn')
  const openProps = t.proposals.filter((p) => p.status === 'open').length
  const b = t.budget
  const legMin = t.legs.reduce((s, l) => s + l.best.minutes, 0)
  document.title = `${t.title} · Hive`
  app.innerHTML = `
  <div class="trip-head">
    <div>
      <span class="tag">${esc(fmtDay(r.startDate))} → ${esc(fmtDay(r.endDate))} · ${r.travellers ?? 1} traveller${(r.travellers ?? 1) > 1 ? 's' : ''} · ${esc(r.pace ?? 'balanced')}</span>
      <h1 style="margin-top:8px">${esc(t.title)}</h1>
      <div class="sub">${esc(t.center?.address ?? r.destination)}</div>
    </div>
    <div class="actions">
      <button class="btn" id="recheck" title="Fetch the latest forecast and re-run every check">🌦️ Re-check forecast</button>
      <a class="btn" href="/api/trips/${esc(t.id)}/calendar.ics">📅 Add to calendar</a>
      <button class="btn" id="print">🖨️ Print</button>
      <button class="btn honey" id="copy">🔗 Copy link</button>
    </div>
  </div>
  <p class="summary">${esc(t.summary)}</p>
  <div id="recheck-note"></div>
  <div class="stats">
    <div class="stat"><small>Per person</small><b>${b ? local(t, b.totalUsd) : '—'}</b><span>${b && t.money?.homeCurrency !== t.money?.currency ? `≈ ${home(t, b.totalUsd)}` : 'all-in estimate'}</span></div>
    <div class="stat"><small>Per day</small><b>${b ? local(t, b.perDayUsd) : '—'}</b><span>${r.dailyBudget ? `budget $${r.dailyBudget}` : 'no budget set'}</span></div>
    <div class="stat"><small>Stops</small><b>${t.stops.length}</b><span>${days.length} day${days.length > 1 ? 's' : ''} · ${Object.keys(t.known ?? {}).length} places researched</span></div>
    <div class="stat"><small>Getting around</small><b>${Math.round(legMin / 60)}h ${legMin % 60}m</b><span>${t.legs.filter((l) => l.best.mode === 'walk').length} of ${t.legs.length} legs on foot</span></div>
  </div>
  <div class="tabs" role="tablist">
    ${[
      ['plan', '🗓️ Itinerary'],
      ['map', '🗺️ Map'],
      ['costs', '💸 Costs'],
      ['ideas', '💡 Ideas'],
      ['chat', `🐝 Ask Hive${openProps ? '<span class="badge">1</span>' : ''}`],
    ]
      .map(([k, l]) => `<button data-tab="${k}" class="${currentTab === k ? 'on' : ''}">${l}</button>`)
      .join('')}
  </div>
  <section id="tab-plan" class="${currentTab === 'plan' ? '' : 'hidden'}">
    ${errs.length ? `<div class="notice err"><span>⚠️</span><div><b>${errs.length} thing${errs.length > 1 ? 's' : ''} still need fixing.</b> Ask Hive to sort ${errs.length > 1 ? 'them' : 'it'} out.<ul>${errs.map((i) => `<li>${esc(i.message)}</li>`).join('')}</ul></div></div>` : `<div class="notice ok"><span>✅</span><div><b>Plan Doctor: no conflicts.</b> ${warns.length ? `${warns.length} heads-up${warns.length > 1 ? 's' : ''}:<ul>${warns.map((i) => `<li>${esc(i.message)}</li>`).join('')}</ul>` : 'Every stop fits, with time to get between them.'}</div></div>`}
    <div class="wx-strip">${days.map(([d]) => { const w = t.forecast?.[d]; return `<div class="wx"><b>${esc(fmtDay(d))}</b>${w ? `${w.rain ? '🌧️' : /cloud|overcast|fog/.test(w.desc) ? '⛅' : '☀️'} ${esc(w.desc)} · ${w.min}–${w.max}°C${w.sunset ? ` · 🌅 ${w.sunset}` : ''}` : 'Forecast not out yet'}</div>` }).join('')}</div>
    ${t.stay ? `<div class="card stay"><span class="ic">🏨</span><div><small class="muted">WHERE YOU'LL STAY</small><h3>${esc(t.stay.name)}</h3><div class="muted" style="font-size:13px">${esc(t.stay.area ?? '')}${t.stay.nightlyUsd ? ` · about ${local(t, t.stay.nightlyUsd)} / night` : ''}</div>${t.stay.why ? `<div style="margin-top:4px">${esc(t.stay.why)}</div>` : ''}</div></div>` : ''}
    <div class="days">${days.map(([d, stops], i) => dayCard(t, d, stops, i)).join('')}</div>
    ${t.tips?.length ? `<div class="card" style="margin-top:18px"><h3>Hive's tips</h3><ul class="tips">${t.tips.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
  </section>
  <section id="tab-map" class="${currentTab === 'map' ? '' : 'hidden'}"><div class="mapwrap"><div id="map"></div><div class="legend" id="legend"></div></div></section>
  <section id="tab-costs" class="${currentTab === 'costs' ? '' : 'hidden'}">${costsHtml(t)}</section>
  <section id="tab-ideas" class="${currentTab === 'ideas' ? '' : 'hidden'}">${ideasHtml(t)}</section>
  <section id="tab-chat" class="${currentTab === 'chat' ? '' : 'hidden'}">${chatHtml(t)}</section>`

  $('.tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]')
    if (!btn) return
    currentTab = btn.dataset.tab
    $$('.tabs button').forEach((x) => x.classList.toggle('on', x === btn))
    $$('main > section[id^="tab-"]').forEach((s) => s.classList.toggle('hidden', s.id !== `tab-${currentTab}`))
    if (currentTab === 'map') drawMap()
    if (currentTab === 'chat') $('#thread').scrollTop = 1e9
  })
  $('#print').onclick = () => window.print()
  $('#copy').onclick = async () => {
    await navigator.clipboard?.writeText(location.href).catch(() => {})
    $('#copy').textContent = '✓ Link copied'
  }
  $('#recheck').onclick = recheck
  bindIdeas()
  bindChat()
  if (currentTab === 'map') drawMap()
  if (currentTab === 'chat') $('#thread').scrollTop = 1e9
}

function dayCard(t, date, stops, i) {
  const w = t.forecast?.[date]
  const legs = new Map(t.legs.map((l) => [`${l.fromId}>${l.toId}`, l]))
  const flagged = new Set(t.issues.flatMap((x) => x.stopIds ?? []))
  const dayCost = stops.reduce((s, x) => s + (x.costPerPerson ?? 0), 0)
  let html = ''
  stops.forEach((s, k) => {
    if (k > 0) {
      const l = legs.get(`${stops[k - 1].id}>${s.id}`)
      if (l) html += legHtml(t, l, stops[k - 1], s)
    }
    html += `<div class="stop">
      <time>${esc(s.start ?? '')}<br>${esc(s.end ?? '')}</time>
      <div>
        <h4>${CAT_ICON[s.category] ?? '📍'} ${esc(s.title)}</h4>
        <div class="where">${esc(s.place ?? '')}${s.address ? ` · ${esc(s.address)}` : ''}</div>
        ${s.note ? `<p class="note">${esc(s.note)}</p>` : ''}
        ${s.tip ? `<div class="tip">💡 ${esc(s.tip)}</div>` : ''}
        <div class="tags">${s.category ? `<span class="tag ${esc(s.category)}">${esc(s.category)}</span>` : ''}${s.outdoor ? '<span class="tag outdoor">outdoor</span>' : ''}${flagged.has(s.id) ? '<span class="tag flag">check</span>' : ''}</div>
      </div>
      <div class="cost">${s.costPerPerson ? local(t, s.costPerPerson) : '<span class="muted">free</span>'}</div>
    </div>`
  })
  return `<div class="card day">
    <div class="day-h"><span class="dot" style="background:${DAY_COLORS[i % 5]}"></span><h3>Day ${i + 1} · ${esc(fmtDay(date))}</h3>
      <div class="wxl">${w ? `${w.rain ? '🌧️' : '☀️'} ${esc(w.desc)}, ${w.min}–${w.max}°C${w.sunset ? ` · sunset ${w.sunset}` : ''}<br>` : ''}<b>${local(t, dayCost)}</b> <span class="muted">planned per person</span></div></div>
    <div class="timeline">${html}</div></div>`
}

function legHtml(t, l, a, b) {
  const [ic, label, gm] = MODE[l.best.mode]
  const dir = `https://www.google.com/maps/dir/?api=1&origin=${a.lat},${a.lng}&destination=${b.lat},${b.lng}&travelmode=${gm}`
  const alts = l.options.filter((o) => o.mode !== l.best.mode)
  return `<div class="leg">${ic} <b>${label} ${l.best.minutes} min</b>${l.best.usd ? ` · ${local(t, l.best.usd)}` : ''} · ${l.best.km} km${l.estimated ? ' <span class="muted">(est.)</span>' : ''} <span class="muted">— ${esc(l.why)}</span>
    ${alts.length ? `<details><summary>alternatives ▾</summary><div class="alts">${alts.map((o) => `<span>${MODE[o.mode][0]} ${o.minutes} min${o.usd ? ` · ${local(t, o.usd)}` : ''}</span>`).join('')}</div></details>` : ''}
    <a href="${dir}" target="_blank" rel="noopener">Directions ↗</a></div>`
}

async function recheck() {
  const btn = $('#recheck')
  btn.disabled = true
  btn.textContent = '🌦️ Checking…'
  try {
    const { trip, newIssues } = await api(`/api/trips/${currentTrip.id}/recheck`, { method: 'POST' })
    currentTrip = trip
    renderTrip()
    $('#recheck-note').innerHTML = newIssues.length
      ? `<div class="notice warn"><span>🌦️</span><div><b>The forecast changed things.</b><ul>${newIssues.map((i) => `<li>${esc(i.message)}</li>`).join('')}</ul>Ask Hive to adjust the plan.</div></div>`
      : `<div class="notice ok"><span>🌦️</span><div>Latest forecast checked. Nothing new to worry about.</div></div>`
  } catch (err) {
    btn.disabled = false
    btn.textContent = `⚠️ ${err.message}`
  }
}

// ---------- map ----------
function drawMap() {
  const t = currentTrip
  if (!window.L) return
  if (map) map.remove()
  map = L.map('map', { scrollWheelZoom: false })
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap', maxZoom: 19 }).addTo(map)
  const days = groupDays(t.stops)
  const layers = []
  days.forEach(([date, stops], i) => {
    const color = DAY_COLORS[i % 5]
    const g = L.layerGroup()
    stops.forEach((s, k) => {
      if (typeof s.lat !== 'number') return
      const icon = L.divIcon({ className: '', html: `<div class="mk" style="background:${color}">${k + 1}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] })
      L.marker([s.lat, s.lng], { icon }).bindPopup(`<b>${esc(s.title)}</b><br>${esc(fmtDay(date))} · ${esc(s.start)}–${esc(s.end)}${s.tip ? `<br>💡 ${esc(s.tip)}` : ''}`).addTo(g)
    })
    t.legs.filter((l) => l.date === date).forEach((l) => {
      const a = stops.find((s) => s.id === l.fromId)
      const b = stops.find((s) => s.id === l.toId)
      const path = l.path ?? (a && b ? [[a.lat, a.lng], [b.lat, b.lng]] : null)
      if (path) L.polyline(path, { color, weight: 4, opacity: 0.8, dashArray: l.best.mode === 'walk' ? null : '6 8' }).addTo(g)
    })
    g.addTo(map)
    layers.push({ date, g, stops })
  })
  if (t.stay) {
    L.marker([t.stay.lat, t.stay.lng], { icon: L.divIcon({ className: '', html: '<div class="mk stay">🏨</div>', iconSize: [26, 26], iconAnchor: [13, 13] }) })
      .bindPopup(`<b>${esc(t.stay.name)}</b><br>Your stay`)
      .addTo(map)
  }
  const fit = (stops) => {
    const pts = stops.filter((s) => typeof s.lat === 'number').map((s) => [s.lat, s.lng])
    if (t.stay) pts.push([t.stay.lat, t.stay.lng])
    if (pts.length) map.fitBounds(pts, { padding: [30, 30] })
    else if (t.center) map.setView([t.center.lat, t.center.lng], 13)
  }
  fit(t.stops)
  $('#legend').innerHTML =
    `<button class="btn small" data-day="all">All days</button>` +
    layers.map((l, i) => `<button class="btn small" data-day="${l.date}"><span class="dot" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${DAY_COLORS[i % 5]}"></span>Day ${i + 1} · ${esc(fmtDay(l.date))}</button>`).join('') +
    `<p class="muted" style="font-size:12.5px">Solid lines: walking routes. Dashed: transit or taxi. Numbers follow the day's order.</p>`
  $('#legend').onclick = (e) => {
    const d = e.target.closest('[data-day]')?.dataset.day
    if (!d) return
    layers.forEach((l) => (d === 'all' || l.date === d ? l.g.addTo(map) : map.removeLayer(l.g)))
    fit(d === 'all' ? t.stops : t.stops.filter((s) => s.date === d))
  }
}

// ---------- costs ----------
function costsHtml(t) {
  const b = t.budget
  if (!b) return '<p class="muted">No cost estimate yet.</p>'
  const max = Math.max(...b.lines.map((l) => l.usd), 1)
  const tr = t.request.travellers ?? 1
  const twoCur = t.money?.homeCurrency !== t.money?.currency
  return `<div class="costs">
    <div class="card">
      <small class="muted">ALL-IN ESTIMATE PER PERSON</small>
      <div class="big">${local(t, b.totalUsd)}</div>
      ${twoCur ? `<div class="muted">≈ ${home(t, b.totalUsd)} in ${esc(t.money.homeCurrency)}</div>` : ''}
      <p>About <b>${local(t, b.perDayUsd)}</b> a day${t.request.dailyBudget ? ` against your $${t.request.dailyBudget} budget (${b.perDayUsd <= t.request.dailyBudget ? '✅ under' : '⚠️ over'})` : ''}. For ${tr} traveller${tr > 1 ? 's' : ''}: <b>${local(t, b.totalUsd * tr)}</b> total.</p>
      ${b.cashUsd ? `<div class="notice warn"><span>💵</span><div>Carry about <b>${local(t, b.cashUsd)}</b> in cash per person${t.money?.country ? ` — ${esc(t.money.country)} is ${Math.round((t.money.cashShare ?? 0) * 100)}% cash for day-to-day spend` : ''}.</div></div>` : ''}
      <p class="muted" style="font-size:12.5px">Prices in ${esc(t.money?.currency ?? 'USD')}${t.money?.live ? ' at today’s rates (Frankfurter)' : ' at offline rates'}. Planned prices come first, then local price levels.</p>
    </div>
    <div class="card">${b.lines.map((l) => `<div class="bar"><span>${COST_LABEL[l.category] ?? esc(l.category)}</span><div class="track"><div class="fill" style="width:${Math.round((l.usd / max) * 100)}%"></div></div><span class="amt">${local(t, l.usd)}</span><small>${esc(l.basis)}</small></div>`).join('')}</div>
  </div>`
}

// ---------- ideas ----------
function ideasHtml(t) {
  const groups = Object.entries(t.ideas ?? {}).filter(([, list]) => list.length)
  const card = (p) => `<div class="card idea"><h4>${esc(p.name)}</h4><div class="muted" style="font-size:12.5px">${esc(p.address ?? '')}</div><button class="btn small" data-add="${esc(p.name)}">🐝 Ask Hive to fit it in</button></div>`
  return `<div class="ideas">
    ${t.rainyBackups?.length ? `<div><div class="section-h" style="margin-top:0"><h2>☔ Rainy-day backups</h2><span class="muted">Indoor places nearby</span></div><div class="idea-grid">${t.rainyBackups.map(card).join('')}</div></div>` : ''}
    ${groups.map(([k, list]) => `<div><div class="section-h" style="margin-top:0"><h2>${KIND_LABEL[k] ?? esc(k)}</h2><span class="muted">Found while researching, not in the plan yet</span></div><div class="idea-grid">${list.map(card).join('')}</div></div>`).join('')}
    ${!groups.length && !t.rainyBackups?.length ? '<p class="muted">Every place Hive found is already in the plan.</p>' : ''}
  </div>`
}
function bindIdeas() {
  $('#tab-ideas').onclick = (e) => {
    const name = e.target.closest('[data-add]')?.dataset.add
    if (!name) return
    $('.tabs [data-tab="chat"]').click()
    $('#chat-input').value = `Can you fit ${name} into the plan? Swap out whatever fits least.`
    $('#chat-input').focus()
  }
}

// ---------- chat ----------
const SUGGEST = ['Make day 2 cheaper', 'Give me a rainy-day version of day 1', 'Add a great local market', 'Swap a museum for something outdoors', 'Start later each morning', 'What should I book in advance?']
function chatHtml(t) {
  return `<div class="chat">
    <div class="card" style="padding:0;display:flex;flex-direction:column">
      <div class="thread" id="thread">${threadHtml(t)}</div>
      <form class="composer" id="composer"><input id="chat-input" maxlength="600" placeholder="Ask Hive to change anything, or ask a question…" /><button class="btn primary" type="submit">Send</button></form>
    </div>
    <div class="suggest"><small class="muted">TRY ASKING</small>${SUGGEST.map((s) => `<button class="btn small" data-s="${esc(s)}">${esc(s)}</button>`).join('')}
      <p class="muted" style="font-size:12.5px">Hive never changes your plan on its own: every change comes back as a suggestion you accept or reject, and it has to pass the Plan Doctor first.</p></div>
  </div>`
}
function threadHtml(t) {
  const props = new Map(t.proposals.map((p) => [p.id, p]))
  const intro = `<div class="msg hive">Hi! I planned this trip. Ask me to change anything (swap a dinner, make a day cheaper, plan around rain) or ask me a question about it. Tell me about yourself (diet, home city, what you love) and I'll remember it for next time.</div>`
  return (
    intro +
    t.chat
      .map((m) => {
        let h = `<div class="msg ${m.role}">${esc(m.text)}</div>`
        const p = m.proposalId && props.get(m.proposalId)
        if (p) h += proposalHtml(p)
        return h
      })
      .join('')
  )
}
function proposalHtml(p) {
  const d = p.diff
  const status = { open: '', accepted: '✅ Accepted', rejected: 'Rejected', stale: 'Replaced by a newer suggestion' }[p.status]
  return `<div class="proposal ${p.status}" data-pid="${esc(p.id)}">
    <h4>🐝 ${esc(p.summary)}</h4>
    <div class="diff">${d.added.map((x) => `<span class="add">＋ ${esc(x)}</span>`).join('')}${d.removed.map((x) => `<span class="rem">－ ${esc(x)}</span>`).join('')}${d.moved.map((x) => `<span class="mov">↻ ${esc(x)}</span>`).join('')}${!d.added.length && !d.removed.length && !d.moved.length ? '<span class="muted">Small edits to notes, prices or the stay.</span>' : ''}</div>
    ${p.status === 'open' ? `<div class="row"><button class="btn honey small" data-v="accept">Accept change</button><button class="btn small" data-v="reject">Keep my plan</button></div>` : `<b class="muted">${status}</b>`}
  </div>`
}
function bindChat() {
  const thread = $('#thread')
  $('.suggest').onclick = (e) => {
    const s = e.target.closest('[data-s]')?.dataset.s
    if (!s) return
    $('#chat-input').value = s
    $('#composer').requestSubmit()
  }
  thread.onclick = async (e) => {
    const btn = e.target.closest('[data-v]')
    if (!btn) return
    const pid = btn.closest('[data-pid]').dataset.pid
    $$('[data-v]', btn.closest('.proposal')).forEach((b) => (b.disabled = true))
    try {
      currentTrip = await api(`/api/trips/${currentTrip.id}/proposals/${pid}/${btn.dataset.v}`, { method: 'POST' })
    } catch (err) {
      alertInThread(err.message)
      return
    }
    currentTab = btn.dataset.v === 'accept' ? 'plan' : 'chat'
    renderTrip()
    if (btn.dataset.v === 'accept') window.scrollTo({ top: $('.tabs').offsetTop - 80, behavior: 'smooth' })
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
      const done = await stream(`/api/trips/${currentTrip.id}/chat`, { message: text }, (ev) => {
        if (ev.type === 'step') {
          $('#work').textContent = `${stepIcon(ev)} ${stepText(ev)}`
          thread.scrollTop = 1e9
        }
      })
      currentTrip = done.trip
      currentTab = 'chat'
      renderTrip()
      $('#chat-input').focus()
    } catch (err) {
      $('#work')?.remove()
      alertInThread(err.message)
      input.disabled = false
    }
  }
}
function alertInThread(msg) {
  $('#thread').insertAdjacentHTML('beforeend', `<div class="msg hive">⚠️ ${esc(msg)}</div>`)
  $('#thread').scrollTop = 1e9
}

// ---------- profile ----------
async function renderProfile() {
  profile = await api('/api/profile').catch(() => ({}))
  app.innerHTML = `<section class="profile">
    <h1 style="font-size:32px">Your traveller profile</h1>
    <p class="lede">Hive is a personal agent: what you set here, and what you tell it in chat, is saved on this Sprite's disk and shapes every trip it plans.</p>
    <form class="card" id="profile-form">
      <div class="row">
        <label>Home city<input name="homeCity" value="${esc(profile.homeCity ?? '')}" placeholder="Los Angeles, USA" /></label>
        <label>Diet<input name="diet" value="${esc(profile.diet ?? '')}" placeholder="vegetarian, halal…" /></label>
      </div>
      <div class="row">
        <label>Usual pace<select name="pace">${['', 'chill', 'balanced', 'packed'].map((p) => `<option value="${p}" ${profile.pace === p ? 'selected' : ''}>${p || '—'}</option>`).join('')}</select></label>
        <label>Usual budget / day (USD)<input type="number" name="dailyBudget" value="${esc(profile.dailyBudget ?? '')}" /></label>
      </div>
      <label>Loves<div class="chips" id="p-interests">${INTERESTS.map((x) => `<button type="button" class="chip ${(profile.interests ?? []).includes(x) ? 'on' : ''}" data-i="${x}">${x}</button>`).join('')}</div></label>
      ${profile.notes?.length ? `<label>Things Hive picked up in chat<ul class="remembered">${profile.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></label>` : ''}
      <button class="btn primary" type="submit">Save profile</button> <span id="p-saved" class="muted"></span>
    </form></section>`
  $('#p-interests').onclick = (e) => e.target.closest('.chip')?.classList.toggle('on')
  $('#profile-form').onsubmit = async (e) => {
    e.preventDefault()
    const body = Object.fromEntries(new FormData(e.target))
    body.interests = $$('#p-interests .on').map((c) => c.dataset.i)
    profile = await api('/api/profile', { method: 'PUT', body: JSON.stringify(body) })
    $('#p-saved').textContent = 'Saved to the Sprite ✓'
  }
}

health()
route()
