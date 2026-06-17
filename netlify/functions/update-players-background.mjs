/**
 * Background function: fetches Jeff Sackmann's public match CSVs, computes
 * surface-specific Elo ratings and serve/return point-win rates for all
 * active ATP and WTA players, then stores the result to Netlify Blobs so
 * the /players.json function can serve it.
 *
 * Runs for up to 15 minutes (background function limit), so it can comfortably
 * fetch ~16 CSV files (~8 years × 2 tours) in parallel.
 */

import { getStore } from '@netlify/blobs'

const ATP_URL = 'https://raw.githubusercontent.com/JeffSackmann/tennis_atp/master/atp_matches_{y}.csv'
const WTA_URL = 'https://raw.githubusercontent.com/JeffSackmann/tennis_wta/master/wta_matches_{y}.csv'

const K = 32
const BASE = 1500
const MIN_RECENT_MATCHES = 8
const SURFACES = ['hard', 'clay', 'grass']

function slug(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'unknown'
}

function parseRow(line) {
  const fields = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { field += '"'; i++ }
      else inQuotes = !inQuotes
    } else if (c === ',' && !inQuotes) {
      fields.push(field)
      field = ''
    } else {
      field += c
    }
  }
  fields.push(field)
  return fields
}

function parseCsv(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  if (lines.length < 2) return []
  const headers = parseRow(lines[0]).map(h => h.trim())
  return lines.slice(1)
    .filter(l => l.trim())
    .map(line => {
      const vals = parseRow(line)
      const row = {}
      headers.forEach((h, i) => { row[h] = (vals[i] || '').trim() })
      return row
    })
}

function normSurface(s) {
  s = (s || '').trim().toLowerCase()
  if (s.startsWith('hard') || s === 'carpet') return 'hard'
  if (s.startsWith('clay')) return 'clay'
  if (s.startsWith('grass')) return 'grass'
  return null
}

function fnum(row, key) {
  const v = row[key]
  if (!v) return null
  const n = parseFloat(v)
  return isNaN(n) ? null : n
}

async function fetchCsv(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'deuce-updater/1.0' },
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

