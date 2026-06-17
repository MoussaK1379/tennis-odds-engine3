export default async (req, context) => {
  const { next_run } = await req.json().catch(() => ({}))
  console.log('Triggering daily player data update. Next run:', next_run)

  const siteUrl = context?.site?.url
  if (!siteUrl) {
    console.error('No site URL available — cannot trigger background function')
    return
  }

  try {
    const res = await fetch(
      `${siteUrl}/.netlify/functions/update-players-background`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } }
    )
    console.log('Background update triggered, status:', res.status)
  } catch (err) {
    console.error('Failed to trigger background update:', err)
  }
}

export const config = {
  schedule: '@daily',
}
