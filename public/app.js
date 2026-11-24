const $ = (s) => document.querySelector(s)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
let map

async function health() {
  const h = await fetch('/api/health').then((r) => r.json()).catch(() => null)
  if (!h) return
  $('#health').innerHTML = [
    `<span class="pill on">Sprite: ${esc(h.host)}</span>`,
    `<span class="pill ${h.llmConnector ? 'on' : ''}">LLM connector ${h.llmConnector ? 'on' : 'off'}</span>`,
    `<span class="pill ${h.slackConnector ? 'on' : ''}">Slack connector ${h.slackConnector ? 'on' : 'off'}</span>`,
  ].join('')
}

async function trips() {
  const list = await fetch('/api/trips').then((r) => r.json()).catch(() => [])
  $('#trips').innerHTML = list.length
    ? list.map((t) => `<li><a data-id="${esc(t.id)}">${esc(t.destination)}</a> · ${esc(t.startDate)} to ${esc(t.endDate)} · ${t.stops} stops</li>`).join('')
    : '<li>None yet.</li>'
}

$('#trips').addEventListener('click', async (e) => {
  const id = e.target?.dataset?.id
  if (!id) return
  show(await fetch(`/api/trips/${id}`).then((r) => r.json()))
})

function show(trip) {
  $('#result').classList.remove('hidden')
  $('#r-title').textContent = `${trip.request.destination}, ${trip.request.startDate} to ${trip.request.endDate}`
  $('#r-summary').textContent = trip.summary + (trip.shared ? ` (Slack ${trip.shared.channel}: ${trip.shared.ok ? 'posted' : trip.shared.error})` : '')
  $('#r-issues').innerHTML = trip.issues.length
    ? trip.issues.map((i) => `<div class="issue ${i.severity}">${esc(i.date)} · ${esc(i.message)}</div>`).join('')
    : '<div class="issue">Plan Doctor: no issues.</div>'

  const byDay = {}
  for (const s of trip.stops) (byDay[s.date] ??= []).push(s)
  $('#days').innerHTML = Object.keys(byDay).sort().map((d) => {
    const w = trip.forecast?.[d]
    const stops = byDay[d].sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''))
    return `<div class="card day"><h3>${esc(d)} ${w ? `<span class="wx">· ${esc(w.desc)}, ${w.min}–${w.max}°C</span>` : ''}</h3>${stops
      .map((s) => `<div class="stop"><time>${esc(s.start ?? '')}–${esc(s.end ?? '')}</time><span>${esc(s.title)}${s.costPerPerson ? ` · $${s.costPerPerson}` : ''}</span></div>`)
      .join('')}</div>`
  }).join('')

  const pts = trip.stops.filter((s) => typeof s.lat === 'number')
  if (window.L && pts.length) {
    if (!map) {
      map = L.map('map')
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(map)
    }
    map.eachLayer((l) => l instanceof L.Marker && map.removeLayer(l))
    pts.forEach((s) => L.marker([s.lat, s.lng]).addTo(map).bindPopup(`${esc(s.date)} ${esc(s.start)}<br>${esc(s.title)}`))
    map.fitBounds(pts.map((s) => [s.lat, s.lng]), { padding: [24, 24] })
  }
}

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const btn = e.target.querySelector('button')
  btn.disabled = true
  $('#live').classList.remove('hidden')
  $('#steps').innerHTML = ''
  const body = Object.fromEntries(new FormData(e.target))
  try {
    const res = await fetch('/api/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (!res.ok) throw new Error((await res.json()).error)
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
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
        if (ev.type === 'step') {
          const li = document.createElement('li')
          li.className = ev.tool === 'propose_plan' ? 'doctor' : ''
          li.textContent = `${ev.tool}: ${ev.note}`
          $('#steps').appendChild(li)
        } else if (ev.type === 'done') show(ev.trip)
        else if (ev.type === 'error') throw new Error(ev.error)
      }
    }
    trips()
  } catch (err) {
    const li = document.createElement('li')
    li.className = 'doctor'
    li.textContent = `error: ${err.message}`
    $('#steps').appendChild(li)
  } finally {
    btn.disabled = false
  }
})

const today = new Date()
const iso = (d) => d.toISOString().slice(0, 10)
$('[name=startDate]').value = iso(new Date(today.getTime() + 3 * 864e5))
$('[name=endDate]').value = iso(new Date(today.getTime() + 4 * 864e5))
health()
trips()