async function build(years = 8) {
  const thisYear = new Date().getUTCFullYear()
  const yearList = Array.from({ length: years }, (_, i) => thisYear - years + 1 + i)

  const fetchTasks = [
    ...yearList.map(y => ({ tour: 'ATP', url: ATP_URL.replace('{y}', y), year: y })),
    ...yearList.map(y => ({ tour: 'WTA', url: WTA_URL.replace('{y}', y), year: y })),
  ]

  // Fetch all CSV files in parallel
  const results = await Promise.allSettled(
    fetchTasks.map(async ({ tour, url, year }) => {
      const text = await fetchCsv(url)
      const rows = parseCsv(text)
      console.log(`${tour} ${year}: ${rows.length} matches`)
      return rows.map(row => ({ tour, row }))
    })
  )

  const allRows = []
  results.forEach((result, i) => {
    const { tour, year } = fetchTasks[i]
    if (result.status === 'fulfilled') {
      allRows.push(...result.value)
    } else {
      console.log(`skip ${tour} ${year}: ${result.reason?.message || result.reason}`)
    }
  })

  // Sort chronologically so Elo evolves in the right order
  allRows.sort((a, b) => {
    const ad = parseInt(a.row.tourney_date || '0') || 0
    const bd = parseInt(b.row.tourney_date || '0') || 0
    return ad - bd
  })

  // Elo state
  const elo = new Map()
  const eloSurf = { hard: new Map(), clay: new Map(), grass: new Map() }
  const getElo = (m, k) => (m.has(k) ? m.get(k) : BASE)

  const nameOf = {}
  const tourOf = {}
  const nRecent = {}
  const surfMatches = {}
  const serveWon = {}
  const servePts = {}
  const retWon = {}
  const retPts = {}
  const tourServeWon = { ATP: 0, WTA: 0 }
  const tourServePts = { ATP: 0, WTA: 0 }

  const recentCutoff = (thisYear - 2) * 10000

  for (const { tour, row } of allRows) {
    const wn = row.winner_name
    const ln = row.loser_name
    if (!wn || !ln) continue

    const wk = slug(wn)
    const lk = slug(ln)
    nameOf[wk] = wn
    nameOf[lk] = ln
    tourOf[wk] = tour
    tourOf[lk] = tour

    const surface = normSurface(row.surface)
    const date = parseInt(row.tourney_date || '0') || 0

    // Overall Elo
    const rw = getElo(elo, wk)
    const rl = getElo(elo, lk)
    const expW = 1 / (1 + Math.pow(10, (rl - rw) / 400))
    elo.set(wk, rw + K * (1 - expW))
    elo.set(lk, rl - K * (1 - expW))

    // Surface Elo
    if (surface) {
      const sw = getElo(eloSurf[surface], wk)
      const sl = getElo(eloSurf[surface], lk)
      const esw = 1 / (1 + Math.pow(10, (sl - sw) / 400))
      eloSurf[surface].set(wk, sw + K * (1 - esw))
      eloSurf[surface].set(lk, sl - K * (1 - esw))

      if (!surfMatches[wk]) surfMatches[wk] = {}
      if (!surfMatches[lk]) surfMatches[lk] = {}
      surfMatches[wk][surface] = (surfMatches[wk][surface] || 0) + 1
      surfMatches[lk][surface] = (surfMatches[lk][surface] || 0) + 1
    }

    if (date >= recentCutoff) {
      nRecent[wk] = (nRecent[wk] || 0) + 1
      nRecent[lk] = (nRecent[lk] || 0) + 1
    }

    // Serve / return point stats
    const wSv = fnum(row, 'w_svpt')
    const lSv = fnum(row, 'l_svpt')
    const w1W = fnum(row, 'w_1stWon')
    const w2W = fnum(row, 'w_2ndWon')
    const l1W = fnum(row, 'l_1stWon')
    const l2W = fnum(row, 'l_2ndWon')
    const wSw = w1W !== null && w2W !== null ? w1W + w2W : null
    const lSw = l1W !== null && l2W !== null ? l1W + l2W : null

    if (surface && wSv > 0 && lSv > 0 && wSw !== null && lSw !== null) {
      if (!serveWon[wk]) serveWon[wk] = {}
      if (!servePts[wk]) servePts[wk] = {}
      if (!serveWon[lk]) serveWon[lk] = {}
      if (!servePts[lk]) servePts[lk] = {}
      if (!retWon[wk]) retWon[wk] = {}
      if (!retPts[wk]) retPts[wk] = {}
      if (!retWon[lk]) retWon[lk] = {}
      if (!retPts[lk]) retPts[lk] = {}

      serveWon[wk][surface] = (serveWon[wk][surface] || 0) + wSw
      servePts[wk][surface] = (servePts[wk][surface] || 0) + wSv
      serveWon[lk][surface] = (serveWon[lk][surface] || 0) + lSw
      servePts[lk][surface] = (servePts[lk][surface] || 0) + lSv
      retWon[wk][surface] = (retWon[wk][surface] || 0) + (lSv - lSw)
      retPts[wk][surface] = (retPts[wk][surface] || 0) + lSv
      retWon[lk][surface] = (retWon[lk][surface] || 0) + (wSv - wSw)
      retPts[lk][surface] = (retPts[lk][surface] || 0) + wSv

      tourServeWon[tour] += wSw + lSw
      tourServePts[tour] += wSv + lSv
    }
  }

  const tourAvg = {}
  for (const t of ['ATP', 'WTA']) {
    tourAvg[t] =
      tourServePts[t] > 0
        ? Math.round((tourServeWon[t] / tourServePts[t]) * 10000) / 10000
        : t === 'ATP' ? 0.64 : 0.56
  }

  function rate(wonMap, ptsMap, key, surface, def) {
    const pts = (ptsMap[key] || {})[surface] || 0
    if (pts >= 40) return (wonMap[key] || {})[surface] / pts
    const tw = Object.values(wonMap[key] || {}).reduce((a, b) => a + b, 0)
    const tp = Object.values(ptsMap[key] || {}).reduce((a, b) => a + b, 0)
    if (tp >= 40) return tw / tp
    return def
  }

  const players = {}
  const active = Object.keys(nameOf).filter(k => (nRecent[k] || 0) >= MIN_RECENT_MATCHES)

  for (const k of active) {
    const t = tourOf[k]
    const srvDef = tourAvg[t]
    const eloO = Math.round(getElo(elo, k))
    const e = {}
    const sv = {}
    const rt = {}

    for (const s of SURFACES) {
      const sm = (surfMatches[k] || {})[s] || 0
      e[s] = sm >= 5 ? Math.round(getElo(eloSurf[s], k)) : eloO
      sv[s] = Math.round(Math.max(0.45, Math.min(0.85, rate(serveWon, servePts, k, s, srvDef))) * 1000) / 1000
      rt[s] = Math.round(Math.max(0.15, Math.min(0.55, rate(retWon, retPts, k, s, 1 - srvDef))) * 1000) / 1000
    }
    e.overall = eloO
    sv.overall = Math.round((SURFACES.reduce((sum, s) => sum + sv[s], 0) / 3) * 1000) / 1000
    rt.overall = Math.round((SURFACES.reduce((sum, s) => sum + rt[s], 0) / 3) * 1000) / 1000

    players[k] = { name: nameOf[k], tour: t, elo: e, serve: sv, return: rt }
  }

  // Tour-average pseudo-players (used as baselines and "Custom player" seed)
  for (const [t, key] of [['ATP', 'tour'], ['WTA', 'wtatour']]) {
    if (Object.values(players).some(p => p.tour === t)) {
      const avg = tourAvg[t]
      const eloBase = t === 'ATP' ? 1750 : 1650
      players[key] = {
        name: `${t} tour average`,
        tour: t,
        elo: { hard: eloBase, clay: eloBase, grass: eloBase, overall: eloBase },
        serve: {
          hard: avg,
          clay: Math.round((avg - 0.015) * 1000) / 1000,
          grass: Math.round((avg + 0.02) * 1000) / 1000,
          overall: avg,
        },
        return: {
          hard: Math.round((1 - avg) * 1000) / 1000,
          clay: Math.round((1 - avg + 0.01) * 1000) / 1000,
          grass: Math.round((1 - avg - 0.02) * 1000) / 1000,
          overall: Math.round((1 - avg) * 1000) / 1000,
        },
      }
    }
  }

  const now = new Date()
  const updated = now.toISOString().slice(0, 10)

  return {
    updated,
    source:
      'Jeff Sackmann tennis_atp / tennis_wta (CC BY-NC-SA). Computed by Netlify scheduled function.',
    tours: {
      ATP: { tour_avg_spw: tourAvg.ATP },
      WTA: { tour_avg_spw: tourAvg.WTA },
    },
    tour_avg_spw: tourAvg.ATP,
    players,
  }
}

export default async () => {
  try {
    console.log('Starting player data update...')
    const data = await build(8)

    const atpCount = Object.values(data.players).filter(p => p.tour === 'ATP').length
    const wtaCount = Object.values(data.players).filter(p => p.tour === 'WTA').length
    console.log(`Built: ${atpCount} ATP + ${wtaCount} WTA players, updated ${data.updated}`)

    const store = getStore('tennis-data')
    await store.setJSON('players', data)
    console.log('Stored players data to Netlify Blobs')
  } catch (err) {
    console.error('Player data update failed:', err)
  }
}
