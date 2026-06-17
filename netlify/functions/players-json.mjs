import { getStore } from '@netlify/blobs'

export default async (req, context) => {
  const store = getStore('tennis-data')
  const data = await store.get('players', { type: 'json' })

  if (!data) {
    // Blobs not populated yet — fire a background update and tell the client
    // to fall back to the seed data embedded in index.html.
    const siteUrl = context?.site?.url
    if (siteUrl) {
      context.waitUntil(
        fetch(`${siteUrl}/.netlify/functions/update-players-background`, { method: 'POST' })
          .catch(e => console.error('Failed to trigger initial update:', e))
      )
    }
    return new Response(JSON.stringify(null), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return Response.json(data, {
    headers: { 'Cache-Control': 'public, max-age=3600, s-maxage=3600' },
  })
}

export const config = {
  path: '/players.json',
}
